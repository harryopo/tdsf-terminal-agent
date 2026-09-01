"""
strands_backend/tools/command_impact.py — 命令影响预测引擎（Task 4，方案书 v3.1 §4.6）
=====================================================================================

职责（审批卡四层卡面的第 4 层「影响预测」的数据来源）：
- ``split_compound(cmd)``：按 ``;`` / ``&&`` / ``||`` / ``|`` 拆分复合命令。
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
1. 纯函数、零内部依赖（不 import strands/tools 其他模块），便于单测与复用。
2. fail-closed：未知命令 risk_l=3（偏高值），卡面文案「影响未知——请人工审查」。
3. risk_l 映射（任务 spec）：删除=4、重启服务=3、装包/改配置/网络外联/用户
   权限/文件写入=2、只读=0、未知=3。
"""
from __future__ import annotations

import re

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

# 类别 → 中文标签（审批卡类别徽标）
CATEGORY_LABELS: dict[str, str] = {
    CATEGORY_READONLY: "只读查询",
    CATEGORY_INSTALL: "安装软件包",
    CATEGORY_CONFIG: "修改配置",
    CATEGORY_SERVICE: "操作服务",
    CATEGORY_DELETE: "删除文件",
    CATEGORY_NETWORK: "网络外联",
    CATEGORY_PERM: "变更用户/权限",
    CATEGORY_FILE_WRITE: "写入/移动文件",
    CATEGORY_UNKNOWN: "未知操作",
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
    CATEGORY_UNKNOWN: 3,
}

# 未知类别卡面文案（fail-closed 提示语，前端也用同文案兜底）
UNKNOWN_IMPACT_TEXT = "影响未知——请人工审查"


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
    (
        "shutdown",
        re.compile(r"\b(?:shutdown|poweroff|halt)\b|^\s*init\s+0\b"),
        "关机/停机命令将中断服务器运行",
    ),
    (
        "reboot",
        re.compile(r"\breboot\b|^\s*init\s+6\b"),
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
    """检测危险构造：$()、反引号、eval、重定向系统文件、管道到 shell"""
    if not cmd:
        return False
    if "$(" in cmd or "`" in cmd:
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
    """按 ``;`` / ``&&`` / ``||`` / ``|`` 拆分复合命令

    引号（单/双）与反斜杠转义内的分隔符不拆；不处理子 shell ``(...)``。
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
        if ch == ";":
            segments.append("".join(buf))
            buf = []
            i += 1
            continue
        if ch == "&" and i + 1 < n and cmd[i + 1] == "&":
            segments.append("".join(buf))
            buf = []
            i += 2
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
_DELETE_CMDS = {"rm", "rmdir", "shred", "unlink"}
_NETWORK_CMDS = {"curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat",
                 "netcat", "telnet", "ftp", "lftp", "git", "ping6"}
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
}
# 注：semanage / firewall-cmd / hostnamectl / timedatectl / localectl 等混合
# 命令（status 只读但 set-* 写）不进白名单——走 unknown L3 保守（fail-closed）。

# systemctl/service 的只读子命令（其余 action 视为写操作 → service L3）
_SERVICE_READONLY_ACTIONS = {
    "status", "show", "is-active", "is-enabled", "is-failed", "list-units",
    "list-unit-files", "list-dependencies", "list-sockets", "list-timers",
    "cat", "help", "show-environment", "get-default",
}

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
# 单段分类
# ============================================================================

def classify_segment(seg: str) -> dict:
    """对单段命令做影响分类

    Returns:
        dict: {command, category, category_label, objects, risk_l}
        （denied / dangerous_construct / deny_reason 由 analyze 叠加）
    """
    raw_toks = [_strip_quotes(t) for t in seg.split()]
    toks = _normalize_tokens(raw_toks)
    base = _base_name(toks[0]).lower() if toks else ""

    # --- systemctl / service 按子命令细分（status 只读，restart 写）---
    if base in ("systemctl", "service", "chkconfig"):
        actions = {t.lower() for t in toks[1:]}
        if base == "chkconfig":
            category = CATEGORY_READONLY if (not actions or "list" in actions) else CATEGORY_SERVICE
        elif actions & _SERVICE_READONLY_ACTIONS:
            category = CATEGORY_READONLY
        else:
            # 未知 action 也按写操作处理（fail-closed）
            category = CATEGORY_SERVICE
    # --- 装包 ---
    elif base in _INSTALL_CMDS:
        category = CATEGORY_INSTALL
    # --- 删除 ---
    elif base in _DELETE_CMDS:
        category = CATEGORY_DELETE
    # --- 配置编辑 ---
    elif base in _CONFIG_CMDS:
        category = CATEGORY_CONFIG
    # --- 网络外联（git clone/push/fetch 也算外联）---
    elif base in _NETWORK_CMDS:
        category = CATEGORY_NETWORK
    # --- 用户/权限 ---
    elif base in _PERM_CMDS:
        category = CATEGORY_PERM
    # --- 文件写入 ---
    elif base in _FILE_WRITE_FIRST or base in _FILE_WRITE_LAST:
        category = CATEGORY_FILE_WRITE
    # --- 重定向写文件（echo x > file / cat a > b 等）---
    # 注意排除无害流重定向：2>/dev/null、2>&1、>/dev/null（fd 数字前缀
    # 紧贴 > 时不匹配；目标是 /dev/null 时排除——否则网络诊断类工具的
    # "nslookup x 2>/dev/null" 会被误判为文件写 L2 触发审批）
    elif _REDIRECT_WRITE_RE.search(seg):
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
    # --- 只读白名单 ---
    elif base in _READONLY_CMDS:
        category = CATEGORY_READONLY
    # --- 兜底：未知（fail-closed 偏高风险）---
    else:
        category = CATEGORY_UNKNOWN

    objects = _extract_objects(category, base, toks)
    return {
        "command": seg,
        "category": category,
        "category_label": CATEGORY_LABELS.get(category, CATEGORY_LABELS[CATEGORY_UNKNOWN]),
        "objects": objects,
        "risk_l": CATEGORY_RISK.get(category, CATEGORY_RISK[CATEGORY_UNKNOWN]),
    }


# ============================================================================
# denylist 匹配
# ============================================================================

def match_denylist(seg: str) -> tuple[str, str] | None:
    """匹配 denylist 硬底线

    Returns:
        (规则名, 拒绝原因)；未命中返回 None
    """
    for name, pattern, reason in _DENYLIST:
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
    segments_raw = split_compound(cmd or "")
    segments: list[dict] = []
    max_risk = 0
    denied = False
    dangerous = False

    for seg in segments_raw:
        info = classify_segment(seg)
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
        return "只读查询，无副作用"
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
