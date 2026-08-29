---
name: ssh-troubleshoot
description: SSH 连接故障排查 Skill，按网络、服务、认证、known_hosts 四层定位连接超时、拒绝与认证失败问题
version: 2.0.0
author: TDSF
tags: [ssh, network, auth, troubleshooting, sshd, key]
# 注: 本技能保持无 executor 的"知识卡"形态 (与 T1 设计一致) —— registry.invoke 走
# 知识卡分支返回完整正文, 且 test_invoke_knowledge_card_carries_metadata 以本技能
# 作为知识卡路径的唯一真实载体. 服务端排障第一命令为 `systemctl status sshd --no-pager`.
---

# SSH 连接故障排查 Skill

## When to use

- 用户报告 SSH **连接超时** / Connection refused / Connection reset
- 用户报告认证失败（Permission denied (publickey/password)）
- 用户遇到 known_hosts 冲突（WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!）
- 用户需要配置 SSH 免密登录（密钥对 + ssh-copy-id）
- 用户报告 SSH 登录很慢（卡在连接阶段数十秒才出提示）
- 需要读懂 `ssh -vvv` 的详细握手输出

触发关键词：ssh / scp / sftp / sshd / 连接超时 / Connection refused / 认证失败 / Permission denied / known_hosts / 免密 / 密钥 / ssh-copy-id / 端口 22

## 核心概念

- **分层模型**：SSH 连通问题自下而上分四层——网络层（IP 可达？）→ 传输层（22 端口开？）→ 服务层（sshd 正常？）→ 认证层（密钥/密码对？）。**逐层排查，别跳步**。
- **密钥认证三要素**：客户端私钥（`~/.ssh/id_ed25519`，权限 600）、服务端公钥登记（`~/.ssh/authorized_keys`）、服务端 sshd 开启 `PubkeyAuthentication yes`——三者任一不满足即 publickey 失败。
- **known_hosts**：客户端记录的"主机指纹通讯录"；服务端重装/换 IP 后指纹变化会触发警告（也可能是中间人攻击，先核实再清）。
- **sshd_config**：服务端配置 `/etc/ssh/sshd_config`，改后必须 `systemctl reload sshd`（reload 不断开已有连接，restart 也不断已建立会话）。
- **服务名差异**：RHEL/CentOS/Rocky 为 `sshd`；Debian/Ubuntu 为 `ssh`——`systemctl status` 前先确认发行版。
- **Permission denied 语义**：ssh 客户端的 "Permission denied" 是认证层失败；系统层面的 "Permission denied" 是文件权限——别混淆。

## 常用命令速查

### 网络与端口层

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `ping -c 4 <host>` | IP 可达性（超时=网络层断） | `-c N` 限包数 |
| `nc -zv <host> 22` | 端口可达性（refused=端口关） | `-w 3` 超时秒数 |
| `traceroute <host>` | 路由路径定位断点 | `-n` 不做 DNS 反查（更快） |
| `ss -tlnp \| grep :22` | 服务端确认 sshd 在监听 | `-tlnp` = TCP+监听+数字+进程 |

### 服务层

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `systemctl status sshd` | sshd 运行状态 | `--no-pager` 脚本友好 |
| `systemctl enable --now sshd` | 启动并设开机自启 | 等价 enable + start |
| `journalctl -u sshd -n 50 --no-pager` | 服务端日志（认证失败会记来源 IP） | `-f` 实时跟踪 |
| `sshd -t` | 校验 sshd_config 语法 | 无输出=语法正确 |

### 客户端诊断与密钥管理

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `ssh -vvv user@host` | 三级详细输出定位握手卡点 | `-v` 一级 / `-vv` 二级 |
| `ssh -p 2222 user@host` | 指定非标准端口 | 服务端改过 Port 时必带 |
| `ls -la ~/.ssh/` | 检查密钥权限 | 私钥须 600、目录须 700 |
| `chmod 700 ~/.ssh && chmod 600 ~/.ssh/id_ed25519` | 修正权限 | authorized_keys 须 600 |
| `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""` | 生成密钥对 | `-C "备注"` 加注释 |
| `ssh-copy-id -i ~/.ssh/id_ed25519.pub user@host` | 一键登记公钥 | 等价手工追加 authorized_keys |
| `ssh-keygen -R <host>` | 清除 known_hosts 旧指纹 | 指纹变更告警时使用 |

## Steps

**场景 1：连接超时 / Connection refused（网络层诊断起步的分层排查）**

```
1. ping -c 4 <host>        → 不通 = 网络层问题（IP 错/机器关机/ICMP 被禁则跳 2）
2. nc -zv <host> 22        → refused = 端口层问题 → 到服务端查
3. systemctl status sshd   → dead → systemctl enable --now sshd；failed → journalctl -u sshd 看报错
4. ss -tlnp | grep :22     → 确认监听 0.0.0.0:22（只监听 127.0.0.1 则查 ListenAddress）
5. firewall-cmd --list-all → firewalld 未放行 ssh 则 --permanent --add-service=ssh && --reload
6. ssh user@host 验证恢复
```

**场景 2：Permission denied (publickey)（认证层）**

```
1. ssh -vvv user@host → 看三处关键行:
   - "Authentications that can continue: publickey" = 服务端只收密钥(关了密码)
   - "Offering public key ... denied" = 服务端拒了这把钥匙
   - "no such identity" = 客户端没找到密钥(查 ~/.ssh 与 -i 参数)
2. 客户端: ls -la ~/.ssh/ → 私钥 644 是最常见根因 → chmod 600
3. 服务端: cat ~/.ssh/authorized_keys → 公钥在不在; ls -ld ~/.ssh → 必须 700 且属主正确
4. 服务端配置: grep -E "PubkeyAuthentication|PermitRootLogin|AuthorizedKeysFile" /etc/ssh/sshd_config
5. 修复后 systemctl reload sshd → ssh user@host 验证
（服务端看不到原因时: 临时 LogLevel VERBOSE, journalctl -u sshd 会写明拒绝理由）
```

**场景 3：known_hosts 指纹冲突**

```
1. 报错 "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!" → 先核实:
   服务端是否重装系统/换 IP/换机器？→ 是 → 正常, 走步骤 2；否 → 怀疑中间人, 停止连接人工确认
2. ssh-keygen -R <host>            → 清除旧指纹
3. ssh user@host → 提示接受新指纹 → yes → 连接成功
```

## Examples

### 示例 1：连接超时（服务未启动）

```
用户: ssh user@192.168.1.100 卡住超时
Agent:
  1. ping 192.168.1.100 → 通（网络层 OK）
  2. nc -zv 192.168.1.100 22 → "Connection refused"（端口层问题）
  3. 到服务端: systemctl status sshd → "inactive (dead)"
  4. risk: systemctl enable --now sshd → L2 → 执行
  5. ss -tlnp | grep :22 → 监听出现 → ssh 重连成功
```

### 示例 2：认证失败（密钥权限过宽）

```
用户: ssh 报 Permission denied (publickey)
Agent:
  1. ssh -vvv user@host → "Offering public key /home/u/.ssh/id_rsa ... denied"
  2. ls -la ~/.ssh/ → id_rsa 权限 644（过宽，sshd 拒绝使用）
  3. risk: chmod 600 ~/.ssh/id_rsa → L1 → 执行
  4. ssh user@host → 免密登录成功
```

### 示例 3：配置免密登录

```
用户: 配置到 192.168.1.100 的免密登录
Agent:
  1. ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" → 生成密钥对
  2. ssh-copy-id -i ~/.ssh/id_ed25519.pub user@192.168.1.100 → 输一次密码登记公钥
  3. ssh user@192.168.1.100 'echo OK' → 输出 OK 无需密码
```

## 易错点

- **私钥权限过宽被拒**：sshd 要求私钥不能组/其他可读，644 会直接不使用该钥匙——`chmod 600`，`.ssh` 目录 700。
- **authorized_keys 属主或权限错**：即使公钥正确，`.ssh` 非 700 / `authorized_keys` 非 600 / 属主不是登录用户，publickey 都会失败——`restorecon`（SELinux 机器上 `~/.ssh` 标签也要对）。
- **改 sshd_config 忘 reload**：配置改了不生效；且 `sshd -t` 校验语法后再 reload，避免 reload 失败把服务弄挂。
- **服务名搞错**：RHEL 系 `sshd`、Debian 系 `ssh`，`systemctl status sshd` 在 Ubuntu 会报 not found——先确认发行版。
- **Root 登录被策略拦**：`PermitRootLogin prohibit-password`（默认）允许 root 用密钥但拒绝密码；想禁 root 直接 `no`——登录失败先核对这条。
- **ssh-keygen -R 只动客户端**：它只清本地 known_hosts，不会改服务端任何东西；指纹告警先核实变更原因再清除，别盲目 yes。

## 验证方法

- 连通：`ssh user@host 'echo OK'` 输出 OK（免交互命令即返回）。
- 认证：`ssh -v user@host 2>&1 | grep -i "authenticated"` 出现 "Authenticated to ... using publickey"。
- 服务端：`journalctl -u sshd -n 20 --no-pager` 出现 "Accepted publickey/password for <user>"。
- 自启：`systemctl is-enabled sshd` 返回 enabled，重启机器后仍可直连。

## 参考

- OpenSSH 官方手册页总索引：https://www.openssh.com/manual.html
- ssh(1) 客户端 man 页：https://man7.org/linux/man-pages/man1/ssh.1.html
- sshd(8) 服务端 man 页：https://man7.org/linux/man-pages/man8/sshd.8.html
- ssh-keygen(1) man 页：https://man7.org/linux/man-pages/man1/ssh-keygen.1.html
- Arch Wiki OpenSSH（实践向配置指南）：https://wiki.archlinux.org/title/OpenSSH
