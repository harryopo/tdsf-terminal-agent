# 2026 年 7 月运维 Agent 开源生态调研（截止 2026-07-30）

> **位置**：`docs/reports/ops-agent-survey-2026-07-30.md`
> **数据基准**：2026-07-30 WebSearch 真实抓取（不依赖训练知识，知识截止 2025-08，1 年差距已通过实时搜索补齐）
> **任务边界**：本文件仅为调研报告，不修改任何 `src/` 或 `src-tauri/` 下的源码文件
> **上游参考**：[crynta/terax-ai](https://github.com/crynta/terax-ai) v0.8.6（TDSF 唯一基线）
> **配套文档**：
> - `docs/reports/ops-agent-opensource-survey-2026-07.md`（v1.0，11 项目深度评估）
> - `docs/reports/ops-agent-opensource-survey-2026-07-v2.md`（v2.0，下半月补充 + OpenWorker/MCP 发现）
> - `docs/reports/strands_backend-audit-2026-07-30.md`（Strands 骨架代码审计）
> - `docs/reports/modded-agent-availability-audit-2026-07-30.md`（魔改 agent 可用性审计，本任务 B 输出）

---

## 1. 执行摘要

1. **首选方案维持不变**：**AWS Strands Agents v1.48.0**（Apache 2.0，2026-07-17 发布）仍是 TDSF 集成首选。其 `@tool` 装饰器 + MCPClient + `stream_async` + Agents-as-Tools 范式与 TDSF sidecar 的 `tools/*.py` + JSON-RPC 架构高度对齐。生产验证（Amazon Q Developer / Leidos ManagedX 政府级文档处理 / Kong AI Gateway）支撑其作为首选。
2. **备选方案**：**PydanticAI v2.13.0**（MIT，类型安全 + MCPToolset + Human-in-the-loop）作为轻量备选；**OpenAI Agents SDK v0.17.7**（MIT，27,900+ stars）作为参考实现。
3. **多 Agent 框架格局变化**：**AutoGen 进入 maintenance mode**，被微软新发布的 **Microsoft Agent Framework (MAF)** 取代；**CrewAI** 与 **LangGraph** 各自分化，前者面向角色编排，后者面向图状态机。
4. **【新增重点】Linux SSH 终端 AI Agent 赛道爆发**：2026-07 涌现一批 AI-Native SSH 终端工具，其中 **NyaTerm**（Tauri + React + Rust，MIT，github.com/nyakang/nyaterm，500+ Stars）与 **Sageport**（Tauri + React + Rust，github.com/joygqz/sageport）和 TDSF **同栈**，是最直接的对标参考。**uniTerm**（Apache 2.0，Vue.js，187 Stars）AI Native 设计，自主故障排查能力是 TDSF 的产品方向参考。**Chaterm**（GPL-3.0，TypeScript + Vue + Electron）是 AI 原生 SSH 终端工具的另一个高星项目。
5. **集成难度评估**：Strands 集成难度 **2.5 人日**（已有 `strands_backend/` 骨架，需修复 4 处 CRITICAL 断裂，详见配套审计报告）；PydanticAI 集成难度 **3-4 人日**（需新建 backend 适配层）；引入 MCP 协议作为 sidecar JSON-RPC 标准化补充 **2 人日**（运维 MCP server 已成熟）。
6. **风险提示**：Strands 依赖 `litellm`，可能与现有 `pydantic`/`chromadb` 冲突，需虚拟环境隔离测试；MCP 规范 2026-07-28 重大版本（无状态核心 + Tasks 扩展）影响所有 MCP 用户，需关注兼容性。

---

## 2. 项目对比总表

### 2.1 通用 AI Agent 框架（运维可复用）

| # | 项目 | 最新版本 | License | Stars | Python | 运维适用度 | 集成难度 | 推荐度 |
|---|------|----------|---------|-------|--------|-----------|----------|--------|
| 1 | **Strands Agents** | 1.48.0 (2026-07-17) | Apache 2.0 | 6,704 | >=3.10 | ★★★★★ | 低 (2.5 人日) | **首选** |
| 2 | PydanticAI v2 | 2.13.0 | MIT | - | >=3.10 | ★★★★☆ | 中 (3-4 人日) | 备选 |
| 3 | OpenAI Agents SDK | 0.17.7 (2026-06-24) | MIT | 27,900+ | >=3.10 | ★★★☆☆ | 中 (参考实现) | 参考 |
| 4 | Claude Agent SDK | - (2026-06) | MIT | - | >=3.10 | ★★★☆☆ | 中 | 参考 |
| 5 | AutoGen | (maintenance) | MIT | - | >=3.10 | ★★☆☆☆ | 高 | 不推荐 |
| 6 | Microsoft Agent Framework (MAF) | 新发布 | MIT | - | >=3.10 | ★★★☆☆ | 中 | 观察 |
| 7 | CrewAI | - | MIT | - | >=3.10 | ★★★☆☆ | 中 | 观察 |
| 8 | LangGraph | - | MIT | - | >=3.10 | ★★★★☆ | 中 (TDSF 当前用) | 维持 |

### 2.2 编码 Agent（IDE 集成型，运维场景可借鉴工具设计）

| # | 项目 | 类型 | License | 运维适用度 | 借鉴点 |
|---|------|------|---------|-----------|--------|
| 9 | OpenHands | 自主编码 Agent | MIT | ★★☆☆☆ | 多 Agent 编排、沙箱执行 |
| 10 | Aider | CLI 编码助手 | Apache 2.0 | ★★☆☆☆ | 终端 UX、git 集成 |
| 11 | Goose | 桌面 Agent | Apache 2.0 | ★★★☆☆ | MCP 优先、本地优先 |
| 12 | Continue.dev | IDE 插件 | Apache 2.0 | ★★☆☆☆ | 上下文工程、RAG |
| 13 | Cline / Roo Code | VSCode Agent | Apache 2.0 / MIT | ★★★☆☆ | 工具调用审批流、diff 展示 |

### 2.3 【新增】Linux SSH 终端 AI Agent 专用项目（重点关注）

| # | 项目 | 技术栈 | License | Stars | AI 能力 | 与 TDSF 对标度 |
|---|------|--------|---------|-------|---------|---------------|
| 14 | **NyaTerm** | Tauri + React + Rust | MIT | 500+ | 终端上下文绑定 AI + 风险等级审批 | ★★★★★ 同栈同方向 |
| 15 | **Sageport** | Tauri + React + Rust | 开源 | - | VSCode 风格 + AI 操作工作台 | ★★★★★ 同栈 |
| 16 | **uniTerm** | Vue.js (Wails) | Apache 2.0 | 187 | AI Native 自主故障排查 | ★★★★☆ AI 方向参考 |
| 17 | **Chaterm** | TypeScript + Vue + Electron | GPL-3.0 | - | AI Agent + 自然语言命令 | ★★★☆☆ GPL 冲突 |
| 18 | OxideTerm | 本地优先 | 开源 | - | 零遥测 AI 工作区 | ★★☆☆☆ |
| 19 | Zap | 本地优先 | 开源 | - | 插拔式 AI/Agent | ★★☆☆☆ |
| 20 | Netcatty | Electron | 开源 | - | Catty Agent 多主机编排 | ★★☆☆☆ |
| 21 | NaviTerm | Apple 生态 | 闭源 | - | SSH + AI Copilot | ☆☆☆☆☆ 平台不匹配 |

---

## 3. 重点开源项目深度分析（Top 5）

### 3.1 AWS Strands Agents（首选，确认）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/strands-agents/sdk-python |
| PyPI 最新 | **1.48.0**（2026-07-17 发布） |
| Stars / Forks | 6,704 / 993 |
| License | Apache 2.0 |
| Python | >=3.10（含 3.14） |
| 发版频率 | 几乎每周（2025-08-26 1.6.0 → 2026-07-17 1.48.0） |
| 生产验证 | Amazon Q Developer / Amazon Glue / VPC Reachability Analyzer / Leidos ManagedX（2026-04-29 政府级文档处理） |
| PyPI extras | a2a / all / anthropic / **bidi** / cedar / gemini / litellm / llamaapi / mistral / ollama / openai / otel / sagemaker / writer |

**核心范式**（与 TDSF 兼容性确认）：
```python
from strands import Agent, tool
from strands.tools.mcp import MCPClient

@tool
def ssh_command(command: str, explanation: str = "") -> dict:
    """Propose an SSH command for approval."""
    # 与 TDSF tools/*.py 的 invoke_*_tool(params) 范式对齐
    ...

# MCPClient 原生支持（stdio + Streamable HTTP）
mcp_client = MCPClient(lambda: stdio_client(...))
with mcp_client:
    agent = Agent(tools=mcp_client.list_tools_sync())
    response = agent("...")
```

**与 TDSF 集成适配度评估：5/5 分**
- ✅ Python SDK，与 sidecar 无缝对接
- ✅ `@tool` 装饰器与 `tools/*.py` 的 `invoke_*_tool(params)` 范式对齐
- ✅ MCPClient 原生支持（stdio + Streamable HTTP）
- ✅ `stream_async` + BidiAgent 双向流式
- ✅ Apache 2.0 与上游 terax-ai 兼容
- ✅ 13+ 模型提供商（含 Ollama 本地、LiteLLM 适配国内 DeepSeek/Qwen）
- ⚠️ 依赖 `litellm`，可能与现有 pydantic/chromadb 冲突（需虚拟环境隔离测试）

**集成阻断点**（详见 `strands_backend-audit-2026-07-30.md`）：
1. `main.py` 缺 `TDSF_AGENT_BACKEND` feature flag 注入点（CRITICAL-1）
2. `agents/__init__.py` 缺 `set_backend` 接口（CRITICAL-2）
3. `requirements.txt` 未声明 `strands-agents` 依赖（CRITICAL-3）
4. 工具调用的 Rust method 名与 Rust 侧实际 Tauri command 名不匹配（CRITICAL-4）

---

### 3.2 PydanticAI v2（备选）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/pydantic/pydantic-ai |
| 最新版本 | **v2.13.0** |
| License | MIT |
| 核心特性 | Model-agnostic + MCPToolset + Human-in-the-loop approval + Durable execution |

**与 TDSF 集成适配度评估：4/5 分**
- ✅ 类型安全，与 TypeScript strict 前端契约对齐
- ✅ 内置 MCPToolset（stdio + Streamable HTTP）
- ✅ Human-in-the-loop approval 与 TDSF needs_you 协调服务对齐
- ✅ Durable execution 支持长时运行任务
- ⚠️ API 风格与 BaseAgent PAOR 模板方法差异较大，需新建 `pydanticai_backend/` 适配层
- ⚠️ 社区规模小于 Strands

---

### 3.3 NyaTerm（同栈对标参考，新增重点）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/nyakang/nyaterm |
| 官网 | https://nyaterm.app |
| 技术栈 | **Tauri + React + Rust**（与 TDSF 完全一致） |
| License | MIT |
| Stars | 500+（2026-07 快速增长） |
| 更新 | v1.0.0 → v1.1.10（2026-06-27 发布后一个多月） |
| 平台 | Windows / macOS / Linux |

**核心特性**：
- SSH / 本地 Shell / Telnet / 串口 / SFTP / 隧道 / OTP / AI 辅助 / 加密云同步 / X11 / 命令窗口
- **终端上下文绑定 AI**：AI 不是单纯聊天窗口，而是和终端会话绑定——可解释当前选中的终端输出、根据活跃终端上下文生成命令
- **Agent 模式**：按"观察、决策、执行"循环辅助处理多步任务（与 TDSF PAOR 模式对齐）
- **风险等级标记 + 审批门槛**：高影响命令触发审批，并给出更安全的替代方案（与 TDSF RiskEngine + needs_you 对齐）
- 受 WindTerm 启发，支持从 WindTerm/Xshell 导入会话配置

**与 TDSF 对标价值**：
- ✅ **同栈同方向**：Tauri + React + Rust，TDSF 可直接参考其 AI 集成方式
- ✅ **风险审批范式对齐**：与 TDSF RiskEngine + needs_you 协调服务设计一致
- ✅ **Agent 模式 = PAOR**：观察-决策-执行循环与 TDSF BaseAgent PAOR 模板方法一致
- ⚠️ MIT 协议允许借鉴代码结构，但需尊重原作者（建议调研后归档分析报告）

---

### 3.4 uniTerm（AI Native 方向参考，新增重点）

| 维度 | 数据 |
|------|------|
| 官网 | https://uniterm.net |
| 技术栈 | Vue.js (Wails) |
| License | Apache 2.0 |
| Stars | 187（2026-07-23 更新） |
| 大小 | 不到 10MB |
| 协议覆盖 | SSH / RDP / SFTP / 数据库 / 远程桌面等 20+ 协议 |

**核心特性**：
- **AI Native 设计**：终端连接能力与 AI Agent 并行构建，共享同一套会话管理、Shell 感知和工具调用体系（非外挂聊天窗口）
- **自主故障排查**：用户说"帮我排查一下这台服务器 CPU 飙升的原因"，Agent 自己 SSH 上去跑命令、看输出、判断下一步
- **多模型支持**：Anthropic/OpenAI-compatible API，支持 Claude/GPT 等
- **9 种语言**界面

**与 TDSF 对标价值**：
- ✅ **AI Native 产品方向参考**：TDSF 应学习其"会话管理 + Shell 感知 + 工具调用"三共享体系
- ✅ **自主故障排查场景**：与 TDSF Linux 运维教学定位高度对齐
- ⚠️ Wails（Go）而非 Tauri（Rust），代码层不可直接借鉴
- ⚠️ Apache 2.0 允许借鉴设计，但需保留归属说明

---

### 3.5 Sageport（同栈工作台参考，新增重点）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/joygqz/sageport |
| 技术栈 | **Tauri + React + Rust**（与 TDSF 完全一致） |
| License | 开源 |
| 平台 | Windows / macOS / Linux |
| 布局 | VSCode 风格（活动栏 + 侧边栏 + 标签页 + 底部面板） |

**核心特性**：
- **主机与凭据分离管理**：Hosts 和 Credentials 分开，一个身份可复用到多台服务器
- **SFTP 双栏文件传输**：本地到远程上传/下载，拖拽传输
- **命令片段**：保存常用命令，一键发送到当前活动终端
- **AI 助手**：可读取终端最近输出，根据上下文提出建议，生成命令；**任何远程命令执行前都需要用户显式确认**
- **本地优先 + 端到端加密同步**：SQLite 本地存储，可选 GitHub Gist / Google Drive / OneDrive / WebDAV / S3 同步

**与 TDSF 对标价值**：
- ✅ **同栈完整项目参考**：Tauri + React + Rust 的状态管理、SSH 会话管理可参考
- ✅ **AI 命令确认范式**：与 TDSF needs_you 审批对齐
- ✅ **凭据分离管理**：TDSF 可借鉴其 Hosts/Credentials 分离设计
- ⚠️ 需确认 License 是否允许代码结构借鉴

---

## 4. 集成建议

### 4.1 推荐集成路径（维持 v2.0 方案）

```
TDSF_AGENT_BACKEND=strands|pydanticai|langgraph  (三后端 Feature Flag)
                                                  ↓
strands_backend/  +  pydanticai_backend/  +  agents/ (现有 langgraph)
        ↓
StrandsAgentAdapter.invoke(agent_id, input, state)
        ↓
Strands Agent (callback_handler → EventBus → Rust → 前端)
```

### 4.2 分阶段落地

| 阶段 | 内容 | 人日 | 优先级 |
|------|------|------|--------|
| **P0** | 修复 4 处 CRITICAL 断裂（main.py 注入 / set_backend 接口 / requirements.txt / Rust method 名） | 1.0 | 🔴 必须 |
| **P1** | 真实 Strands Agent 集成测试（装 strands-agents，跑通 ssh_command 工具） | 1.0 | 🟠 高 |
| **P2** | 双向 JSON-RPC 扩展（Python→Rust 反向调用，让 RustBridge 真正工作） | 1.5 | 🟠 高 |
| **P3** | MCP 协议引入（作为 sidecar JSON-RPC 标准化补充，非替换） | 2.0 | 🟡 中 |
| **P4** | 参考 NyaTerm/Sageport 优化终端上下文绑定 + 风险审批 UX | 1.0 | 🟡 中 |

### 4.3 对标借鉴建议（新增）

| 借鉴对象 | 借鉴点 | 优先级 |
|----------|--------|--------|
| **NyaTerm** | 终端上下文绑定 AI（选中输出即解释）+ 风险等级标记 | 🟠 高 |
| **Sageport** | Hosts/Credentials 分离管理 + AI 命令确认范式 | 🟡 中 |
| **uniTerm** | AI Native 三共享体系（会话/Shell/工具） | 🟡 中 |
| **OpenWorker** | typed risk engine 4 级分类（强化 `tools/risk.py`） | 🟡 中 |
| **TencentOS MCP Server** | 22 工具分类法（扩展运维工具集） | 🟢 低 |

---

## 5. 风险与对比

### 5.1 技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Strands 依赖 `litellm` 与现有依赖冲突 | 中 | 高 | 虚拟环境隔离测试；备选 PydanticAI |
| MCP 规范 2026-07-28 重大版本不兼容 | 低 | 中 | 关注 MCP 官方迁移指南 |
| Strands 发版频率过高（每周）引入 breaking change | 中 | 中 | 锁定 `strands-agents>=1.48.0,<2.0` |
| `strands_backend/` 骨架 4 处 CRITICAL 未修复 | 高 | 高 | P0 阶段优先修复 |
| NyaTerm/Sageport License 未明确 | 低 | 低 | 调研后归档分析报告，不直接复制代码 |

### 5.2 方案对比

| 方案 | 优势 | 劣势 | 推荐度 |
|------|------|------|--------|
| **Strands** | 生产验证 + MCP 原生 + @tool 对齐 + 流式 | 依赖 litellm + 骨架需修复 | ★★★★★ |
| PydanticAI | 类型安全 + MCP + Human-in-the-loop | API 风格差异大 + 社区小 | ★★★★☆ |
| 维持 LangGraph | 零迁移成本 | 无 MCP 原生 + 无 @tool | ★★★☆☆ |
| 参考 NyaTerm 自研 | 同栈完全对齐 | 重造轮子 + 时间成本高 | ★★☆☆☆ |

---

## 6. 调研方法说明

1. **WebSearch 真实搜索**（不依赖训练知识，知识截止 2025-08，1 年差距通过实时搜索补齐）
2. **多源交叉验证**：PyPI + GitHub + 官方博客 + 技术媒体（EET-China / SegmentFault / V2EX / dev.to）
3. **本地源码审计**：`strands_backend/` 骨架代码逐行审计（详见配套审计报告）
4. **诚实知止**：未运行代码验证，所有结论基于静态分析 + 官方文档；运行验证留待修复 CRITICAL 后执行

---

## 7. 关键结论

1. **Strands Agents v1.48.0 仍是首选**，2026-07 下半月未出现颠覆性新框架。
2. **【新增】Linux SSH 终端 AI Agent 赛道在 2026-07 爆发**，NyaTerm（同栈同方向）+ Sageport（同栈工作台）+ uniTerm（AI Native 方向）是 TDSF 的三个重要对标参考。
3. **集成阻断点明确**：`strands_backend/` 骨架有 4 处 CRITICAL 断裂需在 P0 阶段修复，否则任何后续工作无效。
4. **MCP 协议已成熟**，建议 P3 阶段引入作为 sidecar JSON-RPC 标准化补充。
5. **TDSF 的差异化定位**：Linux 运维教学（而非通用编码）+ 中文界面 + 离线选词翻译 + 方案书写功能，与上述开源项目均不同，需在借鉴中保持自身特色。

---

> **最后更新**：2026-07-30
> **数据来源**：WebSearch + PyPI + GitHub + EET-China + SegmentFault + V2EX + dev.to
> **任务边界**：本文件仅为调研报告，不修改任何源码文件
