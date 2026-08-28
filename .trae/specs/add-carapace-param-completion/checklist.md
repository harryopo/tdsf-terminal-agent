# Checklist — add-carapace-param-completion

> ✅ 2026-08-28 全部核对完成（除两项待用户实测，见文末）

## P0：Windows 参数预测 + 本地动态补全

- [x] carapace 二进制已下载到 `src-tauri/bin/`（exe + linux-amd64），CHECKSUMS.txt 含版本与 SHA256（二进制本体已 gitignore，fetch-carapace.ps1 可恢复）
- [x] `tauri.conf.json` resources 含 `bin/`，Rust `carapace_path()` dev/生产双路径解析有单测
- [x] `param_complete` 命令可被前端 invoke，返回 `{value,description,tag}[]`
- [x] 500ms 超时强杀生效（kill_on_drop）；二进制缺失/解析失败时返回空数组且仅一条 warn 日志
- [x] 输入 token 做控制字符过滤（\0/\n/\r，防注入面）
- [x] 本地终端输 `git checkout <分支前缀>` 弹分支/参数候选（协议实测：`git export git checkout t` → terax-clone-v0；**桌面端验证待用户**）
- [x] ~~本地终端输 `Get-ChildItem -` 弹 PowerShell 原生 cmdlet 候选~~ → **spec 已修订**：carapace 无 cmdlet completer，PowerShell 原生补全列入 P2（TabExpansion2 路线）；跨平台 CLI（git/docker/npm 等）本地可用
- [x] 参数模式不再受 `env === 'linux'` 硬限制；windows/linux 分流正确
- [x] `predictSeq` 防竞态覆盖新异步分支（结构保持，测试过）
- [x] 命令名预测（无空格）回归无损（completionInjection.test 16 用例全过）
- [x] 选项 description 中文优先（tldr-zh 选项级 168 命令/1291 选项 > carapace 英文）

## P1：SSH 远端动态补全

- [x] SSH 终端（远端已装）输 `git checkout ` 弹**远端仓库**真实分支（远端 `cd '<cwd>' && carapace export`，cwd 经 sshStore.currentPathBySession 跟踪）——**桌面端验证待用户**
- [x] SSH 终端（远端未装）自动回退 Fig specs 静态层，行为与改造前一致（remoteParamComplete 返回 null → suggestParams）
- [x] 远端查询走独立 exec 通道（ssh_command）：用户终端屏幕无回显、输入行不被打断、不进远端 history
- [x] current token 经 shell 单引号安全转义（`'` → `'\''`，含测试）
- [x] 连接后检测异步执行（fire-and-forget），不阻塞/拖慢 SSH 连接
- [x] 未装提示：**无弹窗设计**——连接后静默检测，SSH 工具栏图标入口（hover 提示），Popover 安装面板，设置页开关持久化
- [x] 一键安装：mkdir→sftp_upload_file（Rust 内部读盘+上传，80MB 不经 IPC）→chmod+verify→缓存失效；失败静默可重试
- [x] 安装的二进制来源为官方 release，版本与 SHA256 已记录（CHECKSUMS.txt）

## 总体门禁

- [x] `pnpm typecheck` 0 错误
- [x] `pnpm lint` 0 错误 0 警告
- [x] `pnpm test` 全过（1046，含新增 58）
- [x] `pnpm build:web` 成功
- [x] `cargo test` 全过（lib 342 + 集成 25/27/1；tauri dev 占用 debug exe 时用 `CARGO_TARGET_DIR=target-test` 隔离）
- [ ] `pnpm tauri:dev` 桌面实测通过 —— **待用户**（验收 4 条：本地 git checkout 弹分支 / SSH 装远端后弹远端分支 / 未装回退静态层 / 命令名预测回归）
- [x] DEV-JOURNAL / ROADMAP / dev-state 收尾更新完成（§37.72 / #32）
