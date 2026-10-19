# Changelog

Version numbering: `0.x` builds are pre-stable releases; `1.x` is reserved for the first
stable release.

## Unreleased

- Keep failed remote-completion probes retryable, reject unconfirmed install
  status, and prevent refresh or late probes from overwriting installation state.
  Show refresh guidance before querying connected servers.
- Correlate remote-file and standalone teaching cards through completion or
  errors. Bind remote-write approvals to their original call and SSH target;
  reject SSH output on non-command records. Local Python approvals keep their
  actionable fallback, and file contents stay out of remote-read UI events.
- Show the unconfigured-model prompt in Chinese. Remove the extra evidence panel
  and fixed evidence footnotes from chat while preserving backend evidence,
  post-write verification and safety approvals.
- Add a monochrome session-inspector dialog through the chat's Confidence button:
  runtime, conversation and tool-evidence views, search, actual call-ID links and
  confirmed local redacted JSON export. Bounded records are not a complete
  persistent audit or calibrated correctness probabilities. Existing installers
  do not yet include this feature.
- Keep the confirmed diagnostic-export preview unchanged while its save is in
  progress, and restore export controls after completion or failure.
- Add correlated cards for terminal readback and other tools without an existing
  event owner. Preserve structured results, cancellations and errors without
  duplicating SSH cards; pair Python, suggestion and teaching-wrapper events
  with call IDs. Existing execution and approval policies remain unchanged.
- Add PowerShell directory-size suggestions with literal paths, recursive file
  lengths and descending totals. Explain unreadable files and logical-size limits;
  unmatched suggestions use neutral theme colours and cannot be run.

- SSH executor approvals appear in their original tool card only when call,
  chat and target identities match. Folding tool details does not hide the
  approval. Within their owning chat, unbound requests and questions remain
  answerable in the fallback area; response state and rejection notes survive
  placement changes. This
  changes presentation only, not backend approval or execution rules.
- Sidecar approval and question cards show response submission and disable repeat
  actions while awaiting acknowledgement. Invalid acknowledgements retain the
  card and answer with a visible retry message; retrying responds to the request,
  not the command. Late RPC failures cannot revive settled requests. The frontend
  read-only-trust indicator updates only after an accepted approval for the same
  known, currently active chat. Backend execution and safety rules are unchanged;
  response acceptance does not mean command completion.
- Remove the legacy in-memory OSC diagnostic buffer that could retain discarded
  SSH input and directory paths. Terminal input and directory-following behavior
  remain unchanged; this does not erase existing terminal history or saved logs.
- Settled approval and question requests cannot be restored by a delayed pending-list
  snapshot. Other pending requests are still recovered, without changing backend
  approval or cancellation rules.
- Agent tool cards accept the SDK's running `input-available` state and collect
  background SSH output by call identity even while collapsed. Standard output
  and standard error remain separately visible; visible-terminal output is labelled
  as merged. Missing identities are not guessed, and final output is not appended twice.
- Structured tool outcomes retain stdout, stderr, messages and reported exit codes
  instead of being flattened into error text. Rejected, cancelled and indeterminate
  results are distinct from execution failures; missing exit status is not shown
  as command completion. Backend safety and execution verdicts are unchanged.
- Windows builds restore and verify both pinned completion binaries before packaging,
  and reject NSIS installers that omit them. Archive and extracted-binary checksums
  are checked separately, so verified local resources are not downloaded again.
- Command prediction discards stale replies after input changes, cancellation or
  terminal-target changes, while retaining debouncing and single-flight requests.
- Dynamic command candidates accumulate without losing earlier batches. Common
  operations commands gain short Chinese descriptions, reused by history suggestions.
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
