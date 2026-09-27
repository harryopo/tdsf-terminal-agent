"""
tools/_credential_paths.py — 「哪些路径算凭据」的唯一主人（#158-④ / #159）
==========================================================================

为什么要有这个文件：同一条安全口径以前被两处各自实现过（`python_risk` 的 AST 分级、
`command_impact` 的命令分级）。两份名单一定会漂 —— 漂的结果是"某条通道免审批"，
而那正是这两条要堵的洞。

用法约定：
- `CREDENTIAL_PATH_MARKS` 只放**具体文件/目录名**，不放整目录通配（`~/.ssh/config` 这类
  排障常用文件不该弹卡，`~/.ssh/id_rsa` 该弹）；
- `is_credential_path_piece()` 是字符串级判断，调用方自己决定"从哪儿取字符串"
  （AST 字面量 / shell token），**不在此模块里做语义判断**；
- 提级幅度由各调用方定（读、写都至少 L3），但**名单只有一份**。
"""
from __future__ import annotations

# 命中即"这是凭据类文件"（全部小写，比对前把待测串 .lower()）
CREDENTIAL_PATH_MARKS: tuple[str, ...] = (
    ".ssh",  # ~/.ssh 与 /root/.ssh/id_rsa 与 C:\Users\x\.ssh\ —— 三种分隔符一并认
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "authorized_keys",
    "known_hosts",
    "ssh-credentials.json",
    "llm_config.json",
    ".aws",
    ".gnupg",
    "/etc/shadow",
    "/etc/sudoers",
    ".npmrc",
    "bash_history",
    "zsh_history",
    "histfile",
)


def is_credential_path_piece(text: str) -> bool:
    """单个字符串片段是否指向凭据类文件"""
    lowered = text.lower()
    return any(mark in lowered for mark in CREDENTIAL_PATH_MARKS)


def first_credential_piece(pieces: list[str]) -> str | None:
    """返回第一个命中的片段（审批卡要说清是哪个文件，不能只说"凭据类文件"）"""
    for piece in pieces:
        if is_credential_path_piece(piece):
            return piece
    return None


__all__ = [
    "CREDENTIAL_PATH_MARKS",
    "first_credential_piece",
    "is_credential_path_piece",
]
