"""sidecar 自报版本的唯一真源（#84）

版本号的真源在 `package.json` / `tauri.conf.json` / `Cargo.toml` 三处清单里，由
`scripts/check-release-version.ps1` 在打包前比对。这里再抄一份不是重复，而是因为
**frozen 运行时读不到包元数据**：`importlib.metadata` 在 PyInstaller 打包后不保证带
`pyproject.toml` 的版本，`tauri.conf.json` 又不在 sidecar 的搜索路径里。

所以约定：改版本时这一行必须跟着改，漂移由两条门禁共同挡住 ——
`tests/test_sidecar_version_parity.py`（普通 pytest 门禁，比对三处清单）
与 `check-release-version.ps1`（打包门禁，把这里当第五处比）。
"""

SIDECAR_VERSION = "1.0.1"
