"""tests/test_turn_scoped_state.py — 沉淀进知识库的文本不许带"本轮即时状态"（#147）

为什么单独一个模块：#146 只钉住了 `session_memory._SUMMARY_PROMPT`（LLM 可用时靠提示词），
但实测存量库（`.tdsf-data/rag.db` 的 `entries` 表）里那 3 条现在时断言，
**有两条根本不是 LLM 摘要写进去的**：

  1. `source=auto-case`   —— `adapter._auto_sink_case` 把助手最终文本
     `observation[:600]` **逐字**塞进 `## 结论`；
  2. `source=session-memory` 且内容以 `[会话摘要·截断]` 开头 —— LLM 不可用时
     `session_memory._fallback_summary` 把整段对话**逐字**截 800 字存进去。

也就是"提示词里写了要求"对这两条路**完全不起作用**（一条压根不调 LLM，
一条压根不发给 LLM）。而且 auto-case 的触发词表里就有「无法」「不行」⇒
**一次"我做不了"的回合特别容易被判成"一个案例"沉淀下来**。

所以这里是一层**与 LLM 无关的机械清洗**：只删"声称本轮工具/能力不可用"的那几句，
其余内容（现象、命令、结论、要点）一个字不动。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from turn_scoped_state import drop_turn_scoped_state  # noqa: E402

# 真机存量原文（rag.db 的 entries.content 片段，逐字摘自两条毒样本）
POISON_AUTO_CASE = (
    "## 结论\n部署 Web 网页的路线：第 1 步 摸清现状：现有 Web 服务是 httpd 还是 nginx。\n"
    "但有一个必须说明的限制：本轮我这边可用的工具只有会话枚举、知识库检索/文档读取和提问，"
    "没有带 shell 映射的执行类工具，所以我无法生成教学命令卡，也不会假装执行。\n"
    "第 2 步 安装/启用 Web 服务（本机为 openEuler 系，用 dnf）。"
)
POISON_MEMORY = (
    "## 根因分析\n应以本轮实际可用工具集为准：当前为 OBSERVE 只读模式，"
    "写操作与命令执行被禁止；`ssh_command` 等执行类工具已从本轮工具集移除，"
    "调用会返回 Unknown tool。"
)


class TestDropsCapabilityDisclaimers(unittest.TestCase):
    def test_删掉声称本轮没有工具的那几句(self):
        out = drop_turn_scoped_state(POISON_AUTO_CASE)
        self.assertNotIn("没有带 shell 映射的执行类工具", out)
        self.assertNotIn("我无法生成教学命令卡", out)
        self.assertNotIn("本轮我这边可用的工具只有", out)

    def test_删掉声称模式禁用工具的那句(self):
        out = drop_turn_scoped_state(POISON_MEMORY)
        self.assertNotIn("已从本轮工具集移除", out)
        self.assertNotIn("调用会返回 Unknown tool", out)
        # 「应以本轮实际可用工具集为准：当前为 OBSERVE 只读模式，写操作与命令执行被禁止」
        # 这一整句**也**是本轮即时状态（它对以后没有任何可复用信息）⇒ 一起删掉是对的。
        self.assertNotIn("写操作与命令执行被禁止", out)

    def test_其余内容一个字不动(self):
        """⚠️ 这条是**承重**的：清洗不能顺手把有用的东西删掉，
        否则"防撒谎"会变成"防说话"——那比留着断言更糟。"""
        out = drop_turn_scoped_state(POISON_AUTO_CASE)
        self.assertIn("第 1 步 摸清现状", out)
        self.assertIn("第 2 步 安装/启用 Web 服务", out)
        self.assertIn("## 结论", out)
        self.assertIn("## 根因分析", drop_turn_scoped_state(POISON_MEMORY))

    def test_没有断言时逐字不变(self):
        clean = "systemctl start php-fpm 后恢复。根因是 php-fpm 未自启。"
        self.assertEqual(drop_turn_scoped_state(clean), clean)


class TestDoesNotOverDrop(unittest.TestCase):
    """只删"工具/能力不可用"这一类，别的"当前/无法"不许连坐。"""

    def test_服务器侧的当下故障要留着(self):
        """这是**诊断结论**不是自我能力声明 —— 它对未来排查有用。"""
        text = "当前无法连接 22 端口，服务器防火墙没放行 ssh 服务。"
        self.assertIn("当前无法连接 22 端口", drop_turn_scoped_state(text))

    def test_讲工具用法不等于声称工具不可用(self):
        text = "ssh_command 工具可以执行远端命令，用它先看 systemctl status。"
        self.assertEqual(text, drop_turn_scoped_state(text))

    def test_服务器侧缺配置缺组件要留着(self):
        """⚠️ 这条是**去掉"本轮"这个条件**时唯一会红的用例：
        "接口/工具 + 没有"这种形状在诊断结论里非常常见，而它说的是**服务器**不是助手自己。
        少了作用域条件就会把有用诊断一起删掉。"""
        text = (
            "nginx 的配置目录里没有 include 指令，接口全部 404。"
            "系统未安装 php-fpm，这个工具用不了。"
        )
        self.assertEqual(text, drop_turn_scoped_state(text))

    def test_空输入与空白不炸(self):
        self.assertEqual(drop_turn_scoped_state(""), "")
        self.assertEqual(drop_turn_scoped_state("   \n "), "   \n ")


class TestBothWritersAreWired(unittest.TestCase):
    """#125 那条口径：**实现了但没接上，只能靠读源码钉住。**

    ⚠️ 但"读源码"这种断言本身会假绿：这一版最初只断言窗口里出现过
    ``drop_turn_scoped_state`` 这个名字 —— 我做的变异（把清洗结果丢掉、只留一行
    ``import ... as _keep_import_only``）**照样 10 条全绿**。所以现在钉的是
    **"结论取自清洗之后的值"这个数据形状**，不是"名字出现过"。
    """

    def _read(self, rel: str) -> str:
        return (Path(__file__).resolve().parents[1] / rel).read_text(
            encoding="utf-8"
        )

    def test_auto_case_结论取自清洗后的文本(self):
        src = self._read("strands_backend/adapter.py")
        at = src.index("def _auto_sink_case")
        window = src[at : at + 3000]
        self.assertRegex(window, r"conclusion\s*=\s*drop_turn_scoped_state\(")
        self.assertIn(r"## 结论\n{conclusion}", window)

    def test_离线回退摘要真的清洗过(self):
        """行为测，不是读源码：LLM 不可用时逐字搬原文的那条路最容易漏。"""
        import session_memory

        out = session_memory._fallback_summary(POISON_AUTO_CASE)
        self.assertTrue(out.startswith("[会话摘要·截断]"))
        self.assertNotIn("没有带 shell 映射的执行类工具", out)
        # 正向配对：有用的步骤必须还在，否则"清洗"等于"整段丢掉了"
        self.assertIn("第 1 步 摸清现状", out)


if __name__ == "__main__":
    unittest.main()
