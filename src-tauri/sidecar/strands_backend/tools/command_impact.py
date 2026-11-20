"""
strands_backend/tools/command_impact.py — 命令影响预测引擎（Task 4，方案书 v3.1 §4.6）
=====================================================================================

职责（审批卡四层卡面的第 4 层「影响预测」的数据来源）：
- ``split_compound(cmd)``：按 shell 控制符和换行拆分复合命令。
  字符串状态机实现（单/双引号 + 反斜杠转义内不拆），不做完整 shell AST。
- ``classify_segment(seg)``：单段命令 → {category, objects, risk_l}。
  类别 = 装包 / 改配置 / 操作服务 / 删除 / 网络外联 / 用户权限 / 文件写入 /
  只读查询 / 未知；对象提取第一个参数级 token（或路径/服务名列表）。
- ``analyze(cmd)``：全命令分析 → {segments, max_risk_l, summary, denied,
  dangerous_construct}（max 取各段最高）。
- denylist 硬底线常量：rm -rf（根/家目录）、mkfs、dd 写块设备、shutdown/
  reboot/halt/poweroff、fork 炸弹、chmod 777 /、git push --force —— 命中直接
  risk_l=4 + ``denied: True``（执行链直接 command_blocked，不走审批）。
- 危险构造检测：命令含 ``$(``、反引号、``eval``、重定向到系统文件、管道到
  shell —— 标记 ``dangerous_construct: True``（不直接拦截，但 risk_l 抬到
  至少 3，且永不自动放行，供 Task 5 白名单消费）。

设计要点：
1. 纯函数。除 `_credential_paths`（#159 起：凭据名单只允许有一份主人，它本身零依赖）
   之外不 import strands/tools 其他模块，便于单测与复用。
2. fail-closed：未知命令 risk_l=3（偏高值），卡面文案「影响未知——请人工审查」。
3. risk_l 映射（任务 spec）：删除=4、重启服务=3、装包/改配置/网络外联/用户
   权限/文件写入=2、只读=0、未知=3；**路径命中凭据名单 ⇒ 至少 3**（#159）。
"""
from __future__ import annotations

import re
import shlex

from ._credential_paths import first_credential_piece

# ============================================================================
# 类别常量与风险映射
# ============================================================================

# 类别（英文标识，供 Task 5 白名单/免审记忆匹配用）
CATEGORY_READONLY = "readonly"      # 只读查询
CATEGORY_INSTALL = "install"        # 装包
CATEGORY_CONFIG = "config"          # 改配置
CATEGORY_SERVICE = "service"        # 操作服务（restart/stop/start...）
CATEGORY_DELETE = "delete"          # 删除
CATEGORY_NETWORK = "network"        # 网络外联
CATEGORY_PERM = "perm"              # 用户权限
CATEGORY_FILE_WRITE = "file_write"  # 文件写入/移动
CATEGORY_UNKNOWN = "unknown"        # 未知
# #159：读凭据类文件不再是"只读查看"（名单与 python_run 共用 `_credential_paths` 那一份）
CATEGORY_CREDENTIAL = "credential"  # 读凭据类文件

# 类别 → 中文标签（审批卡类别徽标，学生友好表述）
CATEGORY_LABELS: dict[str, str] = {
    CATEGORY_READONLY: "只读查看",
    CATEGORY_INSTALL: "装包",
    CATEGORY_CONFIG: "改配置",
    CATEGORY_SERVICE: "操作服务",
    CATEGORY_DELETE: "删除",
    CATEGORY_NETWORK: "联网访问",
    CATEGORY_PERM: "改权限",
    CATEGORY_FILE_WRITE: "写文件",
    CATEGORY_CREDENTIAL: "读凭据类文件",
    CATEGORY_UNKNOWN: "未识别命令（保守待确认）",
}

# 类别 → 风险级（任务 spec 映射；未知给偏高值 fail-closed）
CATEGORY_RISK: dict[str, int] = {
    CATEGORY_READONLY: 0,
    CATEGORY_INSTALL: 2,
    CATEGORY_CONFIG: 2,
    CATEGORY_SERVICE: 3,
    CATEGORY_DELETE: 4,
    CATEGORY_NETWORK: 2,
    CATEGORY_PERM: 2,
    CATEGORY_FILE_WRITE: 2,
    CATEGORY_CREDENTIAL: 3,
    CATEGORY_UNKNOWN: 3,
}

# 未知类别卡面文案（fail-closed 提示语，前端也用同文案兜底）
UNKNOWN_IMPACT_TEXT = "暂无法判断影响，请人工确认"


# ============================================================================
# denylist 硬底线（命中 = denied，执行链直接拦截不审批）
# ============================================================================

# (规则名, 正则, 拒绝原因)
_DENYLIST: list[tuple[str, re.Pattern[str], str]] = [
    (
        "rm_rf_root",
        re.compile(r"\brm\s+(?:-{1,2}[^\s]+\s+)*(?:-{1,2}[^\s]*[rR][^\s]*\s+)+(?:--\s+)?/(\s|$|\*)"),
        "递归强制删除根目录，将造成不可恢复的数据损失",
    ),
    (
        "rm_rf_home",
        re.compile(r"\brm\s+(?:-{1,2}[^\s]+\s+)*(?:-{1,2}[^\s]*[rR][^\s]*\s+)+(?:--\s+)?(~|/root|/home)(\s|/|$)"),
        "递归强制删除家目录，将丢失用户全部数据",
    ),
    (
        "mkfs",
        re.compile(r"\bmkfs(?:\.[a-z0-9]+)?\b"),
        "格式化文件系统将摧毁全部数据",
    ),
    (
        "dd_to_device",
        re.compile(r"\bdd\b[^|;&]*\bof=/dev/"),
        "dd 直接写入块设备可能摧毁磁盘数据",
    ),
    # TDSF 修复 2026-09-18（深度体检 A2）：这两条以前用 `\bshutdown|reboot|halt\b`
    # 在**整串任意位置**匹配，于是 `journalctl -k | grep reboot`、
    # `grep -i shutdown /var/log/syslog`、`dmesg | grep halt` 这类最高频的只读日志
    # 检索被硬封死（不给审批、直接 command_blocked），而真正的破坏命令反而放行（见 A1）。
    # 现在只在**命令位**命中（允许可选的 sudo/env 前缀）；参数位上的这些词交给
    # RiskChecker 走审批。`analyze()` 的整条兜底匹配同样只命中命令位，无需另改。
    (
        "shutdown",
        re.compile(
            r"^\s*(?:sudo\s+(?:-\S+\s+)*|env\s+|nohup\s+)?"
            r"(?:shutdown\b|poweroff\b|halt\b|init\s+0\b)"
        ),
        "关机/停机命令将中断服务器运行",
    ),
    (
        "reboot",
        re.compile(
            r"^\s*(?:sudo\s+(?:-\S+\s+)*|env\s+|nohup\s+)"
            r"?(?:reboot\b|init\s+6\b)"
        ),
        "重启系统将中断服务器运行",
    ),
    (
        "git_push_force",
        re.compile(r"\bgit\s+push\s+(?:[^\s]+\s+)*-(?:f\b|f\s|-force\b|-force-with-lease\b)"),
        "强制推送将覆盖远端提交历史",
    ),
    (
        "fork_bomb",
        re.compile(r":\(\)\s*\{\s*:\|\s*:\&\s*\}\s*;"),
        "fork 炸弹将耗尽系统进程资源",
    ),
    (
        "chmod_777_root",
        re.compile(r"\bchmod\s+(?:-[^\s]+\s+)*777\s+/(?:\s|$)"),
        "对根目录递归 777 将破坏系统权限模型",
    ),
]


# ============================================================================
# 危险构造（不拦截，但永不自动放行；risk_l 抬到至少 3）
# ============================================================================

# 系统关键文件重定向目标（> /etc/...、> /boot/... 等）
_CRITICAL_REDIRECT_RE = re.compile(r">>?\s*/(?:etc|boot|usr|lib|lib64|bin|sbin)/")
# 管道直接进 shell 执行（curl ... | sh 之类）
_PIPE_TO_SHELL_RE = re.compile(r"\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b")
# 真正写文件的重定向：排除 fd 数字前缀（2> 1>）与 /dev/null 目标。
# （分类用——只对「命令产生的输出落盘」归 file_write L2）
_REDIRECT_WRITE_RE = re.compile(r"(?:^|[\s;|&])>>?\s*(?!/dev/null\b)\S")


def detect_dangerous_construct(cmd: str) -> bool:
    """Detect shell evaluation, ambiguous quoting, and sensitive redirects."""
    if not cmd:
        return False
    # Bash process substitution executes a command. ANSI-C quoting can change
    # which separators are quoted, so the lightweight splitter cannot clear it.
    if any(marker in cmd for marker in ("$(", "`", "<(", ">(", "$'")):
        return True
    if _CRITICAL_REDIRECT_RE.search(cmd):
        return True
    if _PIPE_TO_SHELL_RE.search(cmd):
        return True
    # eval 作为独立 token（避免误伤 "evaluation" 等词）
    if re.search(r"(?:^|[\s;|&])eval(?:\s|$)", cmd):
        return True
    return False


# ============================================================================
# 命令拆分（字符串状态机，引号内分隔符不拆）
# ============================================================================

def split_compound(cmd: str) -> list[str]:
    """按 ``;`` / ``&`` / ``&&`` / ``||`` / ``|`` 和换行拆分复合命令

    引号、反斜杠转义和重定向内的控制符不拆；不处理子 shell ``(...)``。
    返回去除首尾空白后的非空段列表。
    """
    segments: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(cmd)
    quote: str | None = None  # None / "'" / '"'
    while i < n:
        ch = cmd[i]
        if quote is not None:
            buf.append(ch)
            # 双引号内支持转义；单引号内无转义
            if quote == '"' and ch == "\\" and i + 1 < n:
                buf.append(cmd[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            # 反斜杠转义（含 \| \; 等被转义的分隔符）
            buf.append(ch)
            buf.append(cmd[i + 1])
            i += 2
            continue
        next_ch = cmd[i + 1 : i + 2]
        if (ch in "<>" and next_ch == "&") or (ch == "&" and next_ch == ">"):
            buf.extend((ch, next_ch))
            i += 2
            continue
        if ch in ";&\n":
            segments.append("".join(buf))
            buf = []
            i += 2 if ch == "&" and next_ch == "&" else 1
            continue
        if ch == "|":
            # || 与 | 都作为分隔（shell 管道不影响风险面拆分）
            segments.append("".join(buf))
            buf = []
            i += 2 if cmd[i + 1 : i + 2] == "|" else 1
            continue
        buf.append(ch)
        i += 1
    segments.append("".join(buf))
    return [s.strip() for s in segments if s.strip()]


# ============================================================================
# token 辅助
# ============================================================================

# sudo/env 等"透明前缀"（不改变命令语义类别）
_TRANSPARENT_PREFIXES = {"sudo", "env", "nohup", "nice", "time", "command", "exec"}

# env 前缀的 VAR=val 赋值形式
_ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=.*$")


def _strip_quotes(tok: str) -> str:
    """去掉成对的首尾引号（单/双）"""
    if len(tok) >= 2 and tok[0] == tok[-1] and tok[0] in ("'", '"'):
        return tok[1:-1]
    return tok


def _base_name(tok: str) -> str:
    """取命令 basename（/usr/bin/rm → rm）"""
    return re.split(r"[\\/]", tok)[-1]


def _normalize_tokens(toks: list[str]) -> list[str]:
    """剥掉 sudo/env 等透明前缀与 VAR=val 赋值 token，返回以命令名开头"""
    toks = list(toks)
    while toks:
        head = toks[0]
        if head.lower() in _TRANSPARENT_PREFIXES:
            toks = toks[1:]
            continue
        if _ENV_ASSIGN_RE.match(head):
            toks = toks[1:]
            continue
        break
    return toks


def _is_last_reboot_history_segment(seg: str) -> bool:
    """Recognize the readonly ``last reboot`` query without weakening denylist."""
    toks = _normalize_tokens([_strip_quotes(t) for t in seg.split()])
    return bool(toks and _base_name(toks[0]).lower() == "last" and "reboot" in toks[1:])


def is_last_reboot_history_query(command: str) -> bool:
    """Allow a compound query only when every reboot mention is ``last reboot``."""
    segments = split_compound(command)
    mentioned = [seg for seg in segments if re.search(r"\breboot\b", seg)]
    return bool(mentioned) and all(_is_last_reboot_history_segment(seg) for seg in mentioned)


def contains_non_history_power_mention(command: str) -> bool:
    """Keep all power-control mentions risky except the explicit history query."""
    power_word = re.compile(r"\b(?:reboot|shutdown|poweroff|halt)\b|\binit\s+[06]\b")
    return any(
        power_word.search(seg) and not is_last_reboot_history_query(seg)
        for seg in split_compound(command)
    )


def _arg_tokens(toks: list[str]) -> list[str]:
    """提取参数级 token（去掉命令名与选项；--opt=val 视为带值选项整体跳过）"""
    args: list[str] = []
    for t in toks[1:]:
        if t.startswith("-") and t != "-":
            continue
        args.append(t)
    return args


# ============================================================================
# 分类用命令名正则
# ============================================================================

_INSTALL_CMDS = {"yum", "dnf", "apt", "apt-get", "aptitude", "pip", "pip3",
                 "npm", "pnpm", "yarn", "gem", "cargo", "rpm", "dpkg"}
_INSTALL_ACTIONS = {"install", "remove", "erase", "uninstall", "search",
                    "update", "upgrade", "autoremove", "list", "info",
                    "add", "reinstall", "downgrade", "mark"}
_PACKAGE_READONLY_ACTIONS = {
    "search", "list", "info", "repolist", "repoquery", "check-update",
}
_DELETE_CMDS = {"rm", "rmdir", "shred", "unlink"}
_NETWORK_CMDS = {"curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat",
                 "netcat", "telnet", "ftp", "lftp", "ping6"}
# Preserve the existing L2 decision for familiar Git queries. Match the whole
# shell segment so aliases, repository/config overrides, or output options
# cannot borrow that risk level from a query-looking word.
_GIT_QUERY_RE = re.compile(
    r"git[ \t]+(?:--version|version"
    r"|branch[ \t]+--show-current|rev-parse[ \t]+--show-toplevel"
    r"|status(?:[ \t]+(?:-s|-sb|--short|--branch|--porcelain(?:=v[12])?))*"
    r"|(?:--no-pager[ \t]+)?(?:log(?:[ \t]+(?:--oneline|-[0-9]+|-n[ \t]+[0-9]+))*"
    r"|diff(?:[ \t]+(?:--stat|--name-only|--cached|--staged))*"
    r"(?:[ \t]+--(?:[ \t]+[A-Za-z0-9_./@-]+)+)?))"
)
_PERM_CMDS = {"chmod", "chown", "chgrp", "umask", "setfacl", "getfacl",
              "useradd", "userdel", "usermod", "groupadd", "groupdel",
              "groupmod", "passwd", "gpasswd", "visudo", "su"}
_CONFIG_CMDS = {"vi", "vim", "nano", "sed", "ed", "ex"}
_FILE_WRITE_FIRST = {"mkdir", "touch", "tee"}           # 对象取第一个参数
_FILE_WRITE_LAST = {"mv", "cp", "ln", "install"}        # 对象取最后一个参数（目标）
_READONLY_CMDS = {
    "ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "awk",
    "cut", "sort", "uniq", "wc", "less", "more", "find", "stat", "file",
    "readlink", "realpath", "basename", "dirname", "diff", "comm", "md5sum",
    "sha256sum", "ps", "pgrep", "pidof", "top", "free", "df", "du", "uptime",
    "uname", "hostname", "whoami", "id", "who", "w", "last",
    "date", "echo", "printf", "pwd", "which", "whereis", "type", "alias",
    "env", "printenv", "man", "help", "history", "ping", "ss", "netstat",
    "ip", "ifconfig", "arp", "route", "dig", "nslookup", "host", "traceroute",
    "tracepath", "journalctl", "dmesg", "lsof", "vmstat", "iostat", "sar",
    "mpstat", "lscpu", "lsblk", "lsmod", "lspci", "lsusb", "systemctl",
    "service", "chkconfig", "getenforce", "sestatus", "getent", "id",
    "dpkg-query", "tar", "gzip", "gunzip",
    "zcat", "xz", "bzip2", "sha1sum", "cksum", "seq", "expr", "test", "true",
    "false", "sleep", "wait", "groups",
    # C3 (2026-09-03, 用户实测：环境探测命令 `nproc` 等被 unknown 抬到 L3):
    # 补充纯只读的系统信息 / 文本处理 / 文件查看命令
    "nproc", "arch", "getconf", "lsb_release", "tty", "numfmt", "tac", "nl",
    "rev", "column", "expand", "unexpand", "fold", "fmt", "join", "paste",
    "strings", "od", "xxd", "hexdump", "readelf", "nm", "size", "ldd",
}

# C3 (2026-09-03): hostnamectl/timedatectl/localectl 等“混合命令”——无参数/
# status 是纯只读，set-* 子命令才写。此前一刀切走 unknown L3（fail-closed），
# 导致 agent 环境探测（`hostnamectl` 查系统信息）被误判高风险触发审批。
# 现按子命令细分：含 set-* → config L2；否则 → readonly L0（见 classify_segment）。
_MIXED_READONLY_CMDS = {"hostnamectl", "timedatectl", "localectl"}

_IP_WRITE_ACTIONS = {
    "add", "append", "change", "delete", "del", "flush", "replace",
    "set", "restore", "up", "down",
}

# firewall-cmd 同时承载查询与规则变更，不能像普通命令一样按 basename 一刀切。
# 只精确放行下列明确无副作用的动作；所有未列出的 flag 仍保持 fail-closed，
# 尤其不能把 --add-* / --remove-* / --reload 等写操作误判为只读。
_FIREWALL_READONLY_ACTIONS = {
    "--state", "--list-all", "--list-all-zones", "--list-ports",
    "--list-services", "--list-rich-rules", "--list-interfaces",
    "--get-active-zones", "--get-default-zone", "--get-zones",
    "--get-services", "--get-icmptypes", "--get-helpers",
    "--get-log-denied", "--get-target", "--query-port", "--query-service",
    "--query-rich-rule", "--query-masquerade", "--query-forward-port",
    "--check-config", "--version",
}
_FIREWALL_WRITE_PREFIXES = (
    "--add-", "--remove-", "--change-", "--set-", "--new-", "--delete-",
    "--rename-", "--enable-", "--disable-", "--reload", "--complete-reload",
    "--panic-", "--runtime-to-permanent", "--load-", "--lockdown-",
)

# systemctl/service 的只读子命令（其余 action 视为写操作 → service L3）
_SERVICE_READONLY_ACTIONS = {
    "status", "show", "is-active", "is-enabled", "is-failed", "list-units",
    "list-unit-files", "list-dependencies", "list-sockets", "list-timers",
    "cat", "help", "show-environment", "get-default",
}

_SYSTEMCTL_FLAG_OPTIONS = {
    "-a", "--all", "-l", "--full", "-q", "--quiet", "-r", "--recursive",
    "--user", "--system", "--global", "--runtime", "--no-pager", "--no-legend",
    "--plain", "--failed", "--no-ask-password", "--reverse", "--with-dependencies",
    "--value", "--show-types",
}
_SYSTEMCTL_VALUE_OPTIONS = {
    "-H", "--host", "-M", "--machine", "-p", "-P", "--property", "-t", "--type",
    "--state", "-n", "--lines", "-o", "--output", "--root", "--image",
}


def _service_query_is_readonly(seg: str, base: str) -> bool:
    """Read the action position; unit names and option values cannot lower risk."""
    try:
        args = _normalize_tokens(shlex.split(seg))[1:]
    except ValueError:
        return False
    if base == "service":
        return args == ["--status-all"] or (
            len(args) == 2 and not args[0].startswith("-") and args[1] == "status"
        )
    if base == "chkconfig":
        query_args = args[1:] if args[:1] == ["--list"] else args
        return len(query_args) <= 1 and (
            not query_args or not query_args[0].startswith("-")
        )

    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--":
            index += 1
            break
        if not arg.startswith("-"):
            break
        option, separator, value = arg.partition("=")
        if len(arg) > 2 and not arg.startswith("--") and arg[:2] in _SYSTEMCTL_VALUE_OPTIONS:
            option, separator, value = arg[:2], "=", arg[2:]
        if option in _SYSTEMCTL_VALUE_OPTIONS:
            if not separator:
                index += 1
                if index >= len(args):
                    return False
                value = args[index]
            if not value and option not in {"-p", "-P", "--property"}:
                return False
        elif arg not in _SYSTEMCTL_FLAG_OPTIONS:
            if arg.startswith("--") or len(arg) == 1 or any(
                f"-{flag}" not in _SYSTEMCTL_FLAG_OPTIONS for flag in arg[1:]
            ):
                return False
        index += 1
    return index < len(args) and args[index] in _SERVICE_READONLY_ACTIONS

# C2 (2026-09-01, 用户实测: `docker ps` 被判"未知操作"抬到 L3 审批):
# 容器/编排工具按子命令细分——只读子命令放行，其余（run/exec/cp/rm 等有
# 副作用的）fail-closed 走 unknown L3。管理组 token（image/container 等）
# 不展开——`docker container ls` 只读但 `docker container rm` 写，保守拦。
_CONTAINER_TOOLS = {"docker", "podman", "nerdctl", "kubectl"}
_CONTAINER_READONLY = {
    "ps", "images", "image", "inspect", "version", "info", "logs", "top",
    "stats", "port", "search", "list", "events",
    # kubectl 只读
    "get", "describe", "cluster-info", "explain", "api-resources",
}

# C2: 无对象语义的只读命令（参数是 flags/无意义，展示对象只产生噪声）
_NO_OBJECT_READONLY = {
    "echo", "printf", "pwd", "date", "uptime", "uname", "whoami", "id",
    "hostname", "ps", "top", "free", "df", "du", "vmstat", "iostat", "sar",
    "lsmod", "lscpu", "lspci", "lsusb", "lsblk", "env", "printenv",
    "history", "alias", "true", "false", "sleep", "wait", "wc", "seq",
    # firewall-cmd 的查询对象已由 flag 表达（例如 --list-all），无须把 flag
    # 伪装为操作对象；zone selector 同样只影响查询范围。
    "firewall-cmd",
}


# ============================================================================
# 对象提取
# ============================================================================

def _first_arg(args: list[str]) -> list[str]:
    return args[:1]


def _last_arg(args: list[str]) -> list[str]:
    return args[-1:] if args else []


def _extract_objects(category: str, base: str, toks: list[str]) -> list[str]:
    """按类别提取对象（包名/路径/服务名等，第一个参数级 token 或列表）"""
    args = _arg_tokens(toks)
    if not args:
        return []

    if category == CATEGORY_INSTALL:
        # 跳过动作词（install/remove/search...），取其后参数级 token
        rest = [a for a in args if a.lower() not in _INSTALL_ACTIONS]
        return rest[:3] or args[:1]

    if category == CATEGORY_DELETE:
        # 删除类取全部目标路径（上限 5 个）
        return args[:5]

    if category == CATEGORY_SERVICE:
        # 服务名 = 非动作非选项 token（systemctl restart nginx httpd → nginx/httpd）
        svcs = [a for a in args if a.lower() not in _SERVICE_READONLY_ACTIONS
                and a.lower() not in {"start", "stop", "restart", "reload",
                                      "enable", "disable", "mask", "unmask",
                                      "kill", "try-restart", "condrestart"}]
        return svcs[:3] or args[:1]

    if category == CATEGORY_CONFIG:
        # sed 的第一个参数往往是表达式 → 取最后一个（目标文件）；编辑器取第一个
        return _last_arg(args) if base in ("sed", "ed", "ex") else _first_arg(args)

    if category == CATEGORY_PERM:
        # chmod/chown 的最后参数是目标路径；useradd 等第一个是新用户
        return _last_arg(args) if base in ("chmod", "chown", "chgrp", "setfacl") else _first_arg(args)

    if category == CATEGORY_FILE_WRITE:
        # mv/cp/ln 目标取最后；mkdir/touch/tee 取第一
        return _last_arg(args) if base in _FILE_WRITE_LAST else _first_arg(args)

    # C2 (2026-09-01): 只读命令对象提取——无对象语义的命令（ps/echo/df 等）
    # 返回空（此前显示 "只读查询: aux"、"只读查询: —" 之类噪声）；对象型
    # 命令（which/ls/cat/grep 等）取前 3 个参数（此前只取第一个，
    # "which nginx docker python3" 误导性地只显示 "nginx"）
    if category == CATEGORY_READONLY:
        if base in _NO_OBJECT_READONLY:
            return []
        # systemctl is-active nginx → 动作词不算对象（服务名才是）
        if base in ("systemctl", "service", "chkconfig"):
            svcs = [a for a in args if a.lower() not in _SERVICE_READONLY_ACTIONS]
            return svcs[:3] or args[:1]
        return args[:3]
    # network / unknown：第一个参数
    return _first_arg(args)


# ============================================================================
# 敏感目标与特殊构造（T1 安全修复：目标对象 + 效果等价 + 特殊类别）
# ============================================================================
# 修复前的根因：定级主要看"命令动词"，不看"目标对象的敏感性"与"实际效果"。
# 于是 `rm /etc/passwd` 是 L4，而同样让它消失的 `mv /etc/passwd /tmp/p` 只有 L2，
# auto 档（L0-L2 免审）下可不经审批完成等价破坏。这里补齐三个维度：
#   1. 目标对象：系统关键路径 / 账户认证 / 持久化点，写改导出即 ≥L3；
#   2. 效果等价：mv/cp/install/ln/chmod/chown/重定向同时看源与目的，取最高；
#   3. 特殊类别：审计规避、交互式、后台常驻单独打标，供 assess_command 强制审批。
# 归一化是纯词法转换：不 expanduser、不读当前用户目录、不访问文件系统。

_HOME_PREFIX = "<HOME>"

_SENSITIVE_SYSTEM_EXACT = {"/etc/passwd", "/etc/shadow", "/etc/sudoers"}
_SENSITIVE_SYSTEM_PREFIXES = ("/etc/ssh/", "/etc/sudoers.d/", "/etc/cron", "/etc/systemd/")
_PERSISTENT_HOME_FILES = {".bashrc", ".profile"}
_PERSISTENT_HOME_PREFIXES = (".ssh/", ".config/autostart/")

_ACCOUNT_COMMANDS = {"useradd", "userdel", "usermod", "passwd", "chpasswd", "visudo"}
_INTERACTIVE_COMMANDS = {"vi", "vim", "nano", "passwd", "top", "less"}
_BACKGROUND_COMMANDS = {"nohup", "setsid", "disown"}
# 这些命令会对操作数产生写/改/移动/链接/导出效果，需要同时检查源与目的路径。
_WRITE_EFFECT_BASES = {
    "mv", "cp", "install", "ln", "chmod", "chown", "chgrp", "setfacl",
    "rm", "rmdir", "shred", "unlink", "tee", "dd", "mkdir", "touch",
    "sed", "ed", "ex", "vi", "vim", "nano",
}


def _normalize_target_path(tok: str) -> str:
    """把 home 等价写法归一到 `<HOME>/` 逻辑前缀；非路径 token 原样返回。

    只覆盖需求批准的等价类：`~/`、`$HOME/`、相对 `.bashrc`/`.profile`、
    `/home/<user>/`、`/root/`、引号包裹与重复斜杠。不做任意变量展开。
    """
    if not tok:
        return ""
    p = _strip_quotes(tok.strip())
    if not p or p.startswith("-"):
        return ""
    # Linux等价分隔符和"."必须先清理，再识别home/敏感目标。
    # 不折叠".."：符号链接使其不能仅靠词法确定真实目标。
    p = "/".join(part for part in re.sub(r"/{2,}", "/", p).split("/") if part != ".")
    if p in (".bashrc", ".profile"):
        p = f"{_HOME_PREFIX}/{p}"
    elif p in ("./.bashrc", "./.profile"):
        p = f"{_HOME_PREFIX}/{p[2:]}"
    elif p == "~":
        p = _HOME_PREFIX
    elif p.startswith("~/"):
        p = f"{_HOME_PREFIX}/{p[2:]}"
    elif p.startswith("$HOME/"):
        p = f"{_HOME_PREFIX}/{p[len('$HOME/'):]}"
    elif p.startswith("/root/"):
        p = f"{_HOME_PREFIX}/{p[len('/root/'):]}"
    elif p.startswith("/home/"):
        parts = p.split("/", 3)
        p = f"{_HOME_PREFIX}/{parts[3]}" if len(parts) >= 4 else _HOME_PREFIX
    return re.sub(r"/{2,}", "/", p)


def _is_sensitive_target(path: str) -> bool:
    if not path:
        return False
    if path in _SENSITIVE_SYSTEM_EXACT:
        return True
    if any(path.startswith(pref) for pref in _SENSITIVE_SYSTEM_PREFIXES):
        return True
    if path.startswith(_HOME_PREFIX + "/"):
        rel = path[len(_HOME_PREFIX) + 1:]
        if rel in _PERSISTENT_HOME_FILES:
            return True
        if any(rel.startswith(pref) for pref in _PERSISTENT_HOME_PREFIXES):
            return True
    return False


def _segment_special_effects(seg: str, base: str, toks: list[str]) -> tuple[int, set[str]]:
    """返回 (最低风险, 特殊标记)。只读查看普通文件不应在这里被提级。"""
    flags: set[str] = set()
    min_risk = 0
    raw = [_strip_quotes(t) for t in seg.split()]
    args = toks[1:]
    has_help = any(a in ("--help", "-h", "--version") for a in args)

    if base in _ACCOUNT_COMMANDS and not has_help:
        # 账户与认证变更：动词本身即敏感，与目标路径无关。
        if not (base == "passwd" and any(a in ("-S", "--status") for a in args)):
            min_risk = max(min_risk, 3)

    if base in _INTERACTIVE_COMMANDS and not has_help:
        # top 的批处理模式不是交互式；短选项可能合并书写（`-bn1` 含 `-b`）。
        batch_top = base == "top" and any(
            a.startswith("-") and not a.startswith("--") and "b" in a[1:] for a in args
        )
        if not batch_top:
            if not (base == "passwd" and any(a in ("-S", "--status") for a in args)):
                flags.add("interactive")

    if base == "history":
        for a in args:
            if a in ("-c", "-d", "-w") or (
                a.startswith("-") and not a.startswith("--") and any(ch in a[1:] for ch in "cdw")
            ):
                flags.add("audit_evasion")
                min_risk = max(min_risk, 3)
                break
    if base == "unset" and any(a == "HISTFILE" for a in args):
        flags.add("audit_evasion")
        min_risk = max(min_risk, 3)
    try:
        assignment_tokens = shlex.split(seg)
    except ValueError:
        assignment_tokens = raw
    assignments: list[str] = []
    if assignment_tokens and assignment_tokens[0] == "export":
        assignments = assignment_tokens[1:]
    else:
        for token in assignment_tokens:
            if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", token):
                break
            assignments.append(token)
    if "HISTSIZE=0" in assignments:
        flags.add("audit_evasion")
        min_risk = max(min_risk, 3)

    if base in _BACKGROUND_COMMANDS or (
        raw and _base_name(raw[0]).lower() in _BACKGROUND_COMMANDS
    ):
        flags.add("background")
        min_risk = max(min_risk, 2)

    redirect_targets = re.findall(r">>?\s*(?!/dev/null\b)([^\s;|&]+)", seg)
    # 保留shell词边界及词内引号拼接，不用空白切分后的残片比较目标路径。
    path_operands = [
        t for t in _normalize_tokens(assignment_tokens)[1:] if not t.startswith("-")
    ]
    if base in _WRITE_EFFECT_BASES or redirect_targets:
        for tok in [*path_operands, *redirect_targets]:
            if _is_sensitive_target(_normalize_target_path(tok)):
                min_risk = max(min_risk, 3)
                break
    return min_risk, flags


def _split_with_background(cmd: str) -> list[tuple[str, bool]]:
    """与 ``split_compound`` 同口径拆分，同时保留"段尾后台 ``&``"信息。

    ``split_compound`` 把单个 ``&`` 当分隔符丢弃，导致 `sleep 999 &` 的后台语义
    在定级时完全消失（V2 的成因之一）。这里单独保留，且不改变原函数签名，
    避免影响 trust_store 等既有调用方。``&&``、``2>&1``、``&>`` 都不算后台。
    """
    segments: list[tuple[str, bool]] = []
    buf: list[str] = []
    background = False
    i = 0
    n = len(cmd)
    quote: str | None = None

    def flush() -> None:
        nonlocal buf, background
        text = "".join(buf).strip()
        if text:
            segments.append((text, background))
        buf = []
        background = False

    while i < n:
        ch = cmd[i]
        if quote is not None:
            buf.append(ch)
            if quote == '"' and ch == "\\" and i + 1 < n:
                buf.append(cmd[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            buf.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            buf.append(ch)
            buf.append(cmd[i + 1])
            i += 2
            continue
        next_ch = cmd[i + 1 : i + 2]
        if (ch in "<>" and next_ch == "&") or (ch == "&" and next_ch == ">"):
            buf.extend((ch, next_ch))
            i += 2
            continue
        if ch == "&" and next_ch != "&":
            background = True
            flush()
            i += 1
            continue
        if ch in ";\n" or (ch == "&" and next_ch == "&"):
            flush()
            i += 2 if ch == "&" else 1
            continue
        if ch == "|":
            flush()
            i += 2 if next_ch == "|" else 1
            continue
        buf.append(ch)
        i += 1
    flush()
    return segments


# ============================================================================
# 单段分类
# ============================================================================

def classify_segment(seg: str) -> dict:
    """对单段命令做影响分类

    Returns:
        dict: {command, category, category_label, objects, risk_l}
        （denied / dangerous_construct / deny_reason 由 analyze 叠加）
    """
    raw_toks = [_strip_quotes(t) for t in seg.split()]
    command_query = (
        len(raw_toks) > 1
        and _base_name(raw_toks[0]).lower() == "command"
        and raw_toks[1] in {"-v", "-V"}
    )
    toks = _normalize_tokens(raw_toks)
    base = _base_name(toks[0]).lower() if toks else ""

    # --- systemctl / service 按子命令细分（status 只读，restart 写）---
    if command_query:
        category = CATEGORY_READONLY
    elif base in ("systemctl", "service", "chkconfig"):
        category = CATEGORY_READONLY if _service_query_is_readonly(seg, base) else CATEGORY_SERVICE
    # --- 装包 ---
    elif base in {"yum", "dnf"} and any(
        token.lower() in _PACKAGE_READONLY_ACTIONS for token in toks[1:]
    ):
        category = CATEGORY_READONLY
    elif base == "rpm" and any(
        token == "--query" or (token.startswith("-q") and not token.startswith("--"))
        for token in toks[1:]
    ):
        category = CATEGORY_READONLY
    elif base in _INSTALL_CMDS:
        category = CATEGORY_INSTALL
    # --- 删除 ---
    elif base in _DELETE_CMDS:
        category = CATEGORY_DELETE
    # --- 配置编辑 ---
    elif base in _CONFIG_CMDS:
        category = CATEGORY_CONFIG
    # Ordinary Git queries retain L2. Other Git forms reach the L3 fallback.
    elif base in _NETWORK_CMDS or (base == "git" and _GIT_QUERY_RE.fullmatch(seg)):
        category = CATEGORY_NETWORK
    # --- 用户/权限 ---
    elif base in _PERM_CMDS:
        category = CATEGORY_PERM
    # --- 文件写入 ---
    elif base in _FILE_WRITE_FIRST or base in _FILE_WRITE_LAST:
        category = CATEGORY_FILE_WRITE
    # --- 容器/编排工具按子命令细分（C2: docker ps 只读，docker run 写）---
    # 无参数/仅 flags（docker --version）视为只读；子命令不在只读集 → unknown
    elif base in _CONTAINER_TOOLS:
        sub = next((t.lower() for t in toks[1:] if not t.startswith("-")), "")
        category = (
            CATEGORY_READONLY
            if (not sub or sub in _CONTAINER_READONLY)
            else CATEGORY_UNKNOWN
        )
    # --- firewall-cmd 混合命令按 flag 细分（2026-09-04）：
    #     明确查询动作 L0；明确改规则/重载 L2；其余维持 unknown L3 ---
    elif base == "firewall-cmd":
        flags = {t.lower().split("=", 1)[0] for t in toks[1:] if t.startswith("--")}
        if any(flag.startswith(_FIREWALL_WRITE_PREFIXES) for flag in flags):
            category = CATEGORY_CONFIG
        elif flags & _FIREWALL_READONLY_ACTIONS:
            category = CATEGORY_READONLY
        else:
            category = CATEGORY_UNKNOWN
    # --- hostnamectl/timedatectl/localectl 混合命令按子命令细分（C3 2026-09-03）：
    #     set-* 是写操作 → config L2；无参数/status/show 纯查询 → readonly L0 ---
    elif base in _MIXED_READONLY_CMDS:
        has_write = any(t.lower().startswith("set-") for t in toks[1:])
        category = CATEGORY_CONFIG if has_write else CATEGORY_READONLY
    elif base in {"ip", "route", "ifconfig"}:
        actions = {t.lower() for t in toks[1:]}
        if base == "ifconfig" and len(toks) > 2:
            actions.add("set")
        category = (
            CATEGORY_CONFIG
            if actions & _IP_WRITE_ACTIONS
            else CATEGORY_READONLY
        )
    # --- 只读白名单（带写/执行型 flag 时否决，见 _readonly_veto_hit）---
    elif base in _READONLY_CMDS and not _readonly_veto_hit(base, seg):
        category = CATEGORY_READONLY
    # --- 兜底：未知（fail-closed 偏高风险）---
    else:
        category = CATEGORY_UNKNOWN

    # A file redirect adds an effect. It must not lower the command's own risk.
    if category == CATEGORY_READONLY and _REDIRECT_WRITE_RE.search(seg):
        category = CATEGORY_FILE_WRITE

    objects = _extract_objects(category, base, toks)
    risk_l = CATEGORY_RISK.get(category, CATEGORY_RISK[CATEGORY_UNKNOWN])
    # #159：路径命中凭据名单 ⇒ 至少 L3。
    # 只读命令（`cat /root/.ssh/id_rsa` / `head -20 /etc/shadow`）以前按**命令名**判成
    # "只读查看 L0"，三档全免审批 —— 这是主通道上比 python_run 更严重的那个洞。
    # 读要换类别：不改类别只抬 risk_l，审批卡会一边问一边说"仅查询、不会写入"（半假事实）。
    # 写类（`tee -a authorized_keys`）本来就要弹卡，这里只把级别抬到 L3，类别不动、说法仍准。
    credential_hit = first_credential_piece(
        [t for t in toks[1:] if not t.startswith("-")]
    )
    if credential_hit is not None:
        if category == CATEGORY_READONLY:
            category = CATEGORY_CREDENTIAL
            objects = [credential_hit]
        risk_l = max(risk_l, CATEGORY_RISK[CATEGORY_CREDENTIAL])
    special_risk, special_flags = _segment_special_effects(seg, base, toks)
    risk_l = max(risk_l, special_risk)
    result = {
        "command": seg,
        "category": category,
        "category_label": CATEGORY_LABELS.get(category, CATEGORY_LABELS[CATEGORY_UNKNOWN]),
        "objects": objects,
        "risk_l": risk_l,
    }
    # 特殊标记仅非空时写入，保持既有返回形状（不破坏段结构断言）。
    if special_flags:
        result["flags"] = sorted(special_flags)
    return result


def _readonly_veto_hit(base: str, seg: str) -> bool:
    """只读白名单的 flag 否决（2026-09-18 深度体检 A1，P0）。

    这些命令**名字**看着只读，但带上特定 flag 就会删文件、写盘或执行任意程序。
    命中即不再算只读 —— 落 UNKNOWN(L3) 走审批。修复前的事实（我自己跑出来复核的）：
    confirm 模式下 `find / -delete`、`awk BEGIN{system("id")}`、
    `sort -o /etc/shadow /dev/null` 全部返回 `allow`，零审批直接执行。
    """
    if base == "env":
        # A path-qualified env can launch a command and must not be a read query.
        return len(seg.split()) > 1
    if base == "find":
        # -delete 直接删；-exec/-execdir/-ok/-okdir 起任意子进程
        if re.search(r"\s-(?:delete|exec|execdir|ok|okdir)\b", seg):
            return True
        try:
            return any(
                arg in {"-delete", "-exec", "-execdir", "-ok", "-okdir"}
                for arg in shlex.split(seg)
            )
        except ValueError:
            return True
    if base in {"awk", "gawk", "mawk", "busybox"}:
        # system()/gensub 执行命令、getline 从管道或命令读、> 重定向写文件
        return bool(re.search(r"\b(?:system|gensub)\s*\(|\bgetline\b", seg)) or _has_file_redirect(seg)
    if base == "sort":
        return bool(re.search(r"\s-o\b", seg)) or _has_file_redirect(seg)
    if base == "tar":
        # -c 打包写文件、-x 解包落盘、-u/-r 追加；-t/-v 只是列目录，不否决。
        # 还要覆盖 BSD 风格连写（`tar czf x.tgz /etc` 根本没有前导 -）。
        bundled = re.match(r"\s*tar\s+(-?[A-Za-z]{1,6})\b", seg)
        if bundled and any(ch in "cxur" for ch in bundled.group(1).lstrip("-")):
            return True
        return bool(re.search(r"(?:^|\s)-[A-Za-z-]*[cxur]", seg)) or bool(
            re.search(r"--(?:create|extract|update|append|delete|to-command)\b", seg)
        )
    if base in {"gzip", "gunzip", "bzip2", "bunzip2", "xz", "unxz", "zstd", "lzma", "compress"}:
        # 默认就地替换/删除输入文件；只有 -k/--keep 才保留原文件
        return not re.search(r"(?:^|\s)-[a-z]*k|--keep\b", seg, flags=re.IGNORECASE)
    if base in {"uniq", "cut"}:
        return bool(re.search(r"\s-[dDoO]\b", seg)) or _has_file_redirect(seg)
    return False


def _has_file_redirect(seg: str) -> bool:
    """`>` / `>>` 重定向到非 /dev/ 目标 = 写盘。

    排除 `2>`、`&>`、`>|` 之类：它们要么改的是 stderr，要么是既有的合并写法。
    """
    for m in re.finditer(r"(?<![0-9&])>{1,2}\s*([^\s;|&]+)", seg):
        target = m.group(1)
        if target.startswith("/dev/") or target in {"", "&1", "&2"}:
            continue
        return True
    return False


# ============================================================================
# denylist 匹配
# ============================================================================

def match_denylist(seg: str) -> tuple[str, str] | None:
    """匹配 denylist 硬底线

    Returns:
        (规则名, 拒绝原因)；未命中返回 None
    """
    for name, pattern, reason in _DENYLIST:
        if name == "reboot" and is_last_reboot_history_query(seg):
            continue
        if pattern.search(seg):
            return name, reason
    return None


# ============================================================================
# 汇总分析
# ============================================================================

def analyze(cmd: str) -> dict:
    """全命令影响分析（Task 4 主入口）

    Returns:
        dict:
            segments: list[dict]（classify_segment + denied / dangerous_construct）
            max_risk_l: int（各段最高风险）
            summary: str（人话摘要，审批卡展示）
            denied: bool（denylist 硬底线命中 → 执行链直接 command_blocked）
            dangerous_construct: bool（危险构造 → 永不自动放行，供 Task 5 白名单）
    """
    segments_raw = _split_with_background(cmd or "")
    segments: list[dict] = []
    max_risk = 0
    denied = False
    dangerous = False

    for seg, is_background in segments_raw:
        info = classify_segment(seg)
        if is_background:
            # 段尾真实后台 `&`：让进程脱离前台生命周期，至少 L2 并强制审批。
            info["risk_l"] = max(info["risk_l"], 2)
            info["flags"] = sorted({*info.get("flags", []), "background"})
        hit = match_denylist(seg)
        if hit:
            rule, reason = hit
            info["risk_l"] = 4
            info["denied"] = True
            info["deny_reason"] = reason
            info["deny_rule"] = rule
            denied = True
        else:
            info["denied"] = False
        seg_dangerous = detect_dangerous_construct(seg)
        info["dangerous_construct"] = seg_dangerous
        if seg_dangerous:
            # 危险构造不拦截但抬风险（至少 L3），且永不自动放行
            info["risk_l"] = max(info["risk_l"], 3)
            dangerous = True
        max_risk = max(max_risk, info["risk_l"])
        segments.append(info)

    # 整条命令兜底匹配（fork bomb 等整体形式含 ; | 会被拆散，段级匹配不到）
    if not denied:
        full_hit = match_denylist(cmd or "")
        if full_hit:
            rule, reason = full_hit
            segments.append({
                "command": cmd or "",
                "category": CATEGORY_UNKNOWN,
                "category_label": CATEGORY_LABELS[CATEGORY_UNKNOWN],
                "objects": [],
                "risk_l": 4,
                "denied": True,
                "deny_reason": reason,
                "deny_rule": rule,
                "dangerous_construct": False,
            })
            denied = True
            max_risk = max(max_risk, 4)

    # 顶层危险构造兜底（$(` 等可能出现在拆分边界附近）
    if not dangerous and detect_dangerous_construct(cmd or ""):
        dangerous = True
    if dangerous:
        max_risk = max(max_risk, 3)

    return {
        "segments": segments,
        "max_risk_l": max_risk,
        "summary": _build_summary(segments, max_risk, denied),
        "denied": denied,
        "dangerous_construct": dangerous,
    }


def _build_summary(segments: list[dict], max_risk: int, denied: bool) -> str:
    """生成人话摘要（审批卡「影响预测」正文）"""
    if denied:
        d = next((s for s in segments if s.get("denied")), None)
        return f"命中硬底线黑名单：{d.get('deny_reason', '')}" if d else "命中硬底线黑名单"
    if not segments:
        return UNKNOWN_IMPACT_TEXT
    if max_risk == 0 and all(s["category"] == CATEGORY_READONLY for s in segments):
        return "只读查看，无副作用"
    parts = []
    for s in segments[:6]:
        objs = "、".join(s["objects"][:3]) if s["objects"] else "—"
        parts.append(f"{s['category_label']}：{objs}")
    if len(segments) > 6:
        parts.append(f"…共 {len(segments)} 段")
    return "；".join(parts)


__all__ = [
    "CATEGORY_LABELS",
    "CATEGORY_RISK",
    "UNKNOWN_IMPACT_TEXT",
    "analyze",
    "classify_segment",
    "detect_dangerous_construct",
    "match_denylist",
    "split_compound",
]
