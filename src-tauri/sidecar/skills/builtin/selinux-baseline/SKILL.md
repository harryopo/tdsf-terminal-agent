---
name: selinux-baseline
description: SELinux 基线排查 Skill，处理 AVC denied、模式切换、文件与端口标签、布尔值及策略模块的生成与安装
version: 2.0.0
author: TDSF
tags: [selinux, security, avc, label, boolean, enforcing]
# TDSF 魔改 (P0-2 修复 2026-07-28): executor 让 Skill 真正可执行
# sestatus = SELinux 排障第一命令: 一屏给出模式/策略/配置文件模式.
executor:
  type: shell
  command: "sestatus"
  timeout: 5
  description: "查询 SELinux 完整状态（当前模式 Enforcing/Permissive/Disabled、策略版本、配置文件模式）. Windows 或未装 SELinux 时自动降级."
---

# SELinux 基线排查 Skill

## When to use

- 用户报告 "Permission denied"，但 `ls -l` 权限位与属主完全正确（十有八九是 SELinux）
- 服务日志出现 **AVC denied**（`avc: denied { ... }` 字样）
- 用户需要查看或切换 SELinux 模式（Enforcing / Permissive / Disabled）
- 用户需要调整文件上下文标签（chcon / restorecon / semanage fcontext）
- 服务监听非标准端口被拒（如 nginx 绑 8081 失败）
- 需要开启/关闭 SELinux 布尔值（如 httpd_can_network_connect）

触发关键词：selinux / AVC / denied / getenforce / setenforce / sestatus / semanage / restorecon / chcon / audit2allow / 布尔值 / boolean / 上下文 / context / Permission denied

## 核心概念

- **三种模式**：`Enforcing`（强制，拒绝违规并记日志）/ `Permissive`（宽容，只记日志不拒绝——诊断利器）/ `Disabled`（关闭，需改 /etc/selinux/config 并重启才能切换）。
- **安全上下文**：`user:role:type:level` 四元组，日常排障重点是第三段 **type**（如 `httpd_sys_content_t`、`samba_share_t`）——进程和文件各有上下文，策略只允许"进程 type → 文件 type"的既定组合。
- **targeted 策略**：RHEL/CentOS 默认策略，只对网络服务（nginx/httpd/samba/ftp 等）施加限制，普通用户进程基本不受限。
- **AVC（Access Vector Cache）拒绝**：SELinux 拦截违规访问时写入审计日志的记录，是排障的直接证据源。
- **布尔值（boolean）**：预置的策略开关（如 `httpd_can_network_connect` 控制 httpd 能否对外发起连接），比改策略模块安全得多——**先查布尔，再考虑改标签，最后才 audit2allow**。
- **文件上下文规则库**：`semanage fcontext` 写入规则库（持久），`restorecon` 按规则库重新打标签；`chcon` 只改眼前文件（重打标签即失效）。

## 常用命令速查

### 状态与模式

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `getenforce` | 输出当前模式（三个词之一） | — |
| `sestatus` | 完整状态：模式/策略/配置文件模式 | `-v` 含进程与文件上下文 |
| `setenforce 0` | 临时切 Permissive（重启失效） | `1` 切回 Enforcing |
| `cat /etc/selinux/config` | 查看开机默认模式 | 改 `SELINUX=` 行需重启生效 |

### 上下文查看与修复

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `ls -Z /var/www/html/` | 查看文件上下文 | `ps -Z` 查进程上下文、`id -Z` 查用户 |
| `restorecon -Rv /web` | 按规则库重打标签（修复首选） | `-R` 递归、`-v` 显示变更 |
| `chcon -t httpd_sys_content_t /web` | 临时改标签 | 重启/restorecon 后失效 |
| `semanage fcontext -a -t httpd_sys_content_t '/web(/.*)?'` | 永久标签规则 | `-m` 修改、`-l` 列出、`-d` 删除 |
| `semanage port -a -t http_port_t -p tcp 8081` | 给端口打标签 | `-l` 列出、`-m` 修改已存在项 |

### 布尔值

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `getsebool -a` | 列出所有布尔值 | 配合 `grep httpd` 过滤 |
| `setsebool -P httpd_can_network_connect on` | 永久开启（写策略） | 不加 `-P` 仅本次生效 |

### AVC 日志与策略生成

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `ausearch -m AVC -ts recent` | 检索 AVC 审计记录 | `-ts today` / `-ts 14:00` 起始时间 |
| `audit2why < /var/log/audit/audit.log` | 解释每条 AVC 的原因分类 | `-a` 读全部审计日志 |
| `audit2allow -a -w` | 预览建议的放行方式 | 先看建议再决定是否放行 |
| `audit2allow -a -m myapp` | 生成策略模块源码(.te) | 输出重定向到文件 |
| `semodule -l` | 列出已装策略模块 | `-i x.pp` 安装、`-r x` 卸载（L4） |

## Steps

**前置动作——风险评估**：只读查询（getenforce/sestatus/ls -Z/getsebool/ausearch）L1 直接执行；`setenforce`/`setsebool -P`/`semanage fcontext/port -a` 为 L3（影响全局安全姿态）；`semodule -i` 为 L4、`semodule -r` 必须人工审批。

**场景 1：服务报 "Permission denied"（标准排查链）**

```
1. ls -l <path> + id                    → 先排除传统权限位问题（属主/组/rwx）
2. getenforce                           → 输出 Enforcing 才继续；Disabled 则与 SELinux 无关
3. ausearch -m AVC -ts recent           → 找 denied 记录（comm="nginx" tclass="file" 等）
4. audit2why < /var/log/audit/audit.log → 给出分类: 标签缺失/布尔未开/策略缺失/端口未标
5. 按分类修复（优先级从高到低）:
   a. 标签错 → semanage fcontext -a -t <正确type> '<path>(/.*)?' && restorecon -Rv <path>
   b. 布尔关 → setsebool -P <相关布尔> on
   c. 端口未标 → semanage port -a -t <服务端口type> -p tcp <port>
   d. 确需放行 → audit2allow 生成模块（最后手段, 须审查 .te 内容）
6. 重现操作 → ausearch -m AVC -ts recent 确认无新记录
```

**场景 2：httpd/nginx 访问自定义目录**

```
1. ls -Z /webapp → "default_t"（非 httpd 可读类型）→ 确认根因
2. semanage fcontext -a -t httpd_sys_content_t '/webapp(/.*)?'
3. restorecon -Rv /webapp → ls -Z 复查已变为 httpd_sys_content_t
4. systemctl restart httpd → 页面可访问
（若目录要写: type 改 httpd_sys_rw_content_t；若仅诊断可先 setenforce 0 验证归因）
```

**场景 3：服务绑定非标准端口被拒**

```
1. journalctl -u nginx -n 20 | grep -i denied → "bind() to 0.0.0.0:8081" 类 AVC
2. semanage port -l | grep http_port_t → 确认 8081 不在列表
3. semanage port -a -t http_port_t -p tcp 8081
4. systemctl restart nginx → 监听成功（ss -tlnp 复查）
```

## Examples

### 示例 1：nginx 监听 8081 失败（端口标签）

```
用户: nginx 配置 8081 起不来，权限位没问题
Agent:
  1. getenforce → "Enforcing"
  2. ausearch -m AVC -ts recent → denied { name_bind } comm="nginx" → 端口类拒绝
  3. semanage port -l | grep 8081 → 无输出
  4. risk: semanage port -a -t http_port_t -p tcp 8081 → L2 → 执行
  5. systemctl restart nginx → active；ausearch -m AVC -ts recent 无新记录
```

### 示例 2：诊断归因（Permissive 临时法）

```
用户: 怀疑是 SELinux 拦的，先确认一下
Agent:
  1. risk: setenforce 0 → L3（仅临时诊断, 重启自动回 Enforcing）
  2. 重现问题 → 现象消失 → 归因 SELinux；现象仍在 → 排查传统权限/应用本身
  3. ausearch -m AVC -ts recent → 拿到具体 denied 记录用于修复
  4. risk: setenforce 1 → L3 → 恢复强制模式 → 按 Steps 场景 1 修复根因
```

### 示例 3：samba 共享目录写入被拒（配合 samba-setup）

```
用户: Samba 共享写不进，testparm 与文件权限都正常
Agent:
  1. ls -Z /srv/samba/shared → "default_t"（应为 samba_share_t）
  2. risk: semanage fcontext -a -t samba_share_t '/srv/samba/shared(/.*)?' → L2
  3. restorecon -Rv /srv/samba/shared → 标签修正
  4. 客户端重试写入 → 成功
```

## 易错点

- **`setenforce 0` 是临时的**：仅运行时生效，重启后按 `/etc/selinux/config` 回到 Enforcing——它只用于诊断归因，不是修复手段。
- **`chcon` 不持久**：重新打标签（restorecon / 自动 relabel）后即失效；要持久必须 `semanage fcontext` 写规则库再 `restorecon`。
- **`setsebool` 不加 `-P` 重启失效**：临时开关只活到下次重启，修复类操作一律带 `-P`。
- **Disabled ↔ Enforcing 不能在线互切**：从 Disabled 开启需要改配置文件并重启（首次可能触发全盘重打标签，耗时且风险高）；日常诊断用 Permissive 而不是关 SELinux。
- **`audit2allow` 别无脑装**：它会把"被拒绝的行为"全部合法化，可能把攻击面也放进去——先 `audit2why`/`-w` 理解原因，能靠标签/布尔/端口解决的就不要生成模块；`.te` 内容必须人工审查。
- **只删规则忘删标签**：`semanage fcontext -d` 删除规则后，已有文件的标签不会自动还原，需要再 `restorecon` 重打。

## 验证方法

- 模式与状态：`getenforce` 返回预期模式；`sestatus` 中 "SELinux status: enabled"。
- 标签：`ls -Z <path>` 显示预期 type；`semanage fcontext -l | grep <path>` 规则在库。
- 端口：`semanage port -l | grep <port>` 在列；服务 `ss -tlnp` 监听成功。
- 根本验证：重现原操作 → `ausearch -m AVC -ts recent` **无新增 denied 记录** → 修复生效。

## 参考

- Gentoo SELinux 维基（概念与流程讲解最清晰）：https://wiki.gentoo.org/wiki/SELinux
- RHEL 9 官方《Using SELinux》：https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/9/html/using_selinux/index
- Fedora SELinux 文档与故障排查：https://docs.fedoraproject.org/en-US/quick-docs/selinux-getting-started/
- man 页面：semanage(8) / restorecon(8) / audit2allow(1) / semanage-fcontext(8)：https://man7.org/linux/man-pages/
- NSA SELinux 项目主页（背景与架构）：https://www.nsa.gov/What-we-do/Research-and-Innovation/Code-and-Computer-Security/
