---
source: docker-docs
category: services
url: consolidated/services/容器运行时（Docker）.md
title: 容器运行时（Docker）
---

- 镜像只读模板，容器为运行实例；registry 存镜像。
- Dockerfile：`FROM`、`RUN`、`COPY`、`CMD`；构建 `docker build -t <tag> .`
- 运行：`docker run -d -p 8080:80 -v $PWD:/app <image>`；`-v` 持久化数据。
- 多阶段构建减小体积；镜像层顺序影响缓存，`--no-cache` 跳过。
- 多容器用 Compose：`docker compose up -d`；端口映射、tag 需明确。
- 易错：容器退出后数据丢失，镜像不可变，GPU 直通需额外配置。

- **核心概念**：AI 治理审计日志记录组织级 Docker AI 治理活动，每条记录含主体（principal）、动作、目标、决策、时间；仅元数据，不含提示词内容、智能体输出或参数值。

- **启用条件**（需同时满足）：
  - AI Governance 付费订阅（需单独购买）
  - Docker Sandboxes ≥ 0.39.0
  - 组织启用 AI Governance
  - 已登录用户持有 AI Governance 许可证，且受强制中央组织策略约束；否则不产生审计数据
  - 个人账户不支持

- **权限要求**：组织所有者或拥有自定义角色（含 AI Governance 审计权限）的用户可配置投递与查看事件。

- **覆盖范围**：Docker Sandboxes 策略决策和沙箱会话事件；其他 Docker AI 源可能复用同一 schema。

- **交付模式**：
  - **本地磁盘**：沙箱守护进程以 JSON Lines（`.jsonl`）写入各主机，适合本地留存、气隙环境或自有日志采集器
  - **Docker Cloud**：事件存储于 Docker Cloud，支持托管审计日志视图、CSV 导出、SIEM 流式转发；启用 AI Governance 时默认开启，组织所有者可在审计投递设置中关闭
  - 两者可同时配置；托管视图、CSV 导出、SIEM 转发均**必须依赖 Docker Cloud 投递**，仅本地模式不提供这些能力

- **易错点**：
  - 旧组织若在托管审计日志出现前仅用本地日志，云投递默认关闭，需所有者手动 opt-in
  - 其他 Docker 订阅不足以使用 AI Governance 审计日志，无许可证且无强制策略的用户不会出现在审计事件或 SIEM 输出中

- **数据保留**：启用 Docker Cloud 投递后，按组织配置的保留窗口存储于 Docker Cloud；相关法律条款见 Docker 服务条款与隐私政策。

- **延伸文档**：本地日志、投递配置、查看/导出事件、SIEM 转发、审计记录参考。

- Angular 生产级容器化（多阶段：Node 构建 + Nginx 托管；镜像 dhi.io，tag 用最新安全版本）：

```
FROM dhi.io/node:24-alpine3.22-dev AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

FROM dhi.io/nginx:1.28.0-alpine3.21-dev AS runner
COPY nginx.conf /etc/nginx/nginx.conf
COPY --chown=nginx:nginx --from=builder /app/dist/*/browser /usr/share/nginx/html
USER nginx
EXPOSE 8080
ENTRYPOINT ["nginx", "-c", "/etc/nginx/nginx.conf"]
CMD ["-g", "daemon off;"]
```

- 易错点：输出路径 `/app/dist/*/browser`；`npm ci` 而非 install；先复制 `package.json` 用层缓存；nginx 端口须 8080。

- **Dockerfile 多阶段构建**：builder 用 `FROM node:${NODE_VERSION} AS builder`，核心命令 `RUN --mount=type=cache,target=/root/.npm npm ci` 和 `RUN npm run build`；runner 用 `FROM nginxinc/nginx-unprivileged:${NGINX_VERSION} AS runner`，`COPY --from=builder /app/dist/*/browser /usr/share/nginx/html`，`USER nginx`，`EXPOSE 8080`，启动 `ENTRYPOINT ["nginx", "-c", "/etc/nginx/nginx.conf"]`、`CMD ["-g", "daemon off;"]`。`npm ci` 可复现安装；`--mount=type=cache` 加速缓存；非 root 运行降低攻击面。  
- **compose.yaml**：`services.server.build.context: .`，端口 `ports: ["8080:8080"]`。  
- **.dockerignore**：排除 `node_modules`、`dist`、`coverage`、`*.env*`（保留 `!.env.production`）、`.git`、`Dockerfile*`，避免敏感文件进镜像。  
- **nginx.conf**：非 root 容器需 `pid /tmp/nginx.pid;`；另配 `worker_processes auto;`、`worker_connections 1024;`、`include /etc/nginx/mime.types;`。  
- **构建/推送**：登录 Docker Hub → 建仓库 → 构建 → 推送。镜像是包含应用、配置、依赖的标准包；可信基础镜像选 Official Images 或 Hardened Images（近零 CVE、最小化）。

- **镜像**：打包应用及运行环境（如 Node、代码）的单一包，任何机器可运行。
- **Dockerfile**：基于文本的构建脚本，定义如何构建镜像。
- **镜像命名（Tagging）**：格式 `<DOCKER_USERNAME>/<repository>:<tag>`，`tag` 默认为 `latest`；名称决定可分发位置。

## 关键命令
```bash
# 登录（也可用 Docker Dashboard 登录）
docker login

# 构建镜像（最后一个 . 是构建上下文路径）
docker build -t <DOCKER_USERNAME>/getting-started-todo-app .

# 查看本地镜像
docker image ls

# 推送镜像到 Docker Hub（需先创建仓库）
docker push <DOCKER_USERNAME>/getting-started-todo-app
```

## 发布流程
1. 在 [Docker Hub](https://hub.docker.com) 创建仓库，填写仓库名、可见性（Public/Private）。
2. 克隆项目并进入目录：
   ```bash
   git clone https://github.com/docker/getting-started-todo-app
   cd getting-started-todo-app
   ```
3. 构建镜像，用 Docker 用户名替换 `DOCKER_USERNAME`。
4. 本地验证后推送。

## 易错点
- 推送前必须登录 Docker Hub；镜像名需带用户名前缀。
- 构建基础镜像已包含 Node 环境，无需手动安装配置。
- 构建上下文`.`不能省略；有其他文件时确保路径正确。
- Docker Hub 是默认 registry；其他 registry 通过 OCI 标准互操作，可私有部署。

- `docker build .` 可不指定镜像名，构建后仅输出镜像 ID（`sha256:...`），可用该 ID 直接 `docker run`。
- 镜像命名结构：
  ```
  [HOST[:PORT_NUMBER]/]PATH[:TAG]
  ```
  - `HOST`：镜像仓库主机名，省略时为 `docker.io`。
  - `PORT_NUMBER`：仓库端口，配合主机名使用。
  - `PATH`：镜像路径，Docker Hub 格式为 `[NAMESPACE/]REPOSITORY`；命名空间省略时为 `library`（官方镜像）。
  - `TAG`：版本/变体标识，省略时为 `latest`。

示例：
- `nginx` = `docker.io/library/nginx:latest`
- `docker/welcome-to-docker` = `docker.io/docker/welcome-to-docker:latest`
- `ghcr.io/dockersamples/example-voting-app-vote:pr-311`

- 构建时打标签：
  ```bash
  docker build -t my-username/my-image .
  ```
- 已有镜像补加标签：
  ```bash
  docker image tag my-username/my-image another-username/another-image:v1
  ```
- 推送镜像到仓库前需认证：
  ```bash
  docker login
  docker push my-username/my-image
  ```

- 常用查看命令：
  ```bash
  docker image ls          # 列出本地镜像
  docker image history <镜像名>   # 查看镜像构建历史
  ```

## 构建镜像

- 核心模块：理解镜像层、编写 Dockerfile、构建/打标签/推送、构建缓存、多阶段构建
- 镜像层机制：Dockerfile 每条指令生成一层；`docker image history` 可查看各层记录，`<missing>` 表示继承自基础镜像的层，当前构建新增的层会显示具体指令
- 推送镜像至 registry：
```bash
docker push <YOUR_DOCKER_USERNAME>/concepts-build-image-demo
```
- 易错点：报错 `requested access to the resource is denied` 时，检查是否已登录且镜像标签中的 Docker 用户名是否正确

## Bun 语言指南

- Bun 是轻量级 JavaScript 运行时，为 Node.js 替代品；用 Docker 可统一管理多运行时依赖，解决 Bun 开发环境一致性问题
- 拉取示例应用：
```bash
git clone https://github.com/dockersamples/bun-docker.git && cd bun-docker
```
- 示例目录包含：`Dockerfile`、`compose.yml`、`server.js`、`README.md`
- 前置要求：了解 Docker 容器、镜像、Dockerfile 基本概念

- 基础镜像选择：Bun 官方镜像 或 Docker Hardened Image (DHI)
- DHI 优势：生产就绪、轻量、安全；从 `dhi.io` 仓库拉取
- 登录 DHI 仓库：
  `docker login dhi.io`
- 拉取 Bun DHI（tag `1` 指最新 1.x 版）：
  `docker pull dhi.io/bun:1`

## Bun Docker 容器化

```dockerfile
FROM oven/bun
WORKDIR /app
COPY . /app
EXPOSE 3000
CMD ["bun", "server.js"]
```
- 启动：`docker compose up --build`（后台 `-d`，停止 `down`）
- 热更新：`compose.yml` 加 `develop.watch`，`docker compose watch` 启动

## Claude Code 沙箱

- 启动：`sbx run claude ~/my-project`
- 传提示词：`sbx run claude -- "prompt"` 或 `-- "$(cat prompt.txt)"`
- 认证：`sbx secret set anthropic`；无 key 时沙箱内 `/login`
- 默认命令：`claude --dangerously-skip-permissions`；`--` 后裸词替换默认命令，flag 追加
- agents：`sbx run --clone claude -- agents`；需授权加 `-- --dangerously-skip-permissions agents`

# 使用本地模型（Claude Code）
- 实验特性，**不支持 Windows**。
- 启用：
  ```
  $ sbx settings set platform.allowExperimentalFeatures true
  $ sbx settings set feature.model true
  ```
- 使用捆绑 `llmman` 服务器：
  ```
  $ sbx run --model gemma4 claude
  ```
- 改用已有 Ollama（需已运行，`sbx` 不管理其进程）：
  ```
  $ sbx run --model gemma4 --provider ollama claude
  ```
- 更换沙箱模型：`sbx run --name <sandbox-name> --model <model-name>`
  - 重建容器，workspace 与 kit-owned 卷保留。

# 容器开发（Docker）
```
$ git clone https://github.com/docker/getting-started-todo-app
$ cd getting-started-todo-app
$ docker compose watch
```
- 宿主机无需装 Node/MySQL（只需 Docker Desktop 和编辑器）。
- 保存文件自动同步至容器并热重载。

## 容器化开发与 Docker Desktop 要点

**开发模型**
- 容器内进程监听文件变化并响应；本地项目目录与容器环境共享，本地编辑自动同步至容器
- Docker Desktop 可创建几乎任意环境并共享给团队
- 下一步：将应用打包为容器镜像并推送至 registry（Docker Hub）

**发行说明通用规则**
- 新版本逐步灰度发布，约一周内全量可用
- 距最新版超过 6 个月的旧版本不再提供下载

**v4.88.1**（2026-08-25）
- 修复：未认证用户打开 Dashboard 被误重定向至登录页

**v4.88.0**（2026-08-24）
- 组件更新：
  - Docker Agent v1.124.0
  - Docker Model Runner v1.2.8
  - containerd v2.3.3
  - Runc v1.4.3
- 关键修复：
  - `~/.docker/daemon.json` 被写坏（null 字节，常见于保存配置时崩溃/断电）导致无法启动；现自动恢复默认 daemon 配置
  - `docker ps` 端口绑定在 Localhost by default/only 模式下准确反映监听器，并新增 `[::1]` 回环监听
  - Resource saver 模式下修改 hypervisor 类型不再无效
  - 修复 Docker VMM 容器入站网络吞吐回归（约 0.3GB/s）
  - `enable fsverity failed` 不再作为崩溃原因，改为显示真实错误
- Mac：Docker VMM 支持超过 28GiB 主机内存
- Windows：修复 CLI 插件目录已存在自更新插件（如 `docker scout`/`docker agent`）时自动更新失败的问题

- **Docker Verified Publisher（DVP）**：面向在 Docker Hub 发布内容的商业发布者的付费组织计划，在已验证发布者身份基础上提供分析报告。
- **DVP Starter**：包含徽章、搜索排名提升、Docker Scout 漏洞扫描、周/月摘要报告。
- **DVP Growth**：含 Starter 全部功能，另加趋势、域级报告、基准报告，默认含 25 个消费域（consuming domains）。
- **消费域**：指拉取你镜像的独立公司域；Growth 可通过账单门户按 25 个增量增购。
- **适用条件**：需组织（organization）身份，每个组织命名空间（namespace）需单独申请；仅持有 Personal/Pro 账户可先创建组织再申请。
- **必须提前申请**，批准后才能订阅；Docker 批准后会邮件发送结账链接，完成支付才计费。

申请流程：
1. 前往 DVP 落地页，选择 **Apply for DVP** 并登录。
2. 选择已有组织命名空间，或新建组织。
3. 填写要发布的内容，选择 DVP Starter 或 Growth。
4. 提交申请等待审核。
5. 收到批准邮件后打开结账链接，选择计划、核对账单并支付。

- **DVP 计划计费**
  - 添加消费域名：Docker Home → **Billing** → Active plans → DVP → **Manage** → **Add consuming domains** → 选数量 → 确认支付。
  - 计费：Starter/Growth 均年付；Starter 可即时升级至 Growth，无需重申请。附加组件按剩余周期比例计费，随年度订阅到期；可减少数量，下周期生效。**无期中退款**。
  - 终止：禁用自动续费，计划持续至周期结束；可选移除消费域名。

- **编辑器与应用集成**
  - 通过 SSH 将外部编辑器（VS Code、Cursor、Claude Desktop 等）连至沙箱，代码在隔离沙箱执行。沙箱地址：`<name>.sbx`。
  - 前置条件：已登录 `sbx` CLI；SSH 客户端（Windows 需 OpenSSH）；编辑器支持远程 SSH。
  - 命令：
    ```bash
    sbx setup ssh                      # 启用 SSH 访问
    sbx create --name demo shell .     # 创建沙箱
    sbx ls                             # 列出沙箱
    ssh demo.sbx                       # 连接
    ```
  - 易错点：
    - 连接后需手动选择工作区（不自动打开挂载目录）。
    - 工作区保留宿主机绝对路径（如 `/Users/bob/src/my-project`），默认主目录 `/home/agent`。
    - SSH 配置：`~/.ssh/config`（macOS/Linux）或 `%USERPROFILE%\.ssh\config`（Windows）。

- `Host *.sbx:sbx ssh proxy %n;IdentityAgent none;KnownHostsCommand sbx ssh known-hosts %H;StrictHostKeyChecking yes`

### 多阶段构建核心概念

- **构建阶段**：使用含编译工具的基础镜像，安装工具、复制源码、执行构建命令。
- **最终阶段**：使用更小的基础镜像，`COPY --from` 复制构建产物（如 JAR），并用 `CMD`/`ENTRYPOINT` 定义运行时配置。

### 示例：Spring Boot + Maven 单阶段 Dockerfile

```dockerfile
FROM eclipse-temurin:21.0.8_9-jdk-jammy
WORKDIR /app
COPY .mvn/ .mvn
COPY mvnw pom.xml ./
RUN ./mvnw dependency:go-offline
COPY src ./src
CMD ["./mvnw", "spring-boot:run"]
```

### 构建与运行

```bash
$ docker build -t spring-helloworld .
$ docker images          # 镜像达 880MB
$ docker run -p 8080:8080 spring-helloworld
$ curl localhost:8080    # 输出 Hello World
```

### 关键点与易错点

- `WORKDIR /app`：设定容器内工作目录，后续命令与复制均基于此。
- `RUN ./mvnw dependency:go-offline`：预下载全部依赖，不打包 JAR，加速后续构建。
- `CMD` 必须使用 exec 形式（JSON 数组）：`["可执行文件", "参数"]`。
- 单阶段镜像 880MB——包含完整 JDK 和 Maven 工具链，生产环境不需要。

### 优化方向

用多阶段构建：第一阶段 JDK+Maven 编译出 JAR；第二阶段改用小型基础镜像，仅 `COPY --from` 复制 JAR，避免构建工具进入生产镜像，大幅减小体积。

### Docker 多阶段构建

`builder` 用 JDK 镜像编译，`final` 用 JRE 镜像运行，最终镜像更小、更安全。生产建议 `jlink` 定制最小 JRE。

```dockerfile
FROM eclipse-temurin:21.0.8_9-jdk-jammy AS builder
RUN ./mvnw clean install

FROM eclipse-temurin:21.0.8_9-jre-jammy AS final
EXPOSE 8080
COPY --from=builder /opt/app/target/*.jar /opt/app/*.jar
ENTRYPOINT ["java", "-jar", "/opt/app/*.jar"]
```

`COPY --from=builder` 跨阶段取产物；`dependency:go-offline` 预取依赖优化层缓存。

### Node.js 容器化指南

- 写 `Dockerfile` + `compose.yaml` 一条命令构建启动
- 基础镜像：Docker Hardened Images（官方最小安全 Node 镜像）
- 示例：TypeScript Express API，端口 `process.env.PORT ?? 3000`
- 脚本：`build: tsc`、`start: node dist/index.js`、`dev: tsx watch src/index.ts`
- tsconfig：`target: ES2022`、`module: commonjs`、`outDir: ./dist`、`rootDir: ./src`、`strict: true`

### 项目基础文件
- `src/index.ts`：Express 应用，根路径返回 `{"message":"Hello World"}`，端口取 `process.env.PORT` 或 `3000`
- `package.json`：脚本 `build`（tsc）、`start`（node dist/index.js）、`dev`（tsx watch）；依赖 `express`
- `tsconfig.json`：编译到 `dist/`，目标 `ES2022`，模块 `commonjs`，启用 `strict`
- `.gitignore`：排除 `node_modules/`、`dist/`、`.env`、`*.log`、`.DS_Store`、`coverage/`、`db/password.txt`

### 创建文件
```bash
mkdir -p nodejs-docker-example/src && cd nodejs-docker-example
```
然后创建上述四个文件（内容见上）。

### 本地运行
```bash
# 开发模式（热重载）
npm install && npm run dev

# 生产构建并运行
npm install && npm run build && npm start
```
访问 `http://localhost:3000` 应看到 `{"message":"Hello World"}`。

### Docker 化准备
```bash
docker login dhi.io   # 登录以下载 Node.js 基础镜像
```
项目根目录需添加 `Dockerfile`、`compose.yaml`、`.dockerignore`；`.dockerignore` 内容与 `.gitignore` 类似，避免将 `node_modules/`、`dist/`、`.env` 等打入构建上下文。

- `[System.IO.File]::WriteAllText($full, $Content, [System.Text.UTF8Encoding]::new($false))`；`New-Item -ItemType Directory -Force -Path <路径> | Out-Null`
- `"build": "tsc","start": "node dist/index.js","dev": "tsx watch src/index.ts"`；依赖：`express@^4.21.2`，dev：`typescript`/`tsx`/`@types/express`/`@types/node`
- `target: ES2022,module: commonjs,outDir: ./dist,rootDir: ./src,strict: true,esModuleInterop: true`
- 易错：`PORT`默认`3000`；`main`指向`dist/index.js`；先`build`

## 31. 覆盖容器默认值

容器启动时执行镜像配置中的应用/命令，可用 `docker run` 覆盖端口、环境变量、资源、网络等默认设置。

### 端口映射
`-p HOST_PORT:CONTAINER_PORT` 映射端口，避免多实例冲突：
```bash
docker run -d -p HOST_PORT:CONTAINER_PORT postgres
```

### 环境变量
`-e` 设置容器内变量；用 `--env-file` 从文件加载，避免命令行过长：
```bash
docker run -e foo=bar postgres env
docker run --env-file .env postgres env
```

### 资源限制
默认容器无资源限制；`--memory` 与 `--cpus` 限制内存和 CPU 配额：
```bash
docker run -e POSTGRES_PASSWORD=secret --memory="512m" --cpus="0.5" postgres
```
实时资源监控用：
```bash
docker stats
```

### 自定义网络
默认所有无 `--network` 的容器连到 bridge 网络；可创建并指定自定义网络：
```bash
docker network create mynetwork
docker network ls
docker run -d -e POSTGRES_PASSWORD=secret -p 5434:5432 --network mynetwork postgres
docker network inspect mynetwork
```

- 默认 bridge：容器仅能通过 IP 互访（`--link` 已过时）；未指定网络的容器共享同一网络，隔离性差。
- 自定义网络：容器可用名称/别名解析，且仅同网络容器互通，隔离性更好。

> 易错点：`-p` 格式为 `宿主机端口:容器端口`；`--cpus="0.5"` 表示半核；`--env-file` 需正确路径；不指定 `--network` 即使用默认 bridge。

### 覆盖默认 CMD / ENTRYPOINT

**Docker Compose 方式**（`compose.yml`）：

```yaml
services:
  postgres:
    image: postgres:18
    entrypoint: ["docker-entrypoint.sh", "postgres"]
    command: ["-h", "localhost", "-p", "5432"]
    environment:
      POSTGRES_PASSWORD: secret
```

- `entrypoint` 覆盖镜像默认入口，`command` 覆盖默认命令/参数。
- 启动：`docker compose up -d`
- 验证：Docker Desktop Dashboard → 容器 → Exec，执行 `psql -U postgres`

**`docker run` 方式**：

```bash
docker run -e POSTGRES_PASSWORD=secret postgres docker-entrypoint.sh -h localhost -p 5432
```

- 镜像名后的第一个参数为 `ENTRYPOINT`，其余为 `CMD` 参数。

**易错点**：
- PostgreSQL 镜像对 localhost（同容器内）使用 trust 认证，连接本机无需密码；跨容器/主机连接才需要密码。

### 持久化容器数据

- **问题**：容器删除后数据丢失。
- **方案**：卷（Volume）将容器目录映射到外部存储，数据独立于容器生命周期。

```bash
docker run -d -p 80:80 -v log-data:/logs img   # 挂载卷（不存在则自动创建）
docker volume rm <卷名>                         # 删除（须无容器挂载）
docker volume prune                             # 清理未使用卷
```

- 同一卷可挂载到多个容器共享数据。

**PostgreSQL 示例**：

```bash
docker run --name=db -e POSTGRES_PASSWORD=secret -d -v postgres_data:/var/lib/postgresql postgres:18
docker exec -ti db psql -U postgres
```

- 数据在 `/var/lib/postgresql`，删容器后仍在卷中。
- 重建容器：`docker stop db && docker rm db`，再以相同 `-v` 启动即可；**仅首次初始化需设 `POSTGRES_PASSWORD`**。

**易错点**：
- `docker volume rm` 仅当卷未被挂载时成功，否则先 `docker rm -f <容器>`。
- 卷占用空间，用 `docker volume prune` 清理无主卷。

- 容器默认网络隔离，需**发布端口**才能从主机访问容器服务。
- 创建容器时用 `-p` / `--publish` 设置转发规则：`HOST_PORT:CONTAINER_PORT`
  ```bash
  docker run -d -p 8080:80 nginx
  ```
- 默认发布到**所有网络接口**（`0.0.0.0`/`::`），数据库等敏感服务慎用。
- 绑定指定主机 IP：完整形式 `HOST_IP:HOST_PORT:CONTAINER_PORT`
  ```bash
  docker run -d -p 127.0.0.1:8080:80 nginx
  ```
  - `127.0.0.1` 仅本机可访问；也可用特定网卡 IP。
- Docker Compose 的 `ports` 支持同样写法：
  ```yaml
  services:
    app:
      image: docker/welcome-to-docker
      ports:
        - "127.0.0.1:8080:80"
  ```
- 省略 `HOST_PORT` 可让 Docker 自动分配**临时端口**：
  ```bash
  docker run -p 80 nginx
  docker ps   # 查看实际映射，如 0.0.0.0:54772->80/tcp
  ```
- `EXPOSE` 仅声明镜像内服务端口，**不会自动发布**。
- `-P` / `--publish-all` 将所有 `EXPOSE` 的端口发布到临时端口，避免开发/测试环境端口冲突：
  ```bash
  docker run -P nginx
  ```
- 易错点：`-p` 中前者是主机端口、后者是容器端口；发布即暴露到网络，需注意安全。

- **文件格式**
  - `Dockerfile`：定义单容器内容与启动行为
  - `Compose file`：定义多容器应用

- **CLI**
  - `docker`：主命令行，含全部命令
  - `docker compose`：构建/运行多容器应用
  - `dockerd`：守护进程，管理容器

- **API**
  - Engine API：主 API，程序化访问 daemon
  - Docker Hub API：操作 Docker Hub
  - DVP Data API：给 Verified Publishers 取分析数据
  - Registry API：操作 Docker Registry

## 沙箱环境文件（.sbxenv.yaml）

- 作用：打包项目环境配置（agent/工具/资源/凭据）；要求 `sbx` ≥ 0.39.0（experimental）
- **易错点**：环境文件须放在所有挂载目录外（workspace/`additionalWorkspaces`），避免被写入沙箱

```yaml
schemaVersion: "1"
name: web-app
agent: claude
workspace: ./web-app
kits: [docker.io/sbx/playwright-kit:latest]
env: {NODE_ENV: test}
```

核心命令：
- `sbx env run [PATH...]`：创建并附加；重复运行仅应用 `env`/MCP 变更
- `sbx env create [PATH...]`：仅创建
- `sbx env exec [PATH...] -- CMD`：环境内执行命令
- `sbx env rm [PATH...]`：删除沙箱及作用域凭据
- PATH 可为目录/文件；目录读 `.sbxenv.yaml`；各命令须传相同 PATH

更新/清理：
- 已建沙箱仅 `env`/MCP 生效；其余字段变更须 rm 后重建
- 全局绑定加 `--prune-bindings`；创建失败残留用相同 PATH 的 `sbx env rm` 清理

- 字段：`schemaVersion` 必填=`"1"`；`agent` 必填；可选 `name`/`kits`/`workspace`/`env`/`sandboxOptions`/`secrets`/`bindings`/`registries`/`mcp`/`ports`。
- kits：支持本地/ZIP/OCI/`git+https|ssh`；远程源须匹配 allowlist（Docker Hub 默认允许）。`sbx settings set kit.allowedSources` 整体替换，需保留已有源：`sbx settings set kit.allowedSources '["docker.io/","github.com/docker/"]'`。Git kit 用 `ref` 固定提交，OCI 用不可变 tag/digest。
- workspace：direct mount 下 agent 可改所有文件；**环境文件须放所有 direct-mounted 工作区之外**。`clone` 可保护主仓库，但 `additionalWorkspaces` 仍 direct mount。字段：`path`（默认/相对首个文件目录）、`clone=false`。
- additionalWorkspaces：`path` 必填，`readOnly` 默认 `false`。
- sandboxOptions：`template`、`memory`（如 `8g`）、`cpus`（`0`=全部）、`pullPolicy`（`always`/`missing`/`never`）、`profile`。
- secrets：每条仅设 `value`/`ref`/`command` 之一；`value` 可读即见，优先 `ref`/`command`；`refresh` 控制解析；`backend` 为 `sdk`/`cli`；`noVerify` 跳过预创建验证。
- bindings：按服务审批凭据注入，合并到 `credentials.yaml`。

## 分享代理技能

- 将宿主机代理技能导入沙箱持久存储，沙箱删除后仍保留，默认对新沙箱生效（实验特性）。
- 导入：`sbx skills import`；同名冲突靠前源优先；`--force` 免确认覆盖；整体替换，非合并，宿主机更新后需重跑。
- 源映射：`~/.<dir>/skills`→`/home/agent/.<dir>/skills`（Claude Code `.claude`，Codex `.agents`，Copilot `.copilot`，Cursor `.cursor`，Droid `.factory`）。
- 存储：macOS `~/Library/Application Support/com.docker.sandboxes/sandboxes/agent-skills`；Linux `~/.local/state/sandboxes/sandboxes/agent-skills`。
- 创建时不挂载：`sbx run --no-share-skills claude`；仅 `sbx` ≥0.37.0 的代理沙箱生效，升级不启用旧沙箱需重建（此参数仅创建时生效）。
- ⚠️ 存储读写挂载，沙箱可篡改技能并经其他沙箱加载（仅沙箱内，不直接宿主执行）；共享存储沙箱同一信任边界，隔离用 `--no-share-skills`。
- 会话启动时扫描；已开会话需新开。

## 与容器共享本地文件

容器默认隔离，无法直接访问宿主机文件。Docker 提供 **volume** 与 **bind mount**：
- volume：持久化容器数据，容器停止后仍保留。
- bind mount：映射宿主机目录到容器，适合共享配置/开发代码。

### 挂载方式
- `-v`：语法简单；宿主机路径不存在时自动创建目录。
- `--mount`：功能强；路径不存在时报错，不自动创建。官方推荐。

```bash
docker run -v /HOST/PATH:/CONTAINER/PATH -it nginx
docker run --mount type=bind,source=/HOST/PATH,target=/CONTAINER/PATH,readonly nginx
```

### 权限
- `:ro` 只读：容器不能修改/删除宿主机文件。
- `:rw` 读写（默认）：改动同步到宿主机。

```bash
docker run -v HOST-DIR:/CONTAINER-DIR:rw nginx
```

### 易错点
- `-v` 路径不存在会自动创建，可能意外产生空目录。
- bind mount 需确保 Docker 有宿主机目录访问权限。
- 只读挂载适合配置类文件，防止容器意外修改。

### 性能提示
代码库很大时 bind mount 可能变慢；Docker Desktop 可用 **Synchronized file share** 提升性能。

### 示例：httpd 挂载本地网页
```bash
mkdir public_html
docker run -d --name my_site -p 8080:80 -v .:/usr/local/apache2/htdocs/ httpd:2.4
```
访问 `http://localhost:8080` 验证。

- `-v` / `--mount` 在 Windows PowerShell 中须使用**绝对路径**，不能用 `./`（PowerShell 相对路径处理与 bash 不同）
- 挂载后访问：`http://localhost:8080`
- Docker Desktop Dashboard 验证挂载：
  1. 容器 **Files** 标签 → 查看 `/usr/local/apache2/htdocs/` 内文件
  2. 删除宿主机文件 → 容器内同步消失
  3. 重建宿主机文件 → 容器内重新出现，并可访问站点
- 停止容器：**Containers** 视图 → 选中容器 → Actions 列选 **Stop**
- 更多资源：Docker 数据管理、Volumes、Bind mounts、运行容器、存储错误排查、持久化容器数据

## 镜像层核心概念

- **层**：镜像由多个只读层组成，每层记录文件系统变更（增/删/改），层创建后不可变。
- **层复用**：不同镜像可共享基础层，加速构建、减少存储和带宽。
- **叠加机制**：内容寻址存储 + 联合文件系统（Union FS），容器启动时叠加为统一视图。
- **容器可写层**：运行时创建容器专属层，写入不影响镜像层，故同一镜像可运行多个容器。

## 关键命令（手动创建层）

> 生产环境使用 Dockerfile；`container commit` 仅用于理解层机制。

```bash
docker run --name=base-container -ti ubuntu
apt update && apt install -y nodejs

# 新终端：
docker container commit -m "Add node" base-container node-base
docker image history node-base
```

## 扩展应用镜像

```bash
docker run --name=app-container -ti node-base
echo 'console.log("Hello from an app")' > app.js

# 新终端：
docker container commit -c "CMD node app.js" -m "Add app" app-container sample-app
docker image history sample-app
```

## 易错点

- `container commit` 不保留历史命令记录，仅生成变更层，**生产环境应使用 Dockerfile**。
- 镜像层只读，容器内修改**必须**通过可写层，否则容器重启后丢失。

- 手动构建镜像：修改容器后，用 `docker container commit <容器> <镜像:标签>` 提交为新镜像。
- 查看分层历史：`docker image history <镜像>`，输出列含 `IMAGE`、`CREATED BY`、`SIZE`、`COMMENT`；`<missing>` 表示中间层 ID 不可用（构建缓存导致）。
- 运行新镜像：`docker run sample-app`（镜像已配置默认 CMD 时直接执行）。
- 删除容器：`docker rm -f app-container` 强制清理。
- 易错点：`docker container commit` 仅适合临时调试；正式构建应用 Dockerfile 自动化，保证可重复、可审计。

## OpenCode 连接 Docker Model Runner

**前置**：Docker Desktop/Engine、启用 Model Runner、安装 OpenCode。需开放 TCP：
```
docker desktop enable model-runner --tcp 12434
```

**拉取模型**：
```
docker model pull ai/qwen3-coder
docker model pull ai/devstral-small-2
```

**配置** `opencode.json`（全局 `~/.config/opencode/opencode.json`；项目根同名文件覆盖全局）：新增 provider `dmr`，`npm` 用 `@ai-sdk/openai-compatible`，`options.baseURL` 为 `http://localhost:12434/v1`，`models` 映射：`qwen3-coder`→`ai/qwen3-coder`、`devstral-small-2`→`ai/devstral-small-2`。旧兼容路径用 `http://localhost:12434/engines/v1`。

**验证与启动**：
```
curl http://localhost:12434/v1/models
opencode
```
TUI 内 `/models` 选 `dmr` 下模型。

**可选：gpt-oss 更大上下文**
```
docker model pull ai/gpt-oss
docker model package --from ai/gpt-oss --context-size 128000 gpt-oss:128k
```
再将 `gpt-oss:128k` 加入 `models`。

**排错**：`docker model status` 查服务状态；`docker model ls` 确认模型名与配置一致。

**端点与认证**
- `POST https://api.dso.docker.com/v1/graphql`，Bearer 认证，Body 含 `query`、`variables.ctx`（`{ organization: "<org>" }`）
- PAT/OAT 不能直接作 Bearer，先换 token：
```bash
curl -X POST https://hub.docker.com/v2/auth/token \
  -H "Content-Type: application/json" \
  -d '{"identifier": "<username或org名>", "secret": "<PAT或OAT>"}'
```
- `identifier`：PAT 用用户名、OAT 用组织名；响应 `access_token` 作 Bearer

**查询 `imagePackagesForImageCoords`**
- 必填：`digest`（平台 digest）、`hostName`、`repoName`；可选：`includeExcepted`/`includeNodsa`/`includePublic`
- `vulnerabilityExceptions`：空数组=未抑制，用 `isExcepted` 过滤；`FALSE_POSITIVE`/`ACCEPTED_RISK`=抑制

- 构建缓存：Docker 逐条执行 Dockerfile 指令，每指令生成一层；若指令与之前相同，复用缓存层，避免重复执行。
- 缓存失效条件：
  - `RUN` 指令命令内容变化
  - `COPY`/`ADD` 复制文件内容或属性变化
  - 某一层失效后，其后的所有层一并失效
- 优化技巧：将依赖安装步骤前置，仅当依赖清单变化时才重装。

```dockerfile
# 低效写法：源代码变化导致依赖层缓存失效
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN yarn install --production
```

```dockerfile
# 高效写法：先复制依赖清单，安装依赖，再复制源码
FROM node:22-alpine
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --production
COPY . .
```

`.dockerignore` 排除不必传输的目录，减少构建上下文：

```
node_modules
```

验证缓存命中：`docker build .` 输出中 `CACHED` 表示复用层。

示例优化前：首次构建 20s，再次构建 1.0s（依赖安装 10s 被缓存）；优化后仅源码变更时依赖层仍命中缓存，极大加快重建。

- **构建上下文**：`docker build` 会发送整个目录，注意 `.dockerignore` 排除不必要文件（如 `node_modules`），减小传输体积。
- **层缓存机制**：每条指令对应一层，若指令及上下文未变则命中缓存（显示 `CACHED`），修改文件会使后续层失效。
- **优化顺序**：将依赖安装指令（如 `COPY package.json yarn.lock` + `RUN yarn install`）放在代码复制之前，避免每次改代码都重装依赖。
- **关键命令**：
  ```bash
  docker build -t node-app:3.0 .
  ```
- **验证缓存**：构建输出中 `CACHED` 标记表示复用未变层，构建时间大幅缩短。
- **易错点**：任何文件内容变化（如 `index.html`）会使从 `COPY . .` 开始的层重建，但前面的依赖层仍缓存；不要随意调整 Dockerfile 指令顺序，否则缓存失效。

## 虚拟机管理器（VMM）

### Docker VMM

- 容器优化 hypervisor；自 4.86 起（Mac 上替代 4.35–4.85 的 `libkrun`）使用 Docker 自家 hypervisor
- 优点：空闲内存归还宿主机；改善容器/宿主机文件 I/O；缩短启动时间；Windows 上比 WSL 2 有更真实 VM 边界
- 前提：Linux VM 至少 4 GB 内存（Settings > Resources）
- 切换：Settings > General > Virtual Machine Manager → 选择 Docker VMM → Apply & restart
- 版本：4.35 及更早由 `libkrun` 支持；4.86 及更新由 Docker 自家 hypervisor 支持；从 4.35 起升级会保留设置并自动切换
- 已知问题：切换后可能需重启 Docker Desktop；不支持 bind mount 自动共享，报错 `file is not shared from the host` 时，到 Settings > Resources > File sharing 添加目录
- Mac 专属限制：不支持 Rosetta，amd64 模拟慢；MongoDB、Cassandra 等在 virtiofs 下可能失败（预计未来修复）

### Mac 替代 VMM

- Apple Virtualization framework：稳定成熟，推荐
- HyperKit（Intel Mac 遗留）：已弃用，建议改用 Apple Virtualization framework

### Windows 替代 VMM

- WSL 2：默认后端，轻量 VM，与 Windows 文件系统/网络深度集成；支持 per-user 和 all-users 模式，无需管理员权限
- Hyper-V：Windows 原生 hypervisor，完全隔离，边界强；仅 all-users 模式，需管理员权限

### 容器核心概念

- **定义**：容器是应用的各组件（前端、API、数据库）的**隔离进程**，各自拥有独立运行环境，与宿主机及其他容器隔离。
- **特性**：
  - **自包含**：无需宿主机预装依赖。
  - **隔离**：最小化对宿主机和彼此的影响，提升安全性。
  - **独立**：删除一个容器不影响其他。
  - **可移植**：开发机、数据中心、云上运行行为一致。

### 容器 vs 虚拟机（VM）

- VM：完整操作系统（独立内核、驱动、程序），隔离单个应用开销大。
- 容器：隔离进程 + 所需文件，多个容器**共享宿主机内核**，资源利用率更高。
- 常见组合：云上 VM 提供基础设施，VM 内的容器运行时运行多个容器应用。

### 关键命令

```bash
# 启动容器（-d 后台运行，-p 映射端口：宿主机8080 -> 容器80）
docker run -d -p 8080:80 docker/welcome-to-docker

# 查看运行中的容器（-a 查看包括已停止的）
docker ps
docker ps -a

# 停止容器（ID 可只写唯一前缀，如 a1f）
docker stop <container-id>
```

### 端口映射

- `-p 8080:80` 将容器内 80 端口暴露到宿主机 8080，通过 `http://localhost:8080` 访问。
- 复杂项目各组件（前端/后端/数据库）分别运行在不同容器。

### 易错点

- `docker ps` 只显示运行中容器；查看所有需加 `-a`。
- 引用容器 ID 无需完整，唯一前缀即可。
- 容器持续运行直到手动停止。

- **registry（镜像仓库）**：集中存储共享镜像，分公共/私有；默认 Docker Hub，亦可用 ECR、ACR、GCR 或自建。
- **registry vs repository**：registry 是管理镜像的服务；repository 是其中按项目组织的镜像集合，一个 registry 含多个 repository，一个 repository 可含多标签镜像。

## 推送镜像流程

```bash
git clone https://github.com/dockersamples/helloworld-demo-node
cd helloworld-demo-node
docker build -t <用户名>/docker-quickstart .
docker images
docker run -d -p 8080:8080 <用户名>/docker-quickstart
docker tag <用户名>/docker-quickstart <用户名>/docker-quickstart:1.0
docker push <用户名>/docker-quickstart:1.0
```

**要点/易错点**：
- 推送前需在 Docker Hub 创建同名仓库，并 `docker login`。
- `docker build` 末尾的 `.` 不能省略，表示 Dockerfile 所在目录。
- 镜像标签格式为 `<用户名>/<仓库名>:<标签>`，推送时用完整标签。

## 镜像（Image）

- **定义**：标准化软件包，包含运行容器所需的全部文件、二进制、库和配置（如 PostgreSQL 镜像含数据库二进制、配置文件及依赖）
- **两大原则**：
  - **不可变**：创建后不能修改，只能新建镜像或在现有镜像上叠加变更
  - **分层**：镜像由多层组成，每层是一组文件系统变更（添加/删除/修改文件）
- 支持从基础镜像（如 Python/Node.js）扩展，叠加依赖和应用代码层

### 镜像来源
- **Docker Hub**：默认全局镜像市场
- Docker Trusted Content 类型：
  - **Docker Official Images**：官方精选，起点稳定、安全
  - **Docker Hardened Images**：精简、生产就绪、近零 CVE
  - **Docker Verified Publishers**：商业发行商验证的高质量镜像
  - **Docker-Sponsored Open Source**：开源项目维护的镜像

### 关键命令
```bash
# 搜索镜像
docker search docker/welcome-to-docker

# 拉取镜像
docker pull docker/welcome-to-docker

# 列出本地镜像
docker image ls

# 查看镜像分层
docker image history docker/welcome-to-docker
```

### 易错点
- `docker image ls` 的 SIZE 为**未压缩**大小，非下载大小
- `docker pull` 输出中每行对应一个层（layer）的下载
- 镜像通过 `Digest`（如 `sha256:...`）唯一标识内容

## 查看 Docker 镜像分层

`docker image history` 显示镜像的构建层信息：

```
docker image history <image>
```

输出列：`IMAGE` / `CREATED` / `CREATED BY` / `SIZE` / `COMMENT`

核心要点：

- 每行对应一个镜像层，从当前层向下回溯至基础镜像
- `<missing>` 表示中间层（构建缓存层），未作为独立镜像保存
- `SIZE` 为该层新增大小，而非累计大小
- 加 `--no-trunc` 显示完整创建命令：

```
docker image history --no-trunc <image>
```

- **易错点**：`--no-trunc` 输出完整命令后，表格格式会被长命令破坏，难以阅读

关键概念：

- Docker 镜像由多层只读层叠加组成，每层对应 Dockerfile 中的一条指令（`COPY`、`RUN`、`ENV`、`EXPOSE` 等）
- 拉取镜像会连同其全部层一起拉取
- 下一步学习：镜像通过注册表（registry）分发

- **核心概念**：Docker Compose 通过单个 YAML 文件（`compose.yaml`）定义多容器应用及其配置（镜像、端口、卷、网络等），实现“一条命令启动整个应用”。
- **设计原则**：容器应“单职责”，避免将多个服务塞进一个容器。
- **声明式工具**：修改配置后再次运行 `docker compose up`，Compose 自动协调变更并智能应用，无需从零重建。
- **Dockerfile vs Compose 文件**：Dockerfile 构建镜像；Compose 文件定义运行时的容器，常引用 Dockerfile 构建服务镜像。

**关键命令**：
```bash
# 启动应用（-d 后台，--build 构建镜像）
docker compose up -d --build

# 停止并移除容器和网络（默认不删卷）
docker compose down

# 连带删除卷（数据持久化清除）
docker compose down --volumes
```

**易错点**：
- 默认 `docker compose down` **不会**删除卷，数据会保留；需加 `--volumes` 强制删除。
- 用 GUI 删除 Compose 应用只移除容器，网络和卷需手动清理。

## Docker 核心概念

- 开放平台，用于应用开发、交付、运行；将应用与基础设施分离，加快交付。
- 容器：松散隔离环境，可同机多容器并发；自带应用运行所需一切，不依赖宿主；保证环境一致。

**用途**
- 标准化开发/测试环境，支撑 CI/CD 流程
- 高可移植性：本地、数据中心物理/虚拟机、云、混合环境均可运行
- 按业务需要近实时扩缩容
- 比 hypervisor 虚拟机更轻量，同硬件承载更多工作负载

**架构（client-server）**
- `dockerd`：守护进程，监听 API，管理镜像、容器、网络、卷
- `docker`：客户端，经 REST API（UNIX socket/网络）与 daemon 通信；`docker run` 等命令发给 `dockerd`
- Docker Desktop：集成 `dockerd`、`docker`、Compose、Content Trust、Kubernetes、Credential Helper
- 仓库：存镜像；默认 Docker Hub；`docker pull`/`docker run` 拉取，`docker push` 推送；可自建私有仓库

**镜像与容器**
- 镜像：只读模板；多基于其他镜像定制；用 Dockerfile 构建，每条指令生成一层，重建时仅变更层重建，因此轻量
- 容器：镜像的可运行实例；可用 API/CLI 创建、启动、停止、移动、删除；可接网络/存储；默认相互及与宿主隔离；删除后未持久化状态丢失

**示例**
```bash
docker run -i -t ubuntu /bin/bash
```

```bash
docker run -it ubuntu /bin/bash
```

- 本地无镜像则自动拉取（`docker pull ubuntu`）
- 创建新容器（`docker container create`），分配可读写文件系统作为最终层
- 创建默认网络接口并分配 IP，经宿主机网络访问外网
- `-i` 交互式，`-t` 伪终端；启动后执行 `/bin/bash`
- 执行 `exit` 停止容器，但容器未删除，可重启或 `docker rm`

底层：Docker 用 Go 编写，依赖 Linux `namespaces` 隔离；每容器独立 namespace，资源访问受限。

易错点：容器停止后不会自动删除，需手动 `docker rm`；`-it` 缺一无法正常交互。

- 下一步学习路径分三大模块：**基础概念**、**构建镜像**、**运行容器**

### 基础概念
- **容器**：运行第一个容器
- **镜像**：镜像层（layer）基础
- **注册表**：容器注册表互操作与交互
- **Docker Compose**：多容器编排工具

### 构建镜像
- **镜像层**：理解容器镜像的分层结构
- **编写 Dockerfile**：通过 Dockerfile 创建镜像
- **构建/标记/发布**：构建镜像并推送至 Docker Hub 或其他 registry
- **构建缓存**：了解缓存失效条件及有效利用方法
- **多阶段构建**：优化镜像体积的关键手段

### 运行容器
- **发布端口**：`-p` 发布与 `EXPOSE` 暴露的区别
- **覆盖默认配置**：通过 `docker run` 覆盖容器默认设置
- **数据持久化**：使用 volume / bind mount 保存数据
- **共享文件**：容器与宿主机之间的存储选项及常见用法
- **多容器应用**：与单容器应用的差异及管理方式

```bash
# 覆盖默认配置示例
docker run -p 8080:80 -v $(pwd)/data:/app/data nginx
```

Dockerfile 是基于文本的镜像构建描述文件，指定构建时要执行的命令、需复制的文件、启动命令等。

```dockerfile
FROM python:3.13
WORKDIR /usr/local/app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY src ./src
EXPOSE 8080
RUN useradd app
USER app
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
```

常用指令：

- `FROM <image>`：指定基础镜像
- `WORKDIR <path>`：设置工作目录，后续命令和复制均基于此路径
- `COPY <host-path> <image-path>`：从宿主机复制文件到镜像
- `RUN <command>`：构建时执行命令
- `ENV <name> <value>`：设置容器运行时的环境变量
- `EXPOSE <port-number>`：声明镜像要暴露的端口
- `USER <user-or-uid>`：设置后续指令及容器运行时的默认用户
- `CMD ["<command>", "<arg1>"]`：设置容器默认启动命令

编写步骤：

1. 确定基础镜像
2. 安装应用依赖
3. 复制源码/二进制
4. 配置最终镜像

Node.js 示例：

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN yarn install --production
CMD ["node", "./src/index.js"]
```

注意：

- Dockerfile 无文件扩展名
- 上述示例尚未生产就绪；需进一步优化构建缓存、使用非 root 用户、采用多阶段构建。

---
来源：consolidated/services/容器运行时（Docker）.md