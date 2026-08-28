"""test_redact.py — B1-G1 Sidecar 侧脱敏测试（TDSF 魔改 2026-08-28）

与前端 redact.test.ts 关键样本对齐；双侧语义一致是 _redact.py 的存在前提。
"""
import pytest

from strands_backend.tools._redact import redact_sensitive_text


class TestRedactSecrets:
    def test_openai_key(self):
        out = redact_sensitive_text("prefix sk-proj-abcdefghijklmnopqrstuvwxyz012345 suffix")
        assert "sk-proj-" not in out
        assert "<REDACTED:openai-key>" in out

    def test_aws_access_key(self):
        out = redact_sensitive_text("key AKIA1234567890ABCDEF in log")
        assert "AKIA1234567890ABCDEF" not in out

    def test_jwt(self):
        out = redact_sensitive_text("token eyJabcdefgh.ZYXWVUTSR.qwertyuiop done")
        assert "eyJabcdefgh" not in out

    def test_env_assign_keeps_name(self):
        out = redact_sensitive_text('MY_SECRET_KEY="hunter2hunter2"')
        assert "MY_SECRET_KEY" in out
        assert "hunter2hunter2" not in out
        assert "<REDACTED>" in out

    def test_bearer_token(self):
        out = redact_sensitive_text("Authorization: Bearer abcdefghijklmnopqrstuvwx")
        assert "abcdefghijklmnopqrstuvwx" not in out
        assert "Authorization:" in out

    def test_private_key_block_multiline(self):
        key = (
            "-----BEGIN RSA PRIVATE KEY-----\n"
            "MIIEpAIBAAKCAQEA0123456789abcdef\n"
            "-----END RSA PRIVATE KEY-----"
        )
        out = redact_sensitive_text(f"id_rsa:\n{key}\ndone")
        assert "MIIEpAIBAAKCAQEA0123456789abcdef" not in out
        assert "<REDACTED:private-key>" in out

    def test_db_url_credentials(self):
        out = redact_sensitive_text("psql postgres://admin:s3cret@db.example.com:5432/app")
        assert "admin:s3cret" not in out
        assert "postgres://<REDACTED:db-url>@db.example.com:5432/app" in out

    def test_mysql_url_credentials(self):
        out = redact_sensitive_text("mysql://root:p@ss@localhost/db")
        assert out.startswith("mysql://<REDACTED:db-url>@")


class TestRedactNotOverRedacted:
    def test_intranet_ip_untouched(self):
        """内网 IP 不脱敏（用户钦定 2026-08-28）"""
        text = "ssh root@192.168.45.200 failed; try 10.0.0.5"
        assert redact_sensitive_text(text) == text

    def test_normal_log_untouched(self):
        text = "just a normal log line with no secrets"
        assert redact_sensitive_text(text) == text
