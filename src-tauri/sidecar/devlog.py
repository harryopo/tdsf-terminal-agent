"""devlog.py — sidecar 日志离线分析器

从 ``<项目根>/.tdsf-data/sidecar.log`` 读取 sidecar（Python AI 引擎）日志，
按项目历史踩坑沉淀的规则自动诊断常见问题：

- 进程崩溃 / 被杀（faulthandler / early eof / Crashed）
- 编码错误（GBK/UTF-8 线协议不匹配，surrogate）
- sidecar 重启循环（ready → crash → restart）
- LLM 未配置 / mock 降级
- invoke 失败 / Strands 后端错误
- 超时
- 工具事件异常（emit 失败 / 孤儿 completed）

设计：纯函数 + 无外部依赖，CLI 包装在 ``scripts/dev-log.py``，
规则可直接被 pytest 用样例日志验证（见 tests/test_devlog.py）。
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

# ============================================================================
# 数据结构
# ============================================================================

SEVERITY_ORDER = {"P0": 0, "P1": 1, "P2": 2, "INFO": 3}


@dataclass
class LogEntry:
    """一条已解析的 sidecar 日志行"""

    raw: str
    ts: str  # "2026-07-31 23:53:17"（无则 "")
    level: str  # INFO/DEBUG/WARNING/ERROR/CRITICAL（无则 "")
    logger: str  # 如 sidecar.main
    message: str


@dataclass
class Finding:
    """一条诊断结论"""

    severity: str  # P0 / P1 / P2 / INFO
    rule: str
    count: int
    examples: list[str] = field(default_factory=list)
    advice: str = ""


# ============================================================================
# 行解析
# ============================================================================

_LINE_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) "
    r"(?P<level>DEBUG|INFO|WARNING|ERROR|CRITICAL) "
    r"(?P<logger>[\w.]+): (?P<message>.*)$"
)

# tauri_plugin_log 行格式: [2026-07-31][16:08:25][module][INFO] [target] message
_RUST_LINE_RE = re.compile(
    r"^\[(?P<date>\d{4}-\d{2}-\d{2})\]\[(?P<time>\d{2}:\d{2}:\d{2})\]"
    r"\[(?P<logger>[^\]]+)\]\[(?P<level>DEBUG|INFO|WARNING|ERROR|TRACE)\] "
    r"(?:\[[^\]]*\] )?(?P<message>.*)$"
)

# 时区实测（2026-08-01）：sidecar.log = 本地时间（logging asctime 默认）；
# rust.log（tauri_plugin_log Folder target）= UTC（与 Stdout 终端本地时间不同）。
# 仅 rust.log 需归一化到本地，sidecar.log 保持原样，两者才能对齐对照。
_LOCAL_TZ = datetime.now().astimezone().tzinfo


def _utc_to_local(ts: str) -> str:
    """把 'YYYY-MM-DD HH:MM:SS'（UTC）转本地时区同格式"""
    try:
        dt = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        return dt.astimezone(_LOCAL_TZ).strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return ts


def parse_line(line: str) -> LogEntry | None:
    """解析一条日志行（sidecar 或 Rust 格式），格式不符返回 None"""
    m = _LINE_RE.match(line.rstrip("\n"))
    if m:
        return LogEntry(
            raw=line.rstrip("\n"),
            # sidecar.log 是本地时间（logging asctime 默认），保持原样
            ts=m.group("ts"),
            level=m.group("level"),
            logger=m.group("logger"),
            message=m.group("message"),
        )
    m = _RUST_LINE_RE.match(line.rstrip("\n"))
    if m:
        return LogEntry(
            raw=line.rstrip("\n"),
            # rust.log 实测 UTC（与 Stdout 终端本地时间不同），归一化对齐
            ts=_utc_to_local(f"{m.group('date')} {m.group('time')}"),
            level=m.group("level"),
            logger=m.group("logger"),
            message=m.group("message"),
        )
    return None


# ============================================================================
# 规则
# ============================================================================

# 每条规则: (规则名, 严重级别, 正则, 建议)
_RULES: list[tuple[str, str, re.Pattern[str], str]] = [
    (
        "crash_terminate",
        "P0",
        re.compile(r"TerminateProcess|Crashed|sidecar.*(?:dead|died|killed)"),
        "sidecar 进程被终止/崩溃。若死亡点随机且无 faulthandler dump，"
        "多为 stdio 编码或 Rust reader 误判 EOF，检查是否满足 UTF-8 三通道契约。",
    ),
    (
        "crash_early_eof",
        "P0",
        re.compile(r"early eof|EOF|BrokenPipe|OSError\(22\)"),
        "stdio 管道提前关闭/写入失败，通常是编码不匹配或父进程异常退出。",
    ),
    (
        "encoding",
        "P0",
        re.compile(r"UnicodeEncodeError|surrogate|InvalidData|gbk|utf-?8"),
        "编码问题：Windows 中文系统默认 gbk，与 Rust UTF-8 线协议不匹配。"
        "检查 main.py 是否对 stdin/stdout/stderr 三通道 reconfigure(utf-8)。",
    ),
    (
        "restart_loop",
        "P1",
        re.compile(
            r"restart_loop|starting Python Sidecar|MAX_RETRY|"
            r"sidecar.*restart|restart.*sidecar"
        ),
        "sidecar 重启循环。检查是否触发了指数退避上限（MAX_RETRY=5），"
        "以及崩溃原因（见同区间 crash_* 规则）。",
    ),
    (
        "llm_not_configured",
        "P1",
        re.compile(r"LLM not configured|no API Key|mock_llm_active|MockLLM"),
        "LLM 未配置（无 API Key）。到 设置 → AI 模型 配置，"
        "或设 TDSF_LLM_API_KEY 环境变量 / 写 .tdsf-data/llm_config.json。",
    ),
    (
        "invoke_error",
        "P1",
        re.compile(
            r"StrandsAgentAdapter\.invoke error|Agent 执行出错|Sidecar Agent 调用失败|invoke failed"
        ),
        "agent.invoke 失败。看紧随其后的 traceback 定位具体异常；"
        "常见：LLM 配置、Strands 序列化、工具内部错误。",
    ),
    (
        "strands_error",
        "P1",
        re.compile(r"strands internal|StrandsAgentAdapter.invoke error"),
        "Strands 后端执行错误。检查 traceback：模型 API 错误、工具执行异常、"
        "消息配对（toolUse/toolResult）问题。",
    ),
    (
        "timeout",
        "P2",
        re.compile(r"超时|timed out|Timeout"),
        "调用超时。长任务/复杂 agentic loop 需确认前端 SIDECAR_TIMEOUT_MS 是否够"
        "（当前 60s），或 LLM 响应过慢。",
    ),
    (
        "tool_event_failed",
        "P2",
        re.compile(r"emit_tool_call failed|tool_call completed without matching"),
        "工具事件推送失败或孤儿事件。工具行显示异常（如 Input {}）时可查此项。",
    ),
    (
        "sidecar_not_running",
        "P1",
        re.compile(r"sidecar not running|not_running"),
        "前端报 sidecar 未运行。查本报告 crash_*/restart_loop/encoding 规则定位根因。",
    ),
    # === Rust 侧规则（tauri_plugin_log 落盘 .tdsf-data/rust.log）===
    (
        "ssh_connect_loop",
        "P2",
        re.compile(r"connect success|starting Python Sidecar"),
        "SSH 连接/应用重启次数过多。若 connect success 密集出现且间隔短，"
        "检查是否有多次连接源（自动连接/手动/组件重挂载）或应用重启循环。",
    ),
    (
        "ssh_auth_failure",
        "P1",
        re.compile(r"authentication failed|auth.*fail|Permission denied"),
        "SSH 认证失败。检查凭据（keyring 密码/密钥路径）或服务器端策略。",
    ),
    (
        "ssh_early_eof",
        "P0",
        re.compile(r"early eof|channel.*closed|connection_closed"),
        "SSH 连接被服务器提前关闭（畸形 pty 请求 / 并发限制 / 服务器策略）。"
        "历史上 terminal_modes 畸形会导致 OpenSSH 硬关 TCP。",
    ),
]


def analyze_lines(lines: list[str]) -> list[Finding]:
    """对日志行集合跑全部规则，返回按严重级别排序的结论列表"""
    entries: list[LogEntry] = []
    for line in lines:
        e = parse_line(line)
        if e:
            entries.append(e)
    return analyze_entries(entries)


def analyze_entries(entries: list[LogEntry]) -> list[Finding]:
    """对已解析条目跑全部规则（sidecar + Rust 合并时间线）"""
    findings: list[Finding] = []
    for rule, severity, pattern, advice in _RULES:
        hits = [e for e in entries if pattern.search(e.message)]
        if not hits:
            continue
        findings.append(
            Finding(
                severity=severity,
                rule=rule,
                count=len(hits),
                examples=[h.raw[:200] for h in hits[:3]],
                advice=advice,
            )
        )

    # 附加统计信息（非规则，但便于快速了解运行情况）
    info = _session_stats(entries)
    if info:
        findings.append(Finding(severity="INFO", rule="session_stats", count=0, examples=info))
    findings.sort(key=lambda f: SEVERITY_ORDER.get(f.severity, 9))
    return findings


def _session_stats(entries: list[LogEntry]) -> list[str]:
    """提取会话统计：启动次数 / 就绪 / mood / 工具事件"""
    lines = [e.message for e in entries]
    starts = sum(1 for m in lines if "ready notification sent" in m)
    invokes = sum(1 for m in lines if "StrandsAgentAdapter.invoke" in m)
    tools = sum(1 for m in lines if "tool_call" in m)
    if starts == 0 and invokes == 0:
        return []
    out = [f"sidecar 就绪次数: {starts}", f"invoke 次数: {invokes}", f"tool_call 事件数: {tools}"]
    if entries:
        out.append(f"日志时间范围: {entries[0].ts} ~ {entries[-1].ts}")
    return out


# ============================================================================
# 日志定位
# ============================================================================

def default_log_path() -> Path:
    """定位 <项目根>/.tdsf-data/sidecar.log"""
    # 本文件位于 <项目根>/src-tauri/sidecar/devlog.py
    return Path(__file__).resolve().parent.parent.parent / ".tdsf-data" / "sidecar.log"


def default_rust_log_path() -> Path:
    """定位 <项目根>/.tdsf-data/rust.log（tauri_plugin_log Folder target 落盘）"""
    return Path(__file__).resolve().parent.parent.parent / ".tdsf-data" / "rust.log"


def read_log(path: Path | None = None, tail: int | None = None) -> list[str]:
    """读取日志文件全部行（或尾部 tail 行）。文件不存在返回空列表"""
    p = path or default_log_path()
    if not p.exists():
        return []
    with open(p, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    if tail is not None and tail > 0:
        lines = lines[-tail:]
    return lines


def collect_entries(
    paths: list[Path], tail: int | None = None
) -> list[LogEntry]:
    """合并多个日志文件的解析条目（sidecar UTC 已归一化本地时区）"""
    entries: list[LogEntry] = []
    for p in paths:
        for line in read_log(p, tail=tail):
            e = parse_line(line)
            if e:
                entries.append(e)
    entries.sort(key=lambda e: e.ts)
    return entries


# ============================================================================
# 报告输出
# ============================================================================

def render_report(findings: list[Finding]) -> str:
    """把结论渲染为人类可读报告"""
    if not findings:
        return "（无日志或未发现已知问题）"
    out: list[str] = []
    for f in findings:
        if f.rule == "session_stats":
            out.append("--- 会话统计 ---")
            out.extend(f"  {e}" for e in f.examples)
            continue
        out.append(f"[{f.severity}] {f.rule} × {f.count}")
        for ex in f.examples:
            out.append(f"    {ex}")
        if f.advice:
            out.append(f"    建议: {f.advice}")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    """CLI 入口（scripts/dev-log.py 包装调用）"""
    import argparse

    parser = argparse.ArgumentParser(
        prog="dev-log",
        description="TDSF sidecar + Rust 日志诊断工具",
    )
    parser.add_argument("--log", help="只分析指定日志文件（默认合并 sidecar.log + rust.log）")
    parser.add_argument("--tail", type=int, default=2000, help="分析最近的 N 行（默认 2000）")
    parser.add_argument("--follow", action="store_true", help="tail -f 跟随新日志")
    parser.add_argument("--raw", action="store_true", help="直接输出原始日志（不做分析）")
    parser.add_argument("--all", action="store_true", help="--raw 时合并 sidecar + rust 并按时间排序")
    args = parser.parse_args(argv)

    paths: list[Path]
    if args.log:
        paths = [Path(args.log)]
    else:
        paths = [default_log_path(), default_rust_log_path()]
    existing = [p for p in paths if p.exists()]
    if not existing:
        print(
            f"日志文件不存在: {[str(p) for p in paths]}\n"
            "（sidecar 启动后自动生成 sidecar.log；Rust 日志 rust.log 需应用重启后生成）",
            file=sys.stderr,
        )
        return 1

    if args.follow:
        return _follow(existing[0])

    if args.raw:
        if args.all or len(existing) > 1:
            for e in collect_entries(existing, tail=args.tail):
                print(f"{e.ts} [{e.level}] {e.logger}: {e.message}")
        else:
            for line in read_log(existing[0], tail=args.tail):
                print(line, end="")
        return 0

    findings = analyze_entries(collect_entries(existing, tail=args.tail))
    print(render_report(findings))
    return 0


def _follow(path: Path) -> int:
    """tail -f：持续输出新日志行"""
    import time

    with open(path, encoding="utf-8", errors="replace") as f:
        f.seek(0, 2)  # 跳到末尾
        try:
            while True:
                line = f.readline()
                if line:
                    print(line, end="", flush=True)
                else:
                    time.sleep(0.2)
        except KeyboardInterrupt:
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
