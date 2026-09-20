# -*- mode: python ; coding: utf-8 -*-
# TDSF sidecar PyInstaller spec
# 只读资源随包分发（frozen 后 __file__ 指向 _MEIPASS, datas 解压到同目录可读）:
#   - config/: 模型/功能开关/风险规则 yaml
#   - knowledge/philosophy/: 随源码分发的通用 Linux 教学语料
#   - skills/builtin/: 内置 5 个运维技能
# 可写数据（.tdsf-data/*.db、skills-installed 等）由代码 frozen 分支重定向到
# exe 同级 .tdsf-data/（见 main.py / self_evolution.py / marketplace.py 等）。


import pathlib

# 工具模块必须显式声明为 hiddenimports —— registry 用 "module:attr" 点路径字符串
# + importlib 延迟解析工厂（防循环依赖），PyInstaller 的静态分析看不到这些导入。
# 实测证据（2026-09-19 打 1.0.1 时）：不声明的话 PYZ 里只有 14/26 个
# strands_backend.tools.* 模块，python_run / ask_user / knowledge_* /
# service_manage 等在安装包里根本不存在，而 make_all_ops_tools 只 warning 跳过
# → 装完的 agent 静默少掉一半工具。列目录（不 import 包，零副作用）即全覆盖。
#
# SPECPATH 是 PyInstaller 注入的“spec 文件所在目录”。这里没有 __file__ ——
# spec 是被 exec 进一个自建命名空间的，写 __file__ 会当场 NameError（实测过）。
_TOOLS_DIR = pathlib.Path(SPECPATH) / "strands_backend" / "tools"  # noqa: F821
_tool_hiddenimports = sorted(
    f"strands_backend.tools.{p.stem}"
    for p in _TOOLS_DIR.glob("*.py")
    if p.name != "__init__.py"
)


a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('config', 'config'),
        ('knowledge/philosophy', 'knowledge/philosophy'),
        ('skills/builtin', 'skills/builtin'),
    ],
    hiddenimports=_tool_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 大件旁路排除: chromadb/torch 等仅在降级路径被引用 (rag 主链路是 FTS5);
    # numpy 保留 (fastembed/sqlite_vec 的 embedding 增强需要它)。
    excludes=['chromadb', 'sentence_transformers', 'torch', 'matplotlib'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='tdsf-sidecar',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

# onedir 模式: 启动无需解压 (onefile 冷启动 30-60s 会超过 Rust READY_TIMEOUT),
# 产物 tdsf-sidecar/tdsf-sidecar.exe + tdsf-sidecar/_internal/ 由 Tauri resources 整目录分发
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='tdsf-sidecar',
)

