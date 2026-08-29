---
name: linux-ops
description: Linux 运维总纲 Skill，覆盖文件、权限、进程、服务、日志、磁盘、网络的日常运维全景与通用排障方法论
version: 2.0.0
author: TDSF
tags: [linux, ops, nginx, systemd, journalctl, disk, network, permission]
# TDSF 魔改 (P0-2 修复 2026-07-28): executor 让 Skill 真正可执行
# uptime = 运维"登录第一命令"：负载、在线时长、登录用户一屏速览。
executor:
  type: shell
  command: "uptime"
  timeout: 5
  description: "查看系统负载与运行时长（运维晨检第一命令）. 输出 load average 1/5/15 分钟均值, 超过 CPU 核数说明过载."
---

# Linux 运维总纲 Skill

## When to use

本技能是**日常运维的入口总纲**：当问题横跨多个领域、或暂时无法归类时，先用本技能做全景诊断，再转入专项技能（systemd-troubleshoot / selinux-baseline / ssh-troubleshoot / docker-management / samba-setup）。

- 用户请求处理 nginx / httpd 等服务的运维问题（启动失败 / 端口 / 配置）
- 用户需要查看 journalctl 或 /var/log 下的系统日志
- 用户报告磁盘满 / 内存吃紧 / 负载过高 / CPU 占用异常
- 用户遇到 Permission denied / 文件权限 / 属主问题
- 用户需要配置防火墙规则（firewalld / iptables）或查看网络连通性
- 教学场景：Linux 运维入门课程的"每天登录服务器该做什么"

触发关键词：nginx / systemctl / journalctl / df / du / ps / top / chmod / chown / ss / 防火墙 / 磁盘 / 负载 / 权限 / 启动失败 / 端口

## 核心概念

- **FHS 目录结构**：`/etc` 配置、`/var/log` 日志、`/var/lib` 状态数据、`/home` 用户数据、`/tmp` 临时文件——找配置去 /etc、找日志去 /var/log 是运维第一反射。
- **权限模型（ugo/rwx）**：每个文件有 属主(u)/属组(g)/其他(o) 三组 读(r=4)/写(w=2)/执行(x=1) 权限；`chmod 755` = 属主 rwx、组和其他 r-x；`chown user:group` 改属主属组。
- **进程与信号**：每个进程有 PID；`kill <pid>` 发 SIGTERM（15，优雅退出），`kill -9` 发 SIGKILL（强制，可能丢数据，最后手段）。
- **服务管理（systemd）**：现代发行版统一用 `systemctl` 管理服务、`journalctl` 查日志——详见 systemd-troubleshoot 技能。
- **journal 与传统日志**：`journalctl` 查 systemd 二进制日志；`/var/log/messages`（RHEL）、`/var/log/syslog`（Debian）是传统文本日志。
- **防火墙**：RHEL 系默认 firewalld（`firewall-cmd`），Debian 系常用 ufw，底层 iptables/nftables——放行端口是"服务通不通"排查的必查项。

## 常用命令速查

### 文件与查找

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `ls -lah` | 列目录（含隐藏+人类可读大小） | `-R` 递归、`-t` 按时间排序 |
| `find /var -name "*.log" -mtime +7` | 按名/时间找文件 | `-size +100M` 按大小、`-type f` 只找文件 |
| `grep -rn "error" /etc/nginx/` | 递归搜文本 | `-i` 忽略大小写、`-v` 反选、`-E` 扩展正则 |
| `cp -a src dst` | 复制（保留权限/时间戳） | `-r` 递归、`-i` 覆盖前确认 |
| `rm -i file` | 删除（逐个确认） | `-r` 递归删目录（高危，先确认路径） |
| `du -sh /var/*` | 统计各子目录总大小 | `-h` 人类可读、`--max-depth=1` 只看一层 |
| `tar -czvf backup.tar.gz /etc` | 打包压缩 | `-xzf` 解压、`-C /tmp` 指定目标目录 |

### 权限与属主

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `chmod 644 file` | 改权限位 | `-R` 递归、`u+x` 给属主加执行 |
| `chown nginx:nginx file` | 改属主属组 | `-R` 递归 |
| `id <user>` | 查用户 uid/gid/附属组 | 无参=当前用户 |
| `sudo -l` | 列出当前用户可执行的 sudo 命令 | — |

### 进程与资源

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `ps aux --sort=-%mem` | 按内存排序的进程列表 | `--sort=-%cpu` 按 CPU 排序 |
| `top` | 实时资源监控 | `P` 按 CPU 排 / `M` 按内存排 / `q` 退出 |
| `kill <pid>` | 优雅终止进程 | `-9` 强杀（最后手段） |
| `df -h` | 各挂载点磁盘使用率 | `-i` 看 inode 使用率（小文件耗尽场景） |
| `free -h` | 内存使用概览 | `-s 2` 每 2 秒刷新 |
| `uptime` | 负载与运行时长 | 负载 > CPU 核数 = 过载 |

### 网络与连通

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `ip addr` | 查看 IP 地址 | `ip route` 看路由表 |
| `ss -tlnp` | 查 TCP 监听端口+进程 | `-ulnp` 查 UDP、`grep :80` 过滤 |
| `ping -c 4 <host>` | 连通性测试 | `-c N` 限次数 |
| `curl -I http://localhost` | HTTP 响应头自测 | `-s` 静默、`-o /dev/null -w "%{http_code}"` 只看状态码 |
| `firewall-cmd --list-all` | 查看 firewalld 放行规则 | `--permanent --add-port=8080/tcp` + `--reload` 永久放行 |

## Steps

**通用排障方法论（任何问题先走这四步）**：

1. **风险评估**：调用 `risk` tool 评估命令风险等级（L0/L1 只读直接执行；L2/L3 变更类自动/提示审批；L4 破坏类必须人工审批）。
2. **现象确认**：用只读命令复现并量化问题（服务状态？端口通不通？磁盘/内存/负载哪项异常？）。
3. **定位根因**：沿着"现象 → 最近日志 → 配置核对"链路收窄范围（见下方场景）。
4. **修复 + 验证**：最小改动修复 → 用第 2 步的同一组只读命令验证恢复 → 必要时 `systemctl enable` 持久化。

**场景 1：磁盘满（df Use% 100%）**

```
1. df -h                          → 定位哪个挂载点满了（常为 / 或 /var）
2. du -sh /var/* 2>/dev/null | sort -rh | head   → 从满的挂载点向下找大目录
3. 常见元凶：
   - journal 日志: journalctl --disk-usage → journalctl --vacuum-size=200M
   - 应用日志: ls -lh /var/log/<app>/ → 截断 > truncate -s 0 big.log（勿删正被写的文件先确认）
   - 旧包缓存: yum clean all / apt clean
4. df -h                          → 复查使用率回落
```

**场景 2：服务启动失败 / 端口不通**

```
1. systemctl status <svc>         → 看 active/failed 与最近日志行
2. journalctl -u <svc> -n 50 --no-pager → 看完整报错
3. 按报错分类 → 转入 systemd-troubleshoot 技能深查
```

**场景 3：Permission denied**

```
1. ls -l <path> + id              → 核对权限位与当前用户/组是否匹配
2. 权限位无误仍拒绝 → getenforce  → 非 Disabled 则转入 selinux-baseline 技能查 AVC
```

## Examples

### 示例 1：nginx 启动失败（端口占用）

```
用户: nginx 启动失败
Agent:
  1. risk: systemctl status nginx → L1 只读
  2. systemctl status nginx → "failed (RESULT: address-already-in-use)"
  3. journalctl -u nginx -n 20 --no-pager → "bind() to 0.0.0.0:80 failed (98)"
  4. ss -tlnp | grep :80 → PID 1234 httpd 占用
  5. risk: systemctl stop httpd → L2 → 执行 → systemctl start nginx
  6. systemctl status nginx → "active (running)" + curl -I localhost → 200
```

### 示例 2：磁盘告警

```
用户: / 分区 95%
Agent:
  1. df -h → / 为 95%；du -sh /var/log/* | sort -rh → journal 占 4G
  2. risk: journalctl --vacuum-size=200M → L2 → 执行
  3. df -h → 回落到 71%；建议配置 SystemMaxUse 持久限制
```

### 示例 3：修改文件后服务读不到

```
用户: 改了配置但服务不认
Agent:
  1. ls -l /etc/app.conf → 属主 root，服务 User=app → chmod 640 + chown root:app
  2. systemctl restart app → status 恢复 active
```

## 易错点

- **`rm -rf $VAR/`**：变量为空时变成 `rm -rf /`——删除前先 `echo` 确认路径，高危命令必须 L4 审批。
- **`chmod -R 777`**：全网可写是安全隐患；正确做法是按需最小授权（如 755/640 + chown），目录用 `X` 而非 `x` 只给目录加执行位。
- **改了 unit 文件忘 `daemon-reload`**：systemd 不会自动重读 unit，必须 `systemctl daemon-reload` 后 restart。
- **`kill -9` 滥用**：先 `kill`（SIGTERM）给进程优雅收尾机会；数据库类进程强杀可能损坏数据。
- **删正被写打开的日志文件**：空间不会释放（fd 未关），用 `truncate -s 0` 或先重启写日志的服务。
- **混淆 sshd 服务名**：RHEL/CentOS 叫 `sshd`，Debian/Ubuntu 叫 `ssh`——跨发行版脚本要兼容。

## 验证方法

- 服务类：`systemctl status <svc>` 回到 `active (running)` + `systemctl is-enabled <svc>` 确认自启。
- 端口类：`ss -tlnp | grep <port>` 有监听 + `curl -I http://<host>:<port>` 返回预期状态码。
- 磁盘类：`df -h` 使用率回落到安全水位；`journalctl --disk-usage` 确认限额生效。
- 权限类：以目标用户身份实测（`sudo -u <user> cat <file>`）而非想当然。

## 参考

- Linux man-pages 项目（所有命令的权威手册）：https://man7.org/linux/man-pages/
- Red Hat Enterprise Linux 9 系统管理员文档：https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/9/html/administration_and_configuration_tasks
- Arch Wiki（发行版无关的高质量实践百科）：https://wiki.archlinux.org/
- firewalld 官方文档：https://firewalld.org/documentation/
