"""#149：`indeterminate`（结果没取回）不许被熔断计成一次「失败」，也不许被写成「failed」。

现场（2026-09-25 取证轮，`outputs/sample_143_long_silence.py`）：故意发一条
`sleep 330 && echo done`，工具静默 303.6s 后返回 `indeterminate`
（reason=`visible_terminal_timeout`），会话日志里落的是
`loop_progress ssh_command -> failed duration_ms=303601.73`。

为什么这是缺陷而不是设计：#113② 立 `indeterminate` 的理由就是
**"以退出码 -1 结束"是假事实** —— 命令可能跑得好好的，只是结果没取回来。
可 `ToolCallLimitHook._after_tool_call` 的判据是 `status != "success"`，
于是"不知道"在熔断那一层又变回"失败"：**连三次取不回就停掉整轮所有工具调用**
（`_trip_breaker` 置 cancelled ⇒ 后续每次调用一律 cancel_tool）。
而取不回的入口都很日常：页面重载（#119）、远端无 shell 集成改道（#113③）、
IPC 异常、合法慢命令 —— 与用户报过的"三条普通诊断命令就叫停整个会话"同形。

用户 2026-09-25 拍板：**不计入 + 文案说真话**。

三条不变量（缺一条都算没修）：
  ① `indeterminate` **不 +1**（不是失败）；
  ② `indeterminate` **也不清零**（它不是成功，不该把已有的真实失败 streak 抹掉）；
  ③ 流水/进度里要落 `indeterminate` 这个真状态，**不许写成 `failed`**。
正向配对必须同时成立：**真实失败三条照样熔断** —— 别把安全底线弄哑。
"""

from __future__ import annotations

import json
from types import SimpleNamespace

from strands_backend.adapter import ToolCallLimitHook

TOOL = "ssh_command"


def _event(inner_status: str, *, reason: str = "visible_terminal_timeout"):
    """造一个 AfterToolCallEvent 的最小可用形状。

    strands 会把工具自报的 dict 序列化进内容块，所以外层 status 是 success、
    真状态藏在块文本里 —— 这正是 `_result_status` 要先看外层再看内层的原因。
    """
    payload = {"status": inner_status, "command": "sleep 330 && echo done"}
    if inner_status == "indeterminate":
        payload["reason"] = reason
    result = {"status": "success", "content": [{"text": json.dumps(payload)}]}
    return SimpleNamespace(tool_use={"name": TOOL, "input": {"command": payload["command"]}},
                           result=result, exception=None, cancel_tool=None)


def _run(hook: ToolCallLimitHook, *inner_statuses: str) -> None:
    for st in inner_statuses:
        hook._before_tool_call(_event(st))
        hook._after_tool_call(_event(st))


def test_indeterminate_不计入连续失败_也不熔断():
    hook = ToolCallLimitHook()
    _run(hook, "indeterminate", "indeterminate", "indeterminate")
    assert hook.failures_by_tool.get(TOOL, 0) == 0, (
        f"indeterminate 被计成了失败：{hook.failures_by_tool}"
    )
    assert hook.cancelled is False, "三条取不回就把整轮工具停了 —— 这正是 #149 的病"


def test_indeterminate_不清零已有的真实失败计数():
    """它不是成功，所以不该把 error streak 抹掉 —— 否则 error/未知/error 永远熔不断。"""
    hook = ToolCallLimitHook()
    _run(hook, "error", "indeterminate", "error")
    assert hook.failures_by_tool.get(TOOL) == 2, (
        f"失败计数被 indeterminate 当成成功了：{hook.failures_by_tool}"
    )
    assert hook.cancelled is False


def test_indeterminate_在流水里落真状态_不写成_failed():
    hook = ToolCallLimitHook()
    seen: list[tuple[str, str]] = []
    hook._report_progress = lambda name, status, duration_ms=None: seen.append((name, status))
    _run(hook, "indeterminate")
    assert seen and seen[-1][1] == "indeterminate", (
        f"loop_progress 落的是 {seen}，把「取不回」说成了「失败」"
    )
    entry = hook.tool_log[-1]
    assert entry["status"] == "indeterminate"
    # success 必须是 False：没取回结果不等于成功，不许为了好看翻成 True
    assert entry["success"] is False


def test_正向配对_真实失败三条照样熔断():
    """安全底线不能被弄哑：这条红了说明我把整个熔断改死了。

    语义是"下一次重试前"熔断（`_before_tool_call` 先看计数再干活），
    所以三条 error 之后要有第四次调用才 trip —— 这是既有行为，别改。
    """
    hook = ToolCallLimitHook()
    _run(hook, "error", "error", "error", "error")
    assert hook.failures_by_tool.get(TOOL) == 4
    assert hook.cancelled is True


def test_正向配对_成功调用仍然清零计数():
    hook = ToolCallLimitHook()
    _run(hook, "error", "error", "success")
    assert hook.failures_by_tool.get(TOOL) == 0
    assert hook.cancelled is False
