"""
test_no_bytecode_write.py — 跑测试不许往源码树里写 .pyc

起因（用户 2026-09-24 截图）：本机火绒把
`strands_backend/tests/__pycache__/test_python_run_approval.cpython-314.pyc`
报成 `Trojan/Python.ShellLoader.am` 并"已处理，删除文件"，一天三次 ——
因为那个测试的字符串常量里必须装着危险代码样本（#66 要断言它们被拦），
编译进 .pyc 后正好像是"解码后执行"的启发式特征。

这条用例钉的是**开关本身**：conftest 里那句 `sys.dont_write_bytecode = True`
一旦被删，这里当场红。（不用 `-B` 也行 —— 判据说的是结果，不是启动方式。）
"""

import sys


def test_bytecode_writing_is_disabled_for_the_suite():
    assert sys.dont_write_bytecode is True, (
        "conftest.py 里的 sys.dont_write_bytecode 没生效：\n"
        "跑测试会往源码树写 .pyc，本机杀毒会把含危险代码样本的测试块\n"
        "（strands_backend/tests/test_python_run_approval.py）报成\n"
        "Trojan/Python.ShellLoader.am 并删除。见 conftest.py 的说明。"
    )
