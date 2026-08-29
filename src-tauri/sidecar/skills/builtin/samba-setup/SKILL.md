---
name: samba-setup
description: Samba 文件共享搭建与排障 Skill，覆盖 smb.conf 配置、smbpasswd 用户、SELinux 与防火墙联动及 Windows/Linux 客户端访问
version: 2.0.0
author: TDSF
tags: [samba, smb, cifs, file-sharing, linux, ops, selinux]
allowed-tools: [ssh_command, get_terminal_output, read_remote_file, remote_file, log_analyzer, suggest_command, knowledge_search, config_diff]
# TDSF 魔改 (P0-2 修复 2026-07-28): executor 让 Skill 真正可执行
# testparm -s = Samba 排障第一命令: 校验 smb.conf 语法并输出实际生效配置.
executor:
  type: shell
  command: "testparm -s"
  timeout: 5
  description: "校验 /etc/samba/smb.conf 语法并输出实际生效配置. 报错会给出具体段落与参数行; 未安装 Samba 时命令不存在自动降级."
---

# Samba 文件共享搭建与排障 Skill

## When to use

- 用户需要在 Linux 服务器上搭建 SMB/CIFS 文件共享（教学实验最高频场景之一）
- 用户配置 smb.conf 后 Windows 客户端无法访问共享
- 用户需要添加/管理 Samba 用户（smbpasswd）与共享目录权限
- 用户遇到共享 "Permission denied" / 只能看不能写 / 服务起不来
- RHEL 系机器上怀疑是 SELinux 或防火墙拦了 Samba

触发关键词：samba / smb / smb.conf / smbpasswd / testparm / smbstatus / cifs / 共享 / 网上邻居 / 文件共享 / smbd / nmb / \\\\ip\\share

## 核心概念

- **双守护进程**：`smbd`（监听 TCP 139/445，文件共享与认证主体）+ `nmbd`（UDP 137/138，NetBIOS 名称解析与浏览）——服务管理通常是 `systemctl enable --now smb nmb`（Debian 系服务名为 smbd/nmbd）。
- **smb.conf 三段式**：`[global]` 全局（workgroup / security = user / hosts allow）+ 各自定义共享段（`[shared]` 等）+ 特殊段 `[homes]`（自动共享各用户家目录）。文件在 `/etc/samba/smb.conf`。
- **Samba 用户库独立**：Samba 自己维护一份"用户+密码"（Trusted DB），必须先有同名系统用户（`useradd`），再用 `smbpasswd -a` 注册进 Samba——系统密码与 SMB 密码互不相干。
- **写权限三道门**：客户端能否写 = `writable yes`（Samba 层）∧ 文件系统权限（chmod/chown）∧ SELinux（`samba_share_t`）——三道门全开才能写，缺一即 Permission denied。
- **SELinux 联动**（RHEL 系必查）：共享自定义目录需 `samba_share_t` 标签；共享家目录需布尔 `samba_enable_home_dirs`。Debian/Ubuntu 默认无 SELinux，跳过此项。
- **testparm**：官方配置校验器，改完 smb.conf **必须先 testparm 再重启服务**——它输出的是"实际生效"的配置（含默认值展开）。

## 常用命令速查

### 配置与校验

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `testparm` | 校验 smb.conf 语法+输出生效配置 | `-s` 不按回车直接输出（脚本友好） |
| `testparm -s /path/other.conf` | 校验指定文件 | 备份配置对比时用 |
| `rpm -q samba` / `dpkg -l samba` | 确认安装与版本 | RHEL 系 / Debian 系 |

### 服务与用户管理

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `systemctl enable --now smb nmb` | 启动并设自启 | Debian 系服务名为 smbd nmbd |
| `smbpasswd -a <user>` | 注册 Samba 用户并设 SMB 密码 | `-x` 删除用户 |
| `pdbedit -L` | 列出已注册的 Samba 用户 | `-v` 详细 |
| `smbstatus` | 查看当前连接/会话/被锁文件 | — |
| `smbclient -L localhost -U <user>` | 本机枚举共享列表（自测金标准） | `-N` 匿名 |

### 客户端访问

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `mount -t cifs //IP/shared /mnt -o user=smbuser` | Linux 挂载共享 | `uid=,gid=` 指定本地属主、`vers=3.0` 指定协议版本 |
| `umount /mnt` | 卸载 | 忙时 `umount -l` 懒卸载 |
| `net use * /delete` | Windows 清空凭据缓存 | 换账号重连前必做（管理员 CMD） |
| `smbget smb://IP/shared/file` | 命令行取文件 | 类 wget 语法 |

### SELinux / 防火墙（RHEL 系联动）

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `semanage fcontext -a -t samba_share_t '/srv/samba/shared(/.*)?'` | 永久标签规则 | 之后必须 restorecon |
| `restorecon -Rv /srv/samba/shared` | 应用标签 | `-R` 递归 |
| `setsebool -P samba_enable_home_dirs on` | 允许共享家目录 | `-P` 持久 |
| `firewall-cmd --permanent --add-service=samba && firewall-cmd --reload` | 防火墙放行 | 等价放行 139/445/tcp |

## Steps

**前置动作——风险评估**：testparm/pdbedit -L/smbstatus/smbclient -L 为 L1 只读；安装/`smbpasswd -a`/修改 smb.conf 为 L2；`systemctl stop smb nmb`/`smbpasswd -x`/防火墙移除规则为 L3（影响服务可用性）。

**场景 1：从零搭建一个标准共享（教学主线）**

```
1. 安装: yum install samba samba-client -y (RHEL) / apt install samba -y (Debian)
2. 建目录与权限:
   mkdir -p /srv/samba/shared
   groupadd smbusers && useradd -s /sbin/nologin -G smbusers smbuser
   chown root:smbusers /srv/samba/shared && chmod 2775 /srv/samba/shared  (setgid 保证组继承)
3. smb.conf 追加共享段:
   [shared]
       comment = Teaching Share
       path = /srv/samba/shared
       browseable = yes
       writable = yes
       valid users = @smbusers
       create mask = 0664
       directory mask = 0775
4. testparm -s                    → 语法必须零报错
5. smbpasswd -a smbuser           → 注册 Samba 用户（系统用户已存在）
6. SELinux (RHEL 系):
   semanage fcontext -a -t samba_share_t '/srv/samba/shared(/.*)?' && restorecon -Rv /srv/samba/shared
7. 防火墙: firewall-cmd --permanent --add-service=samba && firewall-cmd --reload
8. systemctl enable --now smb nmb
9. 自测: smbclient -L localhost -U smbuser → 共享列表可见; smbclient //localhost/shared -U smbuser
   → 's:/> put test.txt' 写入成功 = 服务端全通
```

**场景 2：Windows 访问不了 / 被拒（分层排查）**

```
1. 服务端自测: smbclient -L localhost -U smbuser → 通 = 问题在客户端/网络; 不通 = 服务端问题
2. 服务端不通 → testparm -s(语法/参数) → systemctl status smb nmb → ss -tlnp | grep -E ':(139|445)'
3. 客户端不通 → ping IP → firewall-cmd --list-all(放行 samba?) → 云主机安全组
4. "Permission denied" → pdbedit -L(用户注册了吗) → 共享段 valid users 包含该用户/组吗
   → 文件系统权限(ls -ld) → SELinux: ausearch -m AVC -ts recent | grep smb
5. Windows 凭据缓存串号 → net use * /delete → 重连并重新输入账号
6. smbstatus → 确认连接建立与读写正常
```

**场景 3：能看不能写**

```
1. testparm -s | grep -A6 shared → writable = yes 在吗; valid users 对吗
2. ls -ld /srv/samba/shared → 目录对 smbuser 或其组可写吗（2775 + 组正确）
3. ls -Zd /srv/samba/shared → RHEL 系须 samba_share_t（非则按速查表打标签）
4. 修复对应层 → Windows 重试写入 → smbstatus 确认
```

## Examples

### 示例 1：基础匿名只读共享

```
用户: 搭一个所有人可读的软件共享目录
Agent:
  1. rpm -q samba → 未安装 → risk: yum install samba -y (L2) → 执行
  2. mkdir -p /srv/samba/public 并放入测试文件
  3. smb.conf: [public] 段 public = yes + writable = no（匿名只读）
  4. testparm -s → 语法 OK
  5. risk: systemctl enable --now smb nmb + firewall-cmd 放行 (L2)
  6. smbclient -L localhost → 共享列表可见; Windows \\IP\public 只读可浏览
```

### 示例 2：Windows 提示 Permission denied

```
用户: \\192.168.1.10\shared 打开提示无权限
Agent:
  1. smbclient -L localhost -U smbuser → 服务端正常 → 问题在认证/权限层
  2. pdbedit -L → 列表里没有 smbuser → 根因: 只建了系统用户没注册 Samba
  3. risk: smbpasswd -a smbuser (L2) → 设置密码
  4. Windows: net use * /delete 清缓存 → 重连 \\192.168.1.10\shared → 成功
```

### 示例 3：RHEL 系写入失败（SELinux）

```
用户: Samba 配置与文件权限都正确，但写入失败
Agent:
  1. getenforce → "Enforcing" → 纳入 SELinux 怀疑
  2. ausearch -m AVC -ts recent | grep smb → denied 记录指向写操作
  3. ls -Zd /srv/samba/shared → "default_t"（应为 samba_share_t）
  4. risk: semanage fcontext -a -t samba_share_t '/srv/samba/shared(/.*)?' (L2)
  5. restorecon -Rv /srv/samba/shared → 客户端重试写入 → 成功
```

## 易错点

- **smbpasswd 用户必须有系统账户**：直接 `smbpasswd -a 新名字` 会报 "Failed to add entry"——先 `useradd` 再 `smbpasswd -a`。
- **改 smb.conf 不跑 testparm**：一个拼写错误就能让 smbd 起不来或整段共享失效——testparm 是唯一安全的预检。
- **writable = yes 不等于能写**：Samba 层放行后还有文件系统权限和 SELinux 两道门（RHEL 系 default_t 一律拒写），"能看不能写"按三道门逐层查。
- **防火墙忘放行 / 只放行 445**：NetBIOS 浏览还要 UDP 137/138——用 `--add-service=samba` 一次放全，别手敲端口漏项。
- **Windows 凭据缓存**：Windows 会缓存 SMB 会话，服务端改完权限客户端仍被拒时，先 `net use * /delete` 清缓存再重连。
- **家目录共享没开布尔**：`[homes]` 段在 RHEL 系默认被 SELinux 拦——`setsebool -P samba_enable_home_dirs on`。
- **服务名差异**：RHEL 系 `smb nmb`，Debian 系 `smbd nmbd`——跨发行版教学脚本要兼容。

## 验证方法

- 服务端：`systemctl is-active smb nmb` 均 active；`ss -tlnp | grep -E ':(139|445)'` 有监听；`testparm -s` 无报错。
- 本机回环：`smbclient -L localhost -U <user>` 列出共享；`smbclient //localhost/<share> -U <user>` 可 put/get。
- Linux 客户端：`mount -t cifs //IP/<share> /mnt -o user=<user>` 成功 → 触摸文件可见 → `umount`。
- Windows 客户端：`\\IP\<share>` 可浏览可读写；`smbstatus` 在服务端看到该会话与打开的文件。
- 全链路：写入的文件在服务端 `ls -l` 属主/属组正确（setgid 目录保证组继承）。

## 参考

- Samba 官方文档总入口：https://www.samba.org/samba/docs/
- smb.conf(5) 官方手册（全部参数权威定义）：https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html
- mount.cifs(8) 官方手册：https://www.samba.org/samba/docs/current/man-html/mount.cifs.8.html
- RHEL 9《Configuring and using Samba》：https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/9/html/configuring_and_using_samba/index
- Samba SELinux 布尔与标签官方说明（RHEL 文档内章节）：https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/9/html/using_selinux/index
