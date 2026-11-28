# Linux 浏览器模拟终端与开源运维演练场选型

**调研时间**：2026-11-26
**调研深度**：deep（6 个主题 / 6 路子研究员 / 域专家、怀疑者、实践者三视角）
**用户用途**：为 ShellLab 比赛版选择可落地的真实 Linux 终端与运维演练架构，并确定开源借鉴对象、部署边界和实施顺序。
**数据源限制**：Tavily、Firecrawl、3 个 MCP、Semantic Scholar 两路、搜狗/百度学术/Gitee、SearXNG 缺失或受限；本轮使用实测可用的 15 个源，以 GitHub 一手仓库和官方文档为主。

> **阅读指南**：只关心结论 → 「一页拍板」；需要溯源 → 对应维度的证据 claims（每条挂 [N] 可回源）；审计 → 来源登记表＋引文对账回执。

## 一页拍板
**推荐：比赛首发优先验证〔Qoder Sites 静态前端 + xterm.js + v86 浏览器内真 Linux〕；通过启动、重置、移动端和托管资产门后再作为主路线。产品架构预留 PTY 适配层，后续在合规与资源允许时升级为〔node-pty + 每会话容器〕。** 这不是把现有脚本模拟器加几关，而是换成真实 Linux 客户机，再用场景引擎注入故障、采集证据和判定状态。xterm.js 只负责终端 UI，不是 Shell [136][148]；v86 能模拟 x86 并运行 Linux 客户机 [142][153]；Qoder Sites 已确认支持静态页面和 Server Functions [122][123]，但 ⚠️ Functions 能否承载 WebSocket/PTY/常驻进程仍未证实 [126][127][128]。

| 路线 | 是否真实 Linux | 外部常驻后端 | 重置与隔离 | Qoder Sites 适配 | 本轮建议 |
|---|---|---|---|---|---|
| 脚本/文件系统模拟 | 否 | 否 | 容易 | 最好 | 只做引导，不作为比赛主内核 |
| v86 + Linux 镜像 | 是，受限 | 否 | save_state/restore_state + 镜像；需应用层封装 | 可静态托管，需核资产限制 | **候选首选，先过 PoC 门** |
| WebContainers | Node.js/命令，不是完整 Linux | 否，但依赖商业 API/浏览器能力 | 一次性环境 | 受 COOP/COEP 与许可边界影响 | 备选，不承担系统运维语义 |
| node-pty + 容器 | 是 | 是 | 最强，可做配额/审计/快照 | 需外部后端或官方确认 Functions | **长期主架构** |

**主要风险**：v86 官方明确不支持 64 位内核和多核 [101][154]；仓库只有启动基准方法，没有本轮可用的耗时/内存结果 [100][155]；Qoder Sites 的资产体积与响应头限制未核；纯前端检查器可被修改，只能作为练习反馈，不能作为防篡改的权威成绩 [69]；⚠️ 外部 PTY 后端能否满足比赛由 Qoder 完成部署的要求仍未确认 [133]。
**下一步**：先做一个 v86 真实 Shell 垂直切片，实测冷/热启动 P50/P95、峰值内存、50 次重置成功率、文件/权限/日志命令和移动端；同步向主办方确认外部后端许可。未过门时降级为〔明确标注的脚本练习 + 真实 Linux 录屏〕，不冒充实时环境；过门后先做 1 个旗舰事故，再按时间扩 3 个专项演练。

## 执行摘要
- **真实必须先分层**：xterm.js 是终端 UI，node-pty 是服务端 PTY，v86 是浏览器内 x86 系统模拟，WebContainers 是浏览器内 Node.js 运行时；四者不能互相替代 [136][137][142][153]。
- **会学习不等于完成任务**：任务合同应包含初始状态、目标、成功条件和参考解；复盘应记录命令输入输出与失败类型，并防作弊 [59][65][69]。
- **比赛版建议先验证 v86 静态真 Linux**：它提供真实 Shell 语义且不需要常驻后端，但 64 位、多核、启动耗时、移动端和 Sites 资产限制仍未测或未核，只有通过 PoC 门才能作为主路线 [100][101]。
- **长期主架构建议 node-pty + 每会话容器**：真实性和隔离能力最强，但认证、配额、审计、重置与部署合规必须外层实现 [110][138]。
- **Qoder Sites 边界**：静态页面和 Server Functions 已确认；⚠️ 长连接/PTY/外部后端合规未确认，因此先保留静态作品入口，不把未证实能力写进方案 [122][126][133]。

## 开源项目候选与六维质量

候选项目不是同一类东西：xterm.js、node-pty、v86 是三层构件；Wetty、ttyd、GoTTY、WebSSH、sshx 是不同形态的终端网关；CTFd 是赛事平台；Terminal Mastery Lab 是静态教学模拟器。对 ShellLab 最有价值的组合是 **xterm.js（UI）+ v86（比赛期执行内核）+ 自建场景/判定层**，后续再换 node-pty + 容器。xterm.js 核心零依赖、MIT、维护活跃，适合直接作为终端渲染层 [1][2][3]；node-pty 提供真实 PTY，但许可证元数据存在 GitHub NOASSERTION 与 npm MIT 的冲突，采用前必须读许可证原文 [6][7][8][9]；v86 为 BSD-2-Clause，能运行 Linux，并提供 save_state/restore_state 示例，但教学场景快照、重置入口、网络/MAC/IP 一致性和评估仍需应用层封装与实测 [16][17][18]。Wetty/ttyd/GoTTY 可借鉴 WebSocket、只读默认和 Origin 校验，但它们默认不是多租户沙箱 [20][25][30]；WebSSH/sshx 更适合连接既有真实服务器，不能替代隔离实验环境 [35][41]；CTFd 说明完整赛事后端需要数据库、缓存和挑战编排，不适合当前轻量比赛作品 [45]；shellinabox 的推送时间与最新提交日期冲突；COPYING 原文是 GNU GPL v2 并附 OpenSSL 链接例外，不是〔许可证不明〕，但老旧依赖与直接 shell 暴露面仍使它不适合作为新项目底座 [50]。
- 【原文】xterm.js README 写明『The core library has zero dependencies.』，并把 addon-attach 定义为通过 WebSocket 附着到服务器进程。事实：它是浏览器终端前端而不是 Linux 运行时，本轮未实际启动。维护：GitHub API 显示 pushed_at=2026-11-25、最新提交同日、release 6.0.0 发布于 2025-12-22、未归档。许可：MIT。安全：解析终端流不等于隔离命令；GitHub 依赖告警为 0 也不等于无漏洞，认证与命令执行边界须由后端承担。适配：〔实践判断〕适合作为静态 Web/WebView 终端 UI，需另接 PTY/SSH/容器服务。成本：〔实践判断〕UI 集成低，完整浏览器 Linux 演练环境仍需后端、会话与隔离建设。 [1][2][3][4][5][157]（成立范围：样本=xtermjs/xterm.js；数据源=GitHub REST/GraphQL 与官方 README；核验日=2026-11-26；同行评议=不适用；读到正文=是；实际运行=否；raw/candidates-01.txt）
- 【原文】microsoft/node-pty README 写明『`node-pty` supports Linux, macOS and Windows.』，Windows 依赖 conpty。事实：提供 Node.js PTY 绑定，不提供浏览器 UI 或 Linux 虚拟机，本轮未编译运行。维护：pushed_at=2026-11-02、最新提交同日、release v1.1.0 发布于 2025-12-22、未归档。许可冲突：GitHub 仓库元数据为 NOASSERTION，npm 官方元数据为 MIT，须读许可证原文后再定。安全：PTY 会启动本机进程，库本身不提供多用户认证、容器隔离或命令审批。适配：〔实践判断〕可与 xterm.js 组成 Node 轻后端，Linux 服务端需 C++ 构建链。成本：〔实践判断〕集成中等，原生模块跨平台构建与供应链固定版本是主要成本。 [6][7][8][9][10]（成立范围：样本=microsoft/node-pty；数据源=GitHub REST 与 npm 官方注册表；核验日=2026-11-26；同行评议=不适用；读到正文=是；实际运行=否；许可证存在元数据冲突；raw/candidates-03.txt）
- 【原文】lydell/node-pty README 写明『@lydell/node-pty is way less than one megabyte on macOS and Linux』，并用 optionalDependencies 安装平台包。事实：它是 node-pty 的小型分发分支，仍运行本机 PTY，不是浏览器 Linux 沙箱，本轮未安装。维护：pushed_at=2026-10-24；GitHub 最新 release 为 v1.2.0-beta.3（2026-01-09），npm 已到 1.2.0-beta.18（2026-10-24），发布渠道不同步。许可：MIT。安全：预编译原生二进制提高供应链审查要求，库不提供租户隔离。适配：〔实践判断〕适合 Node 终端网关，可按平台减少包体。成本：〔实践判断〕接入低到中等，但 beta 版本与跨架构二进制验证需计入测试成本。 [11][12][13][14][15]（成立范围：样本=lydell/node-pty；数据源=GitHub REST 与 npm 官方元数据；核验日=2026-11-26；同行评议=不适用；读到正文=是；实际运行=否；仅 34 stars，社区规模小；raw/candidates-02.txt）
- 【原文】v86 README 写明『v86 emulates an x86-compatible CPU and hardware.』，并列出 BasicLinux、Alpine、Arch 等客户机。事实：它在浏览器/WASM 中模拟 x86，可承载真实 Linux 客户机；本轮未下载镜像或启动。维护：pushed_at=2026-11-21、最新提交同日、未归档，但没有 GitHub latest release。许可：BSD-2-Clause。安全：模拟器不等于教学平台，学生认证、任务判分和外网隔离需另建；官方 save_restore 示例提供『await emulator.save_state()』与『await emulator.restore_state(state)』，但教学场景快照、重置入口、网络/MAC/IP 一致性与判分仍需应用层封装和实测。适配：〔实践判断〕适合无后端的单机演练 demo，静态托管需同时托管客户机镜像与 WASM 资产。成本：〔实践判断〕镜像体积、浏览器内存与兼容性测试使完整实验室成本中到高。 [16][17][18][19][158][174]（成立范围：样本=copy/v86；数据源=GitHub REST 与官方 README；核验日=2026-11-26；同行评议=不适用；读到正文=是；实际运行=否；raw/candidates-05.txt）
- 【原文】Wetty README 写明『websockets rather than Ajax and hence better response time.』，并暴露 SSH 主机、用户与认证参数。事实：它是 Node Web 终端/SSH 网关，不是独立 Linux 实验室，本轮未部署。维护：pushed_at=2026-11-20、release v4.2.1 发布于 2026-10-25、未归档。许可：MIT。安全：OSV 的 GHSA-p26j-h7wj-r568 为下载文件名 DOM XSS，标注 3.0.4 修复，当前 4.2.1 不在该受影响范围；仍须保护直接 shell 出口。适配：〔实践判断〕适合作为真实终端的轻 Node 接入层，需容器/VM 隔离学生命令。成本：〔实践判断〕服务部署中等，认证、TLS、会话恢复与隔离需额外实现。 [20][21][22][23][24]（成立范围：样本=butlerx/wetty；数据源=GitHub REST、官方 README、OSV；核验日=2026-11-26；同行评议=不适用；读到正文=是；实际运行=否；CVE 结论仅限所列公告与版本；raw/candidates-06.txt）
- 【原文】ttyd README 写明『Basic authentication support and many other custom options』，并宣称支持 OpenSSL/Mbed TLS 与只读/可写选项。事实：它是共享本机终端的 C 语言 Web 服务，不自动生成隔离 Linux 实验环境，本轮未启动。维护：pushed_at=2026-11-24，但最新提交为 2026-08-12、latest release 1.7.7 为 2024-03-30，推送与发布节奏不一致。许可：MIT。安全：基本认证默认需显式配置，直出 shell 仍须放在受控网络与学生容器之后。适配：〔实践判断〕适合轻量单二进制 Web 终端，不适合直接作为多租户平台。成本：〔实践判断〕网关部署低，按学生创建容器、监控与回收的成本另计。 [25][26][27][28][29][159]（成立范围：样本=tsl0922/ttyd；数据源=GitHub REST 与官方 README；核验日=2026-11-26；同行评议=不适用；读到正文=是；实际运行=否；raw/candidates-07.txt）
- 【原文】GoTTY README 的认证选项写明『Credential for Basic Authentication (ex: user:pass, default disabled)』，TLS 也为默认关闭。事实：它把运行中的命令通过浏览器展示，不提供 Linux 客户机或教学任务系统，本轮未运行。维护：pushed_at=2026-11-21、最新提交 2026-11-10、release v1.11.0 发布于 2026-11-05、未归档。许可：MIT。安全：默认无基本认证且默认无 TLS，直接暴露会形成高风险 shell 入口。适配：〔实践判断〕适合 Go 技术栈的轻后端或内部演示，需反向代理认证与容器隔离。成本：〔实践判断〕单二进制部署低；多学生资源配额、审计与恢复仍需自建。 [30][31][32][33][34][160]（成立范围：样本=sorenisanerd/gotty；数据源=GitHub REST 与官方 README；核验日=2026-11-26；同行评议=不适用；读到正文=是；实际运行=否；raw/candidates-12.txt）
- 【原文】WebSSH README 写明『A simple web application to be used as an ssh client to connect to your ssh servers.』，技术栈为 Python、Tornado、Paramiko 与 xterm.js。事实：它连接既有 SSH 服务器，不创建隔离实验机，本轮未部署。维护：pushed_at=2025-07-27、release v1.6.3 同日、未归档。许可：MIT。安全：OSV 的 XSS 公告 GHSA-9cg4-9hv5-3376/PYSEC-2025-234 标注 1.6.3 修复；README 同时要求启用 SSL 并使用 reject 主机密钥策略。适配：〔实践判断〕适合真实 Linux 教学终端入口，不适合无后端静态站点。成本：〔实践判断〕Python 服务与 SSH 目标部署中等，凭据、known_hosts、TLS 与审计需重点验证。 [35][36][37][38][39][40]（成立范围：样本=huashengdun/webssh；数据源=GitHub REST、官方 README、OSV；核验日=2026-11-26；同行评议=不适用；读到正文=是；实际运行=否；仅核到所列 XSS 公告；raw/candidates-18.txt）
- 【原文】sshx README 写明『A secure web-based, collaborative terminal.』，并列出 Argon2 与 AES 的端到端加密。事实：它面向实时协作终端共享，不负责提供 Linux 客户机或课程隔离，本轮未运行。维护：GraphQL 显示 pushed_at=2026-09-21、7728 stars、未归档；latest release v0.4.1 为 2025-02-12，提交继续但发布较旧。许可：MIT；主要语言 Rust。安全：加密是项目自述，未做独立密码学审计；分享链接的撤销、访问范围与中继信任仍需验证。适配：〔实践判断〕适合教师共享真实终端，不适合纯静态站点。成本：〔实践判断〕客户端加 Rust 服务/中继，部署与排障成本中到高。 [41][42][43][44][161]（成立范围：样本=ekzhang/sshx；数据源=GitHub GraphQL、官方 README 与 release；核验日=2026-11-26；同行评议=不适用；读到正文=是；实际运行=否；raw/candidates-20.txt）
- 【原文】CTFd README 写明『You can use Docker Compose with the following command from the source repository:』。事实：它是 CTF 赛事/题目平台，不是浏览器 Linux 模拟器，挑战 shell 的隔离需挑战部署设施另建，本轮未启动。维护：pushed_at=2026-11-25、release 3.8.9 发布于 2026-10-22、未归档。许可：Apache-2.0。安全：旗帜提交、队伍与权限由平台处理，但题目容器/VM 的网络与资源边界是部署者责任。适配：〔实践判断〕适合完整演练赛事后端，不适合静态站点或轻终端组件。成本：〔实践判断〕Web、数据库、缓存、插件及挑战编排使部署成本高。 [45][46][47][48][49][162]（成立范围：样本=CTFd/CTFd；数据源=GitHub REST 与官方 README；核验日=2026-11-26；同行评议=不适用；读到正文=是；实际运行=否；raw/candidates-11.txt）
- 【原文】shellinabox README 写明『Shell In A Box implements a web server that can export arbitrary command line』到浏览器。事实：它是 C 语言 Web shell 服务，不提供教学任务或 Linux 客户机，本轮未启动。维护冲突：pushed_at=2025-09-06 且 release v2.21 同日，但 API 最新提交为 2019-01-28，不能用推送时间证明持续代码维护。许可：GitHub 元数据为 NOASSERTION，但 COPYING 原文明确为 GNU GPL v2，并附与 OpenSSL 链接时的额外许可例外；采用前仍须核对具体分发组合。安全：直接导出宿主命令行使未隔离 shell 暴露面扩大。适配：〔实践判断〕仅适合受控内部环境或兼容旧项目。成本：〔实践判断〕C 服务本身较轻，但老旧依赖、许可与安全补丁使新型实验室落地成本偏高。 [50][51][52][53][54][163][175]（成立范围：样本=shellinabox/shellinabox；数据源=GitHub REST 与官方 README；核验日=2026-11-26；同行评议=不适用；读到正文=是；实际运行=否；pushed_at 与提交日期冲突；raw/candidates-13.txt）
- 【原文】Terminal Mastery Lab README 写明『Interactive in-browser Linux/Unix terminal simulator to learn, practice, and master the shell from beginner to DevOps and SysAdmin.』，并说明可直接打开 index.html。事实：它是静态浏览器教学模拟器，不是真实 Linux 运行时，本轮未运行。维护：pushed_at=2026-11-25、最新提交同日、未归档，但没有 release，且仅 10 stars。许可：MIT。安全：模拟命令不能替代真实 shell 隔离，也不能据此证明 Linux 语义正确。适配：〔实践判断〕适合快速借鉴课程 UI、任务与即时反馈；不适合直接交付真实运维权限。成本：〔实践判断〕静态演示成本很低，真实命令执行需另接 PTY/SSH/容器与判分。 [55][56][57][58][164]（成立范围：样本=Comeranas/terminal-mastery-lab；数据源=GitHub REST 与官方 README；核验日=2026-11-26；同行评议=不适用；读到正文=是；实际运行=否；社区证据弱；raw/candidates-15.txt）

## 故障演练任务与证据评估

成熟演练的核心不是〔输入正确命令〕，而是 **状态合同 + 证据链 + 可复核判定**。Terminal-Bench 把任务拆成容器化初始环境、指令、完成测试和人工参考解 [59]，可直接转成 ShellLab 的〔场景快照—目标—成功条件—参考路径〕。它的错误分析聚焦命令输入输出与 Execution/Coherence/Verification 失败类型 [65]，说明复盘应记录〔看到了什么、判断了什么、哪一步推理断开〕，而不是只显示最终对错。论文还记录篡改测试环境、猜答案、穷举输出等绕过方式 [69]，因此判定脚本要藏起来、检查负向条件、保存检查器版本和原始输出。⚠️ Killercoda 的验证脚本与提示分级、SadServers 的 check.sh/进度保存目前仍是单源线索 [63][64][67][68]，适合作为设计启发，但不能写成已独立核实的产品事实。对 ShellLab 的直接结论是：每个事故至少包含初始状态、3–5 个可观察目标、关键证据、分级提示、根因提交、迁移测试和完整轨迹；成功条件判断状态，不判断用户是否逐字敲出参考命令。纯前端检查器只能作为练习反馈，不能作为防篡改的权威成绩；要高可信判定，必须把检查器和关键状态放到可信后端 [69]。
- Terminal-Bench 把任务合同拆成容器化初始环境、任务指令、完成测试和人工参考解四部分：『Each task consists of (1) a containerized environment initialized with relevant packages and files, (2) an instruction that describes the task to be completed, (3) a set of tests to verify completion, and (4) a reference solution manually written to solve this task.』这可直接转译为“目标—初始状态—成功条件”，故障由环境配置或任务指令承载。 [59][171]（成立范围：样本=Terminal-Bench 2.0 论文；数据源=arXiv HTML 正文；年份=2026；同行评议=未核实；读到正文=是；raw/drills-02.txt）
- ⚠️ 仅作线索：SadServers 的成功条件可以是可观察状态而非固定命令序列，例如磁盘日志场景只要求文件大小在足够长观察窗内不再变化：『Test: The log file size doesn't change (within a time interval bigger than the rate of change of the log file).』判定由虚拟机内 check.sh 执行：『The "Check My Solution" button runs the script /home/admin/agent/check.sh, which you can see and execute.』 [60]（成立范围：样本=SadServers 官方场景页；数据源=平台正文；年份=2026-11-26 抓取；同行评议=不适用；读到正文=是；raw/drills-07.txt）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：Chaos Toolkit 用稳态假设定义“正常”，并在实验前检查、实验后比较：『A Steady State Hypothesis describes “what normal looks like” for your system in order for the experiment to surface information about weaknesses when compared against the declared “normal” tolerances of what is measured.』以及『It is used as a check before an experiment is run that the target system is in a recognised normal state. It is also used as the template for comparison of the state of your system after the experiment has been run, forming the results provided by the experiment’s report.』 [61]（成立范围：样本=Chaos Toolkit 官方概念文档；数据源=项目文档；年份=版本未钉，2026-11-26 抓取；同行评议=不适用；读到正文=是；raw/drills-09.txt）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：成熟故障编排把探针、动作、回滚和容差分开：『An Experiment declares a steady state hypothesis, alongside probes to validate this steady state is met, and a method as a sequence actions and probes, to interact and query the system respectively.』『Rollbacks declare the sequence of actions that attempt to put the system back to its initial state.』容差支持严格值、区间、集合、regex、jsonpath 等，文档明确：『When the tolerance is a sequence. If it has only two values, those two values represent a lower and upper bound within which the Probe returned value must fall (inclusive).』 [62]（成立范围：样本=Chaos Toolkit Experiment API；数据源=项目规范正文；年份=版本未钉，2026-11-26 抓取；同行评议=不适用；读到正文=是；raw/drills-10.txt）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：🚩 L3不可信：Killercoda 的场景格式支持步骤级验证脚本和前置状态准备：『Verification scripts validate whether a user has completed a step correctly. When the user clicks the CHECK button, the script runs automatically. It passes if it exits with code 0.』初始环境可由打开场景时运行的前台/后台脚本准备，后台命令对用户隐藏；后台脚本报错时可在 Creator Debug Section 检查 stdout、stderr 和错误详情。这适合把故障注入与学员可见操作分离。 [63]（成立范围：样本=Killercoda Creator Documentation；数据源=官方文档；年份=2026-11-26 抓取；同行评议=不适用；读到正文=是；raw/drills-05.txt）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：提示分级已有真实平台实现：Killercoda 默认 hint 模式只在卡住时给提示，切换到 solution 模式才给完整答案：『In (default) hint mode the scenario will provide only tips when you're stuck, switch to solution mode for full answers.』产品可借鉴“提示层级”而非只做二值显示/隐藏答案。 [64]（成立范围：样本=Killercoda FAQ；数据源=官方 FAQ；年份=2026-11-26 抓取；同行评议=不适用；读到正文=是；raw/drills-06.txt）（状态 pending，未达 verified 判据）
- Terminal-Bench 的错因诊断基于记录的命令输入输出和轨迹，而不是只给最终对错：『To better understand agent limitations, we perform an error analysis that focuses on identifying and quantifying command failures.』论文用 LLM-as-judge 审查录制的 Terminus 2 轨迹中的命令输入输出，并把轨迹失败归为 Execution、Coherence、Verification 三类。该机制适合复盘与错因聚类，但属于研究分析，不等于强迫学习者提交根因。 [65][172]（成立范围：样本=Terminal-Bench 2.0 论文；数据源=arXiv HTML 正文；年份=2026；同行评议=未核实；读到正文=是；raw/drills-02.txt）
- ⚠️ 仅作线索：小型开源 Linux 排障仓库展示了另一种轻量证据形态：README 明示 junior-level，列出 systemd、DNS、权限、网络等模拟实验，并以截图和主命令作为学习留痕，例如『| [Service failure with systemd](labs/service-failure-systemd/) | Simulated lab, completed with screenshots | `systemctl`, `journalctl`, `ss`, `curl` |』。在本 README 范围内未看到自动 checker、强制根因/复盘字段或迁移测试；这是阴性发现，不能外推为仓库其他文件一定没有。 [66]（成立范围：样本=masporfirio/linux-troubleshooting-labs README；数据源=GitHub 一手 README；年份=2026-11-26 抓取；同行评议=不适用；读到正文=是；仅 README 范围；raw/drills-11.txt）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：进度保存已有成熟产品实现：SadServers 先供应带预置故障的 VM，学员诊断修复后自动验证，并把进度存入账户仪表盘：『Choose a scenario, start a session, and SadServers provisions a VM with a pre-configured problem.』『Your progress is saved to your account dashboard.』账户还保存已解题场景和用时。静态前端只能保存本地草稿，跨设备进度与防篡改成绩仍需服务端账户和会话状态。 [67]（成立范围：样本=SadServers FAQ；数据源=官方 FAQ；年份=2026-11-26 抓取；同行评议=不适用；读到正文=是；raw/drills-08.txt）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：自动判分存在可复核的边界：SadServers 说明网页按钮调用 VM 内 agent 运行 check.sh，返回 NO/OK；同时明确修改 check.sh 会导致失败，并承认判定脚本可能误判：『It is possible that your solution is right but the check.sh script doesn't capture it properly; the script can have both false positives and false negatives.』因此证据评估应保留检查器版本、原始输出和人工申诉/复核路径，不能把一次脚本结果当成绝对真值。 [68]（成立范围：样本=SadServers FAQ；数据源=官方 FAQ；年份=2026-11-26 抓取；同行评议=不适用；读到正文=是；raw/drills-08.txt）（状态 pending，未达 verified 判据）
- 状态测试也需要防作弊审计。Terminal-Bench 论文记录对抗性 exploit agent 曾通过篡改测试环境、猜答案、穷举输出等方式绕过完成测试：『Common exploits found by this agent include monkey-patching test environments, guessing answers, and generating all possible answers with the hope that tests might only check existence of a correct answer but not absence of wrong answers.』这支持〔服务端隐藏/保护判定逻辑、检查负向条件、审计轨迹〕的实践者结论。 [69][173]（成立范围：样本=Terminal-Bench 2.0 论文附录；数据源=arXiv HTML 正文；年份=2026；同行评议=未核实；读到正文=是；raw/drills-02.txt）
- ⚠️ 仅作线索：🚩 L3不可信：〔实践者综合〕静态前端适合渲染任务与初始状态说明、采集根因/证据/复盘文本、展示命令历史、控制提示层级和保存本地草稿；服务端/VM 必须负责环境供应与故障注入、执行验证脚本或探针、保护判定逻辑、给出权威成绩并持久化跨会话进度。依据包括 OSWorld 的中央控制器与客户端 VM：『- **Host Instance**: The central controller that stores code, configurations, and manages task execution.』Killercoda 的 CHECK 脚本、SadServers 的 VM 内 check.sh 以及 Chaos Toolkit 的 probes 都说明真实状态判定不能由纯前端可信完成。 [70][71][72][73][74]（成立范围：样本=OSWorld-V2、Killercoda、SadServers、Chaos Toolkit 官方文档；数据源=项目文档/平台说明；年份=2026-11-26 抓取；同行评议=不适用；读到正文=是；综合推断，非单一来源原话；raw/drills-03.txt、05、07、08、10）（状态 pending，未达 verified 判据）

## 现有 Linux 学习网站与模拟器

现有产品按〔执行真相〕分层后，差异比终端外观更明显：Webminal/OverTheWire/KodeKloud 是远端真实环境入口，JSLinux 是系统模拟，Terminux 是脚本/文件系统模拟，xterm.js 只是渲染与输入组件，WebContainers 是 Node.js 运行时 [91][92][93][94][95][96][97]。ShellLab 不应再做一个〔看起来像终端〕的页面，而应选择一种明确的执行真相，并把任务、评分和进度单独建起来。可借鉴的产品点包括：OverTheWire 的关卡递进与自助提示、KodeKloud 的开箱即用发行版、Killer.sh 的即时评分与人工复核、Linux Journey 的结构化路径；但 Linux Journey 的 README 明确限制品牌、视觉、课程组织和实质内容集合的模仿式复用 [81][82]，因此只能借鉴〔路径组织方法〕，不能搬运其站点身份或整套内容。Terminux 证明纯前端模拟可以很低成本，但它的 README 只承诺文件系统模拟，不能证明真实 Linux、包管理、权限或进程语义 [89][90]。xterm.js 则明确不是 bash [87][88]，再次说明“终端组件”与“学习产品内核”必须分开。
- ⚠️ 仅作线索：Webminal 官方将其定位为浏览器内免费 GNU/Linux 终端，明示无需安装，并提供 Linux 命令、Bash 脚本练习与 Courses；原文：『Practice Linux commands, write bash scripts, learn Python and more — right in your browser. No setup required.』页面自述为云端 Linux，因此它属于托管云端 Shell 学习入口，而不是纯前端命令模拟器。可借鉴的是把课程、命令挑战与即时终端并置；官方页面未给出自托管部署或开源许可，不能据此宣称可自建。 [75]（成立范围：官方首页，2026-11-26 正文抓取；仅核官方自述，未登录实测、未核开源/自托管；不采用页面用户数。原文见 raw/products-01.txt。）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：OverTheWire 的 Bandit 是分级 SSH wargame：『Finishing a level results in information on how to start the next level.』且官方明确『Each shell game has its own SSH port』；它不是浏览器内模拟终端。可借鉴关卡递进与 man/help 自助提示；缺点是浏览器访问者仍需 SSH 客户端，且官方页未提供课程化评估或自托管说明。 [76][77]（成立范围：OverTheWire 官方 Wargames/Bandit 页，2026-11-26 正文抓取；未实际 SSH 登录，不断言免费、商业或许可。原文见 raw/products-05.txt、raw/products-06.txt。）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：KodeKloud Ubuntu Playground 官方称在浏览器中提供预装 Ubuntu 24.04 的命令行界面：『This playground comes with a command-line interface, allowing you to access and use the pre-installed Ubuntu 24.04 operating system.』站点同时提供免费入口和付费订阅。可借鉴开箱即用的发行版沙盒；明确的会话限制是 playground 1 小时、可延长 15 分钟，不适合需要持久环境的训练。本次未找到官方自托管方案。 [78][79]（成立范围：KodeKloud 官方 Ubuntu Playground 与定价页，2026-11-26 正文抓取；未登录实测，按官方措辞认定可访问预装系统，不推断其虚拟化实现。原文见 raw/products-20.txt、raw/products-08.txt。）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：Killer.sh CKA 是付费商业考试模拟器，本次未找到其开源/自托管证据：官方提供用户自己的集群、Remote Desktop、限时场景，并写明『You'll get an automatically calculated score』；同时也承认『For some questions though there is still manual review required, so you'll have to compare your solutions to ours.』可借鉴即时评分与缺项反馈；缺点是自动评分不能覆盖全部场景，且依赖远程桌面/集群而非轻量浏览器脚本模拟。 [80]（成立范围：Killer.sh 官方 CKA 页，2026-11-26 正文抓取；价格与时限已核到页面但不转引为普遍承诺；未购买/登录，未核自托管。原文见 raw/products-22.txt。）（状态 pending，未达 verified 判据）
- Linux Journey 已由 LabEx 维护，官方仓库定位为交互式课程与学习路径；内容采用 CC BY-SA 4.0，但 README 明确：『This license does not grant permission to use the Linux Journey name, branding, visual identity, course organization, or substantial content collection to create a confusingly similar website, product, or service that imitates Linux Journey or is intended to replace the official Linux Journey experience.』可借鉴结构化路径与可复用课程正文；不能把〔内容开源〕扩大为〔整站可自由自托管/可贴牌〕，自托管部署也未在本次材料中核实。 [81][82]（成立范围：LabEx 官方站与 labex-labs/linuxjourney 官方 README，2026-11-26 正文抓取；旧 cinnamonstones 仓库入口返回 404，不作为现状证据；未部署自托管。原文见 raw/products-03.txt、raw/products-29.txt。）
- ⚠️ 仅作线索：JSLinux 官方列出可在浏览器运行的 x86/x86_64/RISC-V 模拟系统，包含 Alpine、Buildroot/Fedora Linux 与图形/控制台界面；原文：『Run Linux or other Operating Systems in your browser!』其技术路线是系统模拟，而非 Webminal 式云端账号 Shell。可借鉴无需安装即可体验发行版；页面明示部分 Fedora RISC-V『Warning: longer boot time.』，且未提供课程、进度或评估体系。 [83]（成立范围：Fabrice Bellard 官方 JSLinux 页，2026-11-26 正文抓取；仅核官方系统清单与提示，未运行模拟器，不断言开源、免费或可自托管。原文见 raw/products-11.txt。）（状态 pending，未达 verified 判据）
- WebContainers 是 StackBlitz 的浏览器 Node.js 运行时/API，不是完整 Linux 学习发行版：『Create unmatched user experiences by integrating Node.js directly into your web app.』并宣称『Build fully-branded products without connecting to external servers or directing users away to third-party apps.』可借鉴把真实进程执行嵌入教学网页；局限是官方能力锚定 Node.js/WebAssembly，不能把任意 Linux 系统调用或完整 Linux 课程体验等同进去。商业 API/Enterprise 入口存在，webcontainer-core 仓库元数据显示 MIT，但本次未核实独立自托管全套服务。 [84][85][86]（成立范围：WebContainers 官方首页、官方仓库/许可证与 GitHub 元数据，2026-11-26；未运行基准，不推断性能数字；MIT 仅指核心仓库，不代表商业服务整体开源。原文见 raw/products-13.txt、raw/products-15.txt、raw/products-28.txt；元数据见 scratch/products-repo-metadata.json。）
- xterm.js 官方明确：『Xterm.js is a frontend component that enables applications to bring fully-featured terminals to their users in the browser.』且『Xterm.js is not `bash`. Xterm.js can be connected to processes like `bash` and let you interact with them (provide input, receive output) through a library like [node-pty](https://github.com/microsoft/node-pty).』MIT、零依赖核心使其适合自托管嵌入与统一终端 UI；但它本身不提供 Linux、命令执行、课程任务或评估，不能当模拟器内核。 [87][88][149]（成立范围：xterm.js 官方 README 与 MIT 许可证，2026-11-26；核的是组件职责边界，未做浏览器兼容性测试。原文见 raw/products-17.txt、raw/products-26.txt。）
- Terminux 官方 README 自称为纯 HTML/CSS/JavaScript 终端模拟器：『Terminux is a fully functional terminal simulator built with vanilla web technologies.』并写明『Object-oriented file system simulation』；因此它适合零依赖的命令教学/演示，却不能证明提供真实 Linux、包管理、权限或进程语义。仓库元数据显示 MIT；README 未提供任务序列、评分或进度系统。 [89][90][168]（成立范围：RyZenoKelb/Terminux 官方 README 与 GitHub 元数据，2026-11-26；未运行在线 demo，不评价其命令覆盖率。原文见 raw/products-30.txt；元数据见 scratch/products-repo-metadata.json。）
- 把上述产品按〔执行真相〕分层比按终端外观分类更可靠：Webminal/OverTheWire/KodeKloud 是远端真实环境入口，JSLinux 是系统模拟（『The following emulated systems are available:』），Terminux 是脚本/文件系统模拟，xterm.js 只是渲染与输入组件，WebContainers 是 Node.js 容器运行时。对 ShellLab 的直接借鉴是终端外观不能替代真实执行边界，任务、评分和进度必须单独设计；缺点是本次仅做文档交叉核验，未做同机性能、隔离或完成率横评。 [91][92][93][94][95][96][97]（成立范围：七类官方制品/页面的文档三角归纳，2026-11-26；属于待 Lead 复核的架构判断，不是实测比较，不外推为所有浏览器终端产品的统一结论。）

## 性能安全成本与兼容性

本轮没有三条路线的同机横向性能数据，因此不能给〔v86/WebContainers/PTY 谁更快〕的排名。可确认的是：v86 提供可复现的启动计时方法和 32 MiB 客户机配置，但脚本本身没有发布本轮耗时 [100]；官方 README 明确 64 位内核不受支持且缺少多核 [101]；inbrowser 网络后端不提供外网访问，所有 VM 共享浏览器资源 [102]。WebContainers 的商业页区分 POC 与生产/员工场景，core 仓库 MIT 不等于商业 API 免费 [106][107][108][109]。node-pty 官方直接说明子进程继承父进程权限，并建议在容器内启动以保护宿主机 [110][169]。因此比赛版要把〔能跑〕与〔可安全演示〕分开：v86 必须实测启动、内存、镜像缓存、重置和移动端；PTY 后端必须显式实现每会话容器、非特权用户、CPU/内存/进程数上限、空闲回收、命令审计和快照重置。当前证据支持〔v86 先做真实 Shell 切片、PTY 做长期架构〕，不支持任何未实测的性能承诺。
- ⚠️ 仅作线索：【原文】v86 官方镜像仓库的 GitHub API 元数据记录『linux.iso 5666816 https://raw.githubusercontent.com/copy/images/master/linux.iso』；v86 官方 release 元数据记录『latest libv86.mjs 359976 https://github.com/copy/v86/releases/download/latest/libv86.mjs』与『latest v86.wasm 2000261 https://github.com/copy/v86/releases/download/latest/v86.wasm』。这些字节数可由官方 API 复算，分别表示一个测试 Linux ISO、JS 胶水层与 WASM 资产的下载大小，不等于浏览器运行时内存或完整教学站点体积。 [98][99]（成立范围：样本=copy/images 与 copy/v86 latest release 的官方 GitHub API 元数据；核验日=2026-11-26；非同行评审；读到官方 API 正文=是；未下载或执行制品；数字来源等级=官方 API 元数据，可复算；raw/risk-29.txt、raw/risk-30.txt。）（状态 pending，未达 verified 判据）
- 【原文】v86 官方启动基准源码使用『memory_size: 32 * 1024 * 1024,』，从『emulator-started』事件起用 Date.now 计时，并在串口出现 shell 提示符后输出『console.log("Done in %dms", elapsed);』。这证明仓库提供了可复现的启动计时方法与一个 32 MiB 客户机内存配置，但该脚本本身没有发布本次启动耗时，32 MiB 也不是浏览器进程 RSS。 [100][155]（成立范围：样本=copy/v86 master 的 tests/benchmark/linux-boot.js；核验日=2026-11-26；非同行评审；读到源码正文=是；未构建、未运行基准；数字来源等级=可复现基准方法，但无测量结果；raw/risk-15.txt。）
- 【原文】v86 官方 README 明确『Linux works pretty well. 64-bit kernels are not supported.』，并列出缺失的『Multicore』与『64-bit extensions』；对 Debian 衍生系统的边界是『Ubuntu and other Debian derivatives works up to the latest version that supported i386 (16.04 LTS or 18.04 LTS for some variants).』。README 另写『Android-x86 has been tested up to 4.4-r2.』，这是客户机系统兼容性，不是 iOS/Android 移动浏览器兼容性证明。 [101][154]（成立范围：样本=copy/v86 master README 的硬件与 Compatibility 段；核验日=2026-11-26；非同行评审；读到正文=是；未启动客户机；仅确认官方声明，不外推为所有 Linux 发行版或移动设备表现；raw/risk-01.txt。）
- 【原文】v86 网络文档说明 inbrowser 后端『does not provide any access to external networks.』且『all VMs have to share the same browser resources.』；wsproxy 依赖代理服务器，文档同时提醒『Since public proxy servers provide only limited bandwidth it is recommended to install and use a local, private proxy server for best results.』。因此无外网演示可省去代理，但多开客户机会竞争同一浏览器资源；需要安装包或外网课程时，代理、CORS 与带宽成为新增成本与故障点。 [102][156]（成立范围：样本=copy/v86 master docs/networking.md；核验日=2026-11-26；非同行评审；读到正文=是；未测试代理吞吐；后半句为基于官方网络边界的工程归纳；raw/risk-27.txt。）
- ⚠️ 仅作线索：【原文】WebContainers 官方浏览器支持页 TL;DR 写『WebContainers are supported on desktop Chromium-based browsers out of the box, as well as on Safari 16.4 TP and Firefox, which both are in beta.』，但同页 Firefox 段又写『We have alpha support for Firefox.』，存在 beta/alpha 表述不一致。文档还明确任意资源嵌入所需的跨源隔离模式『only enabled in Chromium-based browsers.』，并说明 Chrome 阻止第三方 cookie 或 Brave 默认第三方拦截可能阻止运行。官方表述锚定桌面浏览器，未给出移动端支持矩阵或移动端性能数字。 [103]（成立范围：样本=WebContainers Browser Support 官方页，页面标注 Last update: October 2026；核验日=2026-11-26；厂商文档，非同行评审；读到正文=是；未做浏览器实测；矛盾=同页 Firefox beta 与 alpha 不一致；raw/risk-02.txt。）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：【原文】WebContainers 官方介绍称其为『a browser-based runtime for executing Node.js applications and operating system commands, entirely inside your browser tab.』，并将安全性表述为『everything is contained in a browser tab』。这支持其浏览器内执行与减少服务端 VM 依赖的产品定位，但属于厂商自述；本轮没有取得独立安全审计、逐会话隔离证明或可复算启动时间。 [104]（成立范围：样本=WebContainers Introduction 官方页；核验日=2026-11-26；厂商文档，非同行评审；读到正文=是；未运行、未做安全审计；数字来源等级=厂商定性自述，无可复算基准；raw/risk-19.txt。）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：【原文】WebContainers 进程文档说明 WebContainerProcess 的输出流包含『stderr emitted by the spawned process and its descendants (for example, child processes).』，并提供『server-ready』与『port』事件。这些接口可用于展示子进程输出和端口状态，但文档没有承诺不可篡改的命令审计、会话超时、资源配额或一键重置；教学平台若需要这些控制，仍须在应用层实现并验证。 [105]（成立范围：样本=WebContainers Running Processes 官方页；核验日=2026-11-26；厂商文档，非同行评审；读到正文=是；未调用 API；后半句为能力边界归纳，不断言产品绝对没有相关企业功能；raw/risk-23.txt。）（状态 pending，未达 verified 判据）
- 【原文】WebContainers 商业使用页写『(Prototypes or POCs do not require a commercial license.)』，同时说面向『customers, prospective customers, and/or employees, you need a license』。StackBlitz 服务条款进一步写『Use in a production or commercial setting, or beyond the stated limits, requires an active plan or separate written license that includes it;』。比赛原型/内部演示与面向员工或用户的正式部署边界不同，且 POC 豁免与员工使用措辞存在适用歧义，不能把 core 仓库 MIT 许可证等同于商业 API 免费。 [106][107][108][109]（成立范围：样本=WebContainers Commercial Usage 官方页与 StackBlitz Terms of Service 1.5(c)；核验日=2026-11-26；厂商法律/商业文档，非同行评审；读到正文=是；非法律意见；矛盾/歧义=POC 豁免与员工、生产场景许可要求需向厂商确认；raw/risk-24.txt、raw/risk-26.txt、raw/risk-10.txt、raw/risk-14.txt。）
- 【原文】node-pty 官方安全章节写『All processes launched from node-pty will launch at the same permission level of the parent process.』并建议『We recommend launching the pty inside a container to protect your host machine.』。这直接说明 PTY 库本身不是多租户沙箱；本轮审读的 README 未提供浏览器认证、每会话容器编排、空闲超时、资源配额、命令审计或重置控制，不能把这些外层能力记作 node-pty 已实现。 [110][169]（成立范围：样本=microsoft/node-pty main README Security 段；核验日=2026-11-26；非同行评审；读到正文=是；未部署；结论只针对官方 README 的职责边界，不代替对具体网关代码的安全审计；raw/risk-06.txt。）
- ⚠️ 仅作线索：【原文】Docker 官方资源约束文档写『By default, a container has no resource constraints and can use as much of a given resource as the host's kernel scheduler allows.』，并说明『Docker can enforce hard or soft memory limits.』以及『By default, each container's access to the host machine's CPU cycles is unlimited.』。因此每会话容器不会自动获得内存/CPU 配额，比赛演示必须显式设置限制并验证 OOM、CPU throttling 与进程数治理，否则单个学生命令可能拖慢同机其他会话。 [111]（成立范围：样本=Docker Engine Resource constraints 官方文档；核验日=2026-11-26；非同行评审；读到正文=是；未做容器压测；后半句为故障模式归纳；raw/risk-07.txt。）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：【原文】Docker 官方安全文档把命名空间称为『the first and most straightforward form of isolation.』，并建议『run your processes as non-privileged users inside the container.』及『enabling AppArmor, SELinux, GRSEC, or another appropriate hardening system.』。这支持每会话容器作为服务端 PTY 的隔离层，但容器名称或 namespaces 本身不等于完整安全边界；权限、能力、挂载、网络与宿主机 daemon 暴露面仍需分别配置和审计。 [112]（成立范围：样本=Docker Engine Security 官方文档；核验日=2026-11-26；非同行评审；读到正文=是；未审计具体容器配置；后半句为安全边界归纳；raw/risk-08.txt。）（状态 pending，未达 verified 判据）
- 〔工程归纳〕三种比赛演示路线的成本与故障模式不同：v86 路线可复算的是 ISO/JS/WASM 下载字节，启动基准只有方法没有结果，主要风险是客户机 32 位/单核限制、浏览器资源竞争、镜像加载与代理/CORS；WebContainers 路线省去客户镜像与部分服务端 VM，但『spinning up the entire dev environment in milliseconds』只是厂商自述，主要风险是 COOP/COEP、Service Worker/第三方 cookie、非 Chromium 差异与商业许可；服务端 PTY 路线最接近真实 Linux，但 node-pty 明确『We recommend launching the pty inside a container to protect your host machine.』，认证、会话生命周期、配额、审计和重置均需外层建设。当前没有任何一条同机、同负载的三方案横向性能实测。 [113][114][115][116][117][118][119][120]（成立范围：样本=v86、WebContainers、node-pty 与 Docker 官方文档/元数据的跨方案归纳；核验日=2026-11-26；非同行评审；读到正文=是；未执行任何候选制品或横向基准；属于待 Lead 复核的工程判断，不得当作实测排名；raw/risk-01.txt、raw/risk-02.txt、raw/risk-15.txt、raw/risk-19.txt、raw/risk-24.txt、raw/risk-27.txt、raw/risk-29.txt、raw/risk-30.txt、raw/risk-06.txt、raw/risk-07.txt。）

## Qoder Sites 静态部署边界

Qoder Sites 已确认可从静态页面构建到带数据库、Server Functions 和对象存储的 Agent App [122][123]；xterm.js 可作为静态前端运行，但它不是 Shell [124][150]。**未确认**的是 ⚠️ Sites Functions 是否支持长连接 WebSocket、后台常驻进程、PTY、容器或 SSH [126][127][128]，不能把〔有 Functions〕改写成〔能跑任意 Linux〕。因此比赛版最稳的公网形态是 Qoder Sites 承载前端与浏览器内 v86 资产；真实 PTY 后端作为后续增强，且在启用前必须得到主办方对〔外部后端是否符合比赛部署要求〕的明确答复；⚠️ 该合规边界仍未证实 [133]。架构上应把执行层抽象成 `TerminalRuntime`：比赛期接 v86，后续接 PTY/WebSocket；场景、证据和判定层不依赖具体执行后端。这样既不赌平台未证实能力，也不会把产品写死成只能演示的脚本模拟器。
- ⚠️ 仅作线索：官方明确支持静态网站部署：Qoder Sites 概览写明 Individual Free 计划仅支持 static website deployment，且 database 与 storage 不受支持；同页也说可创建、预览和发布交互式网站。因此 xterm.js 界面、伪 Shell 脚本或浏览器内 WASM 可作为静态资源交付的前端能力，但“静态部署”不等于平台提供 Linux 进程。原文见 raw/sites-01.txt。 [121]（成立范围：Qoder 官方 Sites 概览，2026-11-26 正文抓取；只认定静态网站与 Free 计划边界，未部署、未做浏览器实测，不断言具体构建工具或文件大小限制。）（状态 pending，未达 verified 判据）
- 官方明确承认 Qoder Sites 产品包含 server functions：CLI 文档称可从 static pages 到带 database、server functions、object storage 的 Agent App，中文页对应写明 Server Functions。由此可确认 Functions 是一等产品能力；但页面没有给出运行时、执行时长、长连接或进程模型，不能把“有 Functions”改写成“可跑任意 Shell”。原文见 raw/sites-02.txt、raw/sites-03.txt。 [122][123]（成立范围：Qoder/Qoder CN 官方 CLI Sites 文档，2026-11-26；核的是能力名词与产品范围，不是 Functions 技术实现。）
- xterm.js 官方明确区分终端 UI 与 Shell：『Xterm.js is a frontend component』且『Xterm.js is not `bash`.』，要通过 node-pty 等库连接 bash 类进程。故纯静态站点可以直接运行 xterm.js + 自写伪 Shell/WASM；这是浏览器应用层能力，不是 Qoder 提供伪 Shell。若要真实 Linux 命令语义，仅凭 xterm.js 不够。原文见 raw/sites-04.txt。 [124][150]（成立范围：xterm.js 官方 README，2026-11-26；未运行 WASM 性能或命令覆盖率测试，不把伪 Shell 等同真实发行版。）
- ⚠️ 仅作线索：MDN 官方定义 WebSocket 是创建、管理并与 server 建立连接、收发数据的 API，原文包含『for sending and receiving data on the connection.』。静态文件托管本身只提供客户端资源；真实远端 Shell 需要可连接的 WSS 服务端、鉴权与进程会话。这个结论是 Web 架构推论，不是 Qoder 官方对 Sites 的限制声明。原文见 raw/sites-05.txt。 [125]（成立范围：MDN WebSocket 官方参考，2026-11-26；未对 Qoder 网关做 Upgrade/101 实测。）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：未找到 Qoder 官方公开文档明确支持或禁止 Sites Functions 承载长连接 WebSocket、后台常驻进程、PTY、容器或 SSH。已核 Sites 概览、Qoder CLI Sites 与 Qoder CN CLI Sites；正文只确认静态站点、Functions、数据库和存储等产品能力。因此这些边界应登记为“未证实”，不能写成官方不支持，也不能因 Cloud Agents 或更新日志出现 WebSocket 就外推到 Sites Functions。 [126][127][128]（成立范围：2026-11-26 官方文档正文与多引擎检索；检索不到不等于能力不存在。未登录、未部署、未读取真实站点配置或运行函数。正文见 raw/sites-01.txt、raw/sites-02.txt、raw/sites-03.txt；检索审计见 scratch/sites-search-audit.json。）（状态 pending，未达 verified 判据）
- practitioner 架构建议：真实 Shell 应放在可控的常驻后端（VPS/VM/容器或隔离会话服务），由 PTY 进程执行命令，前端 xterm.js 经 WSS 连接；Qoder Sites 只承担静态前端或经证实可用的函数层。WebContainers 官方把自身定位为浏览器内 Node.js 运行时，不能据此宣称任意 Linux PTY/SSH 可在静态页运行。该部署分工是工程推断，不是 Qoder 官方规定。 [129][130][131]（成立范围：由 xterm.js、MDN WebSocket 与 WebContainers 官方材料综合；未选定供应商、未部署后端、未做隔离或成本压测。原文见 raw/sites-04.txt、raw/sites-05.txt、raw/sites-06.txt。）
- ⚠️ 仅作线索：静态站点 + 外部轻后端的技术合规要点是：浏览器向外部 WSS 发起连接，后端必须自行校验 Origin/租户、鉴权令牌、会话归属与每会话 PTY 生命周期；CORS 不是 WebSocket 的完整授权机制，前端环境变量不能藏秘密。还需限制并发、命令权限、空闲回收、输出脱敏、重连与计费。以上是安全工程建议，不是 Qoder 官方政策；未找到 Qoder 对跨域后端连接的公开承诺。 [132]（成立范围：架构/安全推断，锚定 MDN WebSocket 的客户端—服务器模型；未做渗透测试或框架级 CORS 实测。原文见 raw/sites-05.txt。）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：比赛提交不能据现有材料认定可把外部后端替代 Qoder Sites：官方赛制搜索摘要要求作品开发与部署均由 Qoder 完成并部署到 Qoder Sites、开放公开访问；本次未找到明确允许或禁止外部轻后端的条款。技术上前端可引用外部 WSS，但比赛合规性仍未证实，应向主办方确认并保留 Qoder Sites 公网作品入口，不能把外部后端链接当已获批准的提交链接。 [133][134]（成立范围：天池官方赛制页的 WebSearch 摘要与 Qoder 官方 Sites 公网发布说明，2026-11-26；天池正文由 JS 渲染，WebFetch 未取得完整规则，故外部后端许可保持未证实。未咨询主办方。）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：官方明确说明 Sites 当前限时免费且有 usage limits：达到限制可能暂时限制创建站点或高用量站点的公开访问，用量按账户下所有站点累计，免费期内限制可能调整。外部后端成本不属于这条 Qoder 配额；本次未找到具体函数时长、连接数、流量或数值化价格，不能给出可靠成本上限。原文见 raw/sites-01.txt。 [135]（成立范围：Qoder 官方 Sites 概览，2026-11-26；只核定性配额说明，未登录账单/控制台，不把限时免费解释为永久免费。）（状态 pending，未达 verified 判据）

## 浏览器真实 Shell 与 PTY 技术路线

真实终端应拆成〔渲染、执行、隔离、判定〕四层。xterm.js 负责渲染和输入，node-pty 负责服务端进程与伪终端，两者通过数据读写对接 [136][137]；Wetty 证明 WebSocket 是现成传输路线 [139]，ttyd 则提醒只读默认、可写权限和 Origin 校验必须显式设计 [145]。如果走服务端 PTY，node-pty 官方明确子进程继承父进程权限，必须另加容器或进程隔离 [138][170]。如果走无后端，v86 是在浏览器里模拟 x86 硬件并加载 Linux 镜像 [142][143]，不是把宿主 Shell 搬进浏览器；jQuery Terminal 则代表另一条纯前端命令解释器路线 [144]，适合做引导但不提供真实 Linux 语义。ShellLab 应定义统一运行时接口：`start/reset/write/read/snapshot/check`，比赛期由 v86 实现，后续由 PTY 容器实现；任务与证据层不直接依赖 xterm.js 或 node-pty，避免以后换执行通道时重写全部内容。
- xterm.js 官方 README 将自身定位为浏览器前端组件：『Xterm.js is a frontend component that enables applications to bring fully-featured terminals to their users in the browser.』其接入示例以 『pty.onData(data => term.write(data));』 和 『term.onData(data => pty.write(data));』 对接伪终端，说明终端 UI 与真正驱动它的 PTY 是两层。 [136][148]（成立范围：官方 README 全文；xterm.js 项目当前 master 分支；非同行评审；2026-11-26 读取并存档。结论只说明 xterm.js 的组件定位和示例接法，不证明所有浏览器终端都使用 node-pty。）
- node-pty 官方 README 说明其提供 『`forkpty(3)` bindings for node.js. This allows you to fork processes with pseudoterminal file descriptors. It returns a terminal object which allows reads and writes.』并明确 『`node-pty` supports Linux, macOS and Windows.』因此它承担的是服务端进程与伪终端文件描述符，而不是浏览器终端渲染。 [137][151]（成立范围：官方 README 全文；microsoft/node-pty 当前 main 分支；非同行评审；2026-11-26 读取并存档。平台支持按该 README 当前表述，未进行本机兼容性实测。）
- node-pty 官方安全章节指出：『All processes launched from node-pty will launch at the same permission level of the parent process. Take care particularly when using node-pty inside a server that's accessible on the internet. We recommend launching the pty inside a container to protect your host machine.』这直接支持服务端 PTY 必须另行考虑容器或进程隔离，而不能把 node-pty 本身当作沙箱。 [138][170]（成立范围：官方 README 的 Security 章节；非同行评审；2026-11-26 读取并存档。这里只确认官方建议，不声称容器隔离已经在本项目实现或通过安全验收。）
- Wetty 官方 README 描述其浏览器终端使用 xterm.js，并明确：『WeTTY uses websockets rather than Ajax and hence better response time.』这是一条浏览器终端仿真器经 WebSocket 类通道连接服务端终端的现成架构证据；该 README 本身未给出逐会话容器隔离保证。 [139][165]（成立范围：官方 README 全文；krishnasrinivas/wetty master 分支；非同行评审；2026-11-26 读取并存档。仅确认传输与前端组件表述，未审查其全部服务端实现。）
- ⚠️ 仅作线索：WebContainers 官方介绍将其定义为：『WebContainers are a browser-based runtime for executing Node.js applications and operating system commands, entirely inside your browser tab.』这把浏览器内 Node/命令执行路线与必须依赖服务端 PTY 的路线明确区分开来。 [140]（成立范围：WebContainers 官方 Introduction 页面全文；厂商文档，非同行评审；2026-11-26 读取并存档。只确认官方产品定位，不把厂商性能或用户规模表述当作独立实测。）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：WebContainers 官方浏览器支持文档指出：『StackBlitz requires some of the latest additions to the Web Platform to work correctly when running WebContainers-based projects. Most important among them are SharedArrayBuffer and cross-origin isolation.』同页还说明：『As mentioned above, Firefox does not fully support the required mode for cross-origin isolation, so you might encounter limitations when running a server in a preview window within the StackBlitz editor.』这构成其部署与浏览器兼容边界的一手证据。 [141]（成立范围：WebContainers 官方 Browser Support 页面全文；厂商文档，非同行评审；2026-11-26 读取并存档。浏览器支持会随版本变化，本 claim 不固化为永久兼容矩阵。）（状态 pending，未达 verified 判据）
- v86 官方 README 写明：『v86 emulates an x86-compatible CPU and hardware. Machine code is translated to WebAssembly modules at runtime in order to achieve decent performance.』因此 v86 的路线是在浏览器中模拟 x86 硬件并运行客户机，而不是把宿主 Linux Shell 直接搬到浏览器。 [142][153]（成立范围：v86 官方 Readme.md 全文；copy/v86 当前 master 分支；非同行评审；2026-11-26 读取并存档。只确认仿真机制，不声称其性能已达到原生机器。）
- v86 官方 README 给出 Linux 适用边界：『Linux works pretty well. 64-bit kernels are not supported.』并说明 『ROM and disk images are loaded via XHR』 且 『The disk images for testing are not included in this repository.』这说明 WASM Linux 路线需要准备并加载客户机镜像，不能把启动成本理解为只下载一个前端 Shell 组件。 [143][152]（成立范围：v86 官方 Readme.md 的 Linux、示例与测试镜像段落；非同行评审；2026-11-26 读取并存档。未测量启动耗时或内存占用，故不登记任何量化成本。）
- jQuery Terminal 官方 README 将自身描述为：『jQuery Terminal Emulator is a plugin for creating command line interpreters in your applications.』这代表纯前端命令解释器/伪 Shell 路线：它可以呈现命令行交互并接入 JSON-RPC，但该表述本身不等于创建了 Linux 进程、PTY 或完整客户机。 [144][166]（成立范围：jQuery Terminal 官方 README 开头；非同行评审；2026-11-26 读取并存档。后半句是对组件定位的边界归纳，未声称该项目不能通过后端扩展执行真实命令。）
- ttyd 官方 README 写明：『ttyd is a simple command-line tool for sharing terminal over the web.』其选项包括 『Allow clients to write to the TTY (readonly by default)』 与 websocket origin 检查，说明服务端 TTY 经 Web 暴露时，传输、可写权限与来源校验都属于终端服务设计的一部分。 [145][167]（成立范围：ttyd 官方 README 全文；tsl0922/ttyd 当前 main 分支；非同行评审；2026-11-26 读取并存档。未进行 ttyd 部署或安全实测。）
- ⚠️ 仅作线索：Docker 官方安全文档把内核命名空间作为容器隔离基础：『Namespaces provide the first and most straightforward form of isolation.』这支持把每会话容器/进程隔离视为服务端 PTY 之外的独立安全层；容器名称本身不能证明隔离强度，仍需审查权限、能力与挂载配置。 [146]（成立范围：Docker 官方 Engine Security 文档的 Kernel namespaces 段落；非同行评审；2026-11-26 读取并存档。后半句是安全边界归纳，不构成对任何具体容器配置的审计结论。）（状态 pending，未达 verified 判据）
- ⚠️ 仅作线索：JupyterLab 官方终端文档说明：『JupyterLab terminals provide full support for system shells (bash, tcsh, etc.) on Mac/Linux and PowerShell on Windows.』并说明终端运行在 Jupyter 服务器所在系统。这是浏览器 UI 连接服务端真实系统 Shell 的又一手文档实例，与纯前端命令解释器路线不同。 [147]（成立范围：JupyterLab 官方 Terminals 页面全文；文档版本 4.6.6；非同行评审；2026-11-26 读取并存档。只确认服务器端 Shell 定位，未实测 JupyterLab 终端。）（状态 pending，未达 verified 判据）

## 调研方法
本轮于 2026-11-26 执行，先通过环境门和 27 引擎探针，再按 6 个主题分两波派发子研究员：现有产品、终端技术路线、开源候选、演练评估、Qoder Sites 边界、风险与性能。检索以 GitHub 仓库/API、官方文档、产品官方页和论文为主；Tavily、Firecrawl、3 个 MCP、Semantic Scholar 两路、搜狗/百度学术/Gitee、SearXNG 缺失或受限，未用其补充结论。主 Agent 只读取结构化分片并归并，未吞原始搜索长文。verified 采用两档：档 A 要求去重后至少两个独立来源；档 B 要求同一制品的另一通道反查（GitHub blob/raw/API、arXiv HTML/abs）。最终 67 条 claim 中 37 条 verified、30 条 pending、0 条 conflict；99 段长引文逐字命中，14 段短于 15 字的引文未参与逐字判定。所有候选均未安装、未部署、未做性能或安全实测。
账本事实：claims 67 条（verified 37 / 仅作线索 30 / 来源冲突 0），来源 175 条，独立域名 23 个。
<!-- 选型调研判定：仓库链接只出现在证据节时，发布门自动豁免六维；出现在一页拍板/执行摘要/结论与建议里则按选型走六维门。要显式指定，可写一行以「选型调研」开头接是或否的声明 -->

## 结论与建议

### 1. 技术选型
- **比赛候选首发**：Qoder Sites 静态前端 + xterm.js + v86 + 精简 Linux 镜像。它提供真实 Shell 语义且无需常驻后端，但必须先通过启动、重置、移动端与托管资产 PoC 门，才能升为比赛主路线 [142][143]。
- **长期主候选**：node-pty + 每会话容器 + WebSocket。它最接近真实运维，但〔隔离最强〕不是未配置下的既成事实；必须补齐认证、隔离、配额、审计、快照和重置，并通过威胁模型与压测 [110][138]。
- **不作为主内核**：脚本模拟器、WebContainers、CTFd。前者不够真实；中者不是完整 Linux 且许可/浏览器边界复杂；后者对当前作品过重 [89][106][45]。

### 2. 产品设计
- 采用 **1 个旗舰事故先行，验证通过后再扩 3 个专项演练**；每个场景包含初始状态、目标、成功条件、关键证据、分级提示、根因复盘和迁移测试。截止前优先砍专项数量，不砍核心事故闭环。
- 判定检查状态而非固定命令序列；保存命令轨迹、输出、证据和检查器版本 [59][65][69]。纯前端判定只作为练习反馈；要高可信成绩，检查器和关键状态必须放到可信后端。
- 前端保留黑灰白、JetBrains Mono、无衬线；动效服务状态变化，不做装饰性噪点或假指标。

### 3. 实施顺序
1. **真实 Shell 切片**：v86 启动、输入/输出、save/restore、文件/权限/日志命令；先测桌面冷/热启动 P50/P95、峰值内存、50 次重置成功率，再测手机内存与可用性。未过门不扩内容。
2. **场景引擎**：统一 `TerminalRuntime`、场景快照、目标检查、证据提交、提示层级、轨迹回放；明确区分练习反馈与权威判定。
3. **内容制作**：先做 1 个不依赖 systemd 的多阶段旗舰事故，再补 3 个专项演练和 1 个迁移测试；手机端先保证导览与命令输入可用，不承诺同等级虚拟机体验。
4. **部署与合规**：Qoder Sites 发布静态作品并核资产限制；⚠️ 外部 PTY 后端是否启用，先取得主办方明确答复，当前合规边界未证实 [133]。
5. **验收指标**：冷/热启动 P50/P95、命令到输出 P95、峰值内存、50 次重置成功率、每场景完成率、证据提交率、迁移测试通过率、移动端可用性；全部来自真实运行，不预估。

### 4. 风险与不做项
- v86 的 64 位/多核限制、镜像体积、移动端内存和启动时间仍需实测 [100][101]；Qoder Sites 的资产体积与响应头限制也未核。
- v86 PoC 未过门时，降级为明确标注的脚本练习 + 真实 Linux 录屏，不冒充实时环境。
- ⚠️ Qoder Sites Functions 的长连接/PTY 能力未证实，不写入承诺 [126][127][128]。
- 不直接搬运 Linux Journey 品牌或课程内容 [81][82]；不把厂商性能自述当独立基准；不为了“功能多”提前上账号、排行榜、数据库或复杂 Agent。
- 本轮没有运行任何候选制品，所有性能、隔离和合规结论都以上述证据边界为准。

## 来源

| 编号 | Tier | 标题 | URL |
|------|------|------|-----|
| [1] | 1 | xterm.js official repository | https://github.com/xtermjs/xterm.js |
| [2] | 1 | xterm.js GitHub repository metadata | https://api.github.com/repos/xtermjs/xterm.js |
| [3] | 1 | xterm.js README | https://github.com/xtermjs/xterm.js#readme |
| [4] | 1 | xterm.js 6.0.0 release | https://github.com/xtermjs/xterm.js/releases/tag/6.0.0 |
| [5] | 1 | xterm.js license API | https://api.github.com/repos/xtermjs/xterm.js/license |
| [6] | 1 | microsoft/node-pty official repository | https://github.com/microsoft/node-pty |
| [7] | 1 | microsoft/node-pty GitHub metadata | https://api.github.com/repos/microsoft/node-pty |
| [8] | 1 | microsoft/node-pty README | https://github.com/microsoft/node-pty#readme |
| [9] | 1 | node-pty npm package metadata | https://www.npmjs.com/package/node-pty |
| [10] | 1 | node-pty v1.1.0 release | https://github.com/microsoft/node-pty/releases/tag/v1.1.0 |
| [11] | 1 | lydell/node-pty official repository | https://github.com/lydell/node-pty |
| [12] | 1 | lydell/node-pty GitHub metadata | https://api.github.com/repos/lydell/node-pty |
| [13] | 1 | lydell/node-pty README | https://github.com/lydell/node-pty#readme |
| [14] | 1 | @lydell/node-pty npm package metadata | https://www.npmjs.com/package/@lydell/node-pty |
| [15] | 1 | lydell/node-pty v1.2.0-beta.3 release | https://github.com/lydell/node-pty/releases/tag/v1.2.0-beta.3 |
| [16] | 1 | v86 official repository | https://github.com/copy/v86 |
| [17] | 1 | v86 GitHub metadata | https://api.github.com/repos/copy/v86 |
| [18] | 1 | v86 README | https://github.com/copy/v86#readme |
| [19] | 1 | v86 license API | https://api.github.com/repos/copy/v86/license |
| [20] | 1 | Wetty official repository | https://github.com/butlerx/wetty |
| [21] | 1 | Wetty GitHub metadata | https://api.github.com/repos/butlerx/wetty |
| [22] | 1 | Wetty README | https://github.com/butlerx/wetty#readme |
| [23] | 1 | Wetty v4.2.1 release | https://github.com/butlerx/wetty/releases/tag/v4.2.1 |
| [24] | 1 | OSV: Wetty DOM XSS advisory | https://osv.dev/vulnerability/GHSA-p26j-h7wj-r568 |
| [25] | 1 | ttyd official repository | https://github.com/tsl0922/ttyd |
| [26] | 1 | ttyd GitHub metadata | https://api.github.com/repos/tsl0922/ttyd |
| [27] | 1 | ttyd README | https://github.com/tsl0922/ttyd#readme |
| [28] | 1 | ttyd 1.7.7 release | https://github.com/tsl0922/ttyd/releases/tag/1.7.7 |
| [29] | 1 | ttyd license API | https://api.github.com/repos/tsl0922/ttyd/license |
| [30] | 1 | GoTTY official repository | https://github.com/sorenisanerd/gotty |
| [31] | 1 | GoTTY GitHub metadata | https://api.github.com/repos/sorenisanerd/gotty |
| [32] | 1 | GoTTY README | https://github.com/sorenisanerd/gotty#readme |
| [33] | 1 | GoTTY v1.11.0 release | https://github.com/sorenisanerd/gotty/releases/tag/v1.11.0 |
| [34] | 1 | GoTTY license API | https://api.github.com/repos/sorenisanerd/gotty/license |
| [35] | 1 | WebSSH official repository | https://github.com/huashengdun/webssh |
| [36] | 1 | WebSSH GitHub metadata | https://api.github.com/repos/huashengdun/webssh |
| [37] | 1 | WebSSH README | https://github.com/huashengdun/webssh#readme |
| [38] | 1 | WebSSH v1.6.3 release | https://github.com/huashengdun/webssh/releases/tag/v1.6.3 |
| [39] | 1 | OSV: WebSSH XSS advisory | https://osv.dev/vulnerability/GHSA-9cg4-9hv5-3376 |
| [40] | 1 | PyPA: WebSSH XSS advisory | https://osv.dev/vulnerability/PYSEC-2025-234 |
| [41] | 1 | sshx official repository | https://github.com/ekzhang/sshx |
| [42] | 1 | sshx README | https://github.com/ekzhang/sshx#readme |
| [43] | 1 | sshx v0.4.1 release | https://github.com/ekzhang/sshx/releases/tag/v0.4.1 |
| [44] | 1 | sshx MIT license | https://github.com/ekzhang/sshx/blob/main/LICENSE |
| [45] | 1 | CTFd official repository | https://github.com/CTFd/CTFd |
| [46] | 1 | CTFd GitHub metadata | https://api.github.com/repos/CTFd/CTFd |
| [47] | 1 | CTFd README | https://github.com/CTFd/CTFd#readme |
| [48] | 1 | CTFd 3.8.9 release | https://github.com/CTFd/CTFd/releases/tag/3.8.9 |
| [49] | 1 | CTFd license API | https://api.github.com/repos/CTFd/CTFd/license |
| [50] | 1 | shellinabox official repository | https://github.com/shellinabox/shellinabox |
| [51] | 1 | shellinabox GitHub metadata | https://api.github.com/repos/shellinabox/shellinabox |
| [52] | 1 | shellinabox README | https://github.com/shellinabox/shellinabox#readme |
| [53] | 1 | shellinabox v2.21 release | https://github.com/shellinabox/shellinabox/releases/tag/v2.21 |
| [54] | 1 | shellinabox license API | https://api.github.com/repos/shellinabox/shellinabox/license |
| [55] | 1 | Terminal Mastery Lab official repository | https://github.com/Comeranas/terminal-mastery-lab |
| [56] | 1 | Terminal Mastery Lab GitHub metadata | https://api.github.com/repos/Comeranas/terminal-mastery-lab |
| [57] | 1 | Terminal Mastery Lab README | https://github.com/Comeranas/terminal-mastery-lab#readme |
| [58] | 1 | Terminal Mastery Lab license API | https://api.github.com/repos/Comeranas/terminal-mastery-lab/license |
| [59] | 1 | Terminal-Bench: Benchmarking Agents on Hard, Realistic Tasks in Terminals | https://arxiv.org/html/2601.11868v1 |
| [60] | 1 | SadServers Linux & DevOps Troubleshooting Scenarios | https://sadservers.com/scenarios |
| [61] | 1 | Chaos Engineering Concepts in the Chaos Toolkit | https://chaostoolkit.org/reference/concepts/ |
| [62] | 1 | Chaos Toolkit Experiment API | https://chaostoolkit.org/reference/api/experiment/ |
| [63] | 1 | Killercoda Creator Documentation | https://killercoda.com/creators |
| [64] | 1 | Killercoda FAQ | https://killercoda.com/faq |
| [65] | 1 | Terminal-Bench: Benchmarking Agents on Hard, Realistic Tasks in Terminals | https://arxiv.org/html/2601.11868v1 |
| [66] | 1 | masporfirio/linux-troubleshooting-labs README | https://github.com/masporfirio/linux-troubleshooting-labs |
| [67] | 1 | SadServers FAQ | https://sadservers.com/faq |
| [68] | 1 | SadServers FAQ | https://sadservers.com/faq |
| [69] | 1 | Terminal-Bench: Benchmarking Agents on Hard, Realistic Tasks in Terminals | https://arxiv.org/html/2601.11868v1 |
| [70] | 1 | OSWorld-V2 Public Evaluation Guideline | https://github.com/xlang-ai/OSWorld-V2/blob/main/docs/PUBLIC_EVALUATION_GUIDELINE.md |
| [71] | 1 | Killercoda Creator Documentation | https://killercoda.com/creators |
| [72] | 1 | SadServers Linux & DevOps Troubleshooting Scenarios | https://sadservers.com/scenarios |
| [73] | 1 | SadServers FAQ | https://sadservers.com/faq |
| [74] | 1 | Chaos Toolkit Experiment API | https://chaostoolkit.org/reference/api/experiment/ |
| [75] | 1 | Webminal — Free GNU/Linux Online Terminal | https://webminal.org/ |
| [76] | 1 | OverTheWire: Wargames | https://overthewire.org/wargames/ |
| [77] | 1 | OverTheWire: Bandit | https://overthewire.org/wargames/bandit/ |
| [78] | 1 | Ubuntu Playground | KodeKloud | https://kodekloud.com/playgrounds/playground-ubuntu |
| [79] | 1 | Plans & Pricing | KodeKloud | https://kodekloud.com/pricing |
| [80] | 1 | CKA Simulator | Killer Shell | https://killer.sh/cka |
| [81] | 1 | Linux Journey official repository README | https://github.com/labex-labs/linuxjourney/blob/master/README.md |
| [82] | 1 | Linux Journey Official Site | LabEx | https://labex.io/linuxjourney |
| [83] | 1 | JSLinux — Fabrice Bellard | https://bellard.org/jslinux/ |
| [84] | 1 | WebContainers — Dev environments in your web app | https://webcontainers.io/ |
| [85] | 1 | StackBlitz WebContainer Core repository | https://github.com/stackblitz/webcontainer-core |
| [86] | 1 | WebContainer Core MIT License | https://raw.githubusercontent.com/stackblitz/webcontainers/main/LICENSE |
| [87] | 1 | xterm.js official README | https://github.com/xtermjs/xterm.js/blob/master/README.md |
| [88] | 1 | xterm.js MIT License | https://raw.githubusercontent.com/xtermjs/xterm.js/master/LICENSE |
| [89] | 1 | Terminux official README | https://github.com/RyZenoKelb/Terminux/blob/master/README.md |
| [90] | 1 | Terminux GitHub repository metadata | https://api.github.com/repos/RyZenoKelb/Terminux |
| [91] | 1 | Webminal — cloud Linux terminal | https://webminal.org/ |
| [92] | 1 | OverTheWire — SSH wargames | https://overthewire.org/wargames/ |
| [93] | 1 | KodeKloud — browser Ubuntu playground | https://kodekloud.com/playgrounds/playground-ubuntu |
| [94] | 1 | JSLinux — emulated systems | https://bellard.org/jslinux/ |
| [95] | 1 | Terminux — scripted terminal simulation | https://github.com/RyZenoKelb/Terminux/blob/master/README.md |
| [96] | 1 | xterm.js — frontend component boundary | https://github.com/xtermjs/xterm.js/blob/master/README.md |
| [97] | 1 | WebContainers — browser Node.js runtime | https://webcontainers.io/ |
| [98] | 1 | copy/images official GitHub contents metadata | https://api.github.com/repos/copy/images/contents |
| [99] | 1 | v86 official GitHub release asset metadata | https://api.github.com/repos/copy/v86/releases?per_page=5 |
| [100] | 1 | v86 official Linux boot benchmark source | https://github.com/copy/v86/blob/master/tests/benchmark/linux-boot.js |
| [101] | 1 | v86 official README — hardware and Linux compatibility | https://github.com/copy/v86/blob/master/Readme.md |
| [102] | 1 | v86 official networking documentation | https://github.com/copy/v86/blob/master/docs/networking.md |
| [103] | 1 | WebContainers Browser Support | https://webcontainers.io/guides/browser-support |
| [104] | 1 | Introduction | WebContainers | https://webcontainers.io/guides/introduction |
| [105] | 1 | Running Processes | WebContainers | https://webcontainers.io/guides/running-processes |
| [106] | 1 | Commercial Usage | WebContainers | https://webcontainers.io/enterprise |
| [107] | 1 | StackBlitz Terms of Service — WebContainer API | https://stackblitz.com/terms-of-service |
| [108] | 1 | WebContainer Core MIT License | https://raw.githubusercontent.com/stackblitz/webcontainer-core/main/LICENSE |
| [109] | 1 | WebContainer Core official repository | https://github.com/stackblitz/webcontainer-core |
| [110] | 1 | node-pty official README — Security | https://github.com/microsoft/node-pty/blob/main/README.md#security |
| [111] | 1 | Docker Engine resource constraints | https://docs.docker.com/engine/containers/resource_constraints/ |
| [112] | 1 | Docker Engine security documentation | https://docs.docker.com/engine/security/ |
| [113] | 1 | v86 Linux boot benchmark method | https://github.com/copy/v86/blob/master/tests/benchmark/linux-boot.js |
| [114] | 1 | WebContainers browser compatibility boundaries | https://webcontainers.io/guides/browser-support |
| [115] | 1 | WebContainers official performance and security positioning | https://webcontainers.io/guides/introduction |
| [116] | 1 | WebContainers commercial usage boundary | https://webcontainers.io/enterprise |
| [117] | 1 | node-pty security boundary | https://github.com/microsoft/node-pty/blob/main/README.md#security |
| [118] | 1 | Docker default resource constraint behavior | https://docs.docker.com/engine/containers/resource_constraints/ |
| [119] | 1 | v86 official disk image sizes | https://api.github.com/repos/copy/images/contents |
| [120] | 1 | v86 official WASM and JS asset sizes | https://api.github.com/repos/copy/v86/releases?per_page=5 |
| [121] | 1 | Qoder Sites official overview | https://docs.qoder.com/qoder/sites |
| [122] | 1 | Sites: Build and Host Websites — Qoder CLI | https://docs.qoder.com/cli/sites |
| [123] | 1 | Sites 站点构建与托管 — Qoder CN CLI | https://docs.qoder.cn/cli/sites |
| [124] | 1 | xterm.js official README | https://raw.githubusercontent.com/xtermjs/xterm.js/master/README.md |
| [125] | 1 | WebSocket — MDN Web APIs | https://developer.mozilla.org/en-US/docs/Web/API/WebSocket |
| [126] | 1 | Qoder Sites official overview | https://docs.qoder.com/qoder/sites |
| [127] | 1 | Sites: Build and Host Websites — Qoder CLI | https://docs.qoder.com/cli/sites |
| [128] | 1 | Sites 站点构建与托管 — Qoder CN CLI | https://docs.qoder.cn/cli/sites |
| [129] | 1 | xterm.js official README | https://raw.githubusercontent.com/xtermjs/xterm.js/master/README.md |
| [130] | 1 | WebSocket — MDN Web APIs | https://developer.mozilla.org/en-US/docs/Web/API/WebSocket |
| [131] | 1 | WebContainers official homepage | https://webcontainers.io/ |
| [132] | 1 | WebSocket — MDN Web APIs | https://developer.mozilla.org/en-US/docs/Web/API/WebSocket |
| [133] | 1 | 2026 Qoder 高校创造力大赛 — 天池官方赛制页 | https://tianchi.aliyun.com/competition/entrance/532536 |
| [134] | 1 | Qoder Sites official overview | https://docs.qoder.com/qoder/sites |
| [135] | 1 | Qoder Sites official overview | https://docs.qoder.com/qoder/sites |
| [136] | 1 | xterm.js official README | https://github.com/xtermjs/xterm.js/blob/master/README.md |
| [137] | 1 | node-pty official README | https://github.com/microsoft/node-pty/blob/main/README.md |
| [138] | 1 | node-pty official README — Security | https://github.com/microsoft/node-pty/blob/main/README.md#security |
| [139] | 1 | Wetty official README | https://github.com/krishnasrinivas/wetty/blob/master/README.md |
| [140] | 1 | Introduction | WebContainers | https://webcontainers.io/guides/introduction |
| [141] | 1 | Browser Support | WebContainers | https://webcontainers.io/guides/browser-support |
| [142] | 1 | v86 official README | https://github.com/copy/v86/blob/master/Readme.md |
| [143] | 1 | v86 official README — Linux and images | https://github.com/copy/v86/blob/master/Readme.md |
| [144] | 1 | jQuery Terminal official README | https://github.com/jcubic/jquery.terminal/blob/master/README.md |
| [145] | 1 | ttyd official README | https://github.com/tsl0922/ttyd/blob/main/README.md |
| [146] | 1 | Docker Engine security documentation | https://docs.docker.com/engine/security/ |
| [147] | 1 | Terminals — JupyterLab documentation | https://jupyterlab.readthedocs.io/en/stable/user/terminal.html |
| [148] | 1 | xterm.js README | https://raw.githubusercontent.com/xtermjs/xterm.js/master/README.md |
| [149] | 1 | xterm.js README | https://raw.githubusercontent.com/xtermjs/xterm.js/master/README.md |
| [150] | 1 | xterm.js README | https://github.com/xtermjs/xterm.js/blob/master/README.md |
| [151] | 1 | node-pty README | https://raw.githubusercontent.com/microsoft/node-pty/main/README.md |
| [152] | 1 | v86 README | https://raw.githubusercontent.com/copy/v86/master/Readme.md |
| [153] | 1 | v86 README | https://raw.githubusercontent.com/copy/v86/master/Readme.md |
| [154] | 1 | v86 README | https://raw.githubusercontent.com/copy/v86/master/Readme.md |
| [155] | 1 | v86 Linux boot benchmark | https://raw.githubusercontent.com/copy/v86/master/tests/benchmark/linux-boot.js |
| [156] | 1 | v86 networking | https://raw.githubusercontent.com/copy/v86/master/docs/networking.md |
| [157] | 1 | xterm.js README | https://api.github.com/repos/xtermjs/xterm.js/contents/README.md |
| [158] | 1 | v86 README | https://api.github.com/repos/copy/v86/contents/README.md |
| [159] | 1 | ttyd README | https://api.github.com/repos/tsl0922/ttyd/contents/README.md |
| [160] | 1 | GoTTY README | https://api.github.com/repos/sorenisanerd/gotty/contents/README.md |
| [161] | 1 | sshx README | https://raw.githubusercontent.com/ekzhang/sshx/main/README.md |
| [162] | 1 | CTFd README | https://api.github.com/repos/CTFd/CTFd/contents/README.md |
| [163] | 1 | shellinabox README | https://api.github.com/repos/shellinabox/shellinabox/contents/README.md |
| [164] | 1 | Terminal Mastery Lab README | https://api.github.com/repos/Comeranas/terminal-mastery-lab/contents/README.md |
| [165] | 1 | Wetty README | https://raw.githubusercontent.com/krishnasrinivas/wetty/master/README.md |
| [166] | 1 | jQuery Terminal README | https://raw.githubusercontent.com/jcubic/jquery.terminal/master/README.md |
| [167] | 1 | ttyd README | https://raw.githubusercontent.com/tsl0922/ttyd/main/README.md |
| [168] | 1 | Terminux README | https://raw.githubusercontent.com/RyZenoKelb/Terminux/master/README.md |
| [169] | 1 | node-pty security | https://raw.githubusercontent.com/microsoft/node-pty/main/README.md#security |
| [170] | 1 | node-pty security | https://raw.githubusercontent.com/microsoft/node-pty/main/README.md#security |
| [171] | 1 | Terminal-Bench | https://arxiv.org/abs/2601.11868 |
| [172] | 1 | Terminal-Bench | https://arxiv.org/abs/2601.11868 |
| [173] | 1 | Terminal-Bench | https://arxiv.org/abs/2601.11868 |
| [174] | 1 | v86 save and restore example | https://github.com/copy/v86/blob/master/examples/save_restore.html |
| [175] | 1 | shellinabox COPYING | https://github.com/shellinabox/shellinabox/blob/master/COPYING |

---
> 本文件由 `skeleton.py` 从证据账本生成，引用编号与来源登记表不可手改。标了"待写"的段落（摘要 / 调研方法 / 结论建议 / 每条冲突的裁决）必须由 Lead 写掉——标记不删净就过不了校验门，骨架也就永远不会被当成报告交付。未验证的 claim 已就地渲染为 ⚠️ 仅作线索，不必逐条改写；但正文引用它们时不得写成结论，校验门会查这处标注。

<!-- drux:validated v=1 body=fd23ff3419512ecd ledger=dbea7772ec96d3b4 claims=67 sources=175 -->
