"""遥测加固（#78 复核 + #158-③ 收口）：span 必须落到 NoOp，而且**不许静默跳过**。

strands 自己不装 exporter，但 span 属性默认不脱敏（消息与工具入参出参都在里面）；
风险来自"进程里有一个会导出的 provider"。而打包 venv 里**确实装着**
`opentelemetry-exporter-otlp-proto-*` 与 `opentelemetry-instrumentation-threading`
（2026-09-26 实测 `.venv/Lib/site-packages` 里都在）⇒ "用户机器上恰好有"这个前提
不是假设，是随包分发的事实。所以守卫必须在构造任何 Agent 之前跑，且必须**有人验证它真的钉住了**。

上一版的问题：两处 `pytest.skip`（"provider 已被其他测试装走" / "未安装"）意味着
环境一变，这条判据就静默不跑 —— 判据自己 flaky 等于发了一张"可以忽略红灯"的许可证（#94 §6-B 那条）。
现在改成在**干净子进程**里跑，结果只有"钉住了 / 没钉住"两种，没有第三种"今天先跳过"。
"""
from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from strands_backend.telemetry_guard import disable_outbound_tracing

SIDECAR_ROOT = Path(__file__).resolve().parents[2]
MAIN_PY = SIDECAR_ROOT / "main.py"

# 子进程里跑：先钉，再开一个 span 看它记不记录，打印两行结果。
_FRESH_PROCESS_SCRIPT = textwrap.dedent(
    """
    from strands_backend.telemetry_guard import disable_outbound_tracing
    from opentelemetry import trace

    pinned = disable_outbound_tracing()
    span = trace.get_tracer("tdsf.sidecar").start_span("invoke_agent")
    print("PINNED=" + pinned)
    print("RECORDING=" + str(span.is_recording()))
    """
).strip()

# 子进程里跑：先被人装走一个真 provider，再叫守卫 —— 必须报告 already-set（不静默覆盖）。
_HIJACKED_PROCESS_SCRIPT = textwrap.dedent(
    """
    from strands_backend.telemetry_guard import disable_outbound_tracing
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider

    trace.set_tracer_provider(TracerProvider())
    print("PINNED=" + disable_outbound_tracing())
    """
).strip()


def _run_in_fresh_interpreter(script: str) -> dict[str, str]:
    """在干净解释器里跑一段脚本，返回 KEY=VALUE 读数（不继承本进程的 provider 状态）。"""
    proc = subprocess.run(
        [sys.executable, "-B", "-c", script],
        cwd=str(SIDECAR_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        env={**dict(__import__("os").environ), "PYTHONPATH": str(SIDECAR_ROOT)},
    )
    if proc.returncode != 0:
        raise AssertionError(
            f"子进程没跑起来（这是判据自身故障，不是产品结论）：\n{proc.stderr[-800:]}"
        )
    readings: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            readings[key.strip()] = value.strip()
    if "PINNED" not in readings:
        raise AssertionError(
            f"读不到 PINNED 字段 ⇒ 判据自身故障，别当成'没问题'：stdout={proc.stdout[-400:]}"
        )
    return readings


@pytest.fixture(autouse=True)
def _endpoint_present(monkeypatch: pytest.MonkeyPatch) -> None:
    """模拟"机器上有 OTLP 出口"这种最危险的前提（守卫在本进程内也要能跑）。"""
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")


def test_guard_pins_the_provider_in_a_clean_process() -> None:
    """干净进程里必须返回 noop 且 span 不记录 —— 没有"跳过"这一档。"""
    readings = _run_in_fresh_interpreter(_FRESH_PROCESS_SCRIPT)

    assert readings["PINNED"] == "noop", (
        f"守卫没钉住（{readings['PINNED']}）：终端内容可能进 span 并被导出"
    )
    assert readings.get("RECORDING") == "False", (
        f"span 仍在记录（{readings.get('RECORDING')}）：provider 不是 NoOp"
    )


def test_guard_reports_a_hijacked_provider_instead_of_hiding_it() -> None:
    """别人已经装了会导出的 provider ⇒ 守卫必须报 already-set（不静默覆盖，也不静默成功）。

    这条钉的是"报不报得出来"，不是"能不能救回来"——救不回来是产品事实，
    但绝不能看起来像一切正常（#118/#142 那一族：把不能用的场景说成没问题 = 更糟）。
    """
    readings = _run_in_fresh_interpreter(_HIJACKED_PROCESS_SCRIPT)

    assert readings["PINNED"] == "already-set", (
        f"provider 已被外部装走时守卫没报出来（{readings['PINNED']}）"
    )


def _first_call_line(source: str, func_name: str) -> int | None:
    """取某函数在源码里**真实被调用**的最早行号（注释里的同名文字不算）。"""
    import ast

    tree = ast.parse(source)
    lines = [
        node.lineno
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and (
            (isinstance(node.func, ast.Name) and node.func.id == func_name)
            or (isinstance(node.func, ast.Attribute) and node.func.attr == func_name)
        )
    ]
    return min(lines) if lines else None


def test_guard_is_called_before_any_agent_is_built() -> None:
    """接线断言：`main.py` 里守卫必须排在构造 Agent 之前。

    顺序错了 = 第一个 Agent 的 span 已经进了别人的 provider，守卫再钉也追不回来。
    编译器与单测都看不见这种"谁先跑"的问题，只能读装配源码钉住。

    **必须用 AST 取调用行号**：第一版用 `src.index("configure_strands(")`，
    结果命中了上面几行**注释**里的同名文字，把好好的装配顺序判成反的 ——
    字符串找位置在注释密集的文件里必然出错账。
    """
    src = MAIN_PY.read_text(encoding="utf-8")
    guard_line = _first_call_line(src, "disable_outbound_tracing")
    agent_line = _first_call_line(src, "configure_strands")

    assert guard_line is not None, "main.py 里根本没调用守卫"
    assert agent_line is not None, "main.py 里没有 configure_strands 调用（装配路径变了，本判据要重写）"
    assert guard_line < agent_line, (
        f"守卫在第 {guard_line} 行、构造 Agent 在第 {agent_line} 行 ⇒ "
        "第一个回合的消息可能已经进别人的 span 并被导出"
    )


def test_the_ordering_check_itself_detects_a_reversed_assembly() -> None:
    """改判据必须能演示旧缺陷仍在（这里演示"守卫排在构造之后"那种装配）。

    没有这条，`_first_call_line` 一旦退化成"取最后一次调用"或"命中注释"，
    上一条判据会静默变成永真。
    """
    reversed_src = (
        "def setup():\n"
        "    # 注释里提一句 disable_outbound_tracing 不该被算成调用\n"
        "    adapter = runtime.configure_strands(model=None)\n"
        "    disable_outbound_tracing()\n"
        "    return adapter\n"
    )
    assert _first_call_line(reversed_src, "configure_strands") == 3
    assert _first_call_line(reversed_src, "disable_outbound_tracing") == 4
    assert _first_call_line(reversed_src, "disable_outbound_tracing") > _first_call_line(
        reversed_src, "configure_strands"
    ), "判据没能在「先建 Agent 后钉守卫」的装配上报红 ⇒ 它是永真的"


def test_guard_is_idempotent_in_this_process() -> None:
    """重复调用不许把自己标成异常状态（第二次仍应是 noop）。"""
    first = disable_outbound_tracing()
    if first == "unavailable":
        # 唯一还允许的跳过：本解释器没装 opentelemetry ⇒ 根本没有导出路径。
        # 打包 venv 装了（见模块 docstring），所以真机上这条不跳。
        pytest.skip("本解释器未安装 opentelemetry，无导出路径可钉")
    if first == "already-set":
        pytest.fail(
            "本进程里 provider 已被别的测试装走 ⇒ 守卫救不回来。"
            "这是测试互相污染，不是产品结论：请找出是谁 set_tracer_provider 了并隔离它。"
        )
    assert disable_outbound_tracing() == "noop", "重复调用不应把自己标成异常状态"
