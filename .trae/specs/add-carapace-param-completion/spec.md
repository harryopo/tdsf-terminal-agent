# carapace 参数预测接入（P0 Windows 本地 + P1 SSH 远端）Spec

> change-id: `add-carapace-param-completion` · 2026-08-28 · 状态：待批准
> 调研依据：`docs/命令参数预测-调研与实施方案.md` + `opensource-reference/README-completion-research.md`（inshellisense/carapace-bin 源码已 clone 分析）

## Why

现有参数预测（Fig specs 静态层，2026-08-15）存在三个缺口：① Windows 本地终端参数阶段完全无预测（代码 `env === 'linux'` 硬限制）；② 无动态参数补全（`git checkout ` 补真实分支名、`cd ` 补目录、`kill ` 补 PID）；③ 参数选项描述为英文。竞品 Termius 已通过"SSH 会话内开额外 exec 通道取远端数据"实现远端补全（官方文档证实，修正此前调研结论），该路线成熟可行。

## What Changes

- **carapace-bin 二进制接入**（MIT 许可）：下载 windows_amd64 + linux_amd64 二进制，随安装包 resources 打包
- **范围界定**：P0 覆盖**跨平台 CLI**（git/docker/npm/kubectl/systemctl 等，carapace 1511 completer）在本地 pwsh 与 SSH 远端的参数补全；**PowerShell 原生 cmdlet**（Get-ChildItem -Path 等）的参数补全不含在本次范围（carapace 无 cmdlet completer），列入 P2 可选（TabExpansion2 常驻子进程路线，调研报告 Q1，另行拍板）
- **Rust 新增 `param_complete` 命令**：spawn 本地 carapace `export` 子进程，输出 JSON 候选，500ms 超时强杀，失败静默降级返回空
- **前端参数预测环境分流重构**：
  - 本地终端（windows env）：invoke `param_complete`（本地 carapace，覆盖 git/docker 等 656+ completer——本地 pwsh 里敲 git/容器命令同样受益）
  - SSH 终端（linux env）：invoke 现有 `ssh_command` 跑远端 `~/.local/bin/carapace`（动态值来自**远端真实环境**：远端 git 仓库的分支）→ 无远端二进制时回退现有 Fig specs 静态层（行为无损）
  - 移除 `prefix.includes(' ') && env === 'linux'` 硬限制
- **远端 carapace 安装链路**（P1，**无弹窗设计**）：SSH 连接后后台静默检测远端二进制；未安装时仅在 SSH 终端工具栏/状态区显示一个小图标（hover 提示"启用远端动态补全"，点击弹出安装面板）；不弹 Toast、不打断连接流程；设置页提供永久关闭检测的开关
- **参数选项描述中文化**：扩展 tldr-zh 生成器解析选项级中文说明（`-n` → 中文），静态回退层与 carapace description 合并时中文优先
- **不破坏现有**：命令名预测（history/词典/别名/fuzzy 三层）完全不动；Fig specs 静态参数层保留为回退路径

无 **BREAKING** 变更。

## Impact

- 受影响能力：终端命令预测（参数模式）、SSH 会话生命周期（新增安装提示）、安装包体积（+~70MB 两个二进制，用户已接受大体积路线）
- 受影响代码：
  - `src-tauri/src/modules/` 新增 param_complete 命令模块；`lib.rs` 注册
  - `src-tauri/tauri.conf.json` resources 增加二进制路径
  - `src/modules/terminal/lib/completionInjection.ts`（参数模式分流）
  - `src/lib/spec-data/paramSuggest.ts`（保留为回退，可能小改签名）
  - `src/modules/ssh-explorer/`（安装提示 UI + store 状态）
  - `scripts/` tldr-zh 生成器扩展 + `src/lib/spec-data/generated/tldr-zh.ts` 重新生成
  - `src/lib/suggest-engine.ts`（SuggestionResult 类型若需扩展 arg 来源标记）

## ADDED Requirements

### Requirement: 本地参数动态补全（P0）
本地（Windows）终端在参数阶段（输入含空格）SHALL 调用 Rust `param_complete` 命令：spawn 打包内的 carapace.exe（`carapace <cmd> export <tokens...> <currentWord>`），解析 JSON 输出 `{values:[{value,display,description,style,tag}]}` 转为弹窗候选。

#### Scenario: 本地 git checkout 弹分支
- **WHEN** 用户在本地终端输入 `git checkout `（尾随空格）或 `git checkout ma`
- **THEN** 弹窗显示本地 git 仓库的分支/参数候选（如 `main`、`-b`），已输入前缀做过滤，10-30ms 内出现

#### Scenario: carapace 失败静默降级
- **WHEN** carapace 进程启动失败、超时（500ms）或输出非 JSON
- **THEN** 返回空候选，弹窗不出现，无报错弹窗、无日志刷屏（单条 warning 允许）

### Requirement: SSH 远端参数动态补全（P1）
SSH 终端参数阶段 SHALL 经现有 `ssh_command` invoke 在远端执行 `~/.local/bin/carapace <cmd> export ... 2>/dev/null`，返回远端真实环境候选。

#### Scenario: SSH git checkout 弹远端分支
- **WHEN** 已安装远端 carapace 的 SSH 会话中输入 `git checkout `
- **THEN** 弹窗显示**远端仓库**的分支候选（非本地）

#### Scenario: 远端未装二进制回退静态层
- **WHEN** 远端无 carapace（`command -v` 检测失败）或 exec 超时
- **THEN** 回退现有 Fig specs 静态参数预测（options/subcommands/静态值），行为与当前一致

#### Scenario: 查询不污染用户终端
- **WHEN** 任意远端补全查询发生
- **THEN** 用户终端屏幕无回显、PTY 输入行不被打断、命令不进入远端 history（exec 独立 channel，天然满足）

### Requirement: 远端安装链路（P1）
SSH 连接成功后 SHALL 后台检测远端 `~/.local/bin/carapace` 存在性；不存在时弹一次性非阻塞提示（Toast/横幅），提供"一键安装"（SFTP 上传打包内 linux_amd64 二进制 + `chmod +x`，进度反馈）；用户可在设置中永久关闭该提示。

#### Scenario: 一键安装成功
- **WHEN** 用户点击提示中的"安装"
- **THEN** 显示上传进度，完成后 exec `chmod +x` + 存在性验证，提示"已启用远端动态补全"，后续参数预测走远端

#### Scenario: 提示可关闭不打扰
- **WHEN** 用户关闭提示或设置中关闭开关
- **THEN** 该会话不再提示；关闭开关后所有会话不再提示（preferences 持久化）

### Requirement: 参数描述中文化
候选 description SHALL 中文优先：静态选项说明取 tldr-zh 选项级解析结果；动态值（分支/文件/PID）无翻译必要直接展示；carapace 英文 description 作为兜底。

#### Scenario: 选项中文说明
- **WHEN** 弹窗候选为 `-n` / `--noheadings` 等选项且 tldr-zh 有对应说明
- **THEN** 副标题显示中文说明而非英文

## MODIFIED Requirements

### Requirement: 参数预测环境分流（改自现有"参数模式仅 linux"）
`completionInjection.ts` 参数模式（输入含空格）SHALL 按终端环境分流：
- `windows` env → invoke 本地 `param_complete`
- `linux` env（SSH）→ invoke `ssh_command`（远端 carapace）→ 空则回退 `paramSuggest`（Fig specs）

现有 `predictSeq` 防竞态 SHALL 继续生效（异步结果序号校验，丢弃过期结果）。

## REMOVED Requirements

### Requirement: 参数模式仅限 linux 环境
**Reason**: 被"环境分流 + 双端 carapace"取代，Windows 本地不再被硬限制排除。
**Migration**: `prefix.includes(' ') && env === 'linux'` 条件改为 `prefix.includes(' ')` + 内部分流逻辑；原 linux 分支逻辑保留为回退路径。

## 安全红线（全程约束）

- 只调用 carapace 声明式 spec 产物，不执行 Fig generator 任意 JS postProcess
- 动态查询命令只读（git branch / docker ps 等，由 carapace action 决定），500ms 超时强杀
- 远端安装仅上传官方 release 二进制（记录版本 + SHA256），路径固定 `~/.local/bin/carapace`

## 验收标准（总体）

1. 本地终端：`git checkout ` 弹分支、`Get-ChildItem -` 弹参数、`docker ` 弹子命令
2. SSH 终端（已装远端）：`git checkout ` 弹**远端**分支、`systemctl ` 弹子命令
3. SSH 终端（未装远端）：回退静态层无回归
4. 五绿门禁全过；命令名预测行为与现状一致（回归无损）
