---
source: redis-docs
category: services
url: consolidated/services/数据库（MariaDB 与 Redis）.md
title: 数据库（MariaDB 与 Redis）
---

- **MariaDB**：安装 `apt install mariadb-server`；连接 `mysql -u root -p`。集群：Galera（同步多主复制）、MaxScale（代理/读写分离）。能力：JSON、Analytics、AI RAG。易错：root 默认 unix_socket 认证，远程连接需调整。

- **Redis**：安装 `apt install redis-server`；连接 `redis-cli`。部署：开源、Cloud、Enterprise/K8s。数据模型：String、Hash、List、Set、ZSet、Streams。客户端：多语言（go-redis、Jedis、redis-py 等）。AI/搜索：向量/混合搜索、RedisVL、LangChain、RAG。工具：Insight、VS Code 插件、RIOT-X、Datadog。易错：默认仅监听 127.0.0.1，外部访问需改 `bind`。

- 完整文档索引：`https://mariadb.com/docs/llms.txt`；页面另有 Markdown 版。
- 离线 PDF：`mariadb-general-resources.pdf`（约 220 页 / 2.5 MB），为时间点快照；网站内容始终最新。
- 文档特性：标准美式英语、Markdown 格式、存储于 Git。
- 维护团队：MariaDB plc 与 MariaDB Foundation 的技术写作人员。
- 历史：2025 年 6 月前位于 KnowledgeBase，之后迁移至 GitBook 平台。
- 许可协议：CC BY-SA / Gnu FDL。

```text
索引: https://mariadb.com/docs/llms.txt
PDF: mariadb-general-resources.pdf (~220页/2.5MB)
许可: CC BY-SA / Gnu FDL
```

## AI Agent 构建器

Redis 官方的交互式代码生成器，用于构建由 Redis 驱动的自定义 AI Agent。

### 核心机制

- 依赖 Redis 提供：数据存储、向量搜索、对话记忆
- 支持 Python/Node.js；模型支持 OpenAI、Claude、Llama 2

### 可构建 Agent

- 推荐引擎：个性化推荐
- 对话助手：带记忆的聊天机器人
- 知识助手：RAG 架构（文档摄取、带引用问答、语义缓存）
- Redis Iris 对话助手：基于托管 Iris Agent Memory，无需构建向量索引

### 使用流程

1. 安装 Redis 及依赖
2. 配置 LLM API 密钥到环境变量
3. 本地测试
4. 部署到 Redis Cloud

### 命令/配置

```bash
export OPENAI_API_KEY="your-key"
export ANTHROPIC_API_KEY="your-key"
```

- 生成代码通过 Copy/Download 保存；重新生成点 Start again

### 易错点

- 向量搜索与语义缓存依赖 Redis 版本支持
- Iris 托管记忆与自建向量索引的 RAG 不可混用

### 延伸资源

- Redis Context Engine：托管记忆、语义缓存
- Redis Vector Search：语义搜索
- Redis Streams：实时数据与对话历史
- AI Notebooks / Ecosystem Integrations：教程与框架集成

- MariaDB AI RAG 发布说明版本：1.0.0、1.1.0。
- 完整文档索引：`https://mariadb.com/docs/llms.txt`
- 发布说明文档：`mariadb-ai-rag-1.0.0-release-notes`、`mariadb-ai-rag-1.1.0-release-notes`

- Amazon Bedrock：以统一 API 提供基础模型（FMs），免去复杂基础设施管理；支持构建 AI Agents 与 Knowledge Bases。
- Knowledge Bases：通过检索增强生成（RAG）将 FM 连接到私有数据源，扩展模型能力。
- 向量数据库集成：Redis Cloud 可作为 Bedrock Agent 知识库的向量数据库；集成后自动读取 Amazon S3 中的文本文档，供 LLM 检索并生成有依据的回答。
- 完整配置步骤：
  1. 创建 Redis Cloud 订阅和向量数据库（用于 Bedrock）
  2. 创建连接到该向量数据库的 Knowledge Base
  3. 创建连接到该 Knowledge Base 的 Agent
- 参考：Redis 官方博客“Amazon Bedrock integration with Redis Enterprise”；详细步骤见 GitHub：`aws-redis-bedrock-stack`。

## 分析

### MariaDB ColumnStore
- 列式存储数据库；可独立部署，亦可集成 MariaDB Enterprise Server 作为查询加速器
- 列式格式存储，支持跨服务器集群分布式部署，PB 级数据并行执行复杂查询
- 与 InnoDB 集成：近实时访问事务数据，直接在 ColumnStore 引擎上运行快速并行 OLAP 查询
- 免去独立 pipeline 或延迟批量插入，直接分析实时数据

### MariaDB Exa
- MariaDB 与 Exasol 联合方案，连接关键事务数据到高速分析引擎
- 支持本地部署或云平台（AWS、Azure）
- 基于 Exasol 大规模并行处理（MPP）+ 内存引擎
- 适用于高要求分析及 AI/ML 工作负载

> 两者均为 MariaDB Enterprise Server 独占功能。

## API 接口

Redis 提供开发与运维两类 API。

**开发者 API：**
- **客户端 API**：基于 Redis 命令集，使用官方客户端库连接执行。
- **可编程性 API**（低延迟需求时扩展服务端）：
  - **Lua 脚本**（早期版本）：客户端提供脚本并缓存于服务端，风险是不同客户端可能使用不同脚本版本。
  - **Redis Functions**（Redis 7+）：取代 Lua，客户端触发执行，但函数**可复制、可持久化**。
  - **Modules API**：通过新命令扩展 Redis，适用于以上方式不满足的场景。

**运维 API：**
- **Redis Cloud REST API**：管理托管数据库、账户、访问权限和凭据。
- **Redis Software REST API**：自动化运维自建 Redis Software。
- **Redis Enterprise for Kubernetes**：通过 Operator 管理，关键资源定义：
  - Redis Enterprise Cluster API
  - Redis Enterprise Database API

## 7. 基础指南

连接：`mariadb -u root -p -h localhost`
- `-u` 数据库用户名（非 OS）、`-p` 密码提示、`-h` 地址（本地可略）。退出 `quit`/`exit`。

建库建表：
- `CREATE DATABASE` 建库；`CREATE TABLE` 建表，主键 `PRIMARY KEY`，自增 `AUTO_INCREMENT`。
- 改表 `ALTER TABLE`；删表 `DROP TABLE`（不可逆）。

SQL 语法：
- `;` 或 `\G` 结尾，可跨行；`\c` 取消。
- 关键字大小写不敏感；Linux 下表/库名区分大小写，列名不敏感。

数据操作：
```sql
INSERT INTO authors (first_name, last_name) VALUES ('Franz', 'Kafka');
SELECT ... LIMIT 5;
UPDATE books SET title = '新标题' WHERE isbn = '...';
DELETE FROM books WHERE author_id = 2034;
```
- 自增列可省略，多行插入逗号分隔；`AS` 别名，`JOIN` 关联，`WHERE` 过滤。
- 修改/删除务必带 `WHERE`。

# Redis 客户端工具

- **redis-cli**：终端程序，两种模式：
  1. 交互式 REPL 模式
  2. 命令模式：`redis-cli` 带参数执行，回复输出到标准输出
- **Redis Insight**：GUI + CLI，可视化浏览/操作数据，含诊断工具，免费
- **Redis VSCode 扩展**：VS Code 内连接 Redis，可查看/增删改键，提供类 Insight UI 和内置 CLI
- **redisctl**：统一管理 Redis Cloud/Software 的命令行工具，覆盖订阅、数据库、VPC peering、ACL、集群、用户；含 MCP server 组件，可供 AI 助手调用管理操作。安装：Homebrew、Cargo 或二进制发布

## 第三方工具：LibreDB Studio

- MIT 许可，自托管，浏览器内 GUI，以容器、Helm chart 或 npm 包方式部署
- 基于 `ioredis`，可在同一界面管理 Redis 与其他数据库引擎
- 核心功能：
  - 命令控制台：支持任意命令，包括模块命令（如 `JSON.GET`）
  - 键浏览器：用 `SCAN` 按前缀分组，基于有限键空间采样（不使用 `KEYS`）
  - 服务器/客户端/慢命令视图：基于 `INFO`、`CLIENT LIST`、`SLOWLOG GET`
- **易错点/限制**：
  - 仅支持单 standalone 节点，**不支持 Cluster、Sentinel、TLS**
  - 连接未加密
  - 命令权限取决于连接用户的 Redis ACL，只读访问须通过 Redis ACL 配置，而非工具本身提供

ColumnStore发布说明：索引页，链接各版本更新日志，提供Markdown及llms.txt格式；导航含上一版(MaxScale 2.4.0)与全部版本。无核心命令/参数。

## MariaDB 社区服务器发布说明

- 发布说明按主要版本系列（Series）组织，区分当前版与旧版。
- 当前版本分类：
  - **长期稳定版（LTS）**：`MariaDB 12.3`（维护 3 年）
  - **滚动发布版**：`MariaDB 13.0`
  - **开发版**：`MariaDB 13.1`
- 现行系列：`13.1`、`13.0`、`12.3`、`11.8`、`11.4`、`10.11`、`10.6`
- 旧系列统一归档至 Old Releases，不再单独列出。
- 各系列发布说明 URL 模式：
  `/docs/release-notes/community-server/<系列>/mariadb-<版本>-changes-and-improvements`
- 页面许可：CC BY-SA / Gnu FDL。

## 连接 MariaDB

### 默认连接
```bash
mariadb
```
- 主机 `localhost`；用户为 Unix 登录名（Windows 为 `ODBC`）；无密码；不选库；默认 socket。

### 覆盖默认值
```bash
mariadb -h 166.78.144.191 -u username -ppassword database_name
```
- `-p` 与密码间**不能有空格**；库名作为首个参数；命令行写密码不安全，用 `-p` 不带值可提示输入；默认 TCP 端口 3306。

### 常用参数
- `-h name`：主机，默认 localhost；MariaDB 默认不允许远程登录。
- `-u name`：用户名，默认 Unix 登录名 / Windows `ODBC`。
- `-p[passwd]`：密码；安全做法是不带值。
- `-P num`：端口，默认 3306。
- `-S name`：Unix socket 文件（默认 `/tmp/mysql.sock`）或 Windows 命名管道（默认 `MARIADB`）。
- `--protocol=name`：`TCP` 全平台，`SOCKET` 仅 Unix，`PIPE`/`MEMORY` 仅 Windows。

### TLS 选项
- `--ssl` 启用 TLS；`--skip-ssl` 禁用；任一 `--ssl-*` 自动启用。
- `--ssl-ca`、`--ssl-capath`、`--ssl-cert`、`--ssl-cipher`、`--ssl-key`、`--ssl-crl`、`--ssl-crlpath` 均隐含 `--ssl`。
- `--ssl-verify-server-cert`：验证服务器证书 CN 与连接主机名一致，默认关闭。

### 其他
- 参数可写入选项文件；`--help` 查看客户端读取的选项文件。
- 丢失 root 密码：以 `--skip-grant-tables` 启动可免认证。

- 页面仅为连接器发布说明索引，无具体版本内容。
- 完整索引：[llms.txt](https://mariadb.com/docs/llms.txt)
- Markdown 版：[connectors.md](https://mariadb.com/docs/release-notes/connectors.md)

## Flex 数据库核心知识点

- **架构**：RAM+Flash 自动分层，热数据亚毫秒延迟，温数据优化容量/成本。
- **兼容性**：兼容大多数 Redis 应用；**不支持 Search/Query 和 Time Series**。
- **可用版本**：Redis Cloud Essentials 与 Pro。

### 适用场景
- TB 级规模、高吞吐、亚 10ms 延迟。
- 实时特征存储（风控、推荐、个性化）。
- 大型分布式缓存，需弹性扩展。
- 成本优化：自动分层 RAM+Flash。

### 重要限制
- **非持久化存储**：不保证数据长期持久性，不可作为持久层。
- 需持久化时启用 Data persistence（AOF 或 Snapshot）。

### 创建要点（Essentials）
- New database → 选择 **Essentials** → 选择 **Flex (RAM + SSD)**。
- 设置名称、Region（AWS）、版本、内存限制。
- **RAM 默认占比 10%**。
- 高可用：
  - **None**：无复制，单副本。
  - **Single-Zone**：主从同可用区，主故障时副本接管。
- 持久化：
  - **Append-Only File**：写操作日志，每秒更新一次。
  - **Snapshot**：周期性内存快照（1/6/12 小时）。
- 支付后创建。

### 创建要点（Pro）
- 新建 Pro 数据库 → Advanced options → 选择 **Redis Flex**。
- Sizing 中设置 RAM 百分比：**默认 20%，范围 10%-50%**。
  - 低 RAM：降成本，可能增加延迟。
  - 高 RAM：提升吞吐/延迟，成本更高。

### 易错点
- 误将 Flex 用作持久化数据库。
- 使用不兼容功能（Search/Time Series）导致异常。
- RAM 比例与性能需求不匹配，参考官方“Choosing the right RAM ratio”指南。

### Datadog 集成 Redis Cloud

- 基于 Datadog OpenMetrics 集成，将 Redis Cloud 指标导出到 Datadog，提供预置仪表盘（Overview/Database/Network）。
- 可收集 admin console 之外的指标、配置自动告警、与其他系统指标并排展示。

#### 安装步骤
1. Datadog 门户：`Integrations` → 搜索 `Redis` → 选择 `Redis Cloud by Redis, Inc.` → 点击 `Install Integration`。
2. 确保 Redis Cloud 集群与 Datadog Agent 所在网络已建立 VPC Peering（参考官方 VPC Peering 文档）。
3. 编辑 Agent 配置：`/etc/datadog-agent/conf.d/redis_cloud.d/conf.yaml`，添加实例。

#### 重启与验证
```bash
sudo service datadog-agent restart
sudo service datadog-agent status
tail -f /var/log/datadog/agent.log
```
- 数据到达 Datadog 需等待数分钟。
- 验证方式：
  - `Infrastructure → Host Map` 找到对应主机，组件中出现 `rdsc` 命名空间（可能延迟）。
  - `Metrics → Explorer` 查询 `rdsc.bdb_up`。

#### 预置仪表盘
- `Overview`
- `Database`
- `Network`

更多仪表盘将在 v1.1.0 发布。

> 注意：集成的命名空间为 `rdsc`；监控细节参考官方 Observability 指南。

- **快速体验 Redis**：可用 `redis-cli` 直接执行命令。
- **核心命令示例**：
  ```bash
  PING                          # 测试连接
  HSET user:1 name antirez vocation artist   # 写 Hash
  HGETALL user:1                # 读全部 Hash 字段
  SET e 2.71                    # 写字符串
  INCRBYFLOAT e 0.43            # 浮点自增
  RENAME e pi                   # 重命名键
  GET pi                        # 读字符串
  ```
- **获取 Redis**：Redis Cloud 免费试用 / 本地安装开源版 / Docker Hub 最新镜像。
- **官方客户端**：Python（redis-py）、C#/.NET、Node.js、Java（Jedis、Lettuce）、Go、PHP、ioredis、Rust（hiredis-rs）、C（hiredis）、Ruby。
- **UI 工具**：Redis Insight（可视化客户端）、Redis for VS Code（VS Code 扩展）。
- **核心数据类型**：`String`、`JSON`、`Hash`、`Vector set`、概率型（Probabilistic types）。
- **主要能力**：
  - Redis Search：索引（Indexing）、查询（Querying）、schema 字段类型（field and type options）
  - 向量数据库 / 向量检索
  - 文档存储（Document store）
  - 数据结构存储（Data structure store）
  - RAG 与 GenAI 支持
- **易错点**：键命名建议用 `对象类型:id` 形式（如 `user:1`）；`INCRBYFLOAT` 会改变字符串值类型为浮点。

## MariaDB 下载

### Community Server（免费，100% 开源）

核心特性：兼容 Oracle（sequences、PL/SQL）、时态表、透明分片、即时 schema 变更、时间点回滚、现代 SQL（CTE、窗口函数、JSON 函数）；内置 ColumnStore 支持实时分析。

可用版本：`12.3.3-GA` / `11.8.9-GA` / `11.4.13-GA` / `10.11.19-GA` / `10.6.28-GA`

支持平台：Debian 11/12/13、Ubuntu 22.04/24.04/26.04、RHEL 8/9/10（含 Alma/Rocky）、SLES 15sp7/16sp0、Windows（均提供 64 位 x86 与 ARM 版本）。

安装方式：

```bash
# Docker 安装
docker pull mariadb
```

### MaxScale（30 天试用）

应用与数据库之间的智能代理层：负载均衡、故障转移、安全增强，无需修改应用代码。

### ColumnStore

分布式列式存储，大规模并行处理（MPP）：可搭配 InnoDB 加速分析查询；支持 HTAP（混合事务/分析处理）；亦可独立作为列式分析数据库。支持对接公有/私有云对象存储，降本且无限扩展。

```bash
# Docker 安装
docker pull mariadb/columnstore
```

### Kubernetes Operator

使用声明式配置自动化管理 MariaDB Server 与 MaxScale 部署，内置高可用与容灾（HA/DR）方案，免手动脚本。

### 迁移工具

**MariaDB Migrator**：MySQL → MariaDB 无缝迁移。特性：自动风险评估、可脚本化 YAML 工作流、四种迁移路径（含近零停机复制）。提供 Shell Script（tar.gz/zip）两种格式。

- **MariaDB Migrator 1.3.1 (beta)**：迁移工具，用于从 MySQL 迁移至 MariaDB。下载：`mariadb-migrator-1.3.1-beta.tar.gz`（237.94 KB）。
- **MCP Server**：社区支持的 Model Context Protocol 集成，连接 MariaDB 与 AI 应用/大模型。
  - 支持传统 SQL 与基于向量的语义搜索（embeddings：OpenAI、HuggingFace）。
  - 适用：RAG、语义搜索、推荐引擎、AI 应用测试。
- **MariaDB Enterprise Server**：社区版的加固生产版。
  - 默认生产配置，经过扩展 QA；支持大规模运维效率与高安全环境。
- **MariaDB MaxScale**：数据库代理与查询路由器。
  - 核心功能：自动故障转移、基于工作负载的查询路由（HTAP）。
- **MariaDB ColumnStore**：分布式列式存储与并行处理，用于可扩展分析。
  - 可叠加 InnoDB 加速分析查询，或独立作列式数据库；支持 HTAP。
  - 可选用对象存储（公有/私有云）降低成本、无限扩容。
- **ColumnStore Cluster Manager (CMAPI)**：RESTful API，用于多节点 ColumnStore 集群管理。
- **MariaDB Advanced Cluster (Tech Preview)**：基于 RAFT 算法的高可用方案，自动 leader 选举与 quorum 写入。

- **MariaDB Cloud 三档**：Foundation（免费）、Power（$0.16/h）、PowerPlus（$0.21/h）
- **版本**：Foundation=Community Server；Power/PowerPlus=Enterprise
- **SLA**：多节点 99.95%/99.995%，单节点均 99.9%
- **资源上限**：
  - 计算：Foundation ≤16 vCPU/128GB；Power/PowerPlus ≤128 vCPU/1024GB
  - 存储：1000GB vs 9000GB；只读副本 1 vs 4
- **备份**：均含 Nightly+自助备份；快照保留 7–15/7–30/7–45 天；Power/PowerPlus 支持 PITR
- **安全**：均支持加密、RBAC、IP 白名单；Power/PowerPlus 支持 PrivateLink/Private Service Connect
- **计算示例**（/h）：Sky-2×4 $0.13182；Sky-2×8 $0.1702；Sky-4×16 $0.3405；Sky-16×128 $1.9766
- **存储**（GB/h）：AWS gp3 $0.10、io1 $0.1563；GCP SSD $0.20；Azure StandardSSD $0.10、PremiumSSD $0.1875
- **Enterprise Platform**：
  - Platform：多负载、复制、自动故障转移、MaxScale、原生向量搜索
  - Plus：+Galera、RAFT、Kubernetes Operator
  - Ultimate：+MCP Server、RAG、数据中心复制、分布式快照
- **附加**：MariaDB Exa、Remote DBA

```markdown
## MariaDB Enterprise 核心知识点

- **部署架构**：Galera 多主复制（Enterprise Cluster）；RAFT 共识集群（Advanced Cluster）
- **AI**：原生向量搜索、AI RAG、MCP Server
- **GridGain**：内存缓存、分布式计算、Control Center / K8s Operator、数据中心复制、机架感知、分布式快照
- **企业工具**：Enterprise Audit、Enterprise Manager、K8s Operator
- **稳定性**：LTS 版本；支持期 = 标准 5 年 + 延长 3 年
- **支持选项**：

| 项目 | Standard | Premium |
|---|---|---|
| 工单/联系人 | 无限 | 无限 |
| 电话/实时聊天 | — | ✓ |
| 紧急工单首响应 | 30 分钟 | 15 分钟 |
| 高优先级首响应 | 2 小时 | 1 小时 |
| 标准/低优先级 | 4/8 小时 | 4/8 小时 |
| 终止支持后扩展 | — | 可申请 |
| 热修复 | — | ✓ |

- **Premium 额外**：高级支持工程师、技术客户经理（TAM）、Remote DBA
- **账户管理**：问题周报自动汇总、季度执行审查
- **咨询**：架构/安全/性能咨询；数据库迁移评估与执行；TAM（长期数据战略）；Remote DBA（7×24 主动监控）；培训（learn.mariadb.com）
```

## MariaDB 支持与服务

服务模式：一次性定制套餐 → 长期战略合作，覆盖开发到部署全周期。

- **技术支持**：故障排查、Bug 修复、性能优化、优先支持；保障数据库稳定性、安全性与高可用
- **远程 DBA**：24/7 监控、性能调优、备份管理、安全审计、容量规划
- **咨询服务**：按业务需求提供优化、排障、运维增强的专家指导
- **数据库迁移**：完整迁移执行，含 schema 转换、数据传输与验证
- **技术客户经理**：专属顾问，提供战略指导、主动问题预防、优先支持、架构优化、定期业务复盘
- **培训**：面向开发者/DBA/IT 团队，涵盖最佳实践、性能调优、数据库管理

```
服务入口:  https://mariadb.com/services/
技术支援:  https://mariadb.com/services/technical-support-services/
远程DBA:   https://mariadb.com/services/remote-dba/
咨询:      https://mariadb.com/services/consulting/
迁移:      https://mariadb.com/services/migration-practice/
客户经理:  https://mariadb.com/services/technical-account-manager/
培训:      https://mariadb.com/services/training/
下载:      https://mariadb.com/downloads/
```

### MariaDB 企业技术支持核心知识点

- 支持团队自 2003 年起处理数据库问题，具备 DBA 与开发者双重经验。
- 支持工程师与 MariaDB 工程团队深度集成，可快速调用内部资源，提供性能调优、高可用、安全审计、代码审查等主动咨询。
- Remote DBA 团队与 Support 协同，覆盖开发、部署、运维全生命周期。
- 服务通过 **MariaDB Subscription** 提供，可选档位从开发者支持到 24x7x365 无限次支持。

#### 支持层级对比

| 能力 | Standard | Premium |
|---|---|---|
| 工单/注册联系人 | 无限 | 无限 |
| 电话支持 | — | ✓ |
| 实时聊天 | — | ✓ |
| 紧急 SLA 首次响应 | 30 分钟 | 15 分钟 |
| 高优先级首次响应 | 2 小时 | 1 小时 |
| 标准/低优先级首次响应 | 4 / 8 小时 | 4 / 8 小时 |
| 长期支持（超过 EOS） | 可申请 | 可申请 |
| 热修复构建 | ✓ | ✓ |
| 业务关键优先级 | — | ✓ |
| 每周自动问题摘要 | — | ✓ |
| 季度高管审查 | — | ✓ |
| 专属高级支持工程师 | — | ✓ |
| TAM / Remote DBA | 可申请 | 可申请 |

#### 订阅等级要点

- **Standard**：面向生产环境，提供 24×7 技术支持、长期版本及扩展支持。
- **Premium**：面向最关键应用，包含 Standard 全部内容，另加更激进 SLA、电话/实时聊天支持、专属支持工程师。

此页仅为发布说明索引页，无实质技术内容。含完整文档索引 `llms.txt` 及 Markdown 版链接；上一版：Connector/R2DBC 1.2.3 Changelog；下一版：MariaDB Enterprise Kubernetes Operator 1.0.0。

## MariaDB Enterprise Server 发布说明

- 最新长期稳定版系列：**MariaDB Enterprise Server 11.8**
- 11.8 最新发布版本：**11.8.8-5**
- 下载：[Enterprise Server 11.8.8-5](https://mariadb.com/downloads/enterprise/enterprise-server/)

**当前支持版本：**
- MariaDB Enterprise Server 11.8
- MariaDB Enterprise Server 11.4
- MariaDB Enterprise Server 10.6

**历史版本：** 见 Old Releases 页面。

> 易错点：仅 11.8 为长期稳定版（LTS）；10.6/11.4 仍在维护，旧版本移至 Old Releases。

## 关键查询指南

- **建表**：`CREATE TABLE student_tests (name CHAR(10), test CHAR(10), score TINYINT, test_date DATE);`
- **插入**：`INSERT INTO t1 VALUES (1), (2), (3);`
- **AUTO_INCREMENT**：自增唯一标识，插入时省略该列即自动生成。
- **JOIN**：`SELECT * FROM t1 JOIN t2 ON t1.a = t2.b;`
- **聚合/分组**：`SELECT MAX(score), MIN(score), AVG(score) FROM student_tests; SELECT name, MAX(score) FROM student_tests GROUP BY name;`
- **排序**：`SELECT * FROM student_tests ORDER BY score DESC;`
- **去重**：`DELETE t_del FROM t_del JOIN (SELECT f1, MAX(id) mid FROM t_del GROUP BY f1) k ON t_del.f1 = k.f1 AND t_del.id < k.mid;`

- 该页为 Galera Cluster 发布说明索引，无具体技术内容。
- 导航：前置文档 `MariaDB ColumnStore 1.0.1 Alpha Release Notes`；后置文档 `Galera Cluster 26.4 Release Notes`。
- 用途：跳转至对应版本发布说明。

- 环境：需运行 Redis；go-redis 仅支持最近两个 Go 版本；须在 Go module 中使用。
- 安装：
```bash
go mod init github.com/my/repo
go get github.com/redis/go-redis/v9
```
- 连接（默认本地）：
```go
rdb := redis.NewClient(&redis.Options{Addr: "localhost:6379"})
ctx := context.Background()
defer rdb.Close()
```
- String：
```go
rdb.Set(ctx, "foo", "bar", 0)
val, _ := rdb.Get(ctx, "foo").Result()
```
- Hash：
```go
rdb.HSet(ctx, "bike:1", "model", "Deimos", "price", 4972)
model, _ := rdb.HGet(ctx, "bike:1", "model").Result()
all, _ := rdb.HGetAll(ctx, "bike:1").Result()
```
- 结构体扫描（标签 `redis:"字段"`）：
```go
type Bike struct { Model string `redis:"model"`; Price int `redis:"price"` }
var b Bike
rdb.HGetAll(ctx, "bike:1").Scan(&b)
```
- 易错：勿漏错误检查；`HGetAll` 后先 `Result()` 再 `Scan()`；正确 `go get` v9；记得 `defer rdb.Close()`。

## hiredis 指南（C 语言）

hiredis 是 Redis 官方 C 语言客户端，需先安装并运行 Redis/Redis Stack 服务器。

**构建安装**
- 从 [GitHub 仓库](https://github.com/redis/hiredis) 克隆源码，进入目录执行 `make`
- Linux 生成 `libhiredis.so`，macOS 为 `libhiredis.dylib`
- `sudo make install` 安装至 `/usr/local/lib`

**基本流程**
```c
redisContext *c = redisConnect("127.0.0.1", 6379);
if (c == NULL || c->err) { /* 处理错误 */ }

redisReply *reply = redisCommand(c, "SET foo bar");
freeReplyObject(reply);

reply = redisCommand(c, "GET foo");
printf("Reply: %s\n", reply->str);
freeReplyObject(reply);

redisFree(c);
```

**核心要点**
- `redisCommand()` 返回 `redisReply*`，内存需用 `freeReplyObject()` 释放
- 字符串回复通过 `reply->str` 访问
- 连接用完必须 `redisFree(c)`，防止资源泄漏
- 必须检查 `c == NULL || c->err`：`NULL` 表示上下文分配失败，`c->err` 表示连接错误

**编译运行**
```bash
cc main.c -L/usr/local/lib -lhiredis
./a.out
# 输出：Reply: OK / Reply: bar
```

**更多信息**
- GitHub 仓库含适配器（adapter）示例，可集成各类事件处理框架
- 适合作为实现其他语言高级客户端的底层基础

#### Redis 实时上下文能力

- **Redis Iris**：AI 应用的实时上下文引擎
- **Context Retriever**：基于向量检索，从结构化/非结构化数据中即时检索最相关上下文，确保模型正确响应
- 关键数据：80% 的 AI 项目因缺乏实时上下文而停滞
- 提示词模板示例：

```
$PROMPT
How can I use Redis Context Retriever to improve the quality of my AI output?
```

#### 部署方式

- 云托管（Redis Cloud）/ 本地与混合云（Redis Software）/ 开源 Redis 8

#### 关键特性

- **FLEX**：分层 RAM+闪存，支撑 TB 级数据规模，成本降低至多 80%
- **ACTIVE-ACTIVE**：多区域复制，本地级读取速度，零停机故障转移

- **Docker 快速部署**：`docker run -d --name redis -p 6379:6379 redis`

- **Ubuntu/Debian（APT）**：
  ```bash
  sudo apt-get install lsb-release curl gpg
  curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
  sudo chmod 644 /usr/share/keyrings/redis-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/redis.list
  sudo apt-get update && sudo apt-get install redis
  ```

- **Rocky/Alma（RPM）**：官方仓库安装；`baseurl` 须按系统选 `rockylinux8`/`rockylinux9`，导入 GPG 后 `yum install redis`。

- **macOS**：`brew install redis && brew services start redis`

- **Windows**：仅 Docker（需 Linux 容器）。

- **仅连远程**：可单独安装 `redis-cli`，无需完整发行版。

## MariaDB 服务器安装要点

### Linux 安装（包管理器）

**1. 更新包索引**
```bash
# Debian/Ubuntu
sudo apt update
# Red Hat/CentOS/Fedora
sudo yum update   # 旧系统
sudo dnf update   # 新系统
```

**2. 安装服务端与客户端**
```bash
# Debian/Ubuntu
sudo apt install mariadb-server mariadb-client galera-4
# Red Hat/CentOS/Fedora
sudo dnf install mariadb mariadb-server
```

**3. 安全配置**
```bash
sudo mariadb-secure-installation
```
按提示设置 root 密码、删除匿名用户、禁用远程 root 登录。

**4. 启动与验证**
```bash
sudo systemctl status mariadb    # 查看状态
sudo systemctl start mariadb     # 未运行则启动
mariadb -u root -p               # 验证连接，输入刚设置的密码
```

### Windows 安装

- 下载 `.msi` 安装包，双击运行向导；
- 按向导完成：接受协议 → 选择功能与安装目录 → 设置 `root` 密码 → 配置为服务并设置端口（默认 **3306**）→ 可选默认字符集 **UTF8**。

### 关键注意事项

- **防火墙**：远程访问需放行默认端口 3306；
- **root 密码**：安全配置步骤中务必设置强密码；
- **生产环境**：需进一步调整配置文件 `my.cnf`（Linux）。

- Jedis 为 Redis 同步 Java 客户端；需异步/响应式改用 Lettuce。
- 需先启动 Redis 服务器。
- 7.2.0 起新连接 API：`RedisClient`（替代 `UnifiedJedis`/`JedisPool`/`JedisPooled`）、`RedisClusterClient`（替代 `JedisCluster`）、`RedisSentinelClient`（替代 `JedisSentinelPool`）；旧类已弃用。
- 安装：Maven/Gradle 引入 `redis.clients:jedis:7.2.0`。
- 用法：
```java
RedisClient jedis = new RedisClient("redis://localhost:6379");
jedis.set("bike:1", "Deimos");
jedis.get("bike:1"); // Deimos
jedis.close();
```
- 参考：javadoc.io；GitHub redis/jedis（含 failover 文档）。

## Redis JSON 支持

RedisJSON 模块为 Redis 提供 JSON 类型。

**读写**
- `JSON.SET key path value` — 设置/更新值
- `JSON.GET key [path...]` — 返回 JSON

**删除**
- `JSON.DEL` — 删除值
- `JSON.CLEAR` — 清空数组/对象，数值置 0

**数组**
- `JSON.ARRAPPEND key path val...` — 尾部追加
- `JSON.ARRLEN` / `JSON.ARRPOP` — 长度/弹出

**对象**
- `JSON.OBJKEYS` / `JSON.OBJLEN` — 键列表/键数

**数值与字符串**
- `JSON.NUMINCRBY key path n` — 自增
- `JSON.NUMMULTBY key path n` — 乘
- `JSON.STRAPPEND` / `JSON.STRLEN` — 追加/长度

**合并**
- `JSON.MERGE` — 递归合并

**易错点**
- 路径使用 JSONPath，默认 `$`（根）
- 单路径常为 O(1)，多路径为 O(N)（N 为 key 大小）
- 类型不匹配（如对对象用数组命令）报错

Redis JSON 模块为 Redis 提供 JSON 值存储、更新与检索能力，支持 JSONPath 语法选取文档子元素，文档以二进制树结构存储，支持所有 JSON 值类型的类型化原子操作。

### 核心命令

- `JSON.SET key path json`（@write @json）— 在指定 path 设置 JSON 值，接受所有 JSON 类型。
- `JSON.GET key path`（@read @json）— 获取指定 path 的 JSON 值。
- `JSON.TYPE key path`（@read @json）— 返回指定 path 的 JSON 值类型。

`JSON.SET` 常用参数：
- `NX`：仅在 key 不存在时设置
- `XX`：仅在 key 已存在时设置

### 示例

```python
r.json().set("bike", "$", '"Hyperion"')  # True
r.json().get("bike", "$")                # ['"Hyperion"']
r.json().type("bike", "$")               # ['string']
```

### 复杂度

- 路径解析为单个值时：O(1)
- 路径解析为多个值时：O(N)，N 为 key 大小

### 易错点

- 路径必须使用 JSONPath 语法（如 `$` 表示根）；默认路径为 `$`，但部分命令要求显式指定。
- `JSON.SET` 的 `NX`/`XX` 与 `SET` 命令语义一致，注意区分。
- 返回值为数组形式（如 `['string']`），需按数组解析。

- **Lettuce**：Java 高级 Redis 客户端，支持同步/异步/响应式；需先运行 Redis。
- 同步核心：`RedisClient` → `StatefulRedisConnection` → `RedisCommands`。

## 安装依赖（Maven）
```xml
<dependency>
    <groupId>io.lettuce</groupId>
    <artifactId>lettuce-core</artifactId>
    <version>6.7.1.RELEASE</version>
</dependency>
```

## 连接与测试
```java
import io.lettuce.core.*;
import io.lettuce.core.api.StatefulRedisConnection;
import io.lettuce.core.api.sync.RedisCommands;
```
```java
RedisURI uri = RedisURI.Builder.redis("localhost", 6379).build();
RedisClient client = RedisClient.create(uri);
StatefulRedisConnection<String, String> connection = client.connect();
RedisCommands<String, String> commands = connection.sync();
```
```java
commands.set("foo", "bar");
String result = commands.get("foo"); // >>> bar
```

## 易错点
- 释放资源：`connection.close(); client.shutdown();`
- 版本以 Maven Central 最新版为准。

## Redis 库与工具

**数据集成**
- RDI：近实时同步主数据库
- Confluent Sink Connector：Confluent Cloud → Redis Cloud

**客户端库**
- Python：`redis-py`
- Java：`Jedis`、`Lettuce`
- Node.js：`node-redis`
- Go：`go-redis`
- C#/.NET：`StackExchange.Redis`
- PHP：`Predis`
- Ruby：`redis-rb`
- C：`hiredis`

**AI/向量**
- Redis for AI：支持向量搜索、RAG、语义缓存
- Amazon Bedrock：多厂商 AI 模型 API

**可观测性**
- Prometheus + Grafana：Redis 指标采集可视化
- Datadog / Dynatrace / New Relic：对接 Redis Cloud/Software
- Nagios：仅 Redis Software

**资源编排**
- Terraform / Pulumi：用代码管理 Redis Cloud
- Railway：零配置托管 Redis

**框架集成**
- Spring Data Redis：Spring 缓存 + 故障转移
- fastapi-redis-sdk：连接池 + 依赖注入缓存（ETag/Cache-Control）
- n8n Redis vector store：工作流向量库

**工具**
- Redis Insight：可视化与优化
- RIOT-X：命令行数据导入/导出
- Redis MCP server：MCP 客户端访问 Redis

## Redis 集成生态

**对象映射库（RedisOM）**
- .NET / Node.js / Python：对象映射库，简化 Redis 数据操作
- Java：基于 Spring 框架，提供对象映射抽象

**客户端库**
- Rust：`redis-rs` 官方客户端

**云托管（Redis Cloud）**
- AWS：无缝集成、全局可用
- Azure：企业级安全、全球覆盖
- GCP：可扩展基础设施、AI/ML 集成

**平台部署**
- Kubernetes：通过 operator + helm charts 部署 Redis Enterprise
- Docker：部署 Redis Software，用于开发/测试环境
- Vercel：接入 Redis 提升性能与数据管理
- Heroku：快速数据存储与缓存

**AI 集成**
- Google ADK：通过 `adk-redis` 包，作为 agent 的内存/搜索/缓存层
- LangChain：作为向量数据库与 memory store

无

## MariaDB 文档核心知识点

### 产品生态
- **Platform 组件**：Enterprise Server、Enterprise Cluster（Galera 高可用）、ColumnStore（分析）、MaxScale（代理/路由）、Connectors、Kubernetes Operator、Enterprise Backup
- **存储引擎**：InnoDB、Aria、MyRocks、Spider
- **插件**：Enterprise Audit（审计）、HashiCorp Vault（密钥管理）

### Server 快速入门
- **安装**：Linux 包管理器 `apt/dnf/yum`；初始化 `mariadb-secure-installation`；服务检查 `systemctl status/start`；Windows 用 `.msi`
- **连接**：命令行客户端 `mariadb -u 用户 -p -h 主机`

### 核心 SQL
```sql
CREATE DATABASE db; USE db;
CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, ...);
INSERT/SELECT/UPDATE/DELETE;
ALTER TABLE t ADD COLUMN ...;
LOAD DATA INFILE 'file' INTO TABLE t;
```

### 索引与查询优化
- 索引类型：`PRIMARY KEY`、`UNIQUE INDEX`、`INDEX`、`FULLTEXT`
- 操作：`CREATE INDEX`、`SHOW INDEX`、`EXPLAIN`
- 聚合函数：`MAX/MIN/AVG`
- 多表连接：`INNER/LEFT/RIGHT/CROSS JOIN`

### 日期与运维
- 日期类型：`DATETIME`、`TIMESTAMP`
- 远程访问：配置 `bind-address`、授权远程用户、放行防火墙
- 常见连接排错：`Can't connect to local server`、`access-denied`

- **SQL 基础**：`SELECT` 用于检索、过滤、限制、排序数据；DDL 含 `CREATE`、`DROP`，DML 含 `INSERT`、`UPDATE`、`DELETE`，TCL 含 `COMMIT`、`ROLLBACK`；遵循易读易调试的 SQL 书写约定。
- **备份与恢复**：用 `mariadb-dump` 创建逻辑备份，支持全部数据库、指定库或表；用 `mariadb` 客户端从 dump 文件恢复，可选择性恢复单表。
- **函数与变量**：内置字符串函数按功能分组；日期时间函数如 `DATE_ADD`、`DATE_SUB`；了解系统变量和状态变量的位置。
- **视图**：创建和使用视图，简化复杂查询、限制数据访问、提供特定数据视角。
- **数据库设计**：命名约定、合理数据类型、用视图抽象复杂度。
- **应用代码**：使用 ORM、存储过程，编写对 schema 变更健壮的 SQL。
- **安全变更**：通过金丝雀部署、复制、不可见列等策略安全测试 schema 和应用变更。
- **入门**：使用 `mariadb` 命令行客户端登录、创建数据库、执行基本 SQL。
- **维护**：关注应用维护、升级及关注点分离。

## MariaDB AI RAG

- 一体化企业级 RAG 管道解决方案，覆盖全流程：
  文档解析（含布局提取）→ 语义分块 → 嵌入生成 → 混合检索（向量 + 全文搜索）→ 可选重排序 → 基础模型生成回答
- 核心特性：
  - 文档摄取与处理
  - 语义分块与嵌入
  - 向量相似度搜索
  - AI 响应生成
  - 数据库集成
  - 细粒度访问控制
  - 全面 REST API

## MariaDB Cloud 核心要点

- **定位**：原名 SkySQL，AI 驱动的全托管 DBaaS，面向 MariaDB/MySQL 兼容负载。
- **部署**：支持跨多数据中心、区域、云厂商；提供传统预置（provisioned）与 serverless 两种模式，防止过度配置。
- **无代码 AI Agent**：内置生成器，可为终端用户提供自然语言数据查询接口，无需 SQL 能力。

**企业级/生产就绪特性**
- 合规与治理
- 多种附加强大能力

**关键设计原则**
- 自治、弹性、端到端安全
- 合理默认值、一致配置
- 提供 MariaDB Remote DBA（远程 DBA 服务）

**能力演进路径**
- 从小规模起步，扩展到极端读规模
- 高可用（HA）+ 负载均衡
- 安全内建（Security by Design）
- 专用监控
- 适配任意工作负载

### MariaDB 社区服务器

- MariaDB 是全球最流行的数据库服务器之一，下载量超 10 亿次，是多数 Linux 发行版中替代 MySQL 的默认数据库。
- 由 MySQL 原开发者创建，兼容 MySQL 与 Oracle，**保证永远开源**。
- 开源协议：**GNU Public License v2**；90% 以上代码由 MariaDB 自行开发，与 MariaDB Foundation 紧密合作。
- 企业级可用：可在任意环境中数分钟内启动，无需重构或重训团队，支撑 Wikipedia、WordPress 等大型应用。
- 因与 MySQL 生态共享，开发者/DBA 可无缝上手；若需节省运维时间、聚焦战略业务，可升级至 MariaDB Enterprise Platform。

MariaDB连接器文档：
- 完整索引：llms.txt
- 支持 Markdown 格式
- 离线 PDF（约660页/6MB），快照非实时

- MariaDB 支撑关键业务：智能手机数据访问、处方配药、5G、金融交易
- 主要迁移路径：
  - Oracle → MariaDB（Samsung SDS 成本减半；Pixid 去 Oracle 转混合架构）
  - Oracle RAC → MariaDB Galera Cluster（Greetz）
  - MySQL → MariaDB Enterprise Server（Esade）
- 典型部署场景：
  - DBS（星展银行）迁移至开源 MariaDB
  - Nokia 容器化部署 MariaDB
  - Virgin Media O2 用 MariaDB Cloud 服务 3000 万+ 用户
  - CCV 支付系统依赖 MariaDB 满足高可用
  - Tayana 支撑 5000 万用户电信 PCC 产品
- 核心收益：
  - 高可用：Galera Cluster 替代 Oracle RAC
  - 弹性伸缩：MariaDB Cloud（Google Cloud）自动扩缩容（FTMO）
  - 大数据：IHME 管理分析数十亿行表
  - 运维自动化：TradingScreen 用自动化减负
  - 性能与成本：Visma 响应时间提升 2 倍以上并降本

## MariaDB 文档核心知识点

### 文档入口
- 完整索引：[llms.txt](https://mariadb.com/docs/llms.txt)
- 本站为权威版本，持续更新

### 产品文档分类
- **MariaDB Server** — 核心数据库服务
- **MariaDB Enterprise Platform** — 企业级平台
- **MariaDB MaxScale** — 数据库代理/路由
- **MariaDB ColumnStore** — 分析型列式存储
- **MariaDB Galera Cluster** — 同步多主集群
- **MariaDB Connectors** — 各语言连接器
- **MariaDB Tools** — 运维工具集

### 离线文档（PDF）
每套文档集对应一个 PDF，可内部交叉引用，无需联网：

```bash
# 下载示例
https://github.com/mariadb-corporation/mariadb-docs/releases/latest/download/mariadb-server.pdf
```

主要文档集：
- `mariadb-server.pdf`（约 6,166 页）
- `mariadb-maxscale.pdf`
- `mariadb-release-notes.pdf`
- `mariadb-connectors.pdf`
- `mariadb-galera-cluster.pdf`
- `mariadb-tools.pdf`

页面数为特定快照统计，历史版本可在 GitHub Releases 中浏览下载。

### 生态
- [MariaDB Server Ecosystem Hub](/docs/mariadb-server-ecosystem-hub) — 兼容工具、服务、平台与合作伙伴索引

### 易错点
- 文档集名称与 PDF 文件名不完全一致（如 ColumnStore 对应 `mariadb-analytics.pdf`）
- 离线 PDF 链接指向 latest 快照，非实时版本；权威内容以在线站为准

**MariaDB企业K8s控制器**（MariaDB Enterprise Operator）：在 Kubernetes 上部署/管理 MariaDB。文档：`mariadb-docs/tools/mariadb-enterprise-operator`。相关：`llms.txt`、Markdown 版；前置：Troubleshooting Enterprise Manager；后续：Introduction。

## MariaDB Enterprise Manager

企业级数据库舰队可观测性与管理平台，基于轻量级 Agent + **OpenTelemetry** 标准采集深度遥测数据，覆盖独立库、复制拓扑及 MaxScale 集群。

### 核心能力

- **高级监控**：内置 **Grafana**，预置生产级仪表盘与告警规则；支持自定义仪表盘、告警规则，通知可路由至多种目标。
- **生态集成**：基于开放标准，内置 **Prometheus** 时序数据库，暴露查询 API，可无缝导出指标至既有可观测性栈。
- **集中管理**：拓扑感知的全局视图，自动发现并可视化复制与集群架构；可经 SSO 免登下钻至 **MaxScale UI**。
- **工作区（Workspace）**：面向开发与 DBA 的共享环境，含高级 **Query Editor**（SQL 运行/调试）与可视化 **ERD Designer**（跨连接模式建模与管理）。
- **企业安全**：支持 **OIDC** 企业身份提供商 SSO 认证；**RBAC** 细粒度权限控制；全量管理操作审计日志。

### 核心组件

| 组件 | 作用 |
|---|---|
| Agent | 轻量采集遥测数据 |
| Grafana | 可视化与告警 |
| Prometheus | 指标存储与查询 |
| Workspace | SQL 编辑与 ERD 建模 |
| OIDC/RBAC | 认证与授权 |

### 易错点

- 指标导出依赖 Prometheus 查询 API，需确认既有监控栈兼容 OpenTelemetry 标准。
- MaxScale UI 下钻依赖 SSO 配置，OIDC 未正确对接时无法免登跳转。
- RBAC 需按角色最小权限配置，审计日志不可关闭以满足合规要求。

- MariaDB企业MCP服务器章节：仅含文档导航链接，无技术正文。
- 完整索引见 `llms.txt`；Markdown 版同源。
- 关联页面：迁移至优雅停机主切换、概述。

## MariaDB Enterprise Platform 核心要点

**定位**：企业级生产负载数据库平台，支持私有/公有/混合/多云环境，统一承载事务、分析、混合负载；基于开源技术并强化企业级可靠性、安全与支持。

**核心组件**：
- **Enterprise Server** — 企业增强版数据库，ACID 合规，优化 OLTP
- **ColumnStore** — 分布式列式存储，MPP 并行查询，面向 OLAP/数仓
- **MaxScale** — 数据库代理：负载均衡、数据路由、高可用、安全
- **Galera Cluster** — 多主同步复制集群，读扩展+事务安全
- **Connectors** — 多语言驱动：C/C++/Java/Node.js/ODBC/Python
- **Enterprise Manager** 🆕 — 数据库舰队级可观测性与管理
- **MCP Server** 🆕 — AI 助手与 MariaDB 数据生态的安全接口
- **AI RAG** 🆕 — 企业级检索增强生成（RAG）方案
- **Exa** 🆕 — 高性能内存 MPP 分析数据库
- **Query Accelerator** 🆕 — 将 InnoDB 查询改由 ColumnStore 执行

**安全**：TDE 透明数据加密、查询阻断、结果限制、数据库防火墙、动态数据脱敏、GDPR 合规；持有 DoD STIG 认证（美国政府 IT 方案必需）。

**兼容/创新**：兼容现有 MySQL API 与命令；支持事务、分析、半结构化及 AI 向量数据。

**版本**：Platform 2025 于 2025-01 发布；Platform 2026 于 2025-10 发布，含 Enterprise Server 11.8 及新组件。

> 本文档为产品概述，无具体命令/配置参数。

## 安全与灾难恢复
- 安全特性：加密、掩码（masking）、防火墙、访问控制
- 灾难恢复：备份、**PITR**（时间点恢复）、延迟副本、故障转移策略

## 存储引擎
- **InnoDB**：默认事务引擎，ACID 合规，支持外键
- **Aria**：MyISAM 的崩溃安全替代品，用于内部临时表
- **MyISAM**：非事务引擎，支持 `FULLTEXT` 索引和空间数据类型
- **MEMORY**：数据全存 RAM，适合快速查找场景
- **Spider**：联邦数据库方案，支持分区和 XA 事务

**易错点**：MyISAM 不支持事务；MEMORY 数据重启丢失，仅适用临时/缓存场景；Aria 不等于 InnoDB，无外键支持。

- MariaDB 官方活动日历覆盖 2025–2026 年，按地域分为 **Africa / Asia Pacific / Europe / Middle East / North America / Virtual**。
- 活动类型：行业展会、技术路演、社区 MeetUp、线上培训（Webinar）。
- 重点活动：
  - **LEAP Saudi Arabia** – 2026-08-31 ~ 09-03（中东顶级科技展）
  - **Singapore FinTech Festival** – 2026-11-18 ~ 11-20（MAS 主办）
  - **KubeCon + CloudNativeCon** – 2025-11-10 ~ 11-13（Atlanta，云原生）
  - **MariaDB Tech Tour – Toronto** – 2026-06-18（加拿大数据库/基础设施创新）
  - **MariaDB Day Brussels** – 2026-02-01（社区全天活动）
  - **MariaDB ServerFest Amsterdam** – 2025-08-27（社区活动）
- 技术主题：
  - 数据库现代化（Database Modernisation）
  - 云端统一数据平台、AI Agent 驱动的企业级数据架构
  - Kubernetes 上运行 MariaDB/MySQL：注意 **operator 模式、连接池、副本管理**
  - 金融科技、政府/国防、DevOps、数字主权
- 官方培训资源（Ignite 系列，Java 开发者）：
  - Ignite Fundamentals Training
  - Ignite Essentials Training
  - Spring Boot/Spring Data 开发（90 分钟）
- 生态合作：GridGain（Apache Ignite 原创作者）、IBM Power11/LinuxONE、Nextcloud、HPE 等。

- **官方社区活动**
  - MariaDB ServerFest：阿姆斯特丹（数据库集成与迁移）、新加坡（2025-07-04）、雅加达（2025-07-07）、印度班加罗尔（2024-10-25）
  - MariaDB Meetup：都柏林、伦敦、雅加达、新加坡，主题包括数据库性能、创新与社区
  - MariaDB Hackathon（班加罗尔，2024-10-24~25）：围绕 **MariaDB Vector**，要求参赛团队将框架从 **Qdrant** 改造为兼容 MariaDB

- **合作生态与行业展会**
  - IBM：`MariaDB on IBM Power Linux`、企业级开源数据库未来、AI 与数据库驱动企业转型
  - Nutanix / Microsoft / Veeam / Coro：混合云现代应用、多云与数据库集成
  - 其他：CloudFest、Open Source India、Data Innovation Summit、Nextcloud Enterprise Day、Common Europe Congress、DoDIIS

- **核心主题**
  - 开源数据库的集成、迁移与现代化
  - 向量搜索（Vector）与 AI 场景
  - 混合云 / 多云部署
  - 数字主权与开源协作平台（Nextcloud）

- **易错点**
  - Hackathon 使用 **Qdrant** 作为起点，需迁移到 MariaDB Vector，而非直接使用原框架
  - 多个活动名称相似（ServerFest vs Meetup vs Hackathon），注意区分类型与日期

本节为 MariaDB Galera 集群文档索引页，无实质技术要点。完整索引：`https://mariadb.com/docs/llms.txt`

MariaDB MaxScale 文档：完整索引见 `llms.txt`；离线 PDF（~5800 页, 50MB）为快照，站点当前版。许可证 CC BY-SA / Gnu FDL。

## MariaDB 发布说明

- 分两类：企业版（Enterprise Server）、社区版（Community Server）。
- 企业版发布日期见官网 release schedule；社区版见 Jira。
- 离线 PDF（约 5,700 页 / 93 MB）为时间快照，在线文档始终最新。
- 完整索引：`https://mariadb.com/docs/llms.txt`，另有 Markdown 版。
- 许可证：CC BY-SA / Gnu FDL。

## MariaDB 服务器文档索引

- 完整文档索引: <https://mariadb.com/docs/llms.txt>
- 本页 Markdown: <https://mariadb.com/docs/server/readme.md>
- 离线 PDF: <https://github.com/mariadb-corporation/mariadb-docs/releases/latest/download/mariadb-server.pdf>（约 6200 页，80 MB，快照版本，线上始终最新）
- 许可: CC BY-SA / Gnu FDL

### 文档章节

- **快速入门**：安装、配置、启动使用
- **服务使用**：SQL 语句、内置函数、客户端工具、日常运维最佳实践
- **服务管理**：可靠性、性能、安全等管理内容
- **安全**：用户管理、加密、认证、审计
- **架构**：组件、存储引擎及其交互
- **客户端与工具**：命令行到图形界面的连接/管理工具
- **高可用与性能**：复制、集群、负载均衡、配置调优
- **参考**：SQL 语法、数据类型、函数、系统变量等详细规范

> 注：本文档页更新于 19 天前，PDF 为定时快照，线上内容始终最新。

- **MariaDB Server Ecosystem Hub**：精选发现平台，汇集与 MariaDB Server 协同的技术、服务、工具、应用及供应商，帮助用户找到可支撑实际部署的生态资源。
- **MariaDB Server Solution Stacks**：与生态伙伴联合开发的参考架构，围绕具体用户问题，展示 MariaDB Server + 伙伴技术的组合方案。
- **核心路径**：用户需求 → 实用架构 → 交付/实施伙伴。
- **Hub 价值**：
  - 用户：结构化发现相关伙伴/工具/服务/平台；
  - 伙伴/赞助商：生态内可见性，需求导向定位，获得精准流量与潜在客户。
- **Solution Stack 组成**：用例定义、参与伙伴、架构图、部署/配置指南、联合内容（博客/网络研讨会/活动材料等），以专属落地页为锚点持续运营。
- **入口**：

```text
https://ecohub.mariadb.org
```

- Hub 按分类组织，每个分类对应一个构建/运行 MariaDB 方案的实践问题。
- 易混淆点：Hub 是"发现层"，Solution Stacks 是"方案层"，两者配合形成从问题到架构再到伙伴的完整链路。

# MariaDB EcoHub 生态目录

官方生态聚合平台，按场景收录 MariaDB 集成工具。基础 URL：`https://ecohub.mariadb.org/`

- Solution Stacks：`/solution-stacks` 精选组合栈
- AI/App Dev：`/ai-application-development` Vector/RAG，集成 LangChain/LlamaIndex/Spring AI，MCP Server，ORM 向量支持
- Cloud/Hosting：`/cloud-hosting` 云厂商托管
- 连接：`/connectivity` 驱动/连接器/中间件
- DB 管理可视化：`/database-management` GUI/查询/可视化
- 监控性能：`/monitoring-perf` 监控/可观测性/调优
- DevOps：`/devops` 基础设施/编排/自动化
- 本地开发环境：`/local-dev-env`
- 基准测试：`/benchmark-testing` 负载/性能评估
- 插件：`/plugins` 存储引擎/认证/加密等
- 分析智能：`/analytics-intelligence` BI/可视化
- CMS/电商/CRM-ERP：`/cms`、`/ecommerce`、`/crm-erp` 业务后端
- 存储协作：`/storage-collab` 文件/协作
- 专业应用：`/specialized-apps` 垂直软件
- 密码管理：`/password-management` 凭据/密钥
- 教育实践：`/education-practice` 学习资源/沙箱
- 支持服务：`/support-services` 咨询/支持

- 完整文档索引见 `llms.txt`
- 本页提供 Markdown 版本
- 含 Previous/Next 导航链接

- 发布说明索引页，入口：**MariaDB MCP Server 1.0.0**。
- 完整索引：[llms.txt](https://mariadb.com/docs/llms.txt)，另有 Markdown 版。
- 前后导航：上一版 MariaDB AI RAG 1.1.0；下一版同为 MCP Server 1.0.0。

- **node-redis** 为 Node.js 官方推荐客户端；旧客户端 `ioredis` 仍受支持。

### 安装
```bash
npm install redis
```

### 连接与基础操作
```js
import { createClient } from 'redis';
const client = createClient();
client.on('error', err => console.log('Redis Client Error', err));
await client.connect();
await client.set('key', 'value');
const value = await client.get('key');
await client.hSet('user-session:123', { name: 'John', surname: 'Smith', company: 'Redis', age: 29 });
const userSession = await client.hGetAll('user-session:123');
await client.quit();
```

### 连接参数
- 默认 `localhost:6379`；自定义 URL：`redis[s]://[[username][:password]@][host][:port][/db]`
```js
createClient({ url: 'redis://user:pass@host:6380' });
```

### 状态检查
- `client.isReady`：已连接且就绪
- `client.isOpen`：底层 socket 打开（连接/重连中为 `false`）

### 易错点
- 确保 Redis 已运行
- `connect()`、`set()`/`get()` 均异步，需 `await`
- 操作完调用 `client.quit()`
- 哈希方法为驼峰：`hSet`/`hGetAll`

- **频道**：Developer、Product、Tech Talk  
- **版本更新**  
  ```text
  Community Server: 12.3.3 / 11.8.9 / 11.4.13 / 10.11.19 (Q3 2026)
  Community Server 10.6.28 (最终版)
  Node.js Connector: 3.5.4 / 3.4.7 / 3.3.4 / 3.2.5 GA
  Java Connector: 3.5.10 / 3.4.4 / 3.3.6 / 2.7.15
  ```
- **新特性**  
  - MariaDB 12.3：Matryoshka 优化加速向量搜索，提升高召回率性能  
  - Enterprise Kubernetes Operator 26.06：多集群复制、FIPS 模式  
- **迁移**  
  - MariaDB Migrator 提供 MySQL→MariaDB 迁移，四种模式；仍有未覆盖场景  
- **其他**  
  - 分析 OpenAI 用 MariaDB 替代 PostgreSQL 处理 8 亿用户  
  - 数据主权与云数据库保护  
  - Serverless 云部署适配不均匀 AI 负载

- **Predis**：PHP 的 Redis 客户端，第三方库，非 Redis 官方支持；需先运行 Redis 服务器。
- **安装**（Composer）：`composer require predis/predis`
- **连接**（本地默认 6379）：

```php
<?php
require 'vendor/autoload.php';
use Predis\Client as PredisClient;

$r = new PredisClient([
    'scheme'   => 'tcp',
    'host'     => '127.0.0.1',
    'port'     => 6379,
    'password' => '',
    'database' => 0,
]);
```

- **关键参数**：`scheme`（tcp）、`host`、`port`、`password`、`database`。
- **常用操作**：
  - 字符串：`$r->set('foo', 'bar')` / `$r->get('foo')`
  - 哈希：`$r->hset('user-session:123', 'name', 'John')` / `$r->hgetall('user-session:123')`（返回关联数组）
- **注意**：连接后必须加载 `vendor/autoload.php`；更多连接选项见 [Predis wiki](https://github.com/predis/predis/wiki)。

## MariaDB 企业平台

面向生产环境的开源数据库平台，支持本地/公有/私有/混合/多云部署。

### 核心组件
- **Enterprise Server**: 统一处理事务/分析/混合负载，支持关系、半结构化、向量数据模型
- **Enterprise Cluster**: 基于 Galera 的 active-active 多主同步复制，提供 HA、自动故障转移
- **MaxScale**: 数据库代理，提供 HA、扩展、安全，抽象底层数据库架构
- **Kubernetes Operator**: 声明式配置自动化部署管理，内置 HA/DR 方案
- **Enterprise Manager**: 集中监控管理，拓扑视图、自定义仪表盘、告警；指标可导出至 OpenTelemetry/Prometheus
- **AI RAG**: RAG-in-a-box，数据摄入 + REST API 输出基于自有数据的 AI 答案
- **MCP Server**: 连接 MariaDB 与 GenAI，支持语义搜索等 AI 操作
- **Exa**: MPP 列存数据库，多节点 + 可读写备节点，TPC-H 领先
- **GridGain 内存缓存**: Apache Ignite 企业版，亚毫秒延迟、大规模扩展

### 关键能力
- **HA/DR**: 在线非阻塞备份；binlog 实现时间点恢复；MaxScale 智能路由与故障转移
- **查询优化**: 高级优化器动态分析并确定 SQL 执行计划
- **数据一致性**: 事务管理保证 ACID 属性
- **扩展性**: 垂直（硬件优化）+ 水平（Cluster 同步复制）
- **HTAP**: ColumnStore 提供内置实时分析；可选 Exa 支持大规模多节点复杂查询
- **向量检索**: 原生向量嵌入搜索，支持 RAG，免去向量数据库集成
- **迁移**: 兼容 MySQL/Oracle，低成本替代专有数据库
- **混合数据**: 高级 JSON 支持，单库处理非结构化与关系数据

### 典型场景
事务（复制/集群部署）、分析（列存数仓 + 云对象存储）、半结构化数据

- MariaDB 提供完整 JSON 函数集，支持 JSON 文档提取、修改及与关系数据无缝集成。  
- HTAP（混合事务/分析处理）：融合行存储与列存储，在事务工作流中嵌入实时分析。  
- AI/ML：向量搜索内置于数据库引擎，无需独立向量数据库，简化数据栈、降低复杂度。  
- 支持多样化工作负载，详见 [Learn more](https://mariadb.com/products/enterprise/workload-versatility/) 或 [Contact Us](https://mariadb.com/contact/?interest=platform)。

## Redis 监控集成：Prometheus + Grafana

- 监控集群/节点/数据库/分片/代理指标；补充 UI 不可见指标、配置告警、多系统同屏。
- 最低 4 vCPU、8-12GB RAM、100GB SSD；抓取间隔 30s，默认保留 90 天。

**prometheus.yml（v2 端点，v1 已弃用）**
```yaml
global:
  scrape_interval: 15s
scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]
  - job_name: redis-enterprise
    scrape_interval: 30s
    metrics_path: /v2
    scheme: https
    tls_config:
      insecure_skip_verify: true
    static_configs:
      - targets: ["<cluster_name>:8070"]
```

**⚠️ 易错点**：只能配**单个 target**（集群 FQDN）。v2 为集群级端点，每节点返回全量聚合；若列出所有节点，每个 sum() 面板会乘以节点数，且无报错、Grafana 显示正常，难以察觉。

**验证**
- `node_up` 确认连接。
- `count(up{job="redis-enterprise"})` 应为 `1`（防重复抓取）。
- `node_metrics_up` 为 `0` 表示该节点聚合抓取失败。

**Grafana**：访问 `http://localhost:3000`，添加 Prometheus 数据源指向 `http://localhost:9090`。

- 登录 Grafana（默认凭据：`admin`/`secret`）
- 进入 **Configuration → Data Sources → Add data source**，选择 **Prometheus**
- 关键配置：
  - Name: `redis-enterprise`
  - URL: `http://<prometheus server>:9090`
- 若 Grafana 服务器无法访问该端口，Access 选 **Browser**；测试环境可勾选 **Skip TLS verification**

## 导入预配置仪表盘
- **Dashboards → Manage → Import**，上传官方 JSON 仪表盘文件

## 告警配置
- v2（metrics stream engine）与 v1（deprecated）均需：
  - 参考 [Prometheus 告警文档](https://prometheus.io/docs/alerting/latest/overview/) 与 [Grafana 告警文档](https://grafana.com/docs/grafana/latest/alerting/)
  - 示例规则：`alerts.yml`（v1/v2 在 GitHub 仓库对应目录）
  - Redis 官方教程提供配置指引

## 仪表盘版本注意事项
- v1 仪表盘**不兼容** v2 metrics exporter 端点，必须使用匹配版本
- v2 端点：`https://<cluster_name>:8070/v2`
- 官方仪表盘（GitHub 开源）：cluster、database（延迟/内存/ops/键数）、node、shard、Active-Active

## RDI 快速入门核心要点

- 目标：PostgreSQL 实时同步至 Redis。
- 架构：collector 追踪源库变更写入 RDI stream；processor 处理后写目标 Redis。
- 前置条件：Redis Enterprise v6.4+、目标 Redis、VM（RHEL 8/9 或 Ubuntu 20.04-24.04）。RDI 需独立数据库存储状态。

### RDI 数据库要求
- 开发 125MB 单分片；生产 250MB 主从（建议密码+TLS）。
- 驱逐策略 `noeviction`；持久化 AOF `fsync every 1 sec`。
- **不能启用 clustering**（目标库可以），误开需重建。
- `rladmin` 无法设置，需 UI/REST API：

```bash
curl -v -k -d '{"eviction_policy": "noeviction"}' \
  -u '<USERNAME>:<PASSWORD>' \
  -H "Content-Type: application/json" \
  -X PUT https://<CLUSTER_FQDN>:9443/v1/bdbs/<BDB_UID>

curl -v -k -d '{"data_persistence":"aof","aof_policy":"appendfsync-every-sec"}' \
  -u '<USERNAME>:<PASSWORD>' \
  -H "Content-Type: application/json" \
  -X PUT https://<CLUSTER_FQDN>:9443/v1/bdbs/<BDB_UID>
```

### 管道配置与部署
- 安装后模板在 `/opt/rdi/config`；CLI 要求设置源/目标访问密钥。
- 编辑 `config.yaml`：`host: localhost`, `port: 5432`；`tables` 指定 `Track`；`target` 填目标库。
- 部署：`redis-di deploy --dir <管道目录>`

- 部署 pipeline：`redis-di deploy <path>`（path 为安装时提供）；未使用 context 时，需加 `--api-url` 指定 API 端点。
- 替代方式：Redis Insight 添加 RDI API endpoint 连接（host/IP 与 RDI VM 相同，默认 HTTPS 443），点击 **Deploy** 按钮。
- 验证运行：Redis Insight 查看 pipeline metrics 数据流；或连接目标数据库查看 RDI 写入的 key。
- CDC 模式：pipeline 先加载源数据 snapshot，后进入 change data capture (CDC) 模式。
- 测试 CDC：
  - 在源数据库生成模拟负载；
  - 运行 `redis-di describe` 查看记录流，配合 `watch -n 1 redis-di describe` 实时更新；
  - 用 Redis Insight 查看目标数据库数据。

## MariaDB 文档核心要点

- **文档索引**：完整索引见 `llms.txt`；任意页面 URL 追加 `.md` 即可获取 Markdown 版本
- **快速入门**（Getting Started）：安装指南、基础概念、连接 MariaDB、首批 SQL 查询
- **产品文档**：
  - MariaDB Server / Enterprise Platform / MaxScale / ColumnStore / Galera Cluster
  - Connectors、Tools、Enterprise Manager、Kubernetes Operator、MCP Server、AI RAG
- **生态**：MariaDB Server Ecosystem Hub 汇集兼容工具与服务
- **发布说明**：覆盖 Enterprise/Community Server、MaxScale、ColumnStore、Galera Cluster、Connectors、Kubernetes Operator、AI RAG、MCP Server

### 离线文档

PDF 格式，内部交叉引用可离线正常工作，均来自 GitHub Releases 最新快照：

```text
https://github.com/mariadb-corporation/mariadb-docs/releases/latest/download/mariadb-server.pdf
https://github.com/mariadb-corporation/mariadb-docs/releases/latest/download/mariadb-maxscale.pdf
https://github.com/mariadb-corporation/mariadb-docs/releases/latest/download/mariadb-connectors.pdf
```

**易错点**：
- 在线站点始终是权威版本，PDF 快照可能滞后
- 旧版快照可在同一 GitHub Releases 页面浏览下载

## Redis 命令参考（6.2–8.10 版本）

按功能组划分，各版本：8.10/8.8/8.6/8.4/8.2/8.0/7.4/7.2/6.2

### ACL
- 用户：`ACL SETUSER`（创建/修改）、`ACL DELUSER`（删除+断连）、`ACL GETUSER`、`ACL USERS`、`ACL WHOAMI`
- 规则文件：`ACL LIST`（导出）、`ACL SAVE`、`ACL LOAD`
- 其他：`ACL LOG`（安全事件）、`ACL DRYRUN`（模拟执行不落地）

### 数组（AR*）
- 读写：`ARSET`/`ARGET`/`ARINSERT`/`ARDEL`/`ARMGET`/`ARMSET`
- 查询：`ARLEN`/`ARCOUNT`/`ARGETRANGE`/`ARSCAN`/`ARGREP`/`AROP`
- 游标/缓冲：`ARSEEK`/`ARNEXT`/`ARLASTITEMS`/`ARRING`（自动回绕截断）/`ARINFO`

### 备份
- `BACKUP START` → `BACKUP SEAL`（BASE+INCR+manifest）→ `BACKUP CLEANUP`
- `BACKUP ABORT`（中止未封存）；`BACKUP LIST`/`BACKUP STATUS`

### 布隆过滤器（BF.*）
- `BF.ADD`/`BF.MADD`、`BF.EXISTS`/`BF.MEXISTS`
- `BF.INSERT`（不存在则创建）、`BF.CARD`、`BF.INFO`

### 其他
- `APPEND`（键不存在则创建）、`AUTH`（认证）、`ASKING`（跟随 `-ASK` 重定向）

- `BF.RESERVE`：创建新布隆过滤器。
- `BF.SCANDUMP`：开始布隆过滤器的增量保存。
- `BGREWRITEAOF`：异步重写追加文件（AOF）到磁盘。
- `BGSAVE`：异步保存数据库到磁盘。
- `BITCOUNT`：统计字符串中置位（1）的个数。
- `BITFIELD`：对字符串执行任意位域整数操作。
- `BITFIELD_RO`：对字符串执行只读位域整数操作。
- `BITOP`：对多个字符串执行位运算并存储结果。
- `BITPOS`：查找字符串中第一个置位（1）或清零（0）的位置。
- `BLMOVE`：从列表弹出元素并推入另一列表；无元素则阻塞；若移动的是最后一个元素则删除列表。
- `BLMOVEM`：将一个列表的至多/恰好指定数量元素移到另一列表并返回；无则阻塞；源列表空则删除。
- `BLMPOP`：从多个列表之一弹出首个元素；无则阻塞；弹空则删除列表。
- `BLPOP`：移除并返回列表首个元素；无则阻塞；弹空则删除列表。
- `BRPOP`：移除并返回列表末尾元素；无则阻塞；弹空则删除列表。
- `BRPOPLPUSH`：已废弃，改用`BLMOVE`（RIGHT/LEFT参数）。功能同BLMOVE，阻塞并可能删除列表。
- `BZMPOP`：按分数从多个有序集合之一移除并返回成员；无则阻塞；弹空则删除有序集合。
- `BZPOPMAX`：从多个有序集合移除并返回分数最高成员；无则阻塞；弹空则删除。
- `BZPOPMIN`：从多个有序集合移除并返回分数最低成员；无则阻塞；弹空则删除。
- `CF.ADD`：向布谷鸟过滤器添加项。
- `CF.ADDNX`：若项不存在则添加。
- `CF.COUNT`：返回项可能在过滤器中出现的次数。
- `CF.DEL`：从过滤器删除项。
- `CF.EXISTS`：检查一个或多个项是否存在。
- `CF.INFO`：返回过滤器信息。
- `CF.INSERT`：向过滤器添加一个或多个项。

# redis-cli 核心知识点

**安装**  
- 源码编译仅构建 CLI：`make redis-cli`，产物在 `src/redis-cli`。

**命令行用法**  
- 直接执行命令：`redis-cli INCR mycounter`，返回 `(integer) 7`。

**字符串引用与转义**  
- 双引号支持 `\" \n \r \t \b \a \\ \xhh`；单引号仅 `\'` 和 `\\`。  
- 示例：`SET mykey "Hello\nWorld"` 可存储换行。

**连接参数**  
- 默认 `127.0.0.1:6379`；`-h` 指定主机，`-p` 指定端口。  
- 密码：`-a <password>`（更安全用环境变量 `REDISCLI_AUTH`）。  
- 选库：`-n <dbnum>`。  
- URI：`-u redis://user:password@host:port/dbnum`（无用户名用 `default`；TLS 用 `rediss://`）。  
- `-4`/`-6` 偏好 IPv4/IPv6。

**SSL/TLS**  
- `--tls` 启用；`--cacert` 或 `--cacertdir` 配置信任证书；客户端证书用 `--cert` 和 `--key`。

**从其他程序输入**  
- `-x`：stdin 作为最后一个参数：`redis-cli -x SET net_services < /etc/services`。  
- 管道传入命令文件：`cat commands.txt | redis-cli`，逐条执行，支持引号包裹含空格参数。

**易错点**  
- 密码含引号需转义整个字符串：`AUTH user "pass\"word"`。  
- raw 模式自动切换，重定向/管道时类型信息消失；`--raw` 强制 raw，`--no-raw` 强制可读。

- `-r <count>`：重复执行命令次数；`-i <delay>`：执行间隔秒数，支持小数（如 `0.1` 表示 100ms）。默认间隔为 0（尽快执行）。
- `-r -1`：无限次执行，常配合 `-i` 做监控。
```bash
redis-cli -r 5 INCR counter_value
redis-cli -r -1 -i 1 INFO | grep rss_human
```
- CSV 输出：`--csv` 标志，**仅作用于单条命令**，不能导出整个库。
```bash
redis-cli --csv LRANGE mylist 0 -1
```
- Lua 脚本：`--eval <file>` 执行脚本文件，**用逗号分隔 KEYS 与 ARGV，无需显式指定 key 数量**。示例中 `location:hastings:temp , 23`，前为 KEYS，后为 ARGV。
```bash
redis-cli --eval /tmp/script.lua location:hastings:temp , 23
```
- 交互模式：直接运行 `redis-cli` 进入。提示符显示 `host:port`，当 `SELECT` 到非 0 数据库时，提示符变为 `host:port[db]`。
```bash
redis-cli
127.0.0.1:6379> SELECT 2
127.0.0.1:6379[2]> DBSIZE
```
- 交互模式下可用 `CONNECT <hostname> <port>` 切换连接到其他 Redis 实例。

## Redis Cloud（云服务）

全托管 Redis DBaaS，运行于主流公有云，支持 Redis 与 Redis Stack。

**核心特性**：线性扩展、即时故障转移、备份与恢复、可预测性能、24/7 监控支持。

**免费额度**：30MB 数据库。

### 快速开始
- 按 [Quick start] 创建免费数据库
- 集成：Vercel Marketplace / Heroku Add-on

### 管理项
- **订阅**：区分订阅类型（Subscriptions）
- **账户**：Accounts & settings、Billing、Marketplace integrations
- **数据库**：创建/管理云数据库，支持全部 Redis 命令及兼容性

### 安全
- 访问管理（Access Management）、MFA、SAML SSO、社交登录
- 数据库安全（加密连接）、数据访问控制（Data Access Control）

### 自动化管理
- REST API：管理数据库与订阅（含 reference/examples）
- `redisctl`：终端 CLI 工具，封装 Redis Cloud / Redis Software API

### 迁移路径
- AWS ElastiCache → Redis Cloud（离线/在线）
- Google Memorystore → Redis Cloud（离线/在线）
- 自托管开源 Redis → Redis Cloud
- ElastiCache / Memorystore → Azure Managed Redis (AMR)

- 核心：Redis 是数据结构服务器，原生类型覆盖缓存、队列、事件处理等场景。
- 字符串 Strings：字节序列，基础类型。命令：`SET/GET`
  - 位图 Bitmaps：对字符串进行位运算。命令：`SETBIT/GETBIT`
  - 位域 Bitfields：在字符串内高效编码多个计数器，支持原子 get/set/自增及溢出策略。命令：`BITFIELD`
- 数组 Arrays：稀疏、索引可寻址的字符串序列。命令组：`array`
- 地理索引 Geospatial：按地理半径/边界框定位。命令：`GEOADD/GEOSEARCH`
- 哈希 Hashes：字段-值对集合（类似 Python dict/Java HashMap）。命令：`HSET/HGETALL`
- JSON：结构化层级数组/键值对象，支持导入 JSON 文本并访问/修改/查询元素。命令：`JSON.SET/JSON.GET`
- 列表 Lists：按插入顺序排序的字符串列表，可作队列。命令：`LPUSH/RPUSH/LRANGE`
- 集合 Sets：无序唯一字符串，增删/存在检查 O(1)。命令：`SADD/SMEMBERS`
- 有序集合 Sorted sets：带分值的集合，适合排行榜。命令：`ZADD/ZRANGE`
- 流 Streams：日志/事件处理。命令：`XADD/XREAD`
- 概率型 Probabilistic：近似但高效统计
  - Bloom filter：存在性检查。`BF.ADD`
  - Count-min sketch：频率估计。`CMS.INCRBY`
  - Cuckoo filter：存在性检查（与 Bloom 取舍不同）。`CF.ADD`
  - HyperLogLog：基数估计。`PFADD/PFCOUNT`
  - t-digest：百分位估计。`TDIGEST.ADD`
  - Top-K：排名估计。`TOPK.ADD`
- 时间序列 Time series：时序数据。命令：`TS.CREATE/TS.ADD`
- 向量集 Vector sets：向量存储/检索（原文提及）

- **有序集合（Sorted Sets）**：唯一字符串集合，按关联 score 排序。命令组：`sorted-set`。
- **流（Streams）**：类追加日志（append-only log）结构，按发生顺序记录事件并分发处理。命令组：`stream`。
- **时间序列（Time series）**：存储和查询带时间戳的数据点。命令组：`timeseries`。
- **向量集合（Vector sets）**：管理高维向量数据的专用类型，支持高效向量相似度搜索；基于 **HNSW** 算法，采用**余弦相似度**度量；可结合结构化过滤器实现混合搜索（hybrid search）。适用于机器学习、推荐系统、语义搜索。命令组：`vector_set`。
- **扩展方式**：
  - 使用 **Lua** 编写服务端自定义函数。
  - 使用 **Modules API** 编写 Redis 模块，或采用社区支持模块。

## Kubernetes 上的 Redis Enterprise（核心知识点）

- 部署：通过 **Redis Enterprise Operator** 在 Kubernetes 上部署与管理 Redis Enterprise，支持原生 Kubernetes 资源与工作流（GitOps、K8s-native）。
- CRD 资源：
  - `REC`（Redis Enterprise Cluster）——管理集群
  - `REDB`（Redis Enterprise Database）——管理数据库
- 企业特性：线性扩展（Redis clustering）、自动故障转移高可用、Active-Active 地理分布、Redis Flex 成本优化、企业级安全与加密、24/7 支持。
- 兼容：CNCF-conformant Kubernetes 平台。

- 关键管理对象：
  - 集群与数据库：通过 REC/REDB 创建和管理
  - Active-Active 数据库：跨多个 K8s 集群部署
  - Security：安全连接与访问控制
  - 监控：采集日志（collect logs）、连接 Prometheus Operator
  - 升级与 Release notes

- 注意：Operator 为核心，所有集群/数据库均通过 CRD 定义；REDB 依赖 REC 集群。

Redis 面向 AI/搜索的核心能力：

- **语义向量存储与索引**：将非结构化数据（文本/图像/音频）转为 embedding，存于 **hashes** 或 **JSON** 文档，供索引与查询
- **向量搜索**：KNN / 范围查询 + 元数据过滤，毫秒级延迟
- **语义缓存（LangCache）**：语义相似提示复用缓存响应，降低 LLM API 成本
- **Agent 记忆**：会话级短期记忆 + 跨交互长期持久记忆
- **结构化数据访问**：业务数据转为受治理工具，供 agent 稳定查询
- **实时数据同步**：基于 **Change Data Capture (CDC)** 将关系型数据库近实时同步至 Redis

**向量索引类型**：
- `FLAT`：暴力精确检索
- `HNSW`：近似最近邻，适合大规模

**查询方式**：
- KNN 向量搜索
- 向量范围查询
- 元数据过滤器

**Context Engine（Redis Iris）四服务**（Redis Cloud 托管）：
- `LangCache`：语义缓存降本增效
- `Redis Agent Memory`：双层持久记忆（session + long-term），提供 Python/TypeScript SDK 与 REST API
- `Context Retriever`：业务数据定义为可治理工具，跨 agent 复用
- `Data Integration`：CDC 实时同步

**客户端与框架**：
- 客户端：Python、JavaScript、Java、Go、.NET、PHP
- 框架：LangChain、LlamaIndex、LangGraph

**核心操作流程**：
1. 创建向量索引：定义 schema（含向量字段与元数据）
2. 存储向量：写入 hash 或 JSON，向量与元数据同文档
3. 执行搜索：KNN / 范围 / 过滤
4. 运行时配置查询参数，优化 filter 模式

**Feature Form**：在现有数据系统上定义、管理、服务 ML 特征（Python SDK）。

### 核心知识点

- **RAG**：检索增强生成，用向量数据库检索语义相关结果，作为上下文增强 LLM 生成能力。
  - 示例：RedisVL、LangChain、LlamaIndex 实现；RAGAS 评估；Azure / Vertex AI 集成。
- **Agents**：AI 智能体自主规划并执行任务。
  - 相关资源：交互式 agent builder、处理周期/记忆架构/Redis 数据结构、LangGraph 端到端示例。
- **Context Engine**：托管服务，提供智能体记忆与数据访问。
  - **LangCache**：语义缓存，降低 LLM 成本。
  - **Agent Memory**：REST API 为任意智能体添加持久双层记忆。
  - **Context Retriever**：将业务数据暴露为可信工具供智能体查询。
  - **Data Integration**：与主数据库同步，保证数据新鲜。
- **教程要点**：
  - Agentic RAG：LlamaIndex + Amazon Bedrock。
  - LangGraph 智能体：Redis 记忆、旅行代理（短期会话记忆+长期持久记忆）。
  - Redis Iris：组合 Agent Memory + Context Retriever 构建理财顾问。
  - Google ADK：集成 Redis Agent Memory 实现持久记忆（工作+长期记忆），可用 `adk-redis` 包实现持久记忆、会话、语义缓存。

# VS Code Redis 插件

- 官方扩展名 **Redis for VS Code**（Redis 发布），支持图形 UI 和内置 CLI，可查看/增删改键。
- 支持数据类型：Hash、List、Set、Sorted Set、String、JSON。

## 安装
- 扩展市场搜索 `Redis for VS Code`，认准 Redis 官方发布，安装后启用 **Auto Update**。

## 连接
- Redis 图标（花体 R）→ **+ Connect database**，参数类似 `redis-cli`。
- 易错点：此版本连接后不可更改逻辑数据库，需为不同逻辑库单独添加连接。
- 本地库（非 OSS Cluster，默认用户名、无密码）自动加入连接列表。

## 连接工具
- 刷新、编辑、删除连接；打开 CLI；键排序（升/降序）；按名称/模式/类型过滤；按类型新增键。

## 键视图与编辑
- 键按分隔符自动分组，默认 `:`，可在设置 **Delimiter to separate namespaces** 修改。
- 编辑：重命名（点键名）、设 TTL（秒）、删除整个键/部分、添加键成员、刷新。
- 修改键会立即写入服务器。

## 值格式化器（String/Hash/List/Set/ZSet）
- 支持：Unicode、ASCII、Binary(blob)、HEX、JSON、Msgpack、Pickle、Protobuf、PHP serialized、Java serialized、32-bit vector、64-bit vector。
- Hash 键支持字段级 TTL（Redis 7.4+）。

## CLI 工具
- 点击 `>_` 图标，在 **REDIS CLI** 选项卡打开，用法同 `redis-cli`。

- Redis Insight：Redis 桌面 GUI 客户端，支持 GUI/CLI。
- 连接：自动发现本地/Software Cluster/Cloud Flexible；手动连接任意 Redis（含集群、Sentinel）；支持 RDI。
- 易错：用 `username`/`password` 连接时，该用户必须有 `INFO` 权限（ACL）。
- Azure Managed Redis：自动发现订阅/库；支持 Entra ID(OAuth) 无密码认证，自动刷新令牌。
- Copilot：登录并接受条款；通用问答；“我的数据”自然语言查询。
- RDI：内置连接器，管理管道。
- Browser：浏览/CRUD list、hash、string、set、zset、stream、array、vector set、JSON；按命名空间分组；格式化 Unicode、JSON、MessagePack、HEX、ASCII。
- Profiler：左下角 **Start Profiler** 实时分析命令。
- CLI：左下角 `>_ CLI`。
- Workbench：高级命令行；自动补全；Redis Search schema-aware；可视化索引/查询/聚合/时间序列。
- 分析：类型分布、内存、过期/待释放；top keys/namespaces；历史对比；注意仅分析最多 10,000 key，超出外推。
- Streams：按时间戳增删/过滤条目；管理消费组/消费者/pending；支持 ACK/claim。
- Search：单页创建索引、构建查询（Profile/Explain）、保存 Query Library；Browser 与 Search 切换查看关联索引。
- Bulk：支持批量删除/更新等操作。

- **批量删除**：在 List/Tree 视图按键类型/键名模式设置过滤器，打开 **Bulk Actions** 显示预计删除键数；完成后显示处理键数与耗时。用于优化数据库。
- **Slow Log**：基于 `SLOWLOG` 命令，列出超过指定运行时的命令，排查性能问题。需配置服务器参数：`runtime`、`maximum length`（Slowlog 最大长度），并可设 `auto-refresh interval` 自动刷新。
- **Plugins**：可构建自定义数据可视化扩展功能。
- **Telemetry**：可选遥测系统，数据匿名。
- **日志文件**：查看 `.log` 文件获取系统问题详细信息。
  - Docker：`/data/logs`（容器内）
  - Mac：`/Users/<username>/.redis-insight`
  - Windows：`C:\Users\<username>\.redis-insight`
  - Linux：`/home/<username>/.redis-insight`
- **API（仅 Docker）**：访问 `http://localhost:5540/api/docs`
- **反馈**：GitHub issues
- **许可证**：SSPL

注意：非官方支持系统上安装可能行为异常。

## Redis Iris 上下文引擎

全托管 AI 代理上下文服务，运行于 Redis Cloud，通过 REST API 管理，无需自建数据库。  
**四服务**：LangCache（语义缓存）、Agent Memory（代理记忆）、Context Retriever（上下文检索）、Data Integration（数据集成）。

### LangCache
- 语义相似度匹配缓存 LLM 响应，命中毫秒级返回，降低 LLM 调用成本。
- 自动管理 embedding；可配置相似度阈值、TTL、淘汰策略。
- 易错：查询未命中（cache miss）时才调用 LLM，并将结果写入缓存：

```bash
# 查询语义缓存
POST /v1/caches/{cacheId}/entries/search
{"prompt": "What are the features of Product A?"}

# 未命中时写入
POST /v1/caches/{cacheId}/entries
{"prompt": "What are the features of Product A?", "response": "Product A includes X, Y, and Z..."}
```

### Agent Memory
- 双层模型：会话记忆（短期，可配 TTL）+ 长期记忆（文本 + 向量 embedding，支持语义检索）。
- 会话→长期记忆自动异步提升，也可用 API 直接创建。
- 提供 Python/TypeScript SDK 及 REST API。

### Context Retriever
- 一次定义数据模型（如 customers/orders），自动生成代理可调用的工具，代理不直接访问数据库。
- 每个代理需 key，访问标签自动过滤可见数据；只能调用已定义工具。

### Data Integration (RDI)
- 支持 Oracle、MySQL、PostgreSQL、SQL Server，秒级同步至 Redis。
- 流程：初始同步 + 实时变更捕获；代理只查 Redis，避免源库慢查询与脏数据。

- 源库变更秒级同步至 Redis；Agent 查 Redis 不触生产库
- 零运维：Redis Cloud 托管管道
- 多源：Oracle/MySQL/PostgreSQL/MariaDB/SQL Server/AWS Aurora

## Redis LangCache

**定义**：Redis 全托管语义缓存服务，缓存 LLM 响应；语义相似的 prompt 直接返回缓存结果，无需调用 LLM。

**核心价值**：
- 降低 LLM 成本（省输出 token 费用）、毫秒级响应
- 自动生成 embedding，无需自管 embedding 模型
- 可配置相似度阈值、TTL、淘汰策略
- REST API + Python/JS SDK，支持任意 LLM 工作流（AI 助手、RAG、AI 代理、AI 网关）

**两个关键 API**：

LLM 调用前搜索缓存：
```
POST /v1/caches/{cacheId}/entries/search
{"prompt": "What are the features of Product A?"}
```

未命中时调用 LLM 后存储结果：
```
POST /v1/caches/{cacheId}/entries
{"prompt": "...", "response": "..."}
```

**工作流程**：用户 prompt → 应用调 search 端点 → LangCache 生成 embedding 并匹配存储的 embeddings → 命中返回缓存响应；未命中返回空 → 应用调 LLM 生成响应 → 通过 entries 端点存入缓存供后续使用。

**成本节省估算**：
```
月节省 = 月输出 token 成本 × 缓存命中率
```

**注意**：
- 当前为 preview，功能可能变更
- 缓存命中仅省输出 token 费用；输入 token 成本通常被 embedding 与存储成本抵消

**部署步骤**（Redis Cloud）：创建数据库 → 创建 LangCache 服务 → 客户端调用 API → 在控制台查看/编辑缓存、监控命中率与性能。

### LangCache 私有预览要点
- **前提**：AI 应用需调用 LLM API；存在重复/相似查询场景；愿意在预览期提供反馈。
- **访问**：全托管服务，预览免费，用量可能受限，提供专属支持及定期反馈会议。
- **数据安全**：数据存于用户自有 Redis 服务器；Redis 不访问数据、不用于 AI 训练；符合企业级安全隐私标准。
- **支持**：含入门资源、文档教程、邮件/聊天支持、产品团队定期回访、路线图更新。

- Redis MCP 是基于 MCP 标准的通用实现，允许任何 MCP 客户端（如 Claude Desktop、VS Code）让 AI 代理读写、查询 Redis 数据，并执行基本服务器管理。
- MCP 核心机制：服务端发布命令，兼容客户端可调用，代理可以检索数据或修改数据。
- 启用后可通过自然语言指令操作 Redis，例如：
  - `"Store the entire conversation in the 'recent_chats' stream"`
  - `"Cache this item"`
  - `"How many keys does my database have?"`
  - `"What is user:1's email?"`
- 最新变动参考 GitHub: https://github.com/redis/mcp-redis

- **版本**：Redis 8（开源版）取代 Redis Stack。
- **项目治理**：原始开发者 Salvatore Sanfilippo（antirez）于 2020 年指定 Yossi Gottlieb、Oran Agra 继任；2024 年回归。
- **行为准则**：采用 Contributor Covenant。
- **获取帮助**：Discord 实时交流；Stack Overflow 使用 `redis` 标签提问。
- **资讯**：官方 “What's New” 页面；Twitter 关注 `@redisinc`。
- **开源仓库**：`https://github.com/redis/redis`（源码与多数客户端库）。
- **提交要求**：需代码评审，至少 1 位非作者批准且无异议。
- **贡献方式**：
  - 文档：fork 后提交 PR，首次需签署贡献者许可协议（CLA）。
  - 报告 bug：在 GitHub Issues 新建；重大变更先创建 issue 描述方案。
  - 客户端库：多数开源，遵循各自库的贡献指南。

## Redis 产品核心知识点

### 产品形态
- **Redis Cloud**：全托管云服务，支持订阅、REST API
- **Redis Software**：企业自托管，可自建集群、REST API
- **Redis Open Source**：开源版（Redis 8 / Redis Stack ≤7.4）
- **Redis for Kubernetes**：K8s 部署，基于 REC（Redis Enterprise Cluster）/ REDB 自定义资源

### 辅助工具
- **Redis Insight**：GUI 管理、性能分析
- **Redis Data Integration (RDI)**：数据同步管道
- **Redis Iris**：AI 上下文引擎（Agent Memory / Context Retriever / LangCache）
- **Feature Form**：特征平台，需配置认证

### 高可用与持久化
- 集群/复制：所有产品均支持（开源用 Redis Cluster）
- **Active-Active 异地多活**：仅 Cloud / Software / K8s，**开源版不支持**
- **滚动升级**：仅 Cloud / Software / K8s，**开源版不支持**
- 持久化：全支持；K8s 用 PVC
- 备份：Cloud 自动；Software 定时；K8s 通过 `spec.backup`

### 监控与日志
- 开源监控命令：`INFO`、`MONITOR`、`LATENCY DOCTOR`
- 日志：`/var/log/redis/redis.log`、`SLOWLOG`、键空间通知
- 告警：Cloud/Software 可配置指标告警；K8s 用 `alertSettings`
- K8s 可导出指标至 Prometheus
- Software 支持生成 support package

### Redis 各产品安全功能支持速查

- **TLS**：全产品支持。K8s 通过 `REDB.spec.tlsMode` 启用。
- **RBAC**：Cloud 用 RBAC；Software 用 Access control；开源用 ACL；K8s 用 REC credentials。
- **LDAP**：仅 Software 和 K8s 支持。
- **SSO**：仅 Cloud 支持 SAML SSO。
- **自签名证书**：Software 用 Certificates；开源用 Certificate configuration；K8s 用 REC certificates；Cloud 不支持。
- **节点间加密**：Software 有 Internode encryption；K8s 可用；开源无；Cloud 见 Encryption at rest。
- **审计**：Software 有 Audit events；开源用 Keyspace notifications；Cloud/K8s 无。

- **Redis Software**：自托管、企业级 Redis 发行版（相对于托管 DBaaS 的 Redis Cloud）。
- 核心企业能力：线性扩展、高可用/备份/恢复、可预测性能、24/7 支持。
- 部署位置：本地数据中心或任意云平台。

## 关键管理工具
- `rladmin`：集群管理命令行工具。
- `crdb-cli`：管理 CRDB（无冲突复制数据库）。
- `redisctl`：统一 CLI，可同时管理 Redis Software 与 Redis Cloud。
- REST API：用于集群与数据库的自动化管理。

## 主要配置域
- **安装与搭建**：集群初始化（new cluster setup）及集群配置（configure）。
- **网络**：集群/数据库的网络设置。
- **数据库**：在集群上创建与管理 Redis 数据库。
- **安全**：
  - 访问控制（access control）
  - 用户（users）与角色（roles）
  - 证书（certificates）
  - TLS 与加密（TLS / Encryption）

## 文档版本
- 导航版本选择器覆盖 **7.4 及以上**。
- 更早版本（≤7.2）见归档站：`docs.redis.com/7.2/rs/`、`/6.4/rs/`、`/6.2/rs/`、`/6.0/rs/`。

Redis Stream 是类追加日志数据结构，支持 O(1) 随机访问和消费者组等复杂消费。每条消息有唯一 ID（毫秒时间-序列），ID 可用于读取游标。

- `XADD key * field value` 追加并自动生成 ID；不存在则创建 key。
- `XRANGE key start end` / `XREVRANGE`：按 ID 区间读取，`-`/`+` 表示最小/最大。
- `XREAD [BLOCK ms] COUNT n STREAMS key... id...`：从多个流读新消息；`$` 表示只读新产生消息。
- 消费者组：
  - `XGROUP CREATE key group id`：创建组，`id=0` 从头消费，`$` 只读新消息。
  - `XREADGROUP GROUP g c [BLOCK ms] STREAMS key >`：组内消费，`>` 取未投递新消息；指定 ID 取该消费者的历史消息。
  - `XACK key group id...`：确认消息，未确认的进入 PEL。
  - `XPENDING`：查看 PEL 待处理消息。
  - `XCLAIM key group consumer min_idle id...` / `XAUTOCLAIM`：接管超时未确认消息。
- `XTRIM key MAXLEN|MINID ...`：从头部裁剪；`XDEL key id...`：删除指定消息；`XLEN`：流长度；`XINFO STREAM/GROUPS/CONSUMERS`：查看状态。

易错点：
- ID 基于时间，示例值会变化；不要硬编码。
- `XREAD` 与 `XREADGROUP` 不同：前者按传入 ID 游标读，后者按组进度读。
- 消费后必须 `XACK`，否则消息一直留在 PEL，可能被重新投递。
- `XTRIM`/`XDEL` 删除消息后，未确认的 PEL 条目仍可能存在。
- 阻塞命令用 `BLOCK 0` 表示无限等待。

- **Streams 核心能力**：裁剪策略（防无界增长）+ 多消费策略（`XREAD`/`XREADGROUP`/`XRANGE`）。
- **Redis 8.2+**：`XACKDEL`、`XDELEX`、`XADD`、`XTRIM` 提供与多消费组交互的细粒度控制，简化跨应用消息处理协调。
- **Redis 8.6+**：支持幂等消息处理（at-most-once production），在 at-least-once 投递模式下自动去重，防止重复条目。

#### `XADD`
追加消息到流；key 不存在则创建。ACL 权限标记：`@write @stream @fast`。
- `*`：自动生成 ID，格式 `毫秒时间戳-序号`。
- 参数（Python 客户端）：`name`、`fields`（字段-值对）、`id="*"`、`maxlen`、`approximate`、`nomkstream`、`minid`、`limit`、`ref_policy`（`KEEPREF`/`DELREF`/`ACKED`）、`idmpauto`、`idmp`。

```bash
> XADD race:france * rider Castilla speed 30.2 position 1 location_id 1
"1692632086370-0"
> XADD race:france * rider Norem speed 28.8 position 3 location_id 1
"1692632094485-0"
> XADD race:france * rider Prickett speed 29.7 position 2 location_id 1
"1692632102976-0"
```

```python
r.xadd("race:france", {"rider": "Castilla", "speed": 30.2, "position": 1, "location_id": 1})
```

- **Redis × LangChain**：构建具备持久记忆、向量检索、语义缓存的 AI 应用，适用于聊天机器人、推荐系统等。
- **关键特性**：
  - **向量搜索（Vector Search）**：高性能相似度检索，服务 embedding/AI 模型。
  - **会话记忆（Conversation Memory）**：持久化聊天历史与上下文。
  - **语义缓存（Semantic Caching）**：缓存模型响应，降低延迟与成本。
  - **文档存储（Document Storage）**：支持 RAG（检索增强生成）。
  - **实时更新**：支持动态数据更新。
  - **可扩展架构**：应对大规模 AI 负载。
  - **多模态**：支持文本、图像等数据类型。
  - **原生集成**：与 LangChain 生态及工具链无缝对接。
- **入门**：参考官方教程构建 AI 聊天机器人（https://redis.io/learn/howtos/solutions/vector/gen-ai-chatbot）。

## redis-py 指南

- redis-py 是 Redis 官方 Python 客户端，需先运行 Redis 服务。
- 安装：
  ```bash
  pip install redis
  ```
- 性能优化：安装 `hiredis` 编译解析器，默认若 `hiredis>=1.0` 可用则自动使用，零代码改动：
  ```bash
  pip install redis[hiredis]
  ```
- 注意：Python 3.12+ 移除 `distutils`，安装失败时升级 redis-py 至最新版。

### 连接与基本操作

- 连接本地 Redis 默认端口 6379：
  ```python
  import redis
  r = redis.Redis(host='localhost', port=6379, decode_responses=True)
  ```
- 默认返回 bytes；设置 `decode_responses=True` 后返回解码字符串。
- 字符串操作：
  ```python
  r.set('foo', 'bar')     # True
  r.get('foo')            # 'bar'
  ```
- 哈希操作：
  ```python
  r.hset('user-session:123', mapping={
      'name': 'John', 'surname': 'Smith',
      'company': 'Redis', 'age': 29
  })
  r.hgetall('user-session:123')
  # {'name': 'John', 'surname': 'Smith', 'company': 'Redis', 'age': '29'}
  ```
- 使用后关闭连接：
  ```python
  r.close()
  ```

### 更多参考

- 命令参考与教程：https://redis.readthedocs.io/en/stable/
- GitHub：https://github.com/redis/redis-py

- `redis-rb` 是 Ruby 的 Redis 客户端，使用前需先运行 Redis 服务。
- 安装：`gem install redis`
- 连接与基本操作：

```ruby
require 'redis'
r = Redis.new       # 默认连接 localhost:6379

# 字符串
r.set 'foo', 'bar'
r.get('foo')        # => "bar"

# 哈希
r.hset 'user-session:123', 'name', 'John'
r.hgetall('user-session:123')
# => {"name"=>"John"}

r.close()           # 用后关闭连接
```

要点：
- `Redis.new` 可指定参数：`Redis.new(host: "10.0.0.1", port: 6380)`。
- 字符串用 `set`/`get`，哈希用 `hset`/`hgetall`。
- 操作完成后调用 `close()` 释放连接。
- 更多示例见 https://github.com/redis/redis-rb 。

# redis-rs (Rust) 核心要点

- 第三方 Redis 客户端库，需自行安装并运行 Redis 服务器。
- 同步依赖：`redis = "1.0.4"`；异步启用 tokio：
```toml
[dependencies]
tokio = { version = "1.32.0", features = ["full"] }
redis = { version = "1.0.4", features = ["tokio-comp"] }
```
- 导入 trait：同步 `use redis::Commands;`，异步 `use redis::AsyncCommands;`
- 连接：
  - `redis::Client::open("redis://127.0.0.1")`
  - 同步：`client.get_connection()`；异步：`client.get_multiplexed_async_connection().await`
  - 需处理 `Err`

- 基本操作，需类型标注：
```rust
r.set("foo", "bar")?;               // OK
let res: String = r.get("foo")?;    // "bar"
```
- Hash：
```rust
r.hset_multiple("bike:1", &hash_fields)?; // (&str,&str) 数组
r.hget("bike:1", "model")?;
let all: Vec<(String, String)> = r.hgetall("bike:1")?;
```
- 易错点：
  - 异步方法必须 `.await`
  - 返回值需显式类型标注
  - 操作返回 `Result`，需处理错误

原文仅链接至 redis-rs 文档与仓库，无核心要点。

RedisVL：Redis 专用 Python 向量库客户端。

- 面向 ML/AI 工作流，管理高维向量数据（embeddings）
- 典型应用：推荐系统、语义搜索、异常检测

核心能力：
- **向量相似度搜索**：基于 HNSW（Hierarchical Navigable Small World）实现高维空间最近邻查找
- **AI 框架集成**：兼容 TensorFlow、PyTorch、Hugging Face
- **高性能**：利用 Redis 内存架构，低延迟、可扩展

价值：连接数据存储与 AI 模型部署，简化实时智能应用基础设施。

## 远程 DBA 管理服务（MariaDB Remote DBA）

MariaDB 官方提供的远程数据库管理服务，由专家团队主动+被动管理数据库，弥补内部 DBA 资源不足。

**核心服务**
- 架构与最佳实践审查
- 备份管理
- 性能调优
- 计划维护
- 健康检查
- S1 问题 30 分钟响应

**订阅包含功能**
- 安装监控与告警方案
- 实时聊天 + 电话支持（有限制）
- 初始环境/配置审查
- 数据库配置建议
- 备份配置与监控（有限制）
- 数据库恢复协助
- 通过自动恢复验证备份（有限制）
- 复制搭建、配置与修复
- Schema 变更与迁移
- 被动调优协助
- MariaDB Enterprise Server 季度升级（有限制）
- 半年安全/性能审计（按需）
- 半年架构审查（按需）
- 其他协商的 DBA 任务

**注意事项**
- 部分功能有适用限制（电话支持、备份验证、企业版升级等），具体见订阅服务政策。

- **RIOT-X**: Redis 输入/输出命令行工具，用于数据导入/导出。
- 支持：Redis（快照/实时复制）、文件（CSV/JSON/XML 等）、关系型数据库（MySQL/Snowflake/Oracle 等）、数据生成器（Redis 数据结构/Faker）。
- 文档：`redis.github.io/riotx`。

- 核心：Spring Data Redis 将 Redis 集成到 Spring 框架，支持 Lettuce/Jedis 客户端，兼得连接特性与 Spring 抽象。
- 两大用途：
  - Redis 作为 Spring 缓存抽象存储（`cache` 页）
  - 客户端地理故障转移：配置弹性连接，自动切换 Redis 端点（`geo-failover` 页）

- StackExchange.Redis 为 .NET 主客户端；NRedisStack 扩展 JSON/Search/Time series 等。
- 需 Redis 服务：生产用云托管，本地可用开源版。

安装：
```bash
dotnet add package StackExchange.Redis
```

连接（多路复用器应单例复用，默认 localhost:6379）：
```csharp
var muxer = await ConnectionMultiplexer.ConnectAsync("localhost:6379");
var db = muxer.GetDatabase();
```

字符串读写：
```csharp
db.StringSet("foo", "bar");
string? val = db.StringGet("foo");
// 异步用 StringSetAsync / StringGetAsync
```

Hash 操作（值均按字符串保存，如 "29"）：
```csharp
db.HashSet("user-session:123", new HashEntry[] {
    new("name", "John"), new("age", "29")
});
var fields = db.HashGetAll("user-session:123");
// 异步对应 HashSetAsync / HashGetAllAsync
```

易错点：
- 异步必须调用 Async 后缀方法。
- HashEntry 值须为字符串/字节，勿直接传非字符串。
- 复用 ConnectionMultiplexer，避免频繁创建连接。

## MariaDB 工具

- **MariaDB Enterprise Manager**：面向整个数据库集群的集中式可观测性与管理平台。核心功能：拓扑感知监控、可视化查询开发、Schema 管理。
- **MariaDB Enterprise Operator**：在 Kubernetes 上运行容器化 MariaDB Enterprise Server 与 MaxScale 的组件，利用 K8s 编排与自动化简化部署和管理。
- **MariaDB Enterprise MCP Server**：企业级 MCP（模型上下文协议）服务器，作为 AI 助手与 MariaDB 数据生态之间的安全接口，允许 AI 代理安全高效访问数据。
- **MariaDB AI RAG**：企业级 RAG（检索增强生成）方案，集成 MariaDB，提供 AI 文档处理、语义搜索和自然语言生成能力。

文档路径：

```text
/docs/tools/mariadb-enterprise-manager
/docs/tools/mariadb-enterprise-operator
/docs/tools/mariadb-enterprise-mcp-server
/docs/tools/mariadb-ai-rag
```

- 向量搜索：语义匹配，余弦距离越小越相似。
- 流程：生成嵌入 → 重建索引加 `VECTOR` 字段 → `FT.SEARCH` KNN。
- 存储嵌入（768维 JSON 数组）：
```python
embedder = SentenceTransformer("msmarco-distilbert-base-v4")
embedding = embedder.encode(description).astype("float32").tolist()
r.json().set(key, "$.embedding", embedding)
```
- 重建索引：
```python
r.ft("idx:catalog").dropindex()
schema = (VectorField("$.embedding", "FLAT", {"TYPE": "FLOAT32", "DIM": 768, "DISTANCE_METRIC": "COSINE"}, as_name="embedding"),)
index.create_index(schema, definition=IndexDefinition(prefix=["product:"], index_type=IndexType.JSON))
```
- 小数据 `FLAT`，大数据 `HNSW`；`TYPE`/`DIM` 匹配模型。
- KNN：
```
FT.SEARCH idx:catalog "(*)=>[KNN 3 @embedding $query_vector AS score]" PARAMS 2 query_vector "\x9a..." SORTBY score ASC RETURN 2 score name DIALECT 2
```
- 易错点：查询与建索引同模型；加 `embedding` 后重建索引；`DROPINDEX` 不删文档。

### 向量 KNN 查询
基本命令：
```redis
FT.SEARCH idx:catalog "(*)=>[KNN 3 @embedding $query_vector AS score]" PARAMS 2 query_vector "\x9a..." SORTBY score ASC DIALECT 2
```
- `(*)`：预过滤，`*` 表示全部；替换为任一 `FT.SEARCH` 过滤条件可限定子集（例：`(@category:{Audio})=>[KNN ...]` 仅搜 Audio 类）。
- `=>[KNN 3 @embedding $query_vector AS score]`：在 `embedding` 字段中找 3 个最近邻，距离字段别名为 `score`。
- `PARAMS 2 query_vector "..."`：传入二进制查询向量（实际由客户端库生成，示例中已截断）。
- `SORTBY score ASC`：按距离升序（最近优先）；必须 `DIALECT 2`。

### 混合搜索 FT.HYBRID
同时执行全文检索和向量检索，融合排名：
```redis
FT.HYBRID idx:catalog SEARCH "wireless" VSIM @embedding $query_vector KNN 2 K 5 LOAD 1 @name PARAMS 2 query_vector "\x9a..."
```
- `SEARCH`：全文查询（同 `FT.SEARCH`）。
- `VSIM`：向量相似度查询。
- 默认用 Reciprocal Rank Fusion 融合两种排名；可用 `COMBINE` 调节权重，后接 `FILTER`/`LOAD`/`APPLY`/`SORTBY` 等聚合步骤。

### 易错点
- 查询向量是二进制值，示例中缩短；实际应用中由客户端库根据模型输出生成，勿手动粘贴。
- 向量 KNN 查询需 `DIALECT 2`，否则报错。

---
来源：consolidated/services/数据库（MariaDB 与 Redis）.md