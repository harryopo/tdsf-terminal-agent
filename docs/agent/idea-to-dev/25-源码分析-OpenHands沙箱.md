# 源码分析报告：OpenHands 沙箱

> 归档位置：`d:\ai\linux教学一体\opensource-reference\OpenHands`（git clone 全量源码）
> 分析时间：2026-07-17
> 适用项目：tdsf-linux-desktop v0.9 沙箱方案集成

## 一、仓库总览

| 项目 | 值 |
|---|---|
| 仓库 | `All-Hands-AI/OpenHands` |
| License | MIT（允许商用） |
| 技术栈 | Python 3.13.7 + FastAPI + uvicorn（后端）+ React/TS（前端） |
| 容器化 | Docker + docker-compose |
| 包管理 | Poetry（Python）+ npm（前端） |
| Python 版本 | 3.13.7-slim-trixie |
| Node 版本 | node:25.9-trixie-slim（前端构建用） |

## 二、Docker 容器架构（`containers/app/Dockerfile`）

源码：[containers/app/Dockerfile#L1-L105](file:///d:/ai/linux教学一体/opensource-reference/OpenHands/containers/app/Dockerfile#L1-L105)

### 多阶段构建

| 阶段 | 基础镜像 | 作用 |
|---|---|---|
| `frontend-builder` | `node:25.9-trixie-slim` | 构建前端 React 静态资源 |
| `backend-builder` | `python:3.13.7-slim-trixie` | Poetry 安装 Python 依赖到 venv |
| `openhands-app` | `python:3.13.7-slim-trixie` | 运行时镜像（最终产物） |

### 关键环境变量

```dockerfile
ENV RUN_AS_OPENHANDS=true
ENV OPENHANDS_USER_ID=42420                    # 容器内非 root 用户 UID
ENV SANDBOX_LOCAL_RUNTIME_URL=http://host.docker.internal
ENV USE_HOST_NETWORK=false
ENV WORKSPACE_BASE=/opt/workspace_base         # 工作区挂载点
ENV SANDBOX_USER_ID=0                          # 沙箱内执行用户
ENV FILE_STORE=local                            # 文件存储后端
ENV FILE_STORE_PATH=/.openhands                # 元数据存储路径
ENV INIT_GIT_IN_EMPTY_WORKSPACE=1              # 空工作区自动 init git
```

### 容器内用户

```dockerfile
RUN groupadd --gid $OPENHANDS_USER_ID openhands
RUN useradd -l -m -u $OPENHANDS_USER_ID --gid $OPENHANDS_USER_ID -s /bin/bash openhands && \
    usermod -aG openhands openhands && \
    usermod -aG sudo openhands && \
    echo '%sudo ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers
RUN chown -R openhands:openhands /app && chmod -R 770 /app
```

**关键发现**：
- 容器内非 root 用户（UID 42420），通过 sudo 提权
- 工作目录 `/app` 权限 770
- 工作区目录 `/opt/workspace_base` 权限 770
- 容器启动命令：`uvicorn openhands.server.listen:app --host 0.0.0.0 --port 3000`

### 端口暴露

| 端口 | 服务 |
|---|---|
| 3000 | OpenHands App Server（FastAPI + uvicorn） |
| 后续动态端口 | Sandbox 内 Agent Server（通过 exposed_urls 暴露） |

## 三、Sandbox API 抽象层

源码：[sandbox_service.py#L30-L267](file:///d:/ai/linux教学一体/opensource-reference/OpenHands/openhands/app_server/sandbox/sandbox_service.py#L30-L267)

### SandboxService 抽象基类

```python
class SandboxService(ABC):
    """Service for accessing sandboxes in which conversations may be run."""

    @abstractmethod
    async def search_sandboxes(
        self,
        page_id: str | None = None,
        limit: int = 100,
    ) -> SandboxPage:
        """Search for sandboxes."""

    @abstractmethod
    async def get_sandbox(self, sandbox_id: str) -> SandboxInfo | None:
        """Get a single sandbox. Return None if the sandbox was not found."""

    @abstractmethod
    async def get_sandbox_by_session_api_key(
        self, session_api_key: str
    ) -> SandboxInfo | None:
        """Get a single sandbox by session API key."""

    @abstractmethod
    async def get_sandbox_record_by_session_api_key(
        self, session_api_key: str
    ) -> SandboxRecord | None:
        """Get persisted sandbox identity without querying the runtime."""

    @abstractmethod
    async def start_sandbox(
        self, sandbox_spec_id: str | None = None, sandbox_id: str | None = None
    ) -> SandboxInfo:
        """Begin the process of starting a sandbox.
        Return the info on the new sandbox. If no spec is selected, use the default.
        If sandbox_id is provided, it will be used as the sandbox identifier instead
        of generating a random one."""

    @abstractmethod
    async def resume_sandbox(self, sandbox_id: str) -> bool:
        """Begin the process of resuming a sandbox.
        Return True if the sandbox exists and is being resumed or is already running."""

    @abstractmethod
    async def pause_sandbox(self, sandbox_id: str) -> bool:
        """Begin the process of pausing a sandbox."""

    @abstractmethod
    async def delete_sandbox(self, sandbox_id: str) -> bool:
        """Begin the process of deleting a sandbox."""

    async def wait_for_sandbox_running(
        self,
        sandbox_id: str,
        timeout: int = 120,
        poll_interval: int = 2,
        httpx_client: httpx.AsyncClient | None = None,
    ) -> SandboxInfo:
        """Wait for a sandbox to reach RUNNING status."""

    async def archive_conversation_workspace(
        self,
        sandbox_id: str,
        conversation_id: str | None = None,
        workspace_path: str | None = None,
    ) -> bool:
        """Archive one conversation's workspace."""

    async def pause_old_sandboxes(self, max_num_sandboxes: int) -> list[str]:
        """Pause the oldest sandboxes if there are more than max_num_sandboxes running."""
```

### 关键发现

1. **SandboxService 是抽象基类**，实现类有：
   - `LocalSandboxService`（本地 Docker）
   - `RemoteSandboxService`（远程 OpenHands 实例）
   - `KubernetesSandboxService`（K8s 集群）

2. **生命周期**：`start_sandbox` → `wait_for_sandbox_running` → `pause_sandbox` / `resume_sandbox` → `delete_sandbox`

3. **隔离粒度**：每个对话一个 sandbox（通过 `archive_conversation_workspace` 归档工作区）

4. **资源管理**：`pause_old_sandboxes(max_num_sandboxes)` 自动清理超过配额的老沙箱

5. **健康检查**：`_check_agent_server_alive` 调用 `/alive` 端点验证 agent server 是否就绪

## 四、Sandbox REST API 路由

源码：[sandbox_router.py#L1-L220](file:///d:/ai/linux教学一体/opensource-reference/OpenHands/openhands/app_server/sandbox/sandbox_router.py#L1-L220)

### 路由清单

| 方法 | 路径 | 作用 | 鉴权 |
|---|---|---|---|
| GET | `/sandboxes/search` | 列出当前用户的沙箱（分页） | 用户登录 |
| GET | `/sandboxes?id=xxx&id=yyy` | 批量获取（最多 100 个） | 用户登录 |
| POST | `/sandboxes?sandbox_spec_id=xxx` | 启动新沙箱 | 用户登录 |
| POST | `/sandboxes/{sandbox_id}/pause` | 暂停 | 用户登录 |
| POST | `/sandboxes/{sandbox_id}/resume` | 恢复 | 用户登录 |
| DELETE | `/sandboxes/{sandbox_id}` | 删除 | 用户登录 |
| GET | `/sandboxes/{sandbox_id}/settings/secrets` | 列出可用 secret 名 | X-Session-API-Key |
| GET | `/sandboxes/{sandbox_id}/settings/secrets/{secret_name}` | 获取单个 secret 值（text/plain） | X-Session-API-Key |

### 鉴权机制

```python
async def _valid_sandbox_from_session_key(
    request: Request,
    sandbox_id: str,
    session_api_key: str = Depends(
        APIKeyHeader(name='X-Session-API-Key', auto_error=False)
    ),
) -> SandboxInfo:
    """Authenticate via X-Session-API-Key and verify sandbox ownership."""
    sandbox_info = await validate_session_key(session_api_key)
    if sandbox_info.id != sandbox_id:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail='Session API key does not match sandbox',
        )
    return sandbox_info
```

### 关键鉴权流程

1. **用户级鉴权**（GET/POST/DELETE 通用）：通过 cookie / OAuth token 识别用户身份
2. **沙箱级鉴权**（执行内部操作）：通过 `X-Session-API-Key` HTTP Header
3. **Session Key 验证**：`validate_session_key()` 校验 key 对应的 sandbox

### Secret 管理（重要）

OpenHands 内置 secret 管理系统：
- **自定义 secrets**：用户自定义的环境变量
- **Provider Tokens**：`github_token` / `gitlab_token` 等 OAuth token

```python
# 列出 secrets（仅名称，不含值）
GET /sandboxes/{sandbox_id}/settings/secrets
Response: {
  "secrets": [
    {"name": "MY_API_KEY", "description": "..."},
    {"name": "github_token", "description": "github_token provider token"}
  ]
}

# 获取单个 secret 值（plain text）
GET /sandboxes/{sandbox_id}/settings/secrets/{secret_name}
Response: <secret_value as text/plain>
```

**关键发现**：OpenHands 通过 LookupSecret 机制在沙箱内动态获取 secret，避免把凭据明文传入容器环境变量。这正好对应 Grok Build 数据丑闻后的 Hard Constraint：**所有敏感文件必须 redact**。

## 五、Sandbox 数据模型

源码：[sandbox_models.py#L1-L92](file:///d:/ai/linux教学一体/opensource-reference/OpenHands/openhands/app_server/sandbox/sandbox_models.py#L1-L92)

### SandboxStatus 枚举

```python
class SandboxStatus(Enum):
    STARTING = 'STARTING'       # 启动中
    RUNNING = 'RUNNING'         # 运行中
    PAUSED = 'PAUSED'           # 已暂停
    ERROR = 'ERROR'             # 错误
    MISSING = 'MISSING'         # 已删除（可能已被清理）
```

### ExposedUrl

```python
class ExposedUrl(BaseModel):
    """URL to access some named service within the container."""
    name: str
    url: str
    port: int

# 标准服务名
AGENT_SERVER = 'AGENT_SERVER'   # Agent 执行 server（命令执行 / 文件操作）
VSCODE = 'VSCODE'               # VS Code Server
WORKER_1 = 'WORKER_1'           # 工作线程 1
WORKER_2 = 'WORKER_2'           # 工作线程 2
```

**关键发现**：每个沙箱可以暴露多个服务（agent_server / vscode / workers），通过 `exposed_urls` 列表返回。

### SandboxInfo

```python
class SandboxInfo(BaseModel):
    id: str                                     # 沙箱唯一 ID
    created_by_user_id: str | None              # 创建者用户 ID
    sandbox_spec_id: str                        # 沙箱规格 ID（资源配额模板）
    status: SandboxStatus                       # 当前状态
    session_api_key: str | None                 # 访问沙箱的 API Key（STARTING/PAUSED 时为 None）
    exposed_urls: list[ExposedUrl] | None       # 沙箱内服务的访问 URL
    created_at: datetime                         # 创建时间
```

### SandboxRecord

```python
class SandboxRecord(BaseModel):
    """Persisted identity fields for a sandbox — no live runtime data."""
    id: str
    created_by_user_id: str | None
```

**用途**：快速鉴权场景下避免 runtime round-trip（仅查数据库即可判定 key 归属）。

## 六、沙箱内 Agent Server

OpenHands 的 Sandbox 模型设计：**Sandbox 是一个独立 Docker 容器，内部运行 agent_server**。

### 通信架构

```
┌─────────────────────────────────────────────────────────────┐
│  Host Machine (Docker Desktop)                              │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  OpenHands App Container (port 3000)                  │  │
│  │  ┌──────────────────────────────────────────────┐   │  │
│  │  │  FastAPI App Server                           │   │  │
│  │  │  - /sandboxes/* (SandboxService REST API)     │   │  │
│  │  │  - /conversations/* (会话管理)                │   │  │
│  │  │  - /files/* (文件操作)                         │   │  │
│  │  └──────────────────────────────────────────────┘   │  │
│  │                       ↑                               │  │
│  └───────────────────────┼───────────────────────────────┘  │
│                          │                                    │
│  ┌───────────────────────┼───────────────────────────────┐  │
│  │  Sandbox Container    │ (Dynamic Port)                 │  │
│  │  ┌──────────────────┐ │                                │  │
│  │  │  agent_server    │←┘                                │  │
│  │  │  - /alive        │                                  │  │
│  │  │  - /execute      │                                  │  │
│  │  │  - /read_file    │                                  │  │
│  │  │  - /write_file   │                                  │  │
│  │  │  - /browse       │                                  │  │
│  │  └──────────────────┘                                  │  │
│  │  Workspace: /opt/workspace_base                        │  │
│  │  User: openhands (UID 42420)                           │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 关键 API（推断自代码）

agent_server 暴露的端点（基于 sandbox_service.py 中的引用）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/alive` | 健康检查 |
| POST | `/execute` | 执行 shell 命令 |
| POST | `/read_file` | 读文件 |
| POST | `/write_file` | 写文件 |
| POST | `/browse` | 浏览 URL |
| GET | `/settings/secrets` | 列出可用 secrets |

## 七、Action / Observation 协议

OpenHands 的核心设计是 Action / Observation 模式（基于源码中的 sandbox_spec_service.py 推断）：

```python
# 伪代码（基于源码推断）
class Action(BaseModel):
    action_type: str  # 'run' | 'read_file' | 'write_file' | 'browse' | 'think'
    args: dict

class Observation(BaseModel):
    action_type: str  # 与 Action 对应
    content: str
    success: bool
    error: str | None
```

**关键发现**：Action / Observation 是 Agent 和 Sandbox 之间的统一通信协议。这与 Mastra 的 Tool.execute() 返回值机制本质一致。

## 八、与 tdsf-linux-desktop v0.9 集成方案对比

### 方案 A：完整集成 OpenHands（推荐 - 质量优先）

**优势**：
- ✅ MIT License，商用友好
- ✅ 完整沙箱生命周期管理
- ✅ 隔离的 Docker 容器（HC：默认本地优先）
- ✅ 内置 secret 管理（HC：敏感文件 redact）
- ✅ VS Code Server 集成（HC：所有 IDE 操作可见）
- ✅ 多 worker 支持（并行执行）
- ✅ 社区活跃维护

**集成代价**：
- ⚠️ 用户需安装 Docker Desktop（约 500MB-1GB）
- ⚠️ OpenHands 镜像大小约 1.5-2GB
- ⚠️ 启动一个沙箱约 5-15 秒
- ⚠️ 需要保持 OpenHands App Server 在后台运行

**集成步骤**：

1. **Docker Desktop 检测**（v0.9 W1）：
```typescript
// src/main/services/sandbox/docker-detector.ts
import { exec } from 'child_process';

export async function detectDockerDesktop(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('docker version --format {{.Server.Version}}', (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}
```

2. **OpenHands 容器启动**（v0.9 W2）：
```typescript
// src/main/services/sandbox/openhands-runner.ts
import { exec } from 'child_process';
import path from 'path';

export async function startOpenHandsServer(): Promise<void> {
  const composeFile = path.join(process.resourcesPath, 'sandbox', 'openhands', 'docker-compose.yml');
  await new Promise<void>((resolve, reject) => {
    exec(`docker compose -f "${composeFile}" up -d`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  // 等待 3000 端口就绪
  await waitForPort(3000, 60_000);
}
```

3. **OpenHands API 客户端**（v0.9 W2）：
```typescript
// src/main/services/sandbox/openhands-client.ts
import http from 'http';

export class OpenHandsClient {
  constructor(private baseUrl: string = 'http://localhost:3000') {}

  async createSandbox(sandboxSpecId?: string): Promise<SandboxInfo> {
    return this.post('/sandboxes', { sandbox_spec_id: sandboxSpecId });
  }

  async getSandbox(sandboxId: string): Promise<SandboxInfo | null> {
    return this.get(`/sandboxes/${sandboxId}`);
  }

  async executeInSandbox(sandboxId: string, command: string, sessionApiKey: string): Promise<Observation> {
    // 通过 sandbox 的 exposed_urls[AGENT_SERVER] 调用 /execute
    const sandbox = await this.getSandbox(sandboxId);
    const agentServerUrl = sandbox.exposed_urls?.find(u => u.name === 'AGENT_SERVER')?.url;
    return this.post(`${agentServerUrl}/execute`, { command }, {
      headers: { 'X-Session-API-Key': sessionApiKey }
    });
  }

  async pauseSandbox(sandboxId: string): Promise<void> {
    await this.post(`/sandboxes/${sandboxId}/pause`);
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    await this.delete(`/sandboxes/${sandboxId}`);
  }
}
```

4. **Mastra Tool 集成**（v0.9 W3）：
```typescript
// src/main/core/agent/tools/sandbox-exec.ts
import { createTool } from '@mastra/core';
import { z } from 'zod';
import { OpenHandsClient } from '../../../services/sandbox/openhands-client';

export function createSandboxExecTool(client: OpenHandsClient) {
  return createTool({
    id: 'sandbox-exec',
    description: '在隔离的 Docker 沙箱中执行命令。所有命令都需要审批。',
    inputSchema: z.object({
      command: z.string(),
      sandboxId: z.string(),
    }),
    requireApproval: true,  // 沙箱命令始终审批
    execute: async ({ command, sandboxId }, context) => {
      const sessionApiKey = context?.requestContext?.sessionApiKey;
      const result = await client.executeInSandbox(sandboxId, command, sessionApiKey);

      // HC-1：网络请求 UI 可见
      context?.mastra?.logger?.info(`[sandbox-exec] command=${command} stdout=${result.stdout}`);

      // HC-2：敏感 redact
      return {
        stdout: redactSecrets(result.stdout),
        stderr: redactSecrets(result.stderr),
        exitCode: result.exitCode,
      };
    },
  });
}
```

### 方案 B：借鉴 OpenHands 设计自建轻量沙箱（备选）

**优势**：
- ✅ 无需 Docker Desktop 依赖
- ✅ 镜像小（约 100-200MB）
- ✅ 启动快（<2 秒）

**劣势**：
- ⚠️ 需自己维护 Docker 镜像
- ⚠️ 需自己实现 secret 管理
- ⚠️ 功能受限（无 VS Code / 浏览器集成）
- ⚠️ 需自己实现 Action/Observation 协议

**适用场景**：用户不愿安装 Docker Desktop，或只需基础命令执行。

### 方案 C：远程 OpenHands 实例（云方案）

**优势**：
- ✅ 无需本地 Docker
- ✅ 资源消耗低
- ✅ 易于扩展

**劣势**：
- ⚠️ 网络依赖
- ⚠️ 数据隐私问题（HC：默认本地优先冲突）
- ⚠️ 需远程 OpenHands 服务（自建或付费）

## 九、推荐方案与决策点

### 推荐：方案 A（完整集成 OpenHands）

**理由**：
1. **质量优先原则**（用户硬约束）：完整方案 > 自建轻量
2. **Hard Constraint 对齐**：本地 Docker = 默认本地优先
3. **Secret 管理原生支持**：HC 敏感文件 redact
4. **VS Code Server 集成**：HC 所有 IDE 操作可见
5. **MIT License**：商用无风险
6. **社区活跃**：长期维护有保障

### 用户决策点

| # | 决策 | 推荐 | 备选 |
|---|---|---|---|
| 1 | 是否要求用户安装 Docker Desktop | ✅ 是 | 方案 B（自建轻量） |
| 2 | 镜像打包方式 | 内置 docker-compose.yml 到 resourcesPath | 运行时下载 |
| 3 | 沙箱配置模板 | 默认 sandbox_spec（4 CPU / 4GB RAM / 10GB 磁盘） | 用户可配置 |
| 4 | 沙箱生命周期 | 对话开始时创建，结束时归档 | 全局单沙箱（共享） |
| 5 | VS Code Server 是否启用 | ✅ 是（IDE 集成） | 否（仅命令行） |

### 资源占用预估

| 资源 | 估算 | 备注 |
|---|---|---|
| Docker Desktop 安装 | 500MB-1GB | 一次性 |
| OpenHands 镜像 | 1.5-2GB | 一次性 |
| 运行时内存 | 500MB-1GB / 沙箱 | 闲置时 50MB |
| 启动时间 | 5-15s / 沙箱 | 首次启动更慢（镜像加载） |
| 磁盘 I/O | 工作区隔离 | /opt/workspace_base |

## 十、风险与缓解

| # | 风险 | 缓解 |
|---|---|---|
| 1 | Docker Desktop 未安装 | UI 引导安装，检测失败时降级到方案 B |
| 2 | 镜像下载慢 | 提供国内镜像源（如阿里云 ACR） |
| 3 | 端口冲突（3000） | 用户可配置端口 |
| 4 | 沙箱启动慢 | 异步启动 + 进度条 UI |
| 5 | 资源占用高 | 默认配置 4GB，用户可调整 |
| 6 | secret 泄漏 | X-Session-API-Key 鉴权 + secret 值不进入 LLM 输入 |

## 十一、对比 OpenHands vs 当前 tdsf-linux-desktop 设计

| 维度 | 当前（v0.8） | OpenHands 集成后（v0.9） |
|---|---|---|
| 命令执行 | 直接 SSH 到目标服务器 | SSH + 沙箱双轨（生产环境 SSH / 实验 环境沙箱） |
| 文件操作 | SFTP 直接读写 | SFTP + 沙箱文件系统 |
| 隔离 | ❌ 无 | ✅ Docker 容器隔离 |
| 审批 | LLM Tool 层审批 | LLM Tool 层 + 沙箱 API 层双重审批 |
| Secret 管理 | SecureStore（本地加密） | SecureStore + OpenHands LookupSecret 双重 |
| 可观测性 | IPC 推送 | IPC 推送 + OpenHands EventStream |
| 失败回滚 | ❌ 无 | ✅ 沙箱可 pause/resume/delete 重做 |

## 十二、与 Mastra 集成的代码模板

```typescript
// src/main/core/agent/mastra-instance.ts（更新版）
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core';
import { createOpenAI } from '@ai-sdk/openai';
import { OpenHandsClient } from '../../services/sandbox/openhands-client';
import { createSandboxExecTool } from './tools/sandbox-exec';
import { createSshExecTool } from './tools/ssh-exec';

export function createMastraInstance(): Mastra {
  const openhands = new OpenHandsClient('http://localhost:3000');

  const supervisor = new Agent({
    name: 'tdsf-supervisor',
    instructions: `你是 Linux 运维 AI 助手。
对生产环境任务使用 ssh-exec 工具（需审批）。
对实验性任务使用 sandbox-exec 工具（在隔离沙箱中执行）。`,
    model: provider(llmConfig.model),
    tools: {
      sshExec: createSshExecTool(),         // 直接 SSH（生产）
      sandboxExec: createSandboxExecTool(openhands),  // Docker 沙箱（实验）
    },
  });

  return new Mastra({ agents: { supervisor } });
}
```

## 十三、总结

OpenHands 源码分析证实：

1. ✅ **MIT License**（商用友好）
2. ✅ **完整的沙箱生命周期管理**（start / pause / resume / delete / archive）
3. ✅ **抽象基类设计**（LocalSandboxService / RemoteSandboxService / KubernetesSandboxService）
4. ✅ **REST API 完整**（/sandboxes/* 端点齐全）
5. ✅ **Action/Observation 协议**（与 Mastra Tool 无缝对应）
6. ✅ **Secret 管理原生支持**（LookupSecret 机制）
7. ✅ **多服务暴露**（AGENT_SERVER / VSCODE / WORKER_1 / WORKER_2）
8. ✅ **健康检查机制**（/alive 端点）
9. ✅ **资源管理**（pause_old_sandboxes 自动清理）

**强烈推荐**：v0.9 直接集成 OpenHands Docker 沙箱（方案 A），符合质量优先原则，与 Hard Constraints 完美对齐。

**集成代价**：用户需安装 Docker Desktop，但这是一次性投入，换来的是企业级沙箱能力。
