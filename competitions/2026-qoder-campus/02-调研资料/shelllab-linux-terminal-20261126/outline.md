# Linux 浏览器模拟终端与开源运维演练场选型

## 一页拍板
- 推荐架构：静态前端 + 受控服务端 PTY/容器，Qoder Sites 作为作品入口；浏览器内 WASM 作为无后端演示后备。
- 推荐借鉴：xterm.js（终端 UI）、node-pty（PTY）、ttyd/Wetty（WebSocket 架构）、Killercoda/SadServers/Terminal-Bench（场景与判定）。

## 执行摘要
- 现有产品按执行真相分为远端真实环境、SSH wargame、系统模拟、脚本模拟、Node 运行时、终端 UI。
- 真实 Linux 语义需要 PTY/容器或完整系统模拟，xterm.js 本身不是 Shell。
- 运维演练的关键是状态判定、证据链、提示层级和防作弊，不是固定命令脚本。

## 调研范围与方法
- 6 个主题、67 条 claim、147 条来源映射；37 条已验证，30 条待补。
- 数据源：GitHub 仓库/API、官方文档、论文、产品官方页面；缺失源已标注。

## 1. 现有 Linux 学习网站与模拟器
- Webminal、OverTheWire、KodeKloud、Killer.sh、Linux Journey/LabEx、JSLinux、Terminux、WebContainers、xterm.js。
- 对比执行真相、任务形态、进度/评估、可借鉴点与边界。

## 2. 浏览器真实 Shell 与 PTY 技术路线
- 纯前端伪 Shell；v86/JSLinux 系统模拟；WebContainers Node 运行时；服务端 node-pty + WebSocket + 容器。
- 每种路线的能力、隔离、部署与适用场景。

## 3. 开源项目候选与六维质量
- xterm.js、node-pty/lydell、v86、Wetty、ttyd、GoTTY、WebSSH、sshx、CTFd、shellinabox、Terminal Mastery Lab。
- 事实层、维护、许可证、安全、适配性、落地成本。

## 4. 故障演练任务与证据评估
- Terminal-Bench、SadServers、Killercoda、Chaos Toolkit、OSWorld-V2、linux-troubleshooting-labs。
- 初始状态、成功条件、验证脚本、证据、错因、防作弊、进度保存。

## 5. Qoder Sites 静态部署边界
- 已确认：静态部署、Server Functions、公网发布、限时免费与用量限制。
- 未确认：Functions 是否支持 WebSocket/PTY/常驻进程；外部后端是否满足比赛部署要求。

## 6. 性能、安全、成本与兼容性
- v86 镜像/启动基准/32 位与单核限制；WebContainers 浏览器与许可边界；node-pty 权限；Docker 资源约束。
- 移动端、并发、会话隔离、命令审计、重置与回收。

## 7. ShellLab 借鉴与落地方案
- 产品形态：1 个旗舰事故 + 3 个专项演练；状态变化 + 证据 + 迁移测试。
- 架构：xterm.js + 场景引擎 + PTY 后端 + 判定服务；静态前端降级模式。
- 实施顺序、风险、验证指标与不做项。

## 结论与建议
- 先做可验证的真实 PTY 垂直切片，再扩内容；不要先堆静态任务。
- 比赛公网链接保留 Qoder Sites，外部后端合规性向主办方确认。

## 专家团评审处置
- 域专家：补充“PTY ≠ 隔离”“WebContainers ≠ 完整 Linux”“v86 32 位/单核边界”等易误用术语。
- 怀疑者：厂商自述单独标注；Qoder Functions 长连接能力、外部后端比赛合规、移动端性能保持未证实。
- 实践者：补服务端会话隔离、资源限额、重置回收、成本与分阶段实施；不把未部署方案写成已验证结论。

## 附录
- MECE 问题树、完整来源列表、质量自评、未决事项。
