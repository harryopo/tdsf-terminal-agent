---
name: linux-ops
description: Linux 运维 Skill，处理 nginx/systemd/journalctl/iptables 等常见运维任务
version: 1.1.0
author: TDSF
tags: [linux, ops, nginx, systemd, journalctl, iptables]
# TDSF 魔改 (P0-2 修复 2026-07-28): 添加 executor 字段, 让 Skill 真正可执行
# 默认输出当前系统信息. 用户在输入框可填命令片段, 自动拼到 uptime 后面.
executor:
  type: shell
  command: "uname -a"
  timeout: 5
  description: "查询系统信息 (内核/主机/架构). 在输入框可附加 shell 命令片段, 如 '-r' 仅看内核版本."
---

# Linux 运维 Skill

## When to use

- 用户请求处理 nginx / apache / systemd 服务相关问题
- 用户需要查看 journalctl 系统日志
- 用户需要配置 iptables 防火墙规则
- 用户报告服务启动失败 / 端口冲突 / 权限问题

触发关键词：nginx / systemctl / journalctl / iptables / service / 启动失败 / 端口 / 防火墙

## Steps

1. **风险评估**：调用 `risk` tool 评估用户命令的风险等级（L0-L4）
   - L0/L1：直接执行
   - L2/L3：自动审批（agent 模式）
   - L4：必须人工审批

2. **诊断服务状态**：
   - `systemctl status <service>` 查看服务当前状态
   - `journalctl -u <service> -n 100 --no-pager` 查看最近 100 行日志
   - `ss -tlnp | grep <port>` 检查端口占用

3. **定位根因**：
   - 端口冲突：`ss -tlnp | grep <port>`
   - 配置语法：`nginx -t` / `httpd -t` / `systemd-analyze verify`
   - 权限问题：`ls -la <path>` + `id` + `getenforce`

4. **修复 + 验证**：
   - 修改配置后用 `nginx -t` 验证语法
   - `systemctl restart <service>` 重启
   - `systemctl status <service>` 验证服务运行

5. **持久化**：`systemctl enable <service>` 设置开机自启

## Examples

### 示例 1：nginx 启动失败

```
用户: nginx 启动失败
Agent:
  1. risk: systemctl restart nginx → L3
  2. systemctl status nginx → "failed"
  3. journalctl -u nginx -n 100 → "bind() to 0.0.0.0:80 failed (98: Address already in use)"
  4. ss -tlnp | grep :80 → "PID 1234 apache2"
  5. systemctl stop apache2 && systemctl start nginx
  6. systemctl status nginx → "active (running)"
```

### 示例 2：iptables 防火墙规则

```
用户: 开放 8080 端口
Agent:
  1. risk: iptables -A INPUT -p tcp --dport 8080 -j ACCEPT → L3
  2. iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
  3. iptables -L INPUT -n --line-numbers → 验证规则已添加
  4. iptables-save > /etc/iptables/rules.v4 → 持久化
```

### 示例 3：journalctl 查日志

```
用户: 查看 sshd 最近的登录失败日志
Agent:
  1. journalctl -u sshd -n 200 --no-pager | grep -i "failed\|invalid"
  2. 输出最近 10 条失败登录记录
```
