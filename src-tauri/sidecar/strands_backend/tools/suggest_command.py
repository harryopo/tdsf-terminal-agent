"""
strands_backend/tools/suggest_command.py — 命令建议工具
==========================================================

职责：
- 根据用户意图，按 ``target_os`` 生成该终端**真正能跑**的命令（linux / windows 两套）。
- 返回结构化结果 {command, explanation}，前端 ``tool.tsx`` 据此渲染
  ``SuggestCommandCard``（含 Insert 按钮，一键写入活动终端）。
- 推送 ``tool_call`` 事件到 event_bus，让工具调用过程实时展示。

设计：
- ``invoke_suggest_command_tool(params, ctx)``：核心实现，无 Strands 依赖。
- ``make_suggest_command_tool(ctx)``：工厂函数，返回带 ctx 闭包的 @tool 函数。
- 命令生成采用"规则映射 + 关键词匹配"，避免在 Strands 工具内部再次调用 LLM。
"""
from __future__ import annotations

import logging
import re
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.suggest_command")


# ============================================================================
# 规则映射表：常见运维意图 -> 每个目标系统各自的命令 + 解释
# ============================================================================
#
# ROADMAP #60：这张表**曾经只有一列 Linux 命令**，而 ``target_os`` 只是被原样回显、
# 从不参与匹配。结果是本地 Windows 终端里也会拿到 ``uptime`` / ``free -h`` /
# ``journalctl``，PowerShell 直接报"不是可识别的 cmdlet"，auto 模式下还会被自动
# 追加回车执行。现在每条规则按系统给变体；**没有等价概念的系统就不给 key**
# （例如 SELinux 在 Windows 上不存在 → Windows 侧走 unmatched，绝不伪造命令）。
#
# Windows 变体的取舍：优先用 CIM / 内置 cmdlet，避免依赖**本地化的性能计数器路径**
# （``\Processor(_Total)\% Processor Time`` 在中文 Windows 上取不到），也避免
# ``systeminfo`` 这类输出标签随系统语言变化的命令。

_SUGGESTION_RULES: list[tuple[list[str], dict[str, tuple[str, str]]]] = [
    # 系统负载
    (
        ["负载", "load", "系统负载", "cpu", "平均负载"],
        {
            "linux": (
                "uptime",
                "显示系统运行时间、当前用户数和 1/5/15 分钟平均负载（load average）。",
            ),
            "windows": (
                "Get-CimInstance Win32_Processor | Select-Object DeviceID,LoadPercentage",
                "读取每个逻辑 CPU 的当前负载百分比（Windows 没有 load average 概念，"
                "这里给的是瞬时 CPU 负载）。",
            ),
        },
    ),
    (
        ["cpu 使用", "cpu usage", "cpu 排行"],
        {
            "linux": (
                "top -bn1 | head -20",
                "一次性输出 CPU/内存占用最高的进程快照（非交互式）。",
            ),
            "windows": (
                "Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Name,Id,CPU",
                "按累计 CPU 时间降序列出前 20 个进程（Name/Id/CPU）。",
            ),
        },
    ),
    # 内存
    (
        ["内存", "memory", "mem", "ram", "swap"],
        {
            "linux": (
                "free -h",
                "以人类可读格式显示总内存、已用、可用和 swap 使用情况。",
            ),
            "windows": (
                "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory",
                "总内存与空闲物理内存，**单位是 KB**（除以 1MB 即 GB）。",
            ),
        },
    ),
    # 磁盘
    (
        ["磁盘", "disk", "df", "磁盘空间", "存储空间", "磁盘容量"],
        {
            "linux": (
                "df -h",
                "以人类可读格式显示所有挂载点的磁盘使用情况。",
            ),
            "windows": (
                "Get-PSDrive -PSProvider FileSystem",
                "列出每个文件系统驱动器已用（Used）与空闲（Free）字节数。",
            ),
        },
    ),
    (
        ["目录大小", "文件夹大小", "du"],
        {
            "linux": (
                "du -sh * | sort -h",
                "列出当前目录下所有文件/目录的大小，并按从小到大排序。",
            ),
            "windows": (
                "Get-ChildItem | Sort-Object Length -Descending | Select-Object -First 20 Name,Length",
                "当前目录条目按大小降序前 20 项。注意 PowerShell 没有 ``du`` 等价命令，"
                "目录项的 Length 为空，递归统计需另写脚本。",
            ),
        },
    ),
    # 进程
    (
        ["进程", "process", "ps"],
        {
            "linux": (
                "ps aux --sort=-%cpu | head -20",
                "按 CPU 占用降序列出前 20 个进程。",
            ),
            "windows": (
                "Get-Process | Sort-Object CPU -Descending | Select-Object -First 20",
                "按 CPU 时间降序列出前 20 个进程（含 Handles/Memory/Name）。",
            ),
        },
    ),
    (
        ["端口", "port", "监听", "listen"],
        {
            "linux": (
                "ss -tuln",
                "显示所有 TCP/UDP 监听端口（不解析服务名，速度快）。",
            ),
            "windows": (
                "netstat -ano | Select-String LISTENING",
                "列出处于 LISTENING 的 TCP 端口及对应 PID（-a 全部 / -n 不解析名字 / -o 带 PID）。",
            ),
        },
    ),
    # 日志
    (
        ["日志", "log", "journalctl", "systemd 日志"],
        {
            "linux": (
                "journalctl -xe --no-pager -n 50",
                "显示最近 50 条 systemd 日志（含错误级别和解释）。",
            ),
            "windows": (
                "Get-WinEvent -LogName System -MaxEvents 50",
                "读取 Windows 系统事件日志最近 50 条（TimeCreated / LevelDisplayName / Message）。",
            ),
        },
    ),
    # 服务
    (
        ["nginx 状态", "nginx status", "nginx"],
        {
            "linux": (
                "systemctl status nginx --no-pager",
                "查看 nginx 服务运行状态、最近日志和进程信息。",
            ),
            "windows": (
                "Get-Service -Name nginx | Format-List Name,DisplayName,Status",
                "查看 nginx Windows 服务的启动类型与当前状态。",
            ),
        },
    ),
    (
        ["服务状态", "失败服务", "异常服务", "systemctl status"],
        {
            "linux": (
                "systemctl --failed --no-pager",
                "列出当前处于 failed 状态的服务单元。",
            ),
            "windows": (
                "Get-Service | Where-Object {$_.Status -eq 'Error'} | Select-Object Name,DisplayName",
                "列出处于 Error 状态的服务（Windows 服务没有 failed 单元概念，"
                "Stopped 属正常态，故只挑 Error）。",
            ),
        },
    ),
    # 网络
    (
        [
            "网络连通性",
            "外网连通",
            "公网连通",
            "network connectivity",
            "ping",
            "连通性",
        ],
        {
            "linux": (
                "ping -c 4 8.8.8.8",
                "向 Google DNS 发送 4 个 ICMP 包，测试外网连通性。",
            ),
            "windows": (
                "ping -n 4 8.8.8.8",
                "向 Google DNS 发送 4 个 ICMP 包。Windows 的次数参数是 ``-n``，不是 Linux 的 ``-c``。",
            ),
        },
    ),
    (
        ["路由", "route", "网关"],
        {
            "linux": (
                "ip route",
                "显示当前路由表和默认网关。",
            ),
            "windows": (
                "Get-NetRoute -AddressFamily IPv4 | Select-Object -First 20 InterfaceAlias,DestinationPrefix,NextHop",
                "显示 IPv4 路由表前 20 条（接口 / 目的前缀 / 下一跳网关）。",
            ),
        },
    ),
    # 文件/权限
    (
        ["文件权限", "permission", "chmod", "chown"],
        {
            "linux": (
                "ls -la",
                "列出当前目录文件及详细权限、所有者、组。",
            ),
            "windows": (
                "Get-Acl -Path . | Select-Object -ExpandProperty Access",
                "展开当前目录的 ACL，逐条显示访问者（IdentityReference）与权限（FileSystemRights）。"
                "Windows 用 ACL 而不是 rwx 位。",
            ),
        },
    ),
    (
        ["大文件", "大文件查找"],
        {
            "linux": (
                "find . -type f -size +100M -exec ls -lh {} \\;",
                "查找当前目录下大于 100MB 的文件并显示大小。",
            ),
            "windows": (
                "Get-ChildItem -Recurse -File | Where-Object Length -GT 100MB | Sort-Object Length -Descending | Select-Object -First 20 FullName,Length",
                "递归查找大于 100MB 的文件，按大小降序取前 20 条（``100MB`` 是 PowerShell 内置常量）。",
            ),
        },
    ),
    # SELinux —— 仅 Linux 概念，故**不提供 windows 变体**（Windows 侧必须 unmatched）
    (
        ["selinux", "getenforce", "sestatus"],
        {
            "linux": (
                "getenforce && sestatus",
                "查看 SELinux 当前模式（Enforcing/Permissive/Disabled）和全局状态。",
            ),
        },
    ),
]


def _match_suggestion(
    intent: str,
    target_os: str,
) -> tuple[str, str] | None:
    """根据意图关键词匹配最佳命令建议（按 target_os 取对应变体）

    ``target_os`` 只有 ``windows`` 会切到 PowerShell 表；其余值（含 ``linux``、
    未知系统）一律落回 Linux 表 —— 本产品以 Linux 教学为主场景。
    命中了意图但该系统集成变体不存在（如 Windows 上的 SELinux）时**返回 None**，
    交给上层走 unmatched，绝不伪造一条命令。
    """
    text = " ".join(intent.lower().split())
    variant_key = "windows" if target_os == "windows" else "linux"
    best: tuple[int, int, str, str] | None = None

    def match_score(keyword: str) -> int:
        keyword = keyword.lower().strip()
        if not keyword:
            return 0
        if keyword.isascii():
            # ASCII keywords are matched as shell-like words so “topology”
            # cannot accidentally select the “top” rule.
            found = re.search(
                rf"(?<![a-z0-9_]){re.escape(keyword)}(?![a-z0-9_])", text,
            )
        else:
            found = re.search(re.escape(keyword), text)
        if not found:
            return 0
        # Prefer an explicit phrase over a short generic keyword. The rule
        # index remains the deterministic tie-breaker for equally specific
        # matches.
        return 20 + len(keyword) * 2

    for index, (keywords, variants) in enumerate(_SUGGESTION_RULES):
        if variant_key not in variants:
            continue
        score = sum(match_score(keyword) for keyword in keywords)
        if score <= 0:
            continue
        command, explanation = variants[variant_key]
        candidate = (score, -index, command, explanation)
        if best is None or candidate[:2] > best[:2]:
            best = candidate
    return (best[2], best[3]) if best else None


# ============================================================================
# 预测回显（TDSF 2026-08-09；#60 起补 PowerShell cmdlet）
# ============================================================================

# 首词 -> 预测回显摘要。命令建议卡片会展示它，让用户在执行前知道将看到什么。
_PREDICTIONS: dict[str, str] = {
    "ls": "列出当前目录下的文件和子目录",
    "ll": "以长格式列出当前目录内容（权限/所有者/大小/时间）",
    "uptime": "系统运行时间 + 1/5/15 分钟平均负载",
    "top": "CPU/内存占用排行（实时刷新，q 退出）",
    "free": "内存使用概况：total/used/free/shared/buff/cache/available",
    "df": "各挂载点磁盘使用量：Size/Used/Avail/Use%",
    "du": "指定目录的磁盘占用，按大小排序",
    "ps": "进程快照（PID/TTY/TIME/CMD）",
    "netstat": "网络连接/监听端口/路由表",
    "ss": "socket 统计（替代 netstat，更快速）",
    "systemctl": "服务状态（active/inactive/failed）",
    "journalctl": "系统日志（按时间/优先级过滤）",
    "cat": "输出文件完整内容",
    "head": "输出文件前 N 行（默认 10）",
    "tail": "输出文件末尾 N 行（默认 10，-f 实时跟踪）",
    "grep": "匹配到的文本行（高亮关键词）",
    "find": "匹配到的文件路径列表",
    "who": "当前登录用户列表",
    "w": "登录用户 + 其正在执行的命令",
    "id": "当前用户 UID/GID/组信息",
    "date": "当前系统日期和时间",
    "pwd": "当前工作目录的绝对路径",
    "uname": "内核/操作系统信息（-a 全部）",
    "hostname": "当前主机名",
    "ifconfig": "网络接口配置（IP/MAC/MTU/状态）",
    "ip": "网络接口/地址/路由信息",
    "ping": "ICMP 回显应答（时间/TTL，Ctrl+C 停止）",
    "curl": "HTTP 响应（状态码/头部/正文）",
    "wget": "下载进度条 + 保存路径",
    "chmod": "（无输出表示成功，可通过 ls -l 验证权限变更）",
    "chown": "（无输出表示成功，可通过 ls -l 验证所有者变更）",
    "mkdir": "（无输出表示成功，可通过 ls 验证目录已创建）",
    "touch": "（无输出表示成功，可通过 ls 验证文件已创建/时间已更新）",
    "rm": "（无输出表示成功，文件/目录已删除）",
    "cp": "（无输出表示成功，文件已复制）",
    "mv": "（无输出表示成功，文件已移动/重命名）",
    "echo": "回显参数内容到标准输出",
    # --- Windows / PowerShell（#60）：首词是 "动词-名词" cmdlet ---
    "Get-CimInstance": "WMI/CIM 对象的属性表（内存、CPU 负载、上次启动时间等）",
    "Get-Process": "进程列表（Handles / CPU 秒 / PM 内存 / Name）",
    "Get-PSDrive": "各驱动器的 Used / Free 字节数",
    "Get-ChildItem": "当前目录条目（Mode / LastWriteTime / Name）",
    "Get-Service": "服务列表（Status / Name / DisplayName）",
    "Get-WinEvent": "事件日志条目（TimeCreated / LevelDisplayName / Message）",
    "Get-NetRoute": "路由表条目（接口别名 / 目的前缀 / 下一跳）",
    "Get-Acl": "对象的安全描述符（Owner / Access 明细）",
    "Select-String": "匹配到的文本行（等价 grep）",
    "sort": "按指定字段排序后的列表",
}


def _predict_output(command: str) -> str:
    """根据命令前缀启发式生成预测回显摘要（1-3 行）。

    让用户在执行前就能预期看到什么，增强可信度。
    粗粒度匹配——不追求精确，只给方向性提示。
    """
    cmd = command.strip()
    first_word = cmd.split()[0] if cmd.split() else ""

    prediction = _PREDICTIONS.get(first_word)
    if prediction:
        return prediction

    # 带管道的命令——基于第一个命令推断
    if "|" in cmd:
        pipe_first = cmd.split("|")[0].strip().split()[0]
        prediction = _PREDICTIONS.get(pipe_first)
        if prediction:
            return f"{prediction}（经管道过滤后输出）"

    return f"执行 {first_word} 命令（观察终端输出以确认结果）"


# ============================================================================
# 核心实现
# ============================================================================

def invoke_suggest_command_tool(
    params: dict[str, Any],
    ctx: ToolContext,
) -> dict[str, Any]:
    """命令建议工具核心实现

    Args:
        params: 工具参数 dict，支持字段：
            - intent (str, 必填): 用户想做的事情/目标
            - target_os (str, 可选): 目标系统，默认 "linux"
        ctx: ToolContext 运行时上下文

    Returns:
        结构化 dict：{status, command, explanation}
    """
    intent = (params.get("intent") or params.get("description") or "").strip()
    if not intent:
        raise ValueError("suggest_command 工具必填参数缺失: intent")

    target_os = (params.get("target_os") or "linux").lower()

    matched = _match_suggestion(intent, target_os)
    if matched:
        command, explanation = matched
        result: dict[str, Any] = {
            "status": "success",
            "command": command,
            "explanation": explanation,
            "predicted_output": _predict_output(command),
            "target_os": target_os,
            "intent": intent,
        }
    else:
        # An unmatched intent is not an executable command. Returning an echo
        # fallback previously painted this state green and encouraged the UI
        # to treat a clarification prompt as a real shell command.
        #
        # 注意 target_os 要写进文案：Windows 侧"没匹配到"有两种原因（意图太泛 /
        # 该检查项在这个系统上根本不存在，如 SELinux），含糊成一句会让人以为传参错了。
        result = {
            "status": "unmatched",
            "command": None,
            "explanation": (
                f"在 {target_os} 下未匹配到内置命令规则（该系统可能根本没有对应概念，"
                "例如 Windows 无 SELinux）。请补充对象或目标，例如“查看 nginx 状态”或“检查磁盘空间”。"
            ),
            "target_os": target_os,
            "intent": intent,
            "suggestions": (
                ["cpu/内存", "磁盘空间", "端口监听", "服务状态", "网络连通性"]
                if target_os == "windows"
                else ["cpu/内存", "磁盘空间", "端口监听", "服务状态", "网络连通性", "selinux"]
            ),
        }

    # 推送 tool_call 完成事件（started 在 make_suggest_command_tool 中已推，
    # 这里为了核心实现可被单独调用，再补一次 completed）
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="suggest_command",
                params={"intent": intent, "target_os": target_os},
                result=result,
                status="completed",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.suggest_command",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call completed failed: {e}")

    return result


# ============================================================================
# Strands @tool 工厂
# ============================================================================

def make_suggest_command_tool(ctx: ToolContext):
    """构建命令建议工具（带 ctx 闭包）"""

    @tool
    def suggest_command(
        intent: str,
        target_os: str = "linux",
    ) -> dict:
        """根据用户意图生成一条可执行的命令，并解释每个字段含义。

        使用场景：
        - 用户说"帮我构造一条命令查看系统负载"
        - 用户说"查看磁盘空间的命令是什么"
        - 用户说"如何查看 nginx 状态"

        返回结果会被前端渲染成命令卡片，附带"Insert"按钮，用户可一键
        将命令写入当前活动终端。

        Args:
            intent (str): 用户想做的事情，如"查看系统负载"、"查看端口占用"。
            target_os (str): **必须与用户当前终端实际所在的系统一致**。
                本地 Windows 终端（PowerShell / cmd）传 "windows"，返回
                PowerShell 命令；Linux 或经 SSH 连上的主机传 "linux"（默认）。
                传错会给出在该终端根本跑不了的命令（如给 PowerShell 发 uptime）。

        Returns:
            dict: 结构化结果，含 status / command / explanation / target_os。
        """
        # 推送 tool_call 开始事件，让前端实时显示工具调用卡片
        if ctx.event_bus is not None:
            try:
                ctx.event_bus.emit_tool_call(
                    tool_name="suggest_command",
                    params={"intent": intent, "target_os": target_os},
                    status="started",
                    session_id=ctx.session_id or None,
                    source=f"{ctx.agent_name}_agent.strands_tool.suggest_command",
                )
            except Exception as e:
                logger.debug(f"emit_tool_call started failed: {e}")

        return invoke_suggest_command_tool(
            params={"intent": intent, "target_os": target_os},
            ctx=ctx,
        )

    suggest_command.__name__ = "suggest_command"
    return suggest_command


__all__ = [
    "invoke_suggest_command_tool",
    "make_suggest_command_tool",
]
