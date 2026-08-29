"""
strands_backend/trust_store.py — 免确认记忆三级（Task 5，方案书 v3.1 §4.5-4.6）
================================================================================

职责（spec: add-agent-trust-modes「免确认记忆三级」，防确认模式因频繁打断而
不可用）：

1. **会话级记忆**（``SessionTrustStore``，纯内存不落盘，会话结束即失效）：
   - ``readonly_trust``：⚡「批准且本会话只读免审」点击后开启——本会话内
     L0-L1 命令不再逐条弹卡（仅低风险，L2+ 仍按模式决策）。
   - ``prefix_allow``：相似命令前缀免批（Warp 模式）——⚡批准时把该命令的
     首个 token（如 ``systemctl`` / ``cat``）加入集合；后续命令拆解后
     **所有 segment 的首 token 都命中**前缀集 → 直接放行。

2. **项目白名单**（``WhitelistStore``，持久化 ``$TDSF_DATA_DIR/agent_whitelist.json``，
   跟随 llm_config.json 的存储惯例）：
   - 规则 ``{"pattern": str, "decision": "allow"|"ask"|"deny", "created_at": iso}``
   - fnmatch 风格通配（``*`` / ``?``）+ **最后匹配优先**（列表后添加的规则
     覆盖先前的同命中规则）
   - 匹配口径 = **完整命令 + 每个 segment 首 token + 完整 segment** 取并：
     ``systemctl status *`` 命中完整命令口径；裸 ``systemctl`` 命中首 token 口径。
   - decision 语义：``allow`` 自动放行 / ``ask`` 强制逐条审批 / ``deny`` 直接拦截。

3. **deny 硬底线**：command_impact 的 denylist（``denied=True``）在
   ``assess_command`` 更早分支返回 blocked，永远优先于一切白名单/模式——
   本模块不做重复检测（单测锁定：denylist 命令加入白名单 allow 仍被拦截）。

安全不变量（spec 验收条款，消费方 tools.assess_command 保证）：
- **L4 永远确认**——白名单 allow / 前缀免批仅对 ``risk_l <= 3`` 生效，
  会话只读免审仅对 ``risk_l <= 1`` 生效（⚡ 按钮也仅 L0-L1 显示）；
  无任何模式/白名单可绕过 L4。
- **危险构造永不自动放行**——``dangerous_construct=True``（$() / 反引号 /
  eval / 重定向系统文件 / 管道到 shell）时白名单与免审全部失效。
- **observe 模式跳过一切自动放行**（fail-closed，只读观察语义不被白名单扩大）。

对外接口：
- ``get_global_trust_store()`` / ``get_global_whitelist()``：进程级单例
- ``record_session_trust(session_id, command, risk_l)``：needs_you.respond
  RPC 收到 trust 响应时调用（⚡批准 → 会话免审 + 首 token 前缀入集）
- ``register_methods(dispatcher)``：注册 ``memory.whitelist.list / .add / .remove``
  JSON-RPC 方法（main.register_business_methods 调用，前端设置 UI 消费）
"""
from __future__ import annotations

import fnmatch
import json
import logging
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("sidecar.strands_backend.trust_store")

# 白名单 decision 三元（spec：allow/ask/deny）
DECISION_ALLOW = "allow"
DECISION_ASK = "ask"
DECISION_DENY = "deny"
_VALID_DECISIONS = frozenset({DECISION_ALLOW, DECISION_ASK, DECISION_DENY})

# 放行上限（spec：「L4 永远确认——无任何模式/白名单可绕过」）
_PREFIX_ALLOW_MAX_RISK = 3
_READONLY_TRUST_MAX_RISK = 1

# sudo/env 等透明前缀（与 command_impact._TRANSPARENT_PREFIXES 同源；独立
# 常量避免反向依赖 tools 包——trust_store 被 tools 消费，不反向 import）
_TRANSPARENT_PREFIXES = frozenset(
    {"sudo", "env", "nohup", "nice", "time", "command", "exec"}
)


# ============================================================================
# 会话级记忆（内存，不落盘）
# ============================================================================


class SessionTrustStore:
    """会话级免审记忆（线程安全；per-session {readonly_trust, prefix_allow}）

    生命周期：随 sidecar 进程存活；``end_session`` 供会话清理（当前前端
    会话结束未显式通知 sidecar，允许残留——内存量级极小，仅 prefix 字符串）。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # session_id -> {"readonly_trust": bool, "prefix_allow": set[str]}
        self._sessions: dict[str, dict[str, Any]] = {}

    def _get(self, session_id: str) -> dict[str, Any]:
        """取（或惰性建）会话记录——调用方必须已持锁"""
        rec = self._sessions.get(session_id)
        if rec is None:
            rec = {"readonly_trust": False, "prefix_allow": set()}
            self._sessions[session_id] = rec
        return rec

    # --- ⚡只读免审 ---------------------------------------------------------

    def trust_session(self, session_id: str) -> None:
        """开启会话只读免审（⚡「批准且本会话只读免审」点击时）"""
        with self._lock:
            self._get(session_id)["readonly_trust"] = True
        logger.info(f"session trust enabled: session={session_id}")

    def is_session_trusted(self, session_id: str) -> bool:
        """查询会话是否已开启只读免审"""
        with self._lock:
            rec = self._sessions.get(session_id)
            return bool(rec and rec["readonly_trust"])

    # --- 相似命令前缀免批 ---------------------------------------------------

    def add_prefix_allow(self, session_id: str, prefix: str) -> None:
        """把命令首 token（如 systemctl）加入会话免批前缀集"""
        prefix = (prefix or "").strip().lower()
        if not prefix:
            return
        with self._lock:
            self._get(session_id)["prefix_allow"].add(prefix)
        logger.info(
            f"session prefix allow added: session={session_id}, prefix={prefix}"
        )

    def is_prefix_allowed(self, session_id: str, command: str) -> bool:
        """命令所有 segment 的首 token 都命中前缀集时放行

        前提：命令已拆解（split_compound）且每段首 token 归一化（剥 sudo/env
        透明前缀 + basename + lower）。空段/空集不命中（fail-closed）。
        """
        prefixes = self.get_prefix_allow(session_id)
        if not prefixes:
            return False
        heads = segment_heads(command)
        if not heads:
            return False
        return all(h in prefixes for h in heads)

    def get_prefix_allow(self, session_id: str) -> frozenset[str]:
        """读取会话免批前缀集（只读快照）"""
        with self._lock:
            rec = self._sessions.get(session_id)
            if not rec:
                return frozenset()
            return frozenset(rec["prefix_allow"])

    # --- 清理 ---------------------------------------------------------------

    def end_session(self, session_id: str) -> None:
        """清理会话记忆（测试 / 会话显式结束时用）"""
        with self._lock:
            self._sessions.pop(session_id, None)

    def reset(self) -> None:
        """清空全部会话记忆（测试用）"""
        with self._lock:
            self._sessions.clear()


# ============================================================================
# 首 token 归一化（白名单首 token 口径 + 前缀免批共用）
# ============================================================================


def _strip_quotes(tok: str) -> str:
    """去掉成对的首尾引号（单/双）"""
    if len(tok) >= 2 and tok[0] == tok[-1] and tok[0] in ("'", '"'):
        return tok[1:-1]
    return tok


# env 前缀的 VAR=val 赋值形式（与 command_impact._ENV_ASSIGN_RE 同源）
_ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=.*$")


def normalized_head(segment: str) -> str:
    """单段命令的首 token 归一化：剥引号/透明前缀/VAR=val 赋值 + basename + lower

    例：``sudo /usr/bin/systemctl status nginx`` → ``systemctl``
    """
    toks = [_strip_quotes(t) for t in segment.split()]
    while toks:
        head = toks[0]
        if head.lower() in _TRANSPARENT_PREFIXES or _ENV_ASSIGN_RE.match(head):
            toks = toks[1:]
            continue
        break
    if not toks:
        return ""
    head = toks[0]
    # basename（/usr/bin/rm → rm）
    for sep in ("\\", "/"):
        if sep in head:
            head = head.rsplit(sep, 1)[-1]
    return head.lower()


def segment_heads(command: str) -> list[str]:
    """整条命令按复合分隔符拆解后，返回每段的归一化首 token 列表

    拆解复用 command_impact.split_compound（单一真源）；该函数零内部依赖，
    import 失败时退化为整串单段（降级不阻塞，仅影响口径精度）。
    """
    if not (command or "").strip():
        return []
    try:
        from strands_backend.tools.command_impact import split_compound

        segments = split_compound(command)
    except Exception as e:  # noqa: BLE001 — 拆解失败退化为单段，不阻塞放行判定
        logger.warning(f"split_compound unavailable, fallback to single segment: {e}")
        segments = [command.strip()]
    heads: list[str] = []
    for seg in segments:
        h = normalized_head(seg)
        if h:
            heads.append(h)
    return heads


# ============================================================================
# 项目白名单（持久化）
# ============================================================================


def _whitelist_path() -> Path:
    """白名单文件路径（$TDSF_DATA_DIR/agent_whitelist.json，同 llm_config 惯例）"""
    data_dir = Path(os.environ.get("TDSF_DATA_DIR", "."))
    return data_dir / "agent_whitelist.json"


class WhitelistStore:
    """项目审批白名单（持久化 json + 线程锁；最后匹配优先）

    匹配口径（取并）：完整命令整串 / 每个 segment 完整文本 / 每个 segment
    归一化首 token，逐规则 fnmatchcase；**最后命中的规则生效**（规则按添加
    顺序存储，后加的覆盖先前的同命中结果——用户可在 UI 靠后加特例）。
    """

    def __init__(self, path: Path | None = None) -> None:
        self._path = path if path is not None else _whitelist_path()
        self._lock = threading.Lock()
        self._rules: list[dict[str, Any]] = []
        self.load()

    # --- 持久化 -------------------------------------------------------------

    def load(self) -> None:
        """从磁盘加载规则（文件缺失/损坏 → 空规则表 + warning，不抛错）"""
        with self._lock:
            if not self._path.exists():
                self._rules = []
                return
            try:
                data = json.loads(self._path.read_text(encoding="utf-8"))
                rules = data.get("rules", []) if isinstance(data, dict) else data
                self._rules = [
                    r for r in rules
                    if isinstance(r, dict)
                    and str(r.get("pattern", "")).strip()
                    and str(r.get("decision", "")) in _VALID_DECISIONS
                ]
            except (json.JSONDecodeError, OSError) as e:
                logger.warning(
                    f"whitelist load failed, starting empty: {self._path}, error={e}"
                )
                self._rules = []

    def save(self) -> None:
        """写回磁盘（失败 warning 不抛错——放行判定退化为仅会话级记忆）"""
        with self._lock:
            rules = list(self._rules)
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(
                json.dumps({"rules": rules}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError as e:
            logger.warning(f"whitelist save failed: {self._path}, error={e}")

    # --- CRUD ---------------------------------------------------------------

    def list_rules(self) -> list[dict[str, Any]]:
        """规则列表（深拷贝快照，防调用方原地修改）"""
        with self._lock:
            return [dict(r) for r in self._rules]

    def add_rule(self, pattern: str, decision: str) -> dict[str, Any]:
        """新增规则（同 pattern 已存在 → 先删旧再追加到末尾，保证最后匹配优先语义）"""
        pattern = (pattern or "").strip()
        decision = (decision or "").strip().lower()
        if not pattern:
            raise ValueError("pattern 不能为空")
        if decision not in _VALID_DECISIONS:
            raise ValueError(f"decision 必须是 allow/ask/deny 之一，收到 {decision!r}")
        rule = {
            "pattern": pattern,
            "decision": decision,
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        with self._lock:
            self._rules = [r for r in self._rules if r.get("pattern") != pattern]
            self._rules.append(rule)
        self.save()
        logger.info(f"whitelist rule added: pattern={pattern}, decision={decision}")
        return dict(rule)

    def remove_rule(self, pattern: str) -> bool:
        """按 pattern 删除规则；返回是否删到"""
        pattern = (pattern or "").strip()
        with self._lock:
            before = len(self._rules)
            self._rules = [r for r in self._rules if r.get("pattern") != pattern]
            removed = len(self._rules) < before
        if removed:
            self.save()
            logger.info(f"whitelist rule removed: pattern={pattern}")
        return removed

    # --- 匹配 ---------------------------------------------------------------

    def match_command(self, command: str) -> str | None:
        """整条命令的白名单决策（最后匹配优先）

        Returns:
            "allow" | "ask" | "deny" | None（无命中）
        """
        command = command or ""
        if not command.strip():
            return None
        # 候选口径：完整命令 + 每段完整文本 + 每段首 token（取并）
        candidates: list[str] = [command]
        try:
            from strands_backend.tools.command_impact import split_compound

            segments = split_compound(command)
        except Exception:  # noqa: BLE001 — 同 segment_heads 的降级策略
            segments = [command]
        for seg in segments:
            candidates.append(seg)
            head = normalized_head(seg)
            if head:
                candidates.append(head)
        with self._lock:
            hit: str | None = None
            for rule in self._rules:
                pattern = str(rule.get("pattern", ""))
                for cand in candidates:
                    try:
                        if fnmatch.fnmatchcase(cand, pattern):
                            hit = str(rule.get("decision", ""))
                            break  # 该规则命中 → 后续规则仍可覆盖（最后匹配优先）
                    except Exception as e:  # noqa: BLE001 — 非法 pattern 跳过
                        logger.debug(f"whitelist pattern error: {pattern!r}, {e}")
        return hit


# ============================================================================
# 进程级单例 + trust 记录入口
# ============================================================================

_trust_store: SessionTrustStore | None = None
_trust_store_lock = threading.Lock()
_whitelist: WhitelistStore | None = None


def get_global_trust_store() -> SessionTrustStore:
    """进程级 SessionTrustStore 单例（线程安全惰性初始化）"""
    global _trust_store
    if _trust_store is None:
        with _trust_store_lock:
            if _trust_store is None:
                _trust_store = SessionTrustStore()
    return _trust_store


def get_global_whitelist() -> WhitelistStore:
    """进程级 WhitelistStore 单例（线程安全惰性初始化）"""
    global _whitelist
    if _whitelist is None:
        with _trust_store_lock:
            if _whitelist is None:
                _whitelist = WhitelistStore()
    return _whitelist


def reset_globals() -> None:
    """重置单例（测试用；进程正常运行不调用）"""
    global _trust_store, _whitelist
    with _trust_store_lock:
        _trust_store = None
        _whitelist = None


def record_session_trust(session_id: str, command: str, risk_l: Any = None) -> None:
    """记录会话级 trust（needs_you.respond 收到 trust 响应时调用）

    ⚡「批准且本会话只读免审」的两条会话记忆一次写入：
    1. risk_l <= 1（与审批卡 ⚡ 按钮显隐一致）→ 开启会话只读免审
    2. 命令首 token 加入会话免批前缀集（Warp 模式：本会话同前缀命令免批）

    Args:
        session_id: 对话会话 ID（req.session_id）
        command: 被批准的命令原文（req.extra["command"]）
        risk_l: 综合 L 级（req.extra["risk_l"]；None 时按不满足只读免审处理，
                仍记前缀——前缀放行另有 risk_l<=3 兜底）
    """
    store = get_global_trust_store()
    sid = str(session_id or "")
    if not sid:
        return
    try:
        level = int(risk_l) if risk_l is not None else None
    except (TypeError, ValueError):
        level = None
    if level is not None and level <= _READONLY_TRUST_MAX_RISK:
        store.trust_session(sid)
    head = normalized_head(command or "")
    if head:
        store.add_prefix_allow(sid, head)


# ============================================================================
# JSON-RPC 方法注册（main.register_business_methods 调用）
# ============================================================================


def register_methods(dispatcher: Any) -> None:
    """注册 memory.whitelist.* JSON-RPC 方法（前端设置 UI 消费）"""

    # MethodDispatcher.dispatch 对 dict params 走 handler(**params) 解包，
    # handler 必须用具名参数（与 session_memory.register_methods 同模式）
    def _list() -> dict[str, Any]:
        return {"ok": True, "rules": get_global_whitelist().list_rules()}

    def _add(pattern: str, decision: str = DECISION_ALLOW) -> dict[str, Any]:
        rule = get_global_whitelist().add_rule(str(pattern), str(decision))
        return {"ok": True, "rule": rule}

    def _remove(pattern: str) -> dict[str, Any]:
        removed = get_global_whitelist().remove_rule(str(pattern))
        return {"ok": True, "removed": removed}

    dispatcher.register("memory.whitelist.list", _list)
    dispatcher.register("memory.whitelist.add", _add)
    dispatcher.register("memory.whitelist.remove", _remove)
    logger.info("memory.whitelist.* methods registered (list/add/remove)")


__all__ = [
    "DECISION_ALLOW",
    "DECISION_ASK",
    "DECISION_DENY",
    "SessionTrustStore",
    "WhitelistStore",
    "get_global_trust_store",
    "get_global_whitelist",
    "record_session_trust",
    "normalized_head",
    "segment_heads",
    "register_methods",
    "reset_globals",
]
