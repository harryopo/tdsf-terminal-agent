"""_redact.py — Sidecar 侧敏感信息脱敏（B1-G1，TDSF 魔改 2026-08-28）

与前端 src/modules/ai/lib/redact.ts 语义对齐的最小正则集：
密钥类 token / env 赋值 / PEM 私钥块 / Authorization 头 / DB 连接串凭据。

注意（用户钦定 2026-08-28）：内网 IP 不脱敏——教学场景 AI 需看到 IP 判断连通性。

用途：get_terminal_output 等把终端文本送入 LLM 上下文的工具，返回前必须过
redact_sensitive_text()。前端 3 处调用点已覆盖，本模块补齐 Sidecar 独立路径。

修改正则时须同步前端 redact.ts（双侧语义一致是本模块的存在前提）。
"""
from __future__ import annotations

import re
from typing import Pattern

_PATTERNS: list[tuple[str, Pattern[str]]] = [
    ("openai-key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b")),
    ("anthropic-key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b")),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github-token", re.compile(r"\bgh[opsur]_[A-Za-z0-9]{36,}\b")),
    ("github-pat", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("slack-token", re.compile(r"\bxox[bpsare]-[A-Za-z0-9-]{10,}\b")),
    ("stripe-key", re.compile(r"\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    ("bearer", re.compile(r"\bBearer\s+[A-Za-z0-9._-]{20,}")),
    # env 赋值：NAME=value → NAME=<REDACTED>（大小写不敏感）
    (
        "env-assign",
        re.compile(
            r"\b((?:[A-Z][A-Z0-9_]*)?(?:API[_-]?KEY|SECRET(?:[_-]?KEY)?|"
            r"ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|"
            r"CLIENT[_-]?SECRET)[A-Z0-9_]*)\s*[:=]\s*([\"']?)([^\s\"';|&]+)\2",
            re.IGNORECASE,
        ),
    ),
    # PEM 私钥块（跨行）
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----")),
    # Authorization 头 → 保留头名，脱敏值
    ("authorization", re.compile(r"\bAuthorization:\s*Bearer\s+[A-Za-z0-9._-]+", re.IGNORECASE)),
    # DB 连接串内嵌凭据 user:pass@ → $1://<REDACTED>@
    ("db-url", re.compile(r"\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s@/]+@", re.IGNORECASE)),
]

# env-assign 的 name/quote 分组引用
_ENV_ASSIGN_NAME_GROUP = 1
_ENV_ASSIGN_QUOTE_GROUP = 2


def redact_sensitive_text(text: str) -> str:
    """脱敏文本中的敏感凭据（与前端 redactSensitive 语义对齐）

    替换风格与前端一致：<REDACTED:kind> / env-assign 用 NAME=<REDACTED>。
    """
    out = text
    for kind, pattern in _PATTERNS:
        if kind == "env-assign":
            out = pattern.sub(
                lambda m: f"{m.group(_ENV_ASSIGN_NAME_GROUP)}="
                f"{m.group(_ENV_ASSIGN_QUOTE_GROUP)}<REDACTED>"
                f"{m.group(_ENV_ASSIGN_QUOTE_GROUP)}",
                out,
            )
        elif kind == "authorization":
            out = pattern.sub("Authorization: Bearer <REDACTED:authorization>", out)
        elif kind == "db-url":
            out = pattern.sub(r"\1://<REDACTED:db-url>@", out)
        else:
            out = pattern.sub(f"<REDACTED:{kind}>", out)
    return out
