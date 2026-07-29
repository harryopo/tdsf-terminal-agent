---
name: ssh-troubleshoot
description: SSH 故障排查 Skill，处理连接超时/认证失败/known_hosts/密钥管理等问题
version: 1.0.0
author: TDSF
tags: [ssh, network, auth, troubleshooting]
---

# SSH 故障排查 Skill

## When to use

- 用户报告 SSH 连接超时 / Connection refused
- 用户报告认证失败 / Permission denied
- 用户遇到 known_hosts 冲突（HOSTKEY 主机指纹变化）
- 用户需要配置 SSH 免密登录
- 用户报告 SSH 慢 / 卡顿

触发关键词：ssh / scp / sftp / 连接超时 / 认证失败 / known_hosts / 免密 / 密钥

## Steps

1. **网络层诊断**：
   - `ping <host>` 验证网络连通性
   - `nc -zv <host> 22` 验证 SSH 端口可达
   - `traceroute <host>` 排查网络路由

2. **SSH 服务端诊断**：
   - `systemctl status sshd` 查看 sshd 服务状态
   - `journalctl -u sshd -n 100` 查看 SSH 服务日志
   - `ss -tlnp | grep :22` 验证端口监听

3. **认证层诊断**：
   - `ssh -v <user>@<host>` 启用 verbose 模式查看握手过程
   - 检查客户端密钥权限：`ls -la ~/.ssh/`（要求 600/700）
   - 检查服务端 authorized_keys：`cat ~/.ssh/authorized_keys`
   - 检查 sshd_config：`grep -E "PubkeyAuthentication|PasswordAuthentication" /etc/ssh/sshd_config`

4. **known_hosts 处理**：
   - 主机指纹变化时：`ssh-keygen -R <host>` 清除旧指纹
   - 重新连接并接受新指纹

5. **性能优化**：
   - 关闭 DNS 反查：`UseDNS no`
   - 关闭 GSSAPI：`GSSAPIAuthentication no`
   - 启用压缩：`Compression yes`

## Examples

### 示例 1：连接超时

```
用户: ssh user@192.168.1.100 连接超时
Agent:
  1. ping 192.168.1.100 → 通
  2. nc -zv 192.168.1.100 22 → "Connection refused"
  3. systemctl status sshd → "inactive (dead)"
  4. systemctl start sshd → "active (running)"
  5. ssh user@192.168.1.100 → 成功连接
```

### 示例 2：认证失败（密钥）

```
用户: Permission denied (publickey)
Agent:
  1. ssh -v user@host → "Authentications that can continue: publickey"
  2. ls -la ~/.ssh/ → "id_rsa 644"（权限过宽）
  3. chmod 600 ~/.ssh/id_rsa
  4. ssh user@host → 成功
```

### 示例 3：免密登录配置

```
用户: 配置到 192.168.1.100 的免密登录
Agent:
  1. ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
  2. ssh-copy-id -i ~/.ssh/id_ed25519.pub user@192.168.1.100
  3. ssh user@192.168.1.100 'echo OK' → "OK"（无需密码）
```
