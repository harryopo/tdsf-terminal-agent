"""
src-tauri/sidecar/conftest.py — 跑测试时不写 .pyc（本机杀毒会误报并删除）

为什么放在 conftest 而不是 npm script 的 `-B`：这条约束跟"怎么启动 pytest"无关，
写在这里才覆盖所有入口（`pnpm test:python`、手跑的 `python -m pytest`、
IDE 运行按钮、CI）。有守卫用例盯着它：tests/test_no_bytecode_write.py。

现场（用户 2026-09-24 截图，火绒「安全日志 / 病毒防护 / 文件实时监控」）：
    病毒名称 Trojan/Python.ShellLoader.am
    病毒路径 .../strands_backend/tests/__pycache__/test_python_run_approval.cpython-314.pyc
    操作类型 执行 → 操作结果 已处理，删除文件
    操作进程命令行 ...\\.venv\\Scripts\\python.exe -m pytest -q

不是感染。`strands_backend/tests/test_python_run_approval.py` 是 #66
「python_run 危险构造才弹审批」的测试，它的字符串常量里**必须**装着若干
"要被判成危险"的代码样本（起子进程执行命令的、解码后再反序列化执行的、
删根目录的），否则没法断言这些构造会被拦下来。编译成 .pyc 之后，这些字面量
正好凑成启发式引擎认的"解码后执行"特征 ⇒ 每跑一次测试就重新触发一次。
杀软删掉的是 .pyc（源码无损、用例照常通过），但安全日志会一直刷。

两条不走的路，记在这里免得下一手又试：
- **改测试内容绕开特征**：会削弱断言，等于为了让扫描器舒服而少测一种攻击形状。
- **让他加目录白名单**：那是他机器的安全策略，不由我替他决定。
不产生 .pyc 就没有可扫的东西，且一寸测试强度都不让。

注意：conftest 自己是在这个开关生效**之前**被编译的，所以本文件的注释里
也不要出现真正的样本字面量 —— 描述它，别抄它。
"""

import sys

# pytest 在导入任何测试模块之前先导入 rootdir 的 conftest，所以这里改是有效的。
sys.dont_write_bytecode = True
