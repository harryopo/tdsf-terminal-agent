"""
strands_backend/tests/replay/replay.py — T8 会话回放器（spec add-agent-loop-closure 8.1）
================================================================================================

职责：把 **agent_log 风格的场景 JSONL** 重放进 ``StrandsAgentAdapter`` 的真实会话循环，
再用声明式断言核对闭环行为（工具选择与顺序 / 熔断 / 追加轮 / 上下文连续性 / schema 切换）。

场景 JSONL 每行一个事件（与 strands_backend/agent_log.py 的 ``{ts,type,content,meta}``
同构，便于从真实会话流水直接裁剪成场景）：

- ``meta``       : 场景头（id / title / tasks / agent）
- ``turn``       : 一轮用户输入；``meta.rounds`` 是该轮 LLM 的脚本应答，
                   ``meta.bridge`` 是该轮录制的工具执行结果（RustBridge 返回值）
- ``expect``     : ``meta.checks`` = 断言清单，跑完全部 turn 后逐条核对

轮脚本（``meta.rounds`` 列表元素）三选一：
- ``{"tools": [{"name": ..., "input": {...}}]}``  → 该轮让 LLM 调用工具
- ``{"repeat": {"tools": [...]}, "times": N}``     → 展开成 N 个相同工具轮（熔断场景用）
- ``{"text": "..."}``                              → 该轮输出最终文本

录制结果（``meta.bridge``）= ``{RustBridge 方法名: 返回值}``；值写成
``{"__raise__": "msg"}`` 表示工具执行抛异常。未列出的方法返回空 bytes。

刻意不复用真实执行链（SSH/磁盘）：工具层由 RustBridge mock 供给录制的结果，
被测的是 adapter/hook/回环逻辑本身，LLM 由 ReplayModel 脚本化，全程不联网。
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

_SIDECAR_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _SIDECAR_DIR not in sys.path:
    sys.path.insert(0, _SIDECAR_DIR)

from strands.models.model import Model  # noqa: E402 — sys.path 先行注入

SCENARIOS_DIR = Path(__file__).with_name("scenarios")


class ReplayError(RuntimeError):
    """场景文件格式错误 / 检查项未知"""


# ============================================================================
# 场景解析
# ============================================================================


@dataclass
class Turn:
    user_input: str
    mode: str = "confirm"
    teach: bool = False
    rounds: list[dict[str, Any]] = field(default_factory=list)
    bridge: dict[str, Any] = field(default_factory=dict)
    live: dict[str, Any] = field(default_factory=dict)


@dataclass
class Scenario:
    scenario_id: str
    title: str
    tasks: list[str]
    agent_id: str
    turns: list[Turn]
    checks: list[dict[str, Any]]
    path: Path


def _expand_rounds(raw_rounds: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """展开 repeat 语法糖：{"repeat": {...}, "times": N} → N 个相同轮"""
    rounds: list[dict[str, Any]] = []
    for item in raw_rounds:
        times = int(item.get("times", 1))
        if "repeat" in item:
            rounds.extend([dict(item["repeat"]) for _ in range(times)])
        else:
            rounds.append(item)
    return rounds


def load_scenario(path: str | Path) -> Scenario:
    """读场景 JSONL → Scenario"""
    path = Path(path)
    meta: dict[str, Any] = {}
    turns: list[Turn] = []
    checks: list[dict[str, Any]] = []
    for lineno, raw in enumerate(
        (line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()),
        start=1,
    ):
        try:
            entry = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ReplayError(f"{path.name}:{lineno} 非法 JSON: {e}") from e
        etype = entry.get("type")
        meta_in = entry.get("meta") or {}
        if etype == "meta":
            meta = meta_in
        elif etype == "turn":
            turns.append(
                Turn(
                    user_input=str(entry.get("content", "")),
                    mode=str(meta_in.get("mode", "confirm")),
                    teach=bool(meta_in.get("teach", False)),
                    rounds=_expand_rounds(list(meta_in.get("rounds") or [])),
                    bridge=dict(meta_in.get("bridge") or {}),
                    live=dict(meta_in.get("live") or {}),
                )
            )
        elif etype == "expect":
            checks.extend(meta_in.get("checks") or [])
        else:
            raise ReplayError(f"{path.name}:{lineno} 未知事件类型: {etype!r}")
    if not turns:
        raise ReplayError(f"{path.name} 无 turn 事件")
    return Scenario(
        scenario_id=str(meta.get("id") or path.stem),
        title=str(meta.get("title") or ""),
        tasks=[str(t) for t in (meta.get("tasks") or [])],
        agent_id=str(meta.get("agent") or "main"),
        turns=turns,
        checks=checks,
        path=path,
    )


# ============================================================================
# 假 LLM：按脚本轮应答，并记录每轮收到的 messages / 工具 schema
# ============================================================================


def _spec_names(tool_specs: Any) -> set[str]:
    """从 Strands tool_specs（list[ToolSpec]）提取工具名集合（宽松兼容形态）"""
    names: set[str] = set()
    for spec in tool_specs or []:
        node: Any = spec
        if isinstance(node, dict):
            node = node.get("toolSpec", node)
            name = node.get("name") if isinstance(node, dict) else None
        else:
            name = getattr(node, "name", None)
        if name:
            names.add(str(name))
    return names


class ReplayModel(Model):
    """脚本驱动的 Strands Model：不联网，逐轮吐脚本，并留下可断言的调用痕迹"""

    def __init__(self) -> None:
        self.rounds: list[dict[str, Any]] = []
        self.cursor = 0
        # 每次 stream() 调用记录一条（与自研 Model 协议一致：messages + tool_specs）
        self.received: list[str] = []
        self.schemas: list[set[str]] = []
        self.turn_marks: list[int] = []

    def begin_turn(self, turn: Turn) -> None:
        """追加该轮脚本并记录模型调用起点（供 turn → 模型调用区间断言）"""
        self.turn_marks.append(self.cursor)
        self.rounds.extend(turn.rounds)

    def supports_tool_calls(self) -> bool:
        return True

    def get_config(self) -> dict:
        return {"model": "replay"}

    def update_config(self, **model_config) -> None:
        pass

    async def structured_output(
        self, output_model, prompt, system_prompt=None, **kwargs
    ):
        yield None  # 回放不覆盖结构化输出路径

    async def stream(
        self, messages, tool_specs=None, system_prompt=None, **kwargs
    ):
        self.received.append(_to_text(messages))
        self.schemas.append(_spec_names(tool_specs))
        spec = (
            self.rounds[self.cursor]
            if self.cursor < len(self.rounds)
            else {"text": "（回放脚本已耗尽）"}
        )
        self.cursor += 1
        tools = spec.get("tools") or []
        yield {"messageStart": {"role": "assistant"}}
        if tools:
            for idx, call in enumerate(tools):
                yield {
                    "contentBlockStart": {
                        "start": {
                            "toolUse": {
                                "name": str(call.get("name")),
                                "toolUseId": f"{self.cursor}-{idx}",
                            }
                        }
                    }
                }
                yield {
                    "contentBlockDelta": {
                        "delta": {
                            "toolUse": {
                                "input": json.dumps(
                                    call.get("input") or {}, ensure_ascii=False
                                )
                            }
                        }
                    }
                }
                yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": str(spec.get("text", ""))}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
        yield {
            "metadata": {
                "usage": {"inputTokens": 10, "outputTokens": 10, "totalTokens": 20}
            }
        }


def _to_text(value: Any) -> str:
    """任意对象 → 可子串匹配的文本（回放断言只关心"有没有出现"，不解析结构）"""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001 — 断言辅助，退化成 repr
        return repr(value)


# ============================================================================
# mock RustBridge：按场景录制的结果回答 ipc_invoke
# ============================================================================


class RecordingBridge:
    """RustBridge 替身：查表返回录制结果，并统计每个方法的调用次数"""

    def __init__(self) -> None:
        self.table: dict[str, Any] = {}
        self.calls: list[str] = []
        self.bus = MagicMock()

    def ipc_invoke(self, method: str, payload: Any = None, *args: Any, **kwargs: Any) -> Any:
        self.calls.append(str(method))
        if method not in self.table:
            return b""
        value = self.table[method]
        if isinstance(value, dict) and "__raise__" in value:
            raise RuntimeError(str(value["__raise__"]))
        return value

    def send_notification(self, *args: Any, **kwargs: Any) -> None:
        return None

    def count(self, method: str) -> int:
        return sum(1 for m in self.calls if m == method)


# ============================================================================
# 回放执行
# ============================================================================


@dataclass
class TurnObs:
    index: int
    mode: str
    result: dict[str, Any]
    tool_names: list[str]
    tool_log: list[dict[str, Any]]
    cancelled: bool
    total_calls: int
    failures_by_tool: dict[str, int]
    model_calls: range  # 该 turn 期间 ReplayModel.stream() 的调用下标区间


@dataclass
class ReplayOutcome:
    scenario: Scenario
    session_id: str
    adapter: Any
    model: ReplayModel
    bridge: RecordingBridge
    turns: list[TurnObs]
    logs: list[dict[str, Any]]

    def turn(self, index: int) -> TurnObs:
        if not 0 <= index < len(self.turns):
            raise ReplayError(f"场景 {self.scenario.scenario_id} 无 turn {index}")
        return self.turns[index]


def replay(scenario: Scenario, session_id: str | None = None) -> ReplayOutcome:
    """跑完一个场景，返回可断言的回放结果（含 agent_log 全量流水）"""
    from strands_backend import agent_log as agent_log_mod
    from strands_backend.adapter import StrandsAgentAdapter

    session_id = session_id or f"replay-{scenario.scenario_id}"
    model = ReplayModel()
    bridge = RecordingBridge()
    bus = MagicMock()
    bus.emit_agent_message = MagicMock(return_value=1)
    bus.emit_mood_change = MagicMock(return_value=1)
    bus.emit_tool_call = MagicMock(return_value=1)
    bus.emit_loop_progress = MagicMock(return_value=1)
    bus.emit_needs_you = MagicMock(return_value=1)
    bus.emit_agent_switch = MagicMock(return_value=1)

    adapter = StrandsAgentAdapter(
        event_bus=bus, rust_bridge=bridge, backend_enabled=True, strands_model=model
    )
    adapter._strands_available = True
    adapter._model_available = True

    obs_list: list[TurnObs] = []
    for index, turn in enumerate(scenario.turns):
        bridge.table = turn.bridge
        model.begin_turn(turn)
        live = {"sshSessionId": 1, "agentMode": turn.mode, "teach": turn.teach}
        live.update(turn.live)
        result = adapter.invoke(
            scenario.agent_id,
            turn.user_input,
            {"session_id": session_id, "live": live},
        )
        hook = adapter._limit_hooks.get((scenario.agent_id, session_id))
        obs_list.append(
            TurnObs(
                index=index,
                mode=turn.mode,
                result=result,
                tool_names=[str(e.get("name")) for e in (hook.tool_log if hook else [])],
                tool_log=list(hook.tool_log if hook else []),
                cancelled=bool(hook.cancelled) if hook else False,
                total_calls=int(hook.total_calls) if hook else 0,
                failures_by_tool=dict(hook.failures_by_tool) if hook else {},
                model_calls=range(
                    model.turn_marks[index],
                    model.turn_marks[index + 1]
                    if index + 1 < len(model.turn_marks)
                    else model.cursor,
                ),
            )
        )

    logs = agent_log_mod.tail(session_id=session_id)["lines"]
    return ReplayOutcome(
        scenario=scenario,
        session_id=session_id,
        adapter=adapter,
        model=model,
        bridge=bridge,
        turns=obs_list,
        logs=logs,
    )


# ============================================================================
# 声明式检查（spec 8.1「断言行为」的封闭集合）
# ============================================================================


def _check_verify_settled(outcome: ReplayOutcome, spec: dict[str, Any]) -> str | None:
    """T7 收尾判定：该 turn 结束时工具流水不应再残留写后未验证"""
    from strands_backend.adapter import _needs_verify_followup

    obs = outcome.turn(int(spec.get("turn", 0)))
    return (
        None
        if not _needs_verify_followup(obs.tool_log)
        else f"第 {obs.index} 轮收尾仍有写操作未经验证: {obs.tool_names}"
    )


def _logs_of(outcome: ReplayOutcome, event_type: str) -> list[dict[str, Any]]:
    return [e for e in outcome.logs if e.get("type") == event_type]


def _check_log_event(outcome: ReplayOutcome, spec: dict[str, Any]) -> str | None:
    """agent_log 事件断言：类型存在（可选子串/反子串、meta 字段相等）"""
    etype = str(spec.get("type", ""))
    matched = _logs_of(outcome, etype)
    if not matched:
        return f"agent_log 缺少事件类型 {etype}（实有 {sorted({e.get('type') for e in outcome.logs})}）"
    contains = spec.get("contains")
    not_contains = spec.get("not_contains")
    meta_eq = spec.get("meta") or {}
    for entry in matched:
        content = str(entry.get("content", ""))
        if contains is not None and str(contains) not in content:
            continue
        if not_contains is not None and str(not_contains) in content:
            continue
        entry_meta = entry.get("meta") or {}
        if all(entry_meta.get(k) == v for k, v in meta_eq.items()):
            return None
    return f"agent_log {etype} 存在但无一满足 contains/not_contains/meta: {spec}"


CHECKS: dict[str, Any] = {
    "tool_sequence": lambda o, s: (
        None
        if o.turn(int(s.get("turn", 0))).tool_names == list(s.get("names") or [])
        else f"工具顺序不符: 期望 {s.get('names')} 实际 {o.turn(int(s.get('turn', 0))).tool_names}"
    ),
    "tool_sequence_contains": lambda o, s: (
        None
        if all(n in o.turn(int(s.get("turn", 0))).tool_names for n in s.get("names") or [])
        else f"工具序列缺少项: {s.get('names')} ⊄ {o.turn(int(s.get('turn', 0))).tool_names}"
    ),
    "tool_absent": lambda o, s: (
        None
        if s.get("name") not in o.turn(int(s.get("turn", 0))).tool_names
        else f"不该出现的工具被调用: {s.get('name')}"
    ),
    "schema_has": lambda o, s: (
        None
        if any(s.get("name") in o.model.schemas[i] for i in o.turn(int(s.get("turn", 0))).model_calls)
        else f"LLM 收到的 schema 缺 {s.get('name')}"
    ),
    "schema_lacks": lambda o, s: (
        None
        if all(s.get("name") not in o.model.schemas[i] for i in o.turn(int(s.get("turn", 0))).model_calls)
        else f"LLM 收到的 schema 泄漏了 {s.get('name')}（模式隔离失效）"
    ),
    "history_contains": lambda o, s: (
        None
        if any(str(s.get("text")) in o.model.received[i] for i in o.turn(int(s.get("turn", 0))).model_calls)
        else f"第 {s.get('turn')} 轮模型输入未含历史片段: {s.get('text')!r}"
    ),
    "user_msg_absent": lambda o, s: (
        None
        if all(str(s.get("text")) not in str(e.get("content", "")) for e in _logs_of(o, "user_msg"))
        else f"user_msg 混入了注入区文本: {s.get('text')!r}"
    ),
    "observation_contains": lambda o, s: (
        None
        if str(s.get("text")) in str(o.turn(int(s.get("turn", 0))).result.get("observation", ""))
        else f"第 {s.get('turn')} 轮 observation 未含: {s.get('text')!r}"
    ),
    "breaker_tripped": lambda o, s: (
        None
        if o.turn(int(s.get("turn", 0))).cancelled
        else f"第 {s.get('turn')} 轮护栏未熔断（tool 调用数={o.turn(int(s.get('turn', 0))).total_calls}）"
    ),
    "breaker_not_tripped": lambda o, s: (
        None
        if not o.turn(int(s.get("turn", 0))).cancelled
        else f"第 {s.get('turn')} 轮不该熔断却熔断了"
    ),
    "tool_calls_capped": lambda o, s: (
        None
        if o.turn(int(s.get("turn", 0))).total_calls == int(s.get("max", 50)) + 1
        else f"护栏计数应在第 {int(s.get('max', 50)) + 1} 次调用触发，实际 {o.turn(int(s.get('turn', 0))).total_calls}"
    ),
    "verify_followup_not_needed": _check_verify_settled,
    "bridge_calls": lambda o, s: (
        None
        if o.bridge.count(str(s.get("method"))) == int(s.get("equals"))
        else f"bridge.{s.get('method')} 调用 {o.bridge.count(str(s.get('method')))} 次，期望 {s.get('equals')}"
    ),
    "log_event": _check_log_event,
}


def run_checks(outcome: ReplayOutcome) -> list[str]:
    """逐条执行场景 expect.checks，返回未通过项（空列表=全通过）"""
    failures: list[str] = []
    for spec in outcome.scenario.checks:
        kind = str(spec.get("check", ""))
        fn = CHECKS.get(kind)
        if fn is None:
            raise ReplayError(f"未知检查项 {kind!r}（可用: {sorted(CHECKS)}）")
        reason = fn(outcome, spec)
        if reason:
            failures.append(f"[{outcome.scenario.scenario_id}] {kind}: {reason}")
    return failures


__all__ = [
    "SCENARIOS_DIR",
    "RecordingBridge",
    "ReplayError",
    "ReplayModel",
    "ReplayOutcome",
    "Scenario",
    "Turn",
    "TurnObs",
    "load_scenario",
    "replay",
    "run_checks",
]
