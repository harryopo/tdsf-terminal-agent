"""
tests/test_credential_path_single_owner.py — 命令通道读凭据也要点头 + 名单只有一份主人
=====================================================================================

#158-④ 把 `python_run` 里的凭据读取提到 L3 之后，同族横扫抓到**主通道上更大的那条**：
`command_impact` 按**命令名**判级，实测 `cat /root/.ssh/id_rsa`、`cat /etc/shadow` 仍是
L0「只读查看，无副作用」⇒ 三档全免审批（#159）。

本轮两件事：
1. 路径命中凭据名单 ⇒ **至少 L3**；只读段换 `credential` 类别（不换类别只抬级别，
   审批卡会一边问一边说"仅查询、不会写入文件"——那是半假事实，#118/#123 同族）；
   写类段（`tee -a authorized_keys`）类别不动、只把级别抬到 L3，说法仍然准。
2. **名单只有一份**：`_credential_paths.py`。python_risk 与 command_impact 都从它取，
   谁再本地写一份就算漂移（静态扫）。一份名单两套标准，就是下一个 #159。

判据两头钉：提级（含写类）+ **普通排障文件不许被抬**（`/var/log/syslog`、
`/etc/ssh/sshd_config`、`~/.kube/config`、`cat /etc/hostname` 仍 L0 只读）。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from strands_backend.tools import (  # noqa: E402
    _factual_approval_explanation,
    _semantic_from_impact,
)
from strands_backend.tools.command_impact import (  # noqa: E402
    CATEGORY_CREDENTIAL,
    CATEGORY_FILE_WRITE,
    CATEGORY_READONLY,
    analyze,
    classify_segment,
)


def _seg(cmd: str) -> dict:
    return analyze(cmd)["segments"][0]


class TestCredentialReadIsNotFreeReadOnly:
    @pytest.mark.parametrize(
        "cmd",
        [
            "cat /root/.ssh/id_rsa",
            "head -20 /home/op/.ssh/id_ed25519",
            "cat /etc/shadow",
            "cat ~/.tdsf-data/llm_config.json",
            "tail -5 /root/.aws/credentials",
            "grep -r token /root/.ssh/",
        ],
    )
    def test_reading_credentials_needs_approval(self, cmd: str) -> None:
        seg = _seg(cmd)
        assert seg["category"] == CATEGORY_CREDENTIAL, f"{cmd} 仍被当只读 ⇒ 免审批"
        assert seg["risk_l"] >= 3, f"{cmd} 级别不够，auto 档会直接跑"
        assert "凭据" in seg["category_label"]
        # 对象要指到那个文件，不能只说"凭据类文件"就让人点同意
        assert seg["objects"], cmd

    def test_writing_credentials_escalates_without_lying(self) -> None:
        """`tee -a authorized_keys` 原已是 L2 写文件；抬到 L3 但类别不动 —— 卡面仍说"写文件"，说法准。"""
        seg = _seg("tee -a /root/.ssh/authorized_keys")
        assert seg["category"] == CATEGORY_FILE_WRITE
        assert seg["category_label"] == "写文件"
        assert seg["risk_l"] >= 3

    def test_ordinary_troubleshooting_files_stay_quiet(self) -> None:
        """正向配对：不把整条"读文件"通道一起抬进审批，否则 #66 的口径就没了。"""
        for cmd in (
            "cat /var/log/syslog",
            "cat /etc/ssh/sshd_config",
            "cat ~/.kube/config",
            "cat /etc/hostname",
            "tail -f /var/log/nginx/access.log",
            "ls -l /etc/ssh",
        ):
            seg = _seg(cmd)
            assert seg["category"] == CATEGORY_READONLY, f"{cmd} 被误抬：{seg}"
            assert seg["risk_l"] == 0, f"{cmd} 不该进审批：{seg}"

    def test_pipeline_only_escalates_the_touching_segment(self) -> None:
        """管道里只有一段碰凭据 ⇒ 该段 L3，其余段不变（`analyze` 取 max）。"""
        result = analyze("cat /etc/hostname | wc -l && cat /root/.ssh/id_rsa")
        assert result["max_risk_l"] >= 3
        by_cmd = {s["command"]: s for s in result["segments"]}
        quiet = [s for s in result["segments"] if s["category"] == CATEGORY_READONLY]
        assert quiet, "非凭据段应仍是只读（不该被连坐）"
        assert by_cmd  # 结构自检：分段真分出来了


class TestCardTextStaysHonest:
    """换类别的意义就在这两条：卡片不许一边要人批准一边说"仅查询、不会写入"。"""

    def test_explanation_names_credential_reading(self) -> None:
        impact = analyze("cat /root/.ssh/id_rsa")
        text = _factual_approval_explanation("cat /root/.ssh/id_rsa", impact)
        assert "凭据" in text, text
        assert "不会写入文件、修改服务或改变权限" not in text, "这是那条半假事实"

    def test_semantic_does_not_call_it_a_readonly_query(self) -> None:
        impact = analyze("cat /root/.ssh/id_rsa")
        semantic = _semantic_from_impact(impact)
        assert "凭据" in semantic, semantic
        assert not semantic.startswith("想只读查看"), semantic


class TestMarkListHasOneOwner:
    """名单只能有一份。两份必漂 —— 漂出来的就是下一个 #159。"""

    def test_no_local_copy_of_the_mark_list(self) -> None:
        """名单只能有一份。判"有没有另起名单"要看**代码字面量**，不能看文本 ——
        python_risk 的注释里就有 `~/.ssh/id_rsa` 这种例子，文本级判断会把它当成名单。
        （本轮已经栽过一次 `src.index()` 命中注释，这里直接走 AST。）"""
        import ast

        from strands_backend.tools._credential_paths import CREDENTIAL_PATH_MARKS

        tools = Path(__file__).parent.parent / "strands_backend" / "tools"
        owner = tools / "_credential_paths.py"
        assert owner.exists(), "唯一主人文件不见了"
        marks = set(CREDENTIAL_PATH_MARKS)

        for py in sorted(tools.glob("*.py")):
            if py == owner:
                continue
            tree = ast.parse(py.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not isinstance(node, (ast.Tuple, ast.List)):
                    continue
                values = [
                    el.value
                    for el in node.elts
                    if isinstance(el, ast.Constant) and isinstance(el.value, str)
                ]
                overlap = marks.intersection(values)
                assert len(overlap) < 2, (
                    f"{py.name} 里疑似另起了一份名单：{sorted(overlap)}"
                )

    def test_both_channels_import_the_owner(self) -> None:
        """接线断言：两条通道都真从主人取（不取就等于名单失效）。"""
        tools = Path(__file__).parent.parent / "strands_backend" / "tools"
        for name in ("command_impact.py", "python_risk.py"):
            text = (tools / name).read_text(encoding="utf-8")
            assert "_credential_paths" in text, f"{name} 没接上唯一主人"

    def test_shared_list_covers_the_both_channels_cases(self) -> None:
        """同一条输入在两条通道上判级方向一致（都进审批），不要求数字相同。"""
        from strands_backend.tools.python_risk import analyze_python_code

        cmd_l = analyze("cat /root/.ssh/id_rsa")["max_risk_l"]
        py_l = analyze_python_code("print(open('/root/.ssh/id_rsa').read())")["risk_l"]
        assert cmd_l >= 3 and py_l >= 3, (cmd_l, py_l)


class TestClassifySegmentShape:
    def test_category_label_present_for_new_category(self) -> None:
        """新类别必须有中文标签 —— 前端显示的是 category_label，缺了就渲染成空。"""
        seg = classify_segment("cat /root/.ssh/id_rsa")
        assert seg["category_label"]
        assert seg["category"] == CATEGORY_CREDENTIAL
