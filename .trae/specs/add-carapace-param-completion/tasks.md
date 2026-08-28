# Tasks — add-carapace-param-completion

> ✅ 全部完成（2026-08-28，commits 0f66a72 / 7fd79a3 / ad2b6f6 / bbed100；门禁记录见 DEV-JOURNAL §37.72）

## P0：Windows 参数预测 + 本地动态补全

- [x] T1: 获取 carapace 二进制 + 打包配置
  - [x] T1.1: 下载 v1.7.3 windows_amd64 + linux_amd64 → `src-tauri/bin/`（**二进制不入 git**，CHECKSUMS.txt 记录版本/SHA256/协议，`scripts/fetch-carapace.ps1` 一键恢复）
  - [x] T1.2: `carapace.exe --version` 验证（1.7.3）+ export 协议实测（`git export git checkout t` → terax-clone-v0 分支）
  - [x] T1.3: tauri.conf.json resources 加 `bin/`；Rust `carapace_path()` dev(CARGO_MANIFEST_DIR)/生产(resource_dir) 双路径纯函数 + 单测
- [x] T2: Rust `param_complete` 命令
  - [x] T2.1: param_complete.rs（argv=[exe,cmd,"export"]++tokens++[current]，CARAPACE_SHELL=export，stdout JSON→ParamCandidate）
  - [x] T2.2: 500ms timeout + kill_on_drop；全部失败路径 warn 单条 + Ok(vec![])；\0/\n/\r 入参过滤
  - [x] T2.3: lib.rs 注册（param_complete + carapace_linux_path + sftp_upload_file）
  - [x] T2.4: 12 个 cargo 单测（真实 fixture/畸形 JSON/过滤/路径）全过
- [x] T3: 前端参数模式环境分流
  - [x] T3.1: completionInjection 参数模式去 env 硬限制；windows→invoke param_complete（**含本地 cwd**）；linux→远端 carapace（**含远端 cd 前缀**）→回退 suggestParams
  - [x] T3.2: mergeCandidates（carapace 优先去重、限 8、zhDescription 钩子）；predictSeq 包裹保持
  - [x] T3.3: vitest 46 用例（转义/解析/构造/合并/注册表/远端/安装）
  - [x] T3.4: 命令名预测回归（completionInjection.test 16 用例过）
- [x] T4: 参数描述中文化（tldr-zh 选项级）
  - [x] T4.1: build-tldr-zh.mjs 扩展（`{{[-a|--all]}}` 占位符组 + 裸 token；短/长/组合拆分变体）→ tldr-zh-options.ts（168 命令/1291 选项，98.5KB）
  - [x] T4.2: mergeCandidates zhDescription 钩子接线（中文 > carapace > Fig）
  - [x] T4.3: vitest 5 用例

## P1：SSH 远端动态补全

- [x] T5: 远端查询 + 检测
  - [x] T5.1: remoteParamComplete（escapeShSingleQuote 全词转义 + 2s ssh_command + null 回退）
  - [x] T5.2: remoteCarapaceInstalled（command -v + __TDSF_CARAPACE_YES__ 标记 + 会话级缓存 + invalidate）
  - [x] T5.3: vitest（转义/标记/缓存/null 回退）
- [x] T6: 远端安装链路 UI（无弹窗设计）
  - [x] T6.1: Rust sftp_upload_file（Rust 内读盘+SFTP 写，不经 IPC 搬 80MB）+ carapace_linux_path
  - [x] T6.2: 连接后静默检测（fire-and-forget 不阻塞）+ SshCarapaceBadge 工具栏图标（Popover 安装面板）+ 设置开关 sshRemoteCarapacePrompt
  - [x] T6.3: 安装流程 mkdir→upload→chmod+verify→缓存失效，进度四阶段，失败静默可重试
  - [x] T6.4: vitest（安装顺序构造/preferences 逻辑）
- [x] T7: 门禁验证 + 收尾
  - [x] T7.1: 五绿全过：tsc 0 / eslint 0 / vitest **1046**(+58) / build:web / cargo 全量（target-test 隔离绕 tauri dev 文件锁）
  - [x] T7.2: DEV-JOURNAL §37.72 + ROADMAP #32 + dev-state 头部
  - [x] T7.3: tauri:dev 桌面实测 —— **待用户**（本地 `git checkout t` / SSH 一键装远端 / 回退层）

# Task Dependencies

- 全部依赖链已闭合：T1→T2→T3→(T5→T6)→T7；T4 独立已合并
- 实施方式：3 并行 sub-agent（Rust/前端/tldr-zh）+ 主线程集成修复（cwd 注册表、循环依赖规避、命令对齐）
