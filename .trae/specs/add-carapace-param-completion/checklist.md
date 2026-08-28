# Checklist — add-carapace-param-completion

## P0：Windows 参数预测 + 本地动态补全

- [ ] carapace 二进制已下载到 `src-tauri/bin/`（exe + linux-amd64），CHECKSUMS.txt 含版本与 SHA256
- [ ] `tauri.conf.json` resources 含 `bin/`，Rust `carapace_path()` dev/生产双路径解析有单测
- [ ] `param_complete` 命令可被前端 invoke，返回 `{value,description,tag}[]`
- [ ] 500ms 超时强杀生效；二进制缺失/解析失败时返回空数组且仅一条 warn 日志
- [ ] 输入 token 做控制字符过滤（防注入面）
- [ ] 本地终端输 `git checkout `（或 `git checkout ma`）弹分支/参数候选
- [ ] 本地终端输 `Get-ChildItem -` 弹 PowerShell 兼容候选（carapace powershell completer 或通用）
- [ ] 参数模式不再受 `env === 'linux'` 硬限制；windows/linux 分流正确
- [ ] `predictSeq` 防竞态覆盖新异步分支（快速连续输入无过期结果覆盖）
- [ ] 命令名预测（无空格）回归无损（现有测试全过）
- [ ] 选项 description 中文优先（tldr-zh 选项级 > carapace 英文）

## P1：SSH 远端动态补全

- [ ] SSH 终端（远端已装）输 `git checkout ` 弹**远端仓库**真实分支
- [ ] SSH 终端（远端未装）自动回退 Fig specs 静态层，行为与改造前一致
- [ ] 远端查询走独立 exec 通道：用户终端屏幕无回显、输入行不被打断、不进远端 history
- [ ] current token 经 shell 单引号安全转义（含 `'` 的 token 不破坏命令）
- [ ] 连接后检测异步执行，不阻塞/拖慢 SSH 连接
- [ ] 未装提示：一次性、非阻塞、可"本次忽略"、设置可永久关闭（持久化）
- [ ] 一键安装：SFTP 上传有进度、完成后 chmod +x 且复检通过、失败可重试
- [ ] 安装的二进制来源为官方 release，版本与 SHA256 已记录

## 总体门禁

- [ ] `pnpm typecheck` 0 错误
- [ ] `pnpm lint` 0 错误 0 警告
- [ ] `pnpm test` 全过（含新增 vitest）
- [ ] `pnpm build:web` 成功
- [ ] `cargo test` 全过（含新增单测）
- [ ] `pnpm tauri:dev` 桌面实测通过（验收标准 4 条全验）
- [ ] DEV-JOURNAL / ROADMAP / dev-state 收尾更新完成
