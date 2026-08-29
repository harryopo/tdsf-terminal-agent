---
name: docker-management
description: Docker 管理 Skill，覆盖容器生命周期、镜像、网络、卷与 Compose 编排的日常操作及容器类故障排查
version: 2.0.0
author: TDSF
tags: [docker, container, image, volume, network, devops, compose]
# TDSF 魔改 (P0-2 修复 2026-07-28): executor 让 Skill 真正可执行
# docker ps -a = 容器排障第一命令: 含已停止容器, 一眼看到 Exited 状态与退出码.
executor:
  type: shell
  command: "docker ps -a"
  timeout: 10
  description: "列出所有容器（含已停止）. STATUS 列显示 Up/Exited 及退出码, 0 为正常退出, 非 0 需查 logs."
---

# Docker 管理 Skill

## When to use

- 用户请求管理 Docker 容器（启动 / 停止 / 重启 / 删除 / 进入）
- 用户需要构建、拉取、导入导出镜像或编写 Dockerfile
- 用户报告容器启动失败 / 秒退 / 反复重启 / 无响应
- 用户需要配置 Docker 网络（端口映射 / 容器互联）或数据卷（持久化）
- 用户请求编写或调试 docker-compose.yml
- Docker 磁盘占用过高需要清理

触发关键词：docker / container / 容器 / 镜像 / image / compose / Dockerfile / volume / 端口映射 / 容器启动失败

## 核心概念

- **镜像（Image）与容器（Container）**：镜像是分层只读模板；容器是镜像的运行实例，顶部多一层可写层——容器内写的数据随 `docker rm` 消失，持久化必须用卷。
- **端口映射 `-p`**：`-p 8080:80` = 宿主机 8080 → 容器 80；格式固定为 `宿主机:容器`，写反会"映射成功但访问不通"。
- **卷（Volume）与绑定挂载**：`-v mydata:/var/lib/mysql` 是 Docker 管理的命名卷（推荐）；`-v /host/path:/ct/path` 是绑定挂载（路径必须绝对）。
- **网络模式**：默认 bridge（容器间用容器名互访需自定义网络）；`--network host` 直接共享宿主机网络栈（无端口隔离）。
- **Compose**：一个 docker-compose.yml 声明多服务；`up -d` 创建启动、`down` 停止删除（默认不删命名卷）、`logs -f` 跟日志。
- **退出码（Exit Code）**：`docker ps -a` 的 STATUS 列，0 = 正常退出；137 = 被 SIGKILL（常为 OOM 或手动强杀）；126/127 = 命令无法执行/找不到。

## 常用命令速查

### 容器生命周期

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `docker run -d --name web -p 8080:80 nginx` | 创建并启动容器 | `-d` 后台、`--rm` 退出即删、`--restart=unless-stopped` 自愈 |
| `docker ps -a` | 列出所有容器（含停止） | `--filter status=exited` 只看退出的 |
| `docker logs --tail 100 -f web` | 看容器日志 | `--since 10m` 时间过滤、`-t` 带时间戳 |
| `docker exec -it web bash` | 进入运行中容器 | `-u root` 指定用户；镜像无 bash 时改用 `sh` |
| `docker inspect web` | 查看容器完整元数据 | `--format '{{.State.Status}}'` 取单字段 |
| `docker stats` | 实时资源占用 | `--no-stream` 输出一次即退 |
| `docker stop/start/restart web` | 停止/启动/重启 | `stop` 默认 10s 超时后强杀 |
| `docker rm web` | 删除容器 | `-f` 强删运行中的（先 stop 更稳妥） |

### 镜像管理

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `docker images` | 列出本地镜像 | `--digests` 显示摘要 |
| `docker pull nginx:1.27-alpine` | 拉取镜像 | 尽量固定 tag，避免 latest 漂移 |
| `docker build -t myapp:1.0 .` | 构建镜像 | `-f Dockerfile.prod` 指定文件、`--no-cache` 全量重建 |
| `docker rmi <image>` | 删除镜像 | `-f` 强制 |
| `docker system df` | 查看 Docker 磁盘占用 | `-v` 详细列表 |

### 网络 / 卷 / Compose

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `docker network create appnet` | 创建自定义网络 | 同网络内容器可用容器名互访 |
| `docker network inspect appnet` | 查看网络成员 | — |
| `docker volume create / ls / inspect` | 卷管理三件套 | `rm` 删除卷 |
| `docker compose up -d` | 按编排启动全部服务 | `--build` 先重建镜像 |
| `docker compose down` | 停止并删除容器+网络 | `-v` 连命名卷一起删（高危） |
| `docker compose logs -f <svc>` | 跟踪某服务日志 | `--tail 100` 限量 |
| `docker compose config` | 校验 yml 语法与引用 | 报错即指出文件与行 |

## Steps

**前置动作——风险评估**：只读命令（ps/logs/inspect/stats/system df）L1 直接执行；`stop/restart` 为 L2；`rm -f / container prune` 为 L3；`system prune -a / volume prune / run --privileged` 为 L4，必须人工审批。

**场景 1：容器起不来 / 秒退（最高频）**

```
1. docker ps -a                          → 找到目标容器, 记下 STATUS 的退出码
2. docker logs --tail 50 <ct>            → 读报错（配置错/端口占用/缺环境变量/依赖连不上）
3. docker inspect <ct>                   → 核对 Cmd/Env/Mounts/PortBindings 是否符合预期
4. 退出码辅助定位: 137→OOM 或被杀(查 dmesg | grep -i oom)
                    1→应用报错(看 logs)  126/127→入口命令错误(查 Dockerfile CMD/ENTRYPOINT)
5. 修正配置后 docker rm <ct> 再 docker run 重建（run 参数改不了, 只能重建）
6. docker ps + docker logs 验证 Up 且无报错
```

**场景 2：端口映射不通**

```
1. docker ps                             → 确认映射列 0.0.0.0:8080->80/tcp 存在
2. curl -I http://localhost:8080         → 宿主机自测；不通进容器内测
3. docker exec -it <ct> curl -I http://localhost:80   → 容器内通 = 问题在映射/防火墙
4. ss -tlnp | grep 8080                  → 宿主机端口被其他进程占用会 run 失败
5. firewall-cmd --list-all               → 云主机还要查安全组
```

**场景 3：Docker 磁盘满**

```
1. docker system df            → Images/Containers/Volumes 各占多少
2. docker system df -v         → 找出悬空镜像(dangling)与停止容器明细
3. risk 评估(清理不可逆, L3~L4):
   - docker container prune    → 删全部已停止容器
   - docker image prune -a     → 删全部未被容器引用的镜像(谨慎)
   - docker volume prune       → 删未挂载的卷(会丢数据, 必须人工确认)
4. docker system df            → 复查占用下降
```

## Examples

### 示例 1：nginx 容器启动失败

```
用户: nginx 容器启动失败
Agent:
  1. docker ps -a | grep nginx → "Exited (1) 5 seconds ago"
  2. docker logs nginx → "bind() to 0.0.0.0:80 failed (98: Address already in use)"
  3. ss -tlnp | grep :80 → 宿主机 httpd 占用 80
  4. 方案 A: 停宿主机 httpd；方案 B: 改映射 -p 8080:80（推荐，不动宿主机服务）
  5. docker rm -f nginx && docker run -d --name nginx -p 8080:80 nginx
  6. docker ps → "Up 5s" + curl -I localhost:8080 → 200
```

### 示例 2：MySQL 容器反复重启丢数据

```
用户: mysql 容器每次重建数据就没了
Agent:
  1. docker inspect mysql --format '{{json .Mounts}}' → 无任何挂载
  2. 解释: 容器可写层随 rm 删除, 数据库必须持久化
  3. docker volume create mysqldata
  4. docker run -d --name mysql -v mysqldata:/var/lib/mysql -e MYSQL_ROOT_PASSWORD=*** mysql:8.0
  5. docker rm 后重建容器 → 数据仍在卷中
```

### 示例 3：Compose 启动失败

```
用户: docker compose up 报错
Agent:
  1. docker compose config → "service 'web' depends on undefined service 'db'"
  2. 修正 yml: 补全 services.db 定义
  3. docker compose config → 校验通过（无输出即 OK）
  4. docker compose up -d → Started；docker compose ps → 全部 running
```

## 易错点

- **容器数据不持久化**：容器可写层随 `docker rm` 一起消失——数据库/有状态服务必须 `-v` 挂卷，`docker compose down -v` 会连卷一起删（数据丢失）。
- **`-p` 端口写反**：格式是 `宿主机:容器`；`-p 80:8080` 意为访问宿主机 80 转到容器 8080，写反表现为"容器内正常但外部不通"。
- **`docker run` 参数改不了**：端口/卷/环境变量在创建时固定，修改只能 `docker rm` 后重建（Compose 改 yml 后 `up -d` 会自动重建变化的服务）。
- **`docker logs` 刷屏**：日志多时务必加 `--tail N` 或 `--since`，别直接裸跑 `-f`。
- **`latest` 标签漂移**：`docker pull nginx` 今天和明天可能拉到不同版本——生产固定具体 tag 或摘要。
- **`system prune -a` 误删**：会删除所有未被容器引用的镜像（含构建缓存），下次构建/回滚需重新拉取——执行前必须 `docker system df -v` 预览并 L4 审批。

## 验证方法

- 状态：`docker ps` 目标容器 `Up` 且 `docker logs --tail 20` 无错误输出。
- 服务：`curl -I http://localhost:<映射端口>` 返回预期状态码；`docker exec <ct> <探活命令>` 容器内自测。
- 持久化：`docker volume inspect <vol>` 确认挂载点；删除容器重建后数据仍在。
- 编排：`docker compose ps` 全部 `running/healthy`；`docker compose config` 无报错。

## 参考

- Docker Engine CLI 官方参考（每条子命令的权威文档）：https://docs.docker.com/reference/cli/docker/
- Dockerfile 与镜像构建官方手册：https://docs.docker.com/reference/dockerfile/
- Docker Compose 官方文档：https://docs.docker.com/compose/
- Docker 网络概念官方文档：https://docs.docker.com/engine/network/
- 存储与卷官方文档：https://docs.docker.com/engine/storage/volumes/
