# Changelog

Version numbering: `0.x` builds are pre-stable releases; `1.x` is reserved for the first
stable release.

## Unreleased

- Remote file overwrites now require approval in both Auto and Confirm modes, while
  retaining backup, version-hash checks and post-write verification.
- Python risk classification recognises qualified built-ins, imported aliases and
  standard file-opening APIs. Static classification is not an OS sandbox.
- SSH remote-forward targets are isolated by transport generation; one connection
  cannot use another connection's registered local target or cancel its forwarding.
- Public repository presentation and history cleanup preserve application code,
  formal tests and license notices. Existing release installers are not rebuilt by
  these source changes.

## 0.9.2

Windows x64 预稳定版，整合已合入主分支的修复与改进。

- 修复独立设置窗口的打开与缩放同步，改善侧栏标题、文本选中和弹窗布局。
- 加固终端与 SSH 会话的归属和退出清理，避免欢迎页显示无关的后台连接。
- 随安装包提供按来源许可筛选的精简离线知识库；首次启动初始化，不覆盖已有用户数据库。
- 收口文件与配置项的删除确认，减少误操作。

## 0.9.1

装机验收后的修复。

- SSH 连接失败会弹出分步诊断：走到哪一步、卡在哪一步、服务器支持哪些登录方式、下一步怎么办。
- 「测试连接」的结果只在 SSH 标签页显示，切到本地或 WSL 后不再残留。
- 远程终端的命令预测认得 shell 别名了，输入 `l` 能预测出 `ll`。
- 检查更新失败时显示中文说明，不再抛英文原文。

## 0.9.0

Pre-stable Windows x64 build. It carries the capabilities of the earlier internal builds
plus the fixes listed below.

**Capabilities**

- Strands-only Linux operations agent with visible terminal execution.
- Local, WSL and SSH workspaces with remote file browsing and editing.
- Auto / confirm / observe / teaching interaction modes.
- Command prediction, terminal translation, skills, snippets and offline knowledge retrieval.
- Windows current-user NSIS installer with a bundled Python sidecar.

**Signed automatic updates**

- Released builds check GitHub Releases for a newer version at start-up and at most once per
  day; the result appears in the status bar.
- Downloading and installing stays user-initiated: the package size is shown first, and the
  update signature is verified before installation.
- Installing is refused while an approval is waiting or a turn is still running; otherwise the
  agent turn, SSH sessions, terminals, language servers and the bundled sidecar are closed out
  first, so an update does not leave background processes behind.

**Security**

- Reading credential files is no longer treated as a harmless read-only action:
  `cat ~/.ssh/id_rsa`, `head /etc/shadow` and equivalents now require approval, on both the
  SSH command path and the Python path.
- Tool output that reaches the model is redacted for known secret shapes, and the configured
  API key is no longer written to disk in plaintext.

**Interface**

- Remote parameter completion now has a settings entry: the servers you are connected to are
  listed with their install state, an install can be started from there, and a failed attempt
  reports the underlying error.
