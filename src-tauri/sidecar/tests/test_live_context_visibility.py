"""#128（2026-09-24）：<live_context> 必须把「连接活着」和「有可见终端」分开说。

实测形状：用户停在欢迎页（`terminalRefs` 为空、屏幕上一块终端都没有），
而 SSH 会话确实连着 —— `live.sshSessionId` 有值。Python 侧原先只看 `sshSessionId`
就输出 `connection_mode: ssh`，模型据此认为可以执行；前端 #118 那道闸把它拒回来
（`no_visible_terminal`），于是同一条只读命令连着撞三次同一堵墙再汇报失败
（2026-09-23 真机记录：三条命令 1–6 毫秒全被拒）。

安全口径的字面变化只有 2026-09-25 用户拍板的那一处（#118 后半）：**没有可见终端时，
只读/低风险改走后台通道并写明换了通道；写操作仍然不执行**。所以这一句必须同时说清
两件事，不能再说成"整类命令都不会执行"——那是把放宽藏起来，模型会拒绝去试只读命令。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from strands_backend.adapter import StrandsAgentAdapter  # noqa: E402


class _PromptOnly:
    """只借用 `_build_prompt` / `_append_interrupt_note` 两个方法，不构造整个适配器
    （真适配器要拉起 SDK、注册表、网络客户端，测一句 prompt 拼接不该付这个代价）。"""

    _build_prompt = StrandsAgentAdapter._build_prompt
    _append_interrupt_note = StrandsAgentAdapter._append_interrupt_note
    _cancel_notes: dict = {}


VISIBLE_MARK = "可见终端"


def _prompt(live: dict) -> str:
    return _PromptOnly()._build_prompt("跑一下 whoami", {"session_id": "s-test", "live": live})


class TestSshVisibility:
    def test_connected_but_no_visible_terminal_says_so(self):
        """欢迎页：会话号有值（连接确实活着）+ terminalSession=none（界面上没终端可写）"""
        prompt = _prompt({"sshSessionId": 30, "terminalSession": "none"})
        # 连接是真的，不该抹掉
        assert "connection_mode: ssh" in prompt
        # 但必须说明没有可写的可见终端，且要求别对同一件写操作连续重试
        assert VISIBLE_MARK in prompt
        line = next(ln for ln in prompt.splitlines() if VISIBLE_MARK in ln)
        assert "无" in line
        assert "重试" in line
        # #118 后半（2026-09-25 用户拍板）：这一句必须把"放宽了哪一半"和
        # "哪一寸没松"同时说清 —— 只说"不会被执行"会让模型连只读都不肯试。
        assert "后台" in line, "只读命令会自动改走后台通道，这句必须告诉模型"
        assert "写操作" in line, "不许把放宽说成全放：写操作仍然不执行"
        assert "命令不会被执行" not in line, "整类命令'不会执行'那句旧口径不许回来"

    def test_visible_terminal_present_does_not_discourage(self):
        """正向配对（防"永远不输出"式假绿）：终端真的可见时，不许出现那句劝退。"""
        prompt = _prompt({"sshSessionId": 30, "terminalSession": "ssh"})
        assert "connection_mode: ssh" in prompt
        assert VISIBLE_MARK not in prompt

    def test_legacy_caller_without_terminal_session_stays_silent(self):
        """旧调用方没注入 terminalSession 时**不吭声**（fail-quiet）：
        认不出的形状就断言"没有可见终端"，会把能用的场景说成不能用。"""
        prompt = _prompt({"sshSessionId": 30})
        assert "connection_mode: ssh" in prompt
        assert VISIBLE_MARK not in prompt

    def test_no_ssh_session_keeps_existing_no_terminal_branch(self):
        """完全没连接（既无会话号也无终端会话）时，仍走原有 connection_mode: none 分支，
        不要多出可见终端那一句（那句的前提是"连接活着"）。"""
        prompt = _prompt({"terminalSession": "none"})
        assert "connection_mode: none" in prompt
        assert VISIBLE_MARK not in prompt
