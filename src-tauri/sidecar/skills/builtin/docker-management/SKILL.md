---
name: docker-management
description: Docker 管理 Skill，处理容器/镜像/网络/卷/Compose 等任务
version: 1.1.0
author: TDSF
tags: [docker, container, devops, compose]
# TDSF 魔改 (P0-2 修复 2026-07-28): 添加 executor 字段, 让 Skill 真正可执行
# 默认执行 `docker ps -a` 列出所有容器. 用户可输入 container 名称作为 input 过滤.
executor:
  type: shell
  command: "docker ps -a"
  timeout: 10
  description: "列出所有 Docker 容器（含已停止）。可在输入框传入 grep 参数, 如 '-a --filter status=exited' 过滤."
---

# Docker 管理 Skill

## When to use

- 用户请求管理 Docker 容器（启动/停止/重启/删除）
- 用户需要构建 / 拉取 / 推送镜像
- 用户报告容器启动失败 / 退出 / 无响应
- 用户需要配置 Docker 网络 / 数据卷
- 用户请求编写 / 调试 docker-compose.yml

触发关键词：docker / container / 镜像 / image / 容器 / compose / Dockerfile

## Steps

1. **风险评估**：
   - `docker rm -f` / `docker system prune -a` → L4（必须人工审批）
   - `docker run --privileged` → L4
   - `docker stop/restart` → L3
   - `docker ps/logs/exec` → L1（只读）

2. **容器诊断**：
   - `docker ps -a` 列出所有容器（含已停止）
   - `docker logs --tail 100 <container>` 查看日志
   - `docker inspect <container>` 查看详细配置
   - `docker exec -it <container> sh` 进入容器

3. **镜像管理**：
   - `docker images` 列出本地镜像
   - `docker pull <image>:<tag>` 拉取镜像
   - `docker rmi <image>` 删除镜像
   - `docker build -t <name>:<tag> .` 构建镜像

4. **网络 + 卷**：
   - `docker network ls` / `docker network create <name>`
   - `docker volume ls` / `docker volume create <name>`
   - `docker network inspect <name>` 查看网络详情

5. **Compose 编排**：
   - `docker-compose up -d` 启动
   - `docker-compose down` 停止 + 删除
   - `docker-compose logs -f <service>` 跟踪日志
   - `docker-compose config` 验证 yml 语法

## Examples

### 示例 1：容器启动失败

```
用户: nginx 容器启动失败
Agent:
  1. docker ps -a | grep nginx → "Exited (1) 5s ago"
  2. docker logs nginx → "bind() to 0.0.0.0:80 failed"
  3. ss -tlnp | grep :80 → "host apache2"
  4. docker run -d -p 8080:80 --name nginx nginx:alpine
  5. docker ps | grep nginx → "Up 10s"
```

### 示例 2：清理无用镜像

```
用户: 清理 Docker 占用空间
Agent:
  1. risk: docker system prune -a → L4（需审批）
  2. [等待用户审批]
  3. docker system df → 显示当前占用
  4. docker system prune -a --volumes → 清理
  5. docker system df → 显示清理后占用
```

### 示例 3：Compose 调试

```
用户: docker-compose 启动失败
Agent:
  1. docker-compose config → "ERROR: service 'web' depends on undefined service 'db'"
  2. 编辑 docker-compose.yml 修正 services.db 定义
  3. docker-compose config → OK
  4. docker-compose up -d → 启动成功
```
