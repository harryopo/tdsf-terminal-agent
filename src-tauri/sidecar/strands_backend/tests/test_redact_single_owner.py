"""#157 安全复查：脱敏规则收到一个主人 —— SSH 输出那套只能更严、不许更松。

判据来源（2026-09-26 推送前安全复查）：仓里原本三套正则各写各的 ——
① 前端 `src/modules/ai/lib/redact.ts`（14 条）
② `tools/_redact.py`（14 条，与 ① 逐条对齐）
③ `tools/__init__.py:_SENSITIVE_PATTERNS`（6 条，`execute_via_ssh` 的 output/stderr、
   证据面板、审计链命令都走它）
③ 只认"形状是 `key=value`"的凭据，**完全不认裸 token**：命令输出里孤零零一条
`sk-proj-...` / GitHub token / Slack token / JWT 会原样进模型（`AKIA` 那条也只认
`AKIA`，不认 `ASIA`）。本轮把 ③ 收成"③ 原有规则 + ② 全套"，**先跑 ③ 保持既有输出形状，
再过 ②** ⇒ 结果集是两者的并，只收紧不放宽。

用户钦定口径原样保留：**内网 IP 不脱敏**（教学场景 agent 要看 IP 判断连通性）。
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

TOOLS_INIT = Path(__file__).resolve().parents[1] / "tools" / "__init__.py"

# AWS 文档示例的 Access Key ID 后缀。**必须拼出来、不能写成整串字面量**：
# `ASIA` + 这个后缀的形状完全合法，GitHub 密钥扫描会把它当真凭据报警
# （2026-09-26 提交 d01cba2 就吃了这张警报；同族的教训是火绒把含危险样本的 .pyc 报成木马）。
_AWS_KEY_SUFFIX = "IOSFODNN7EXAMPLE"

# ③ 历史上认的形状（这些不许退回去）
LEGACY_FIXTURES = [
    ("inline mysql password", "mysql -u root -pS3cretPw\n", "S3cretPw"),
    ("password assignment", "DB_PASSWORD=hunter2\n", "hunter2"),
    ("url embedded creds", "git clone https://user:pass123@example.com/repo.git\n", "pass123"),
    ("aws access key", f"AKIA{_AWS_KEY_SUFFIX}\n", f"AKIA{_AWS_KEY_SUFFIX}"),
    ("bearer header", "Authorization: Bearer abcdefghijklmnopqrstuvwx\n", "abcdefghijklmnopqrstuvwx"),
    (
        "private key block",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nabc123secret\n-----END OPENSSH PRIVATE KEY-----\n",
        "abc123secret",
    ),
]

# ③ 以前完全不认、本轮必须认下来的裸 token
BARE_TOKEN_FIXTURES = [
    ("openai key", "loaded sk-proj-abcdefghijklmnopqrstuvwxyz012345 ok"),
    ("anthropic key", "export ANTHROPIC=sk-ant-abcdefghijklmnopqrstuvwxyz012345"),
    ("github token", f"ghp_{'a' * 36}"),
    ("github pat", f"github_pat_{'A' * 40}"),
    ("google api key", f"AIza{'a' * 35}"),
    ("slack token", f"xoxb-{'1' * 12}"),
    ("stripe live key", f"sk_live_{'a' * 24}"),
    ("aws temp access key id", f"ASIA{_AWS_KEY_SUFFIX}"),
    ("jwt", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123"),
]


@pytest.mark.parametrize("label,text,secret", LEGACY_FIXTURES)
def test_legacy_shapes_stay_masked(label: str, text: str, secret: str) -> None:
    """负向配对的底座：合并之后 ③ 原来能脱的必须照样能脱（不许"收主人"收松了）。"""
    from strands_backend.tools import redact_sensitive

    assert secret not in redact_sensitive(text), f"③ 原来能脱的 {label} 退化了"


def test_url_credential_shape_is_unchanged() -> None:
    """既有输出形状是契约的一部分（审计链/证据面板按它做过断言，不许悄悄换写法）。"""
    from strands_backend.tools import redact_sensitive

    out = redact_sensitive("git clone https://user:pass123@example.com/repo.git\n")
    assert "user:***@" in out


@pytest.mark.parametrize("label,secret", BARE_TOKEN_FIXTURES)
def test_bare_token_shapes_are_now_masked(label: str, secret: str) -> None:
    """本轮真正补上的一格：命令输出里没有 `key=` 前缀的裸 token。"""
    from strands_backend.tools import redact_sensitive

    text = f"total 4\n-rw-r--r-- 1 root root 128 Sep 26 09:00 dump.txt\n{secret}\n"
    out = redact_sensitive(text)
    assert secret not in out, f"{label} 仍然原样送给模型"
    assert "<REDACTED" in out or "***" in out


def test_normal_output_and_private_ip_are_untouched() -> None:
    """用户钦定（2026-08-28）：内网 IP 不脱敏 —— 教学场景 agent 要看 IP 判断连通性。

    这一条是"只收紧不放宽"的边界测：正常输出与 IP 必须一字不动，
    否则收紧就把 #113② 那条"把现场如实回传给模型"的口径顶掉了。
    """
    from strands_backend.tools import redact_sensitive

    for text in (
        "load average: 0.08, 0.03, 0.05\n",
        "PING 192.168.45.128 (192.168.45.128) 56(84) bytes of data.\n64 bytes seq=0 ttl=64\n",
        "Active Internet connections 10.0.0.5:22 -> 172.17.0.1:43210 ESTABLISHED\n",
    ):
        assert redact_sensitive(text) == text


def test_the_two_sidecar_owners_agree_on_every_bare_token() -> None:
    """两个消费者口径一致：`execute_via_ssh`（redact_sensitive）与
    `get_terminal_output` / `_sanitize_tool_result`（redact_sensitive_text）认得出同一批凭据。

    不一致就是"同一个不变量被两处近似实现"（#128 那一族的形状）。
    """
    from strands_backend.tools import redact_sensitive
    from strands_backend.tools._redact import redact_sensitive_text

    for label, secret in BARE_TOKEN_FIXTURES:
        text = f"prefix {secret} suffix"
        assert secret not in redact_sensitive(text), f"{label}：execute_via_ssh 那一臂没脱"
        assert secret not in redact_sensitive_text(text), f"{label}：_redact 那一臂没脱"


def test_legacy_rules_are_composed_not_replaced() -> None:
    """接线判据：`redact_sensitive` 必须仍然跑自己那 6 条**并且**过 `_redact`。

    只留 `_redact` 会让 `-pS3cret` 与 `pwd=` 这两种形状退回不脱敏
    （`_redact` 的 env-assign 要求键名以 PASSWORD/PASSWD 等结尾，不认裸 `pwd`）。
    """
    src = TOOLS_INIT.read_text(encoding="utf-8")
    body = src.split("def redact_sensitive(", 1)[1].split("\n\n\n", 1)[0]
    assert "_SENSITIVE_PATTERNS" in body, "旧 6 条被整体换掉 ⇒ -p / pwd 形状会退化"
    assert re.search(r"redact_sensitive_text\(", body), "没并到唯一主人 _redact"


def test_pwd_and_token_without_prefix_still_masked() -> None:
    """③ 独有的一格（`pwd=` / 裸 `token=`）不许在合并中丢掉。"""
    from strands_backend.tools import redact_sensitive

    assert "s3cr3tlong" not in redact_sensitive("redis pwd=s3cr3tlong\n")
    assert "abcdefghij0987654321" not in redact_sensitive("curl -H 'token=abcdefghij0987654321'\n")
