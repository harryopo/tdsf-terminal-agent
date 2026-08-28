---
name: systemd-troubleshoot
description: systemd 服务故障排查 Skill，处理服务启动失败、状态异常、日志定位、unit 文件修改与开机自启配置
version: 1.0.0
author: TDSF
tags: [systemd, service, journalctl, systemctl, linux, ops]
allowed-tools: [ssh_command, get_terminal_output, read_remote_file, log_analyzer, suggest_command, knowledge_search]
executor:
  type: shell
  command: "systemctl is-system-running"
  timeout: 5
  description: "查询 systemd 整体运行状态 (running/degraded/starting...). Windows 或无 systemd 环境会失败, 输出自动降级."
---

# systemd 服务故障排查 Skill

## When to use

- 用户报告服务启动失败 / 异常退出 / 状态显示 failed
- 用户需要查看服务日志定位报错原因
- 用户需要修改 unit 文件（override / 依赖 / 资源限制）
- 用户需要配置开机自启或调整启动顺序
- 用户遇到 "Job for xxx.service failed" 类报错

触发关键词：systemctl / systemd / journalctl / service / unit / daemon-reload / enable / status / failed / inactive / 服务 / 开机自启 / 启动失败

## Steps

1. **风险评估**：
   - `systemctl status / is-active / is-enabled / list-units` → L1（只读）
   - `journalctl` 查询 → L1（只读）
   - `systemctl restart / start / stop` → L2（改变服务运行态）
   - `systemctl disable / mask` → L3（影响开机自启/彻底禁用）
   - `systemctl isolate`（切换 target）→ L3（影响全局会话）

2. **确认服务状态**：
   - `systemctl status <service>` → loaded/active 状态 + 最近日志行 + 主 PID
   - `systemctl is-active <service>` / `is-enabled <service>` → 快速判断
   - `systemctl list-units --state=failed` → 找出所有 failed 单元

3. **日志定位**（排障核心）：
   - `journalctl -u <service> -n 50 --no-pager` → 最近 50 行
   - `journalctl -u <service> -b --no-pager` → 本次开机以来的日志
   - `journalctl -u <service> --since "10 min ago" --no-pager` → 时间窗过滤
   - `journalctl -xe` → 带解释的最新系统日志（含 unit 失败原因）
   - `systemctl cat <service>` → 查看 unit 文件实际内容与 override

4. **常见失败模式与修复**：
   - 配置文件语法错 → `systemd-analyze verify <unit>` 校验；修复后 `systemctl daemon-reload`
   - 端口被占用 → `ss -tlnp | grep <port>` 找占用进程
   - 依赖服务未起 → `systemctl list-dependencies <service>`；调整 After=/Requires=
   - 权限/路径错 → 检查 User=/ExecStart= 路径；`ls -l` 核对权限
   - 资源限制 → `journalctl -u <service> | grep -i oom`；调整 MemoryMax=

5. **修改 unit 文件**（推荐 override 方式）：
   - `systemctl edit <service>` → 生成 /etc/systemd/system/<service>.d/override.conf
   - 修改后必须 `systemctl daemon-reload` → 再 `systemctl restart <service>`
   - `systemd-delta` → 查看哪些 unit 被 override

6. **开机自启管理**：
   - `systemctl enable <service>` / `enable --now <service>`（立即启动并自启）
   - `systemctl disable <service>` → 取消自启（L3，需说明影响）

7. **深度诊断**（服务反复失败时）：
   - `systemd-analyze blame` → 各 unit 启动耗时
   - `systemd-analyze critical-chain <service>` → 启动链路瓶颈
   - `systemctl show <service> -p NRestarts,Restart,TimeoutStartUSec` → 重启策略检查

## Examples

### 示例 1：nginx 启动失败

```
用户: nginx 起不来，systemctl status 显示 failed
Agent:
  1. systemctl status nginx → "code=exited, status=1/FAILURE"
  2. journalctl -u nginx -n 30 --no-pager → "bind() to 0.0.0.0:80 failed (98: Address already in use)"
  3. ss -tlnp | grep :80 → 被 httpd 占用
  4. 建议：停用 httpd 或改 nginx 端口（给出两条方案及影响说明）
  5. systemctl restart nginx → "active (running)"
```

### 示例 2：修改 sshd 端口后未生效

```
用户: 改了 /etc/ssh/sshd_config 端口但没生效
Agent:
  1. systemctl cat sshd → 确认实际加载的配置
  2. 解释：改配置后必须 daemon-reload（unit 变化）或 restart（服务配置）
  3. systemctl restart sshd → 生效
  4. 提示：sshd 重启不会断开已建立的连接（L2 风险说明）
```

### 示例 3：配置开机自启

```
用户: 让 frps 开机自动启动
Agent:
  1. systemctl is-enabled frps → "disabled"
  2. systemctl enable --now frps → 创建 symlink + 立即启动
  3. systemctl is-active frps → "active" 验证
```

### 示例 4：服务反复重启（restart loop）

```
用户: myapp 一直自动重启
Agent:
  1. systemctl show myapp -p NRestarts,Restart → "NRestarts=12, Restart=on-failure"
  2. journalctl -u myapp -b --no-pager → 找到崩溃原因（如 Python ImportError）
  3. 修复根因（依赖缺失/配置错误）→ restart → 稳定
  4. 建议加 StartLimitIntervalSec 防止无限重启（L3 需审批）
```
