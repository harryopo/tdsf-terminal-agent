# 开源 AI 运维终端 — 竞品对比与借鉴规划（2026-08-28）

> **调研方式**：3 个用户指定项目 clone 全量源码分析（Chaterm / nyaterm / Netcatty）+ 30+ 项目联网全景调研（GitHub topic / trending / 中文社区）
> **源码与分析报告**（均在 `opensource-reference/`）：`Chaterm/` + `ANALYSIS-Chaterm.md` · `nyaterm/` + `Netcatty/` + `ANALYSIS-nyaterm-Netcatty.md` · 全景报告见本文件 §6 · carapace/inshellisense 见 `README-completion-research.md`
> **用途**：修正认知 → 提炼可借鉴机制 → 分期纳入 ROADMAP。**本文是规划依据，替代此前"竞品均无 XX"类不严谨结论。**

---

## 1. 三大对标项目横向对比

| 维度 | Chaterm v0.12.2 | nyaterm v1.2.5 | Netcatty |
|------|-----------------|----------------|----------|
| 定位 | AI 运维终端（CNCF 收录） | AI 终端工作台（个人精品） | AI 运维工作台（工程化最全） |
| 技术栈 | Electron 43 + Vue 3 + 纯 Node（ssh2/node-pty） | **Tauri 2 + React 19 + Rust（与我们同栈！）** | Electron + Node（AgentRuntime harness） |
| AI 内核 | 改编自 Cline（Apache 派生） | Rust genai ReAct 循环 | 自研 AgentRuntime（60+ 工具单一真源） |
| 许可证 | **GPL-3.0** ⚠️ | **MIT** ✅ | **GPL-3.0** ⚠️ |
| 活跃度 | 6101 commits，2026-08-26 仍在提交 | 1379 commits，2026-08-28 当天 | 3852 commits，2026-07-26 |
| 可否复制代码 | ❌ 只学设计（GPL 传染） | ✅ 可直接抄（MIT） | ❌ 只学设计 |

**合规红线**：Chaterm / Netcatty 为 GPL-3.0（且 Chaterm 内含 Cline 派生代码）——**只能借鉴机制思路，禁止复制任何代码**；nyaterm 为 MIT 可放心移植。全景清单中 Open Interpreter（AGPL）、JumpServer/1Panel/mosh（GPL）、Spug（AGPL）同理只学设计；MIT/Apache 项目（shell_gpt、aichat、gptme、sshx、ttyd、Warpgate、Atuin、Nexterm 等）可用。

## 2. 功能差距总表（它们有、我们没有的）

> 合并三项目差距分析去重而成。P0=应尽快做，P1=重要，P2=可选，P3=观察。
> ✅ 标记 = 已有替代或部分覆盖。

| # | 功能 | 来源 | 重要度 | 难度 | 说明 |
|---|------|------|--------|------|------|
| 1 | **AI ghost text 参数补全**（部分输入→快模型生成→2s 超时→补全+中文一句话解释） | Chaterm | P0 | 中 | 与 carapace 静态/动态补全互补：carapace 先行，AI 兜底生成 |
| 2 | **CMD 模式**（自然语言→单命令卡片 Apply/Copy/Reject，执行前校验当前窗口是否目标主机） | Chaterm | P0 | 中 | 我们 Agent 面板偏"对话"，缺"命令卡片"轻交互 |
| 3 | **AI 解释报错输出**（命令失败自动解释 stderr） | Chaterm/termaid | P0 | 中 | Teach 模式天然延伸；教学场景核心价值 |
| 4 | **交互检测器**（y/n、password、pager 自动应对：规则正则先行 + LLM 兜底） | Chaterm | P1 | 中 | 提升Agent 自主执行成功率 |
| 5 | **AI 上下文脱敏**（发给 LLM 前抹除密码/token/IP） | nyaterm | P0 | 低 | `redaction.rs` 思路，MIT 可参考实现 |
| 6 | **被拦截后 AI 禁止伪造输出**（系统提示层防绕过） | Chaterm | P0 | 低 | 与我们 RiskGuard 配套的安全提示强化 |
| 7 | **透明执行**（Agent 执行命令时把真实终端 show 给用户看） | Chaterm | P0 | 中 | 我们有 visible 模式，需补"自动切前台+高亮"教学体验 |
| 8 | **终端关键词高亮 + 行号时间戳 gutter + 动作链接**（URL/IP 可点击） | nyaterm | P1 | 中 | xterm decorations 可实现 |
| 9 | **终端内搜索**（xterm search addon UI 化） | nyaterm | P1 | 低 | `@xterm/addon-search` 已在依赖中，只缺 UI |
| 10 | **known-hosts 学习转正**（临时接受的主机密钥→确认后写 known_hosts） | Netcatty | P1 | 低 | 我们 TOFU 已有断链修复，补转正 UX |
| 11 | **~/.ssh/config 导入**（解析 ssh_config 生成主机列表） | Netcatty | P1 | 低 | 教学场景学生导入机房主机很实用 |
| 12 | **竞品会话导入器**（Xshell/FinalShell/MobaXterm 凭据导入，nyaterm 支持 7 家） | nyaterm/Netcatty | P2 | 中 | 教学换机场景加分项 |
| 13 | **/summary-to-skill**（对话一键沉淀为可复用技能） | Chaterm | P1 | 中 | 与 Teach 模式 + 知识库天然契合 |
| 14 | **多主机批量执行**（逗号分隔 IP execute_command） | Chaterm/Netcatty | P2 | 中 | 教学班机管理铺垫 |
| 15 | **RTK 输出过滤 + offload 落盘**（token 治理） | Netcatty | P1 | 中 | 我们有两阶段压缩，补"大输出落盘引用" |
| 16 | **分离式终端执行**（terminal start/poll/stop 三段式，Agent 不阻塞） | Netcatty | P1 | 中 | 我们 ssh_command 已解耦，缺 start/poll 长任务形态 |
| 17 | **会话录制回放**（asciicast） | Netcatty | P2 | 中 | 方案书 §4.8 已有占位（UI 待接） |
| 18 | **教学广播/围观**（教师终端只读共享给学生） | sshx/ttyd/Girus | P1 | 大 | 全景调研最大机会：无人整合"教学全链路" |
| 19 | **Mosh/ET 断线续连** | uniTerm/mosh | P2 | 大 | 弱网机房场景 |
| 20 | **K8s/Docker 面板** | Netcatty/Termix | P3 | 大 | 超出教学 v1 定位 |

## 3. 我们更优处（守住差异化，不要被带偏）

- Tauri 2 性能与体积（vs Electron 双雄）、russh 原生 SSH、RiskGuard L1-L3 分级拦截、Teach 教学模式、划词翻译、实时监控、主题系统、HITL 审批、知识库
- **定位差异**：三个对标项目都是"工程师效率工具"，无人做"教学"——Teach/翻译/实训是我们护城河，借鉴功能时都应问一句"教学场景怎么用"

## 4. 借鉴机制精选（按主题）

### 4.1 AI 能力层
| 机制 | 参考实现 | 移植要点 |
|------|----------|----------|
| ghost text 补全 | Chaterm `controller/index.ts:890`（固定快模型 + 2s 超时 + CMD/EXP 两行协议） | 快模型走现有 llm_config；超时丢弃静默化；与 carapace 结果合并 |
| 命令卡片 CMD 模式 | Chaterm CMD 卡片（Apply/Copy/Reject） | 复用 Agent 面板 composer，输出结构化 card；执行走 RiskGuard |
| 报错解释 | Chaterm AI 解释输出 + termaid | 检测 exit≠0 → 截取 stderr → 快模型解释 → 气泡展示（Teach 开关控制） |
| 交互检测器 | Chaterm `interaction-detector/index.ts`（规则先行 LLM 兜底） | 前端正则（\[y/n\]/password/--More--）优先，未命中才 LLM |
| 脱敏 | nyaterm `core/ai/redaction.rs` | 正则库（password/token/private key/IPv4 内网段）在 transport.ts 注入前跑 |
| 防伪造提示 | Chaterm CommandSecurityManager 系统提示 | system prompt 追加"被 RiskGuard 拦截时如实报告，禁止编造执行结果" |
| token 治理 | Netcatty AgentRuntime（估算→预算→413 压缩→陈旧修剪） | 对照我们 compact.ts 五级策略查漏补"offload 落盘引用" |

### 4.2 安全与凭据
- known-hosts 转正（Netcatty）：TOFU 接受后提示"信任并保存到 known_hosts"，写远端 `~/.ssh/known_hosts`
- ssh_config 导入（Netcatty）：解析 Host/HostName/User/Port → 批量建主机
- 主密码体系（nyaterm）：暂缓（P2），当前 keyring 已够

### 4.3 终端体验
- 关键词高亮/gutter/动作链接（nyaterm，MIT）：xterm.js `registerDecoration` + `registerLinkProvider`
- 终端搜索 UI（nyaterm）：search addon 已在依赖，加 Ctrl+F 面板
- 命令捕获三壳 marker（nyaterm `core/capture/command.rs`）：pwsh base64 包裹取退出码——比我们 OSC 133 依赖更稳，可对照改进

### 4.4 教学场景（护城河加厚）
- **围观/广播模式**（sshx 思路）：教师终端状态经 Rust broadcast 到其他窗口/学生端（v2 规划，先做"双人同机围观"最小版）
- **实训自动校验**（Girus 思路）：Teach 模式加"任务卡 + 校验命令 + 通过判定"
- **/summary-to-skill**（Chaterm）：Teach 会话结束 → 沉淀知识库片段（我们知识库已有 _add，补一键入口）

## 5. 分期纳入规划（提议，待用户拍板）

> 与现有 carapace spec（`.trae/specs/add-carapace-param-completion/`）的关系：carapace 是参数补全地基（P0 保留不动），本表是其上的增量。

| 批次 | 内容 | 对应差距表 # |
|------|------|--------------|
| **B1（carapace 之后立刻）** | AI 脱敏 + 防伪造提示 + 报错解释（Teach 联动）+ 终端搜索 UI | #5 #6 #3 #9 |
| **B2** | ghost text AI 补全（carapace 兜底合并）+ CMD 命令卡片 + 交互检测器 | #1 #2 #4 |
| **B3** | known-hosts 转正 + ssh_config 导入 + /summary-to-skill + RTK offload | #10 #11 #13 #15 |
| **B4（观察/大件）** | 围观广播最小版 + 关键词高亮/动作链接 + 透明执行强化 | #18 #8 #7 |
| **P3 观察** | Mosh/ET、会话录制、批量执行、K8s 面板、竞品导入器 | #19 #17 #14 #20 #12 |

## 6. 全景调研精华（30+ 项目速览）

**方向 1 · AI 终端**（相关度高）：shell_gpt（12k★，MIT，[E]xecute/[D]escribe/[A]bort 三选一范式）、aichat（10k★，Rust，Alt+E 写入缓冲）、gptme（4.5k★，MIT，agent 工具集 + tauri 壳）、Atuin AI（19k★）、termaid（NL→命令 + **AI 解释输出**，Ollama 本地路线）
**方向 2 · 堡垒机/批量**：JumpServer（30.5k★，GPL，审计参照系）、Warpgate（7k★，Apache，Rust 无客户端透明堡垒）、Bastillion（多终端命令广播）、Spug（10.3k★，AGPL）
**方向 3 · 教学协作**：**sshx**（6.3k★，MIT，无限画布共享终端——教学广播范本）、ttyd（9.9k★，MIT，只读广播 + ZMODEM）、Girus（1k★，Apache，**任务引导 + 自动校验打分**）、linux-lab-k8s（学生实验容器编排）
**方向 4 · SSH 新趋势**：Termix（10k★，分屏+会话工具条+跨服务器 SFTP 拷贝）、Nexterm（4.8k★，MIT，Termius 开源对标 + 终端内 AI 建议）、WindTerm（tmux 集成/智能补全）、uniTerm（SSH+Mosh+Telnet+Serial 大满贯）、nexa-term（**AI-CLI-first 渲染**新趋势）
**方向 5 · 国产**：GMSSH（716★，桌面级 AI 运维 + MCP 引擎 + 等保审计，定位最接近我们）、HexHub（AI 助手 30+ 工具链）、1Panel（36.7k★，Metal-to-Agent）

**2025-2026 趋势**：① 端口转发 UI 化（健康检查/自动重连）；② K8s/Docker 面板标配；③ AI-CLI-first 渲染；④ Mosh/串口回潮；⑤ 本地模型（Ollama）对抗闭源。**最大空白**：教学全链路（广播 + 实操 + 校验 + 沉淀）无人整合 = 我们的机会。

完整 30+ 项目明细（含链接/stars/许可证/相关度评级）见调研原文：`opensource-reference/ANALYSIS-nyaterm-Netcatty.md` 综合章 + 本次全景调研归档。

## 7. 调研资料索引

| 资料 | 位置 |
|------|------|
| Chaterm 源码 + 分析 | `opensource-reference/Chaterm/` + `ANALYSIS-Chaterm.md` |
| nyaterm / Netcatty 源码 + 分析 | `opensource-reference/nyaterm/`、`Netcatty/` + `ANALYSIS-nyaterm-Netcatty.md` |
| carapace / inshellisense（参数补全） | `opensource-reference/carapace-bin/`、`inshellisense/` + `README-completion-research.md` |
| 参数预测实施方案 | `docs/命令参数预测-调研与实施方案.md` |
| 本综合报告 | `docs/开源AI运维终端-竞品对比与借鉴规划.md` |
