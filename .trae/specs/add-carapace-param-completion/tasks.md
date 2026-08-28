# Tasks — add-carapace-param-completion

## P0：Windows 参数预测 + 本地动态补全

- [ ] T1: 获取 carapace 二进制 + 打包配置
  - [ ] T1.1: 从 GitHub releases（或镜像 gh-proxy.com/ghfast.top）下载 carapace-bin 最新版 windows_amd64 与 linux_amd64 二进制，解包到 `src-tauri/bin/carapace.exe` 与 `src-tauri/bin/carapace-linux-amd64`；记录版本号与 SHA256 到 `src-tauri/bin/CHECKSUMS.txt`
  - [ ] T1.2: 验证 `carapace.exe --help` 可执行（PowerShell 运行确认版本输出）
  - [ ] T1.3: `src-tauri/tauri.conf.json` resources 增加 `"bin/"`；确认 Rust 侧 dev/生产双路径解析（dev = `CARGO_MANIFEST_DIR/bin`，生产 = resource dir），写成公共函数 `carapace_path(kind)`

- [ ] T2: Rust `param_complete` 命令
  - [ ] T2.1: 新增 `src-tauri/src/modules/param_complete.rs`：`param_complete(cmd: String, tokens: Vec<String>, current: String, cwd: Option<String>)` → spawn `carapace.exe <cmd> export <tokens...> <current>`（当前词为空传 `""`；cwd 不传则继承进程目录），stdout UTF-8 解析 JSON `{values:[{value,display,description,style,tag}]}` → 返回 `Vec<ParamCandidate{value,description,tag}>`
  - [ ] T2.2: 500ms `tokio::time::timeout` 超时 kill；任何错误（找不到二进制/解析失败/非零退出）→ 返回空数组 + `log::warn!` 单条；输入 token 不含控制字符（防注入面）
  - [ ] T2.3: `lib.rs` 注册命令 + `invoke_handler`
  - [ ] T2.4: cargo 单元测试：JSON 解析纯函数测试（真实 carapace 输出样例 fixture）；路径解析函数测试（dev/生产模拟）

- [ ] T3: 前端参数模式环境分流
  - [ ] T3.1: `completionInjection.ts`：参数模式条件从 `prefix.includes(' ') && env === 'linux'` 改为 `prefix.includes(' ')`；分支：`env === 'windows'` → `invoke('param_complete', ...)`（cmd/tokens/current 由现有 `parseCommandLine` 结果映射，尾随空格时 current 传空串）；`env === 'linux'` → T5 的 `invoke('ssh_command', ...)` 远端 carapace，结果空时回退现有 `suggestParams`（Fig specs）
  - [ ] T3.2: 候选映射：carapace value/display → `SuggestionResult{kind:'arg', source:'arg'}`；与回退层结果合并去重（按 value）；`predictSeq` 序号校验包裹两个异步分支（复用现有模式）
  - [ ] T3.3: vitest：windows env 参数模式走 param_complete（mock invoke）、linux env 远端成功/失败回退、predictSeq 过期丢弃、合并去重
  - [ ] T3.4: `completionInjection.test.ts` 增补回归：命令名预测（无空格路径）行为不变

- [ ] T4: 参数描述中文化（tldr-zh 选项级）
  - [ ] T4.1: 扩展 `scripts/` tldr-zh 生成器：解析 pages.zh 的选项行（`- n, --name` → 中文说明），生成 `OPTION_ZH: Record<命令名, Record<选项名, 中文>>`（若现有生成器结构不支持，单独生成 `tldr-zh-options.ts`）
  - [ ] T4.2: 候选 description 组装时中文优先：`OPTION_ZH[cmd]?.[opt]` > carapace description > Fig 英文 description
  - [ ] T4.3: vitest：中文化优先级纯函数测试

## P1：SSH 远端动态补全

- [ ] T5: 远端查询 + 检测（依赖 T2/T3）
  - [ ] T5.1: 前端 ssh-bridge 封装 `remoteParamComplete(sessionId, cmd, tokens, current)`：构造 `~/.local/bin/carapace <cmd> export <tokens...> '<current>' 2>/dev/null`（current 经 shell 单引号转义，内嵌 `'` 写成 `'\''`），invoke 现有 `ssh_command`（timeout 2s），解析 stdout JSON → 候选数组；失败/超时/exit≠0 → 返回 null（调用方回退静态层）
  - [ ] T5.2: `remoteCarapaceInstalled(sessionId)`：invoke `ssh_command` 执行 `command -v ~/.local/bin/carapace >/dev/null 2>&1 && echo __TDSF_YES__`，按标记判断；结果缓存到 sshStore（会话级）
  - [ ] T5.3: vitest：命令构造与转义纯函数测试、标记解析、null 回退

- [ ] T6: 远端安装链路 UI（依赖 T5）
  - [ ] T6.1: Rust/复用：SFTP 写文件能力确认（现有 sftp-bridge 若只支持文本，需扩展二进制 write；`russh-sftp` 支持大文件，分块写）+ exec `chmod +x ~/.local/bin/carapace`（复用 ssh_command）
  - [ ] T6.2: 连接成功后异步检测（不阻塞连接流程）→ 未装且设置未关闭 → 非阻塞 Toast/横幅"检测到远端未安装 carapace，是否安装以启用动态补全？"（含"安装"与"本次忽略"）；设置页新增开关（preferences 持久化）
  - [ ] T6.3: 安装流程：上传进度提示（已传字节/总字节）→ chmod → `remoteCarapaceInstalled` 复检 → 成功提示；失败可重试
  - [ ] T6.4: vitest + 组件测试：提示出现/忽略/关闭开关不弹

- [ ] T7: 门禁验证 + 收尾
  - [ ] T7.1: 五绿门禁：`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build:web` / `cargo test`（含新增单测）
  - [ ] T7.2: 文档收尾：DEV-JOURNAL 复盘 + ROADMAP 新条目 + dev-state 更新
  - [ ] T7.3: tauri:dev 桌面实测（用户配合）：本地 `git checkout ` 弹分支、`Get-ChildItem -` 弹参数、SSH 连 VM 装 carapace 后 `git checkout ` 弹远端分支、未装回退静态层

# Task Dependencies

- T2 依赖 T1（需要二进制路径函数）；T3 依赖 T2；T4 独立可与 T3 并行
- T5 依赖 T3（分流骨架）+ T1（linux 二进制）；T6 依赖 T5
- T7 最后（T1-T6 全部完成后）
- 可并行组：[T1→T2→T3] 主线 ∥ [T4] ∥ [T5.1/T5.3 纯函数部分提前写]
