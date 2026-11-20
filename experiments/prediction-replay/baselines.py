"""P4 下一命令离线基线（独立 Python 裁判，不导入生产 TS ranker）。

固定口径（见 00-共享实验合同-v1 C 节）：
- kind 固定 mru / mfc / decay / markov；
- 先按 namespace（markov 另需同 epoch）与可学习资格过滤，再过滤可用性，最后截 Top-5；
- 命令按精确字符串去重，不做参数／引号／大小写规范化；
- 同分依次按频次降序、最近使用降序、命令 Unicode 字典序升序。
"""

from __future__ import annotations

BASELINE_VERSION = "p4-baselines-v1"
KINDS = ("mru", "mfc", "decay", "markov")
TOP_K = 5
DECAY_HALF_LIFE_DAYS = 7.0
MS_PER_DAY = 86_400_000
ORIGINS = ("user", "agent", "probe", "unknown")
AVAILABILITY_STATES = ("available", "unavailable", "unknown")

EVENT_FIELDS = (
    "eventId",
    "namespaceId",
    "epoch",
    "sequence",
    "tMs",
    "cwdKey",
    "command",
    "origin",
    "exitCode",
    "complete",
    "recordable",
)

QUERY_FIELDS = ("queryId", "namespaceId", "epoch", "tMs", "afterEventId", "availability")


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_str(value: object) -> bool:
    return isinstance(value, str)


def normalize_event(event: object) -> dict:
    """校验并归一化单个事件；-1 退出码归一为 None（不伪装正常退出）。"""
    if not isinstance(event, dict):
        raise ValueError("事件必须是 dict")
    missing = [f for f in EVENT_FIELDS if f not in event]
    if missing:
        raise ValueError(f"事件缺少字段: {missing}")
    if not _is_str(event["eventId"]) or not event["eventId"]:
        raise ValueError("eventId 必须是非空字符串")
    if not _is_str(event["namespaceId"]) or not event["namespaceId"]:
        raise ValueError("namespaceId 必须是非空字符串")
    if not _is_str(event["epoch"]) or not event["epoch"]:
        raise ValueError("epoch 必须是非空字符串")
    if not _is_int(event["sequence"]) or event["sequence"] < 0:
        raise ValueError("sequence 必须是非负整数")
    if not _is_int(event["tMs"]) or event["tMs"] < 0:
        raise ValueError("tMs 必须是非负整数毫秒")
    if not _is_str(event["cwdKey"]):
        raise ValueError("cwdKey 必须是字符串")
    if not _is_str(event["origin"]) or event["origin"] not in ORIGINS:
        raise ValueError(f"origin 必须是 {ORIGINS} 之一")
    if not isinstance(event["complete"], bool):
        raise ValueError("complete 必须是 bool")
    if not isinstance(event["recordable"], bool):
        raise ValueError("recordable 必须是 bool")

    command = event["command"]
    if command is not None and not _is_str(command):
        raise ValueError("command 必须是字符串或 null")
    if event["recordable"] is False and command is not None:
        raise ValueError("recordable=false 时 command 必须为 null")

    exit_code = event["exitCode"]
    if exit_code is not None:
        if not _is_int(exit_code):
            raise ValueError("exitCode 必须是整数或 null")
        if exit_code == -1:
            exit_code = None

    return {
        "eventId": event["eventId"],
        "namespaceId": event["namespaceId"],
        "epoch": event["epoch"],
        "sequence": event["sequence"],
        "tMs": event["tMs"],
        "cwdKey": event["cwdKey"],
        "command": command,
        "origin": event["origin"],
        "exitCode": exit_code,
        "complete": event["complete"],
        "recordable": event["recordable"],
    }


def validate_events(events: object) -> list[dict]:
    if not isinstance(events, list):
        raise ValueError("events/history 必须是 list")
    return [normalize_event(e) for e in events]


def validate_query(query: object, *, require_gold: bool = False) -> dict:
    """校验 query。predict 用 require_gold=False，此时含 gold 即判为泄漏并拒绝。"""
    if not isinstance(query, dict):
        raise ValueError("query 必须是 dict")
    missing = [f for f in QUERY_FIELDS if f not in query]
    if missing:
        raise ValueError(f"query 缺少字段: {missing}")
    if not _is_str(query["queryId"]) or not query["queryId"]:
        raise ValueError("queryId 必须是非空字符串")
    if not _is_str(query["namespaceId"]) or not query["namespaceId"]:
        raise ValueError("namespaceId 必须是非空字符串")
    if not _is_str(query["epoch"]) or not query["epoch"]:
        raise ValueError("epoch 必须是非空字符串")
    if not _is_int(query["tMs"]) or query["tMs"] < 0:
        raise ValueError("tMs 必须是非负整数毫秒")
    after = query["afterEventId"]
    if after is not None and (not _is_str(after) or not after):
        raise ValueError("afterEventId 必须是非空字符串或 null")
    availability = query["availability"]
    if not isinstance(availability, dict):
        raise ValueError("availability 必须是 dict")
    for key, state in availability.items():
        if not _is_str(key) or not key:
            raise ValueError("availability 的键必须是非空命令字符串")
        if state not in AVAILABILITY_STATES:
            raise ValueError(f"availability 值必须是 {AVAILABILITY_STATES} 之一")

    has_gold = "gold" in query
    if has_gold and not require_gold:
        raise ValueError("predict 的 query 不得包含 gold（未来泄漏）")
    gold = query.get("gold")
    if require_gold and (not _is_str(gold) or not gold):
        raise ValueError("replay 的 query 必须含非空 gold 字符串")

    normalized = {
        "queryId": query["queryId"],
        "namespaceId": query["namespaceId"],
        "epoch": query["epoch"],
        "tMs": query["tMs"],
        "afterEventId": after,
        "availability": dict(availability),
    }
    if "cwdKey" in query:
        if not _is_str(query["cwdKey"]):
            raise ValueError("cwdKey 必须是字符串")
        normalized["cwdKey"] = query["cwdKey"]
    if require_gold:
        normalized["gold"] = gold
    return normalized


def is_eligible(event: dict) -> bool:
    """可学习事件：用户来源、完整、可记录、有完整命令、退出码已知（非零不惩罚）。"""
    return (
        event["origin"] == "user"
        and event["complete"] is True
        and event["recordable"] is True
        and isinstance(event["command"], str)
        and bool(event["command"])
        and event["exitCode"] is not None
    )


def eligible_history(history: list[dict], namespace_id: str) -> list[dict]:
    """同 namespace 的可学习事件；不做 epoch 过滤（频次类基线可跨 epoch 累计）。"""
    return [e for e in history if e["namespaceId"] == namespace_id and is_eligible(e)]


def is_cold_start(history: list[dict], namespace_id: str) -> bool:
    return not eligible_history(history, namespace_id)


def _collect_stats(events: list[dict], now: int) -> dict[str, dict]:
    stats: dict[str, dict] = {}
    for event in events:
        item = stats.setdefault(event["command"], {"count": 0, "last": -1, "decay": 0.0})
        item["count"] += 1
        if event["tMs"] > item["last"]:
            item["last"] = event["tMs"]
        age_days = (now - event["tMs"]) / MS_PER_DAY
        item["decay"] += 2.0 ** (-age_days / DECAY_HALF_LIFE_DAYS)
    return stats


def _rank_mru(stats: dict[str, dict]) -> list[str]:
    return sorted(stats, key=lambda c: (-stats[c]["last"], -stats[c]["count"], c))


def _rank_mfc(stats: dict[str, dict]) -> list[str]:
    return sorted(stats, key=lambda c: (-stats[c]["count"], -stats[c]["last"], c))


def _rank_decay(stats: dict[str, dict]) -> list[str]:
    return sorted(stats, key=lambda c: (-stats[c]["decay"], -stats[c]["count"], -stats[c]["last"], c))


def _transition_counts(events: list[dict], epoch: str) -> dict[tuple[str, str], int]:
    """同 namespace（调用方已过滤）同 epoch、sequence 相邻且两端均可学习的转移计数。"""
    scoped = sorted(
        (e for e in events if e["epoch"] == epoch),
        key=lambda e: (e["sequence"], e["eventId"]),
    )
    counts: dict[tuple[str, str], int] = {}
    for prev, nxt in zip(scoped, scoped[1:]):
        if nxt["sequence"] != prev["sequence"] + 1:
            continue
        key = (prev["command"], nxt["command"])
        counts[key] = counts.get(key, 0) + 1
    return counts


def _predecessor(history: list[dict], query: dict) -> dict | None:
    """仅当 afterEventId 存在、同 namespace/epoch 且可学习时才认定为真实前序；否则不猜。"""
    event_id = query["afterEventId"]
    if event_id is None:
        return None
    for event in history:
        if event["eventId"] != event_id:
            continue
        if event["namespaceId"] != query["namespaceId"]:
            return None
        if event["epoch"] != query["epoch"]:
            return None
        if not is_eligible(event):
            return None
        return event
    return None


def _rank_markov(history: list[dict], scoped: list[dict], stats: dict[str, dict], query: dict) -> list[str]:
    prev = _predecessor(history, query)
    if prev is None:
        return _rank_mfc(stats)

    successors: dict[str, int] = {}
    for (from_cmd, to_cmd), count in _transition_counts(scoped, prev["epoch"]).items():
        if from_cmd == prev["command"]:
            successors[to_cmd] = successors.get(to_cmd, 0) + count
    if not successors:
        return _rank_mfc(stats)

    head = sorted(
        successors,
        key=lambda c: (-successors[c], -stats[c]["count"], -stats[c]["last"], c),
    )
    tail = [c for c in _rank_mfc(stats) if c not in successors]
    return head + tail


def predict(kind: str, history: list[dict], query_without_gold: dict) -> list[str]:
    """按固定基线给出 0–5 条命令；history 必须严格早于 query.tMs，query 不得含 gold。"""
    if kind not in KINDS:
        raise ValueError(f"kind 必须是 {KINDS} 之一")

    query = validate_query(query_without_gold)
    events = validate_events(history)
    now = query["tMs"]
    for event in events:
        if event["tMs"] >= now:
            raise ValueError(
                f"history 含未来事件 {event['eventId']}（tMs={event['tMs']} >= query.tMs={now}）"
            )

    scoped = eligible_history(events, query["namespaceId"])
    stats = _collect_stats(scoped, now)

    if kind == "mru":
        ranked = _rank_mru(stats)
    elif kind == "mfc":
        ranked = _rank_mfc(stats)
    elif kind == "decay":
        ranked = _rank_decay(stats)
    else:
        ranked = _rank_markov(events, scoped, stats, query)

    # 先过滤可用性（缺项按 unknown），再截 Top-5；不拿历史执行过当作当前可用。
    allowed = {cmd for cmd, state in query["availability"].items() if state == "available"}
    filtered = [cmd for cmd in ranked if cmd in allowed]
    return filtered[:TOP_K]
