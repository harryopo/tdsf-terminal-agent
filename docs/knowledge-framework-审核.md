# Linux 运维教学知识库框架（v1.0 已审核通过）

> **状态：已通过审核（2026-08-30），执行中。**
> 用户拍板：八层分类/来源策略/导入机制全部认可，按框架建设内容。
> 实施记录见本文档末尾「建设执行记录」。

## 一、定位与边界

| 维度 | 知识库 | Skill（技能包）——**不在知识库范围** |
|------|--------|-------------------------------------|
| 回答的问题 | **"是什么 / 为什么"**——概念、参数、配置语法、原理 | **"怎么做"**——分步操作流程、排查路径、何时触发 |
| 消费方式 | Agent **检索引用**（RAG 双路混合检索） | Agent **主动调用执行**（skill_invoke） |
| 类比 | 图书馆/百科全书 | 员工的 SOP 操作手册 |
| 内容形态 | 参考资料类 md | 带触发条件、步骤、验证的操作模板 |
| 更新频率 | 低（文档性质，随官方版本演进） | 中（随运维实践与教学反馈迭代） |

一句话：**知识库负责"懂"，Skill 负责"会"**。Agent 排障时先用 Skill 找到操作路径，过程中查知识库拿具体参数与原理佐证。

## 二、内容分类框架（八层）

| # | 分类 | 覆盖内容 | 来源策略 | 优先级 |
|---|------|---------|---------|--------|
| 1 | **基础概念** | Linux 哲学、FHS 目录标准、文件/权限/进程模型、shell 与终端基础 | 官方文档（man/FHS 标准）+ 审核后导入 | P0 |
| 2 | **命令与工具** | 文件操作、文本三剑客（grep/sed/awk）、压缩归档、磁盘与进程工具 | 官方 man 手册（debian/arch manpages） | P0 |
| 3 | **系统管理** | systemd 单元/日志/开机自启、用户与组、定时任务、软件包管理（apt/dnf） | systemd man（Arch 托管）+ 官方 wiki | P0 |
| 4 | **网络与远程** | IP/路由/DNS 配置、端口诊断、SSH 服务与密钥、scp/rsync | OpenSSH 官方手册（man.openbsd.org） | P0 |
| 5 | **安全加固** | SELinux 概念与排障、iptables/nftables 防火墙、安全基线、审计 | Gentoo Wiki + netfilter 官方文档 | P1 |
| 6 | **服务部署** | nginx/apache、MySQL/Redis、Docker、Samba 文件共享 | 各项目官方文档站（已爬 10 源） | P1 |
| 7 | **故障排查** | 分层排查方法论、典型故障模式（502/磁盘满/权限拒绝/服务启动失败/网络不通） | 会话沉淀（case-*，自动积累）+ 案例文档 | P1 |
| 8 | **教学课程** | 课程对照、练习与考点（**个人内容，只走导入，永不随源码分发**） | 用户手动导入 md | 按需 |

## 三、来源与分发策略（开源合规）

| 来源 | source 标识 | 随源码分发？ | 说明 |
|------|------------|-------------|------|
| 官方文档爬取 | `<名称>-docs`（nginx-docs 等 14 源） | ✅ 可以（官方文档允许引用，标注出处 URL） | 知识库**主体**，爬虫脚本可复现 |
| 会话沉淀 | `case-*` | ❌ 不分发（本地数据目录） | 使用中自动积累的排障案例 |
| **用户导入** | `imported-docs` | ❌ 不分发（gitignore，仅本地） | 只接受 .md 文件，面板「导入 md」按钮 |
| ~~内置教学文档~~ | ~~builtin-docs~~ | 已剔除（个人语料移至 corpus_personal/，gitignore） | 需要时手动导入 |
| ~~SKILL 索引~~ | ~~builtin-skills~~ | 已剔除 | Skill 与知识库定位不同，走 skill_invoke 通道 |

## 四、组织与检索规范

- **分块**：按标题边界（`^#{1,3}`）切章节段，章内聚合；块 title=`文件名 · 章节标题`
- **检索**：FTS5 关键词 + BGE 语义向量双路 → RRF 融合 → 余弦相似度精排（top 8）
- **标签规范**：每条目 tags = `[主题域, 主题词]`（如 `["网络", "ssh"]`）；文件级 tag `file:<文件名>`
- **来源透明**：前端分组即来源（`nginx 官方文档` / `导入文档` / `会话沉淀`），条目可见出处 URL

## 五、当前知识库现状（重构后基线）

| 来源 | 文件数 | 说明 |
|------|--------|------|
| 官方文档（python/nginx/kubernetes/git/apache/rust/redis/iptables/docker 等） | ~264 页 | 已入库 |
| systemd（Arch man）/ ssh（OpenBSD man）/ selinux（Gentoo Wiki）/ bash（Debian manpages） | 补抓中 | 官方源 URL 已修复（原配置 404/反爬） |
| 导入文档 / 会话沉淀 | 0 | 等待使用与导入 |

## 六、审核清单（请逐项拍板）

1. **八层分类**是否认可？要增删哪些分类？
2. **优先级**（P0 先行）是否符合教学节奏？
3. 14 个官方爬取源是否要增删？（当前：nginx/apache/mysql/redis/docker/kubernetes/systemd/selinux/iptables/ssh/bash/python/rust/git）
4. 会话沉淀（case-*）是否保留自动入库？
5. 个人教学文档：确认**手动导入**方式（「导入 md」按钮），不随开源分发？
6. 每类内容的目标体量（当前每源 30 页上限，是否加深到 100 页/源）？

> 审核意见直接批注本文档或对话告知；通过后按框架执行内容建设。

## 七、建设执行记录

**2026-08-30（审核通过，执行轮 1）：**

| 动作 | 明细 |
|------|------|
| 源修复 | systemd→man.archlinux.org / ssh→man.openbsd.org/ssh / selinux→wiki.gentoo.org/SELinux / bash→manpages.debian.org（每源 probe 实测 200 才配置） |
| mysql 换源 | dev.mysql.com 全站 403 反爬 → **MariaDB KB**（mariadb-docs，同族数据库官方知识库） |
| 新增源 | **archwiki**（Arch Wiki，系统管理教学金矿，100 页）/ **dnf-docs**（软件包管理 P0）/ **firewalld-docs**（防火墙 P1） |
| 加深 | 各源 max_pages 30→50（Arch Wiki 100） |
| 爬取 | 17 源全量后台执行，统计见下轮更新 |

**内容 → 八层分类映射（爬取源自动覆盖）**：

- 基础概念/命令工具 ← man-pages 系列（systemd-docs/bash-docs 的 man 页）
- 系统管理 ← archwiki + systemd-docs
- 网络与远程 ← ssh-docs
- 安全加固 ← selinux-docs + iptables-docs + firewalld-docs
- 服务部署 ← nginx/apache/mariadb/redis/docker/kubernetes 各 docs
- 软件包管理 ← dnf-docs
- 故障排查 ← 会话沉淀（case-*，使用中积累）
- 教学课程 ← 用户手动导入（「导入 md」按钮）
