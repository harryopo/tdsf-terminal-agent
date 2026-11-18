"""D7 RED：审计链 reason 副本未脱敏（附言可能含凭据）。"""
from __future__ import annotations

import pytest


@pytest.mark.xfail(
    strict=True,
    reason="D7 RED：audit reason 副本未脱敏，待 ROOT 修复字段级脱敏",
)
def test_audit_reason_is_redacted() -> None:
    from strands_backend.audit_chain import get_global_chain
    from strands_backend.tools import _audit_append

    _audit_append(
        session_id="privacy",
        tool="ssh_command",
        status="rejected",
        command="mysql -uroot -pS3cretPw -e 'select 1'",
        detail="rejected",
        reason="用户拒绝：mysql -pS3cretPw",
    )
    entry = get_global_chain().tail(1)[0]["entry"]
    assert "S3cretPw" not in str(entry.get("reason", ""))
    assert "S3cretPw" not in str(entry.get("command", ""))


def test_audit_command_is_redacted_as_positive_control() -> None:
    from strands_backend.audit_chain import get_global_chain
    from strands_backend.tools import _audit_append

    _audit_append(
        session_id="privacy",
        tool="ssh_command",
        status="rejected",
        command="mysql -uroot -pS3cretPw -e 'select 1'",
        detail="rejected",
        reason="普通附言",
    )
    entry = get_global_chain().tail(1)[0]["entry"]
    assert "S3cretPw" not in str(entry.get("command", ""))