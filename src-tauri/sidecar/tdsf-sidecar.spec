# -*- mode: python ; coding: utf-8 -*-
# TDSF sidecar PyInstaller spec
# 只读资源随包分发（frozen 后 __file__ 指向 _MEIPASS, datas 解压到同目录可读）:
#   - config/: 模型/功能开关/风险规则 yaml
#   - knowledge/corpus/: 内置教学语料种子（首启幂等索引入 knowledge.db）
#   - skills/builtin/: 内置 5 个运维技能
# 可写数据（.tdsf-data/*.db、skills-installed 等）由代码 frozen 分支重定向到
# exe 同级 .tdsf-data/（见 main.py / self_evolution.py / marketplace.py 等）。


a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('config', 'config'),
        ('knowledge/corpus', 'knowledge/corpus'),
        ('skills/builtin', 'skills/builtin'),
    ],
    hiddenimports=[],
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

