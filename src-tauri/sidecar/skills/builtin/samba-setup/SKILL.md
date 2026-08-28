---
name: samba-setup
description: Samba 文件共享服务配置与排障 Skill，覆盖安装、smb.conf 配置、用户管理、SELinux 联动与 Windows 客户端访问
version: 1.0.0
author: TDSF
tags: [samba, smb, file-sharing, linux, ops, selinux]
allowed-tools: [ssh_command, get_terminal_output, read_remote_file, remote_file, log_analyzer, suggest_command, knowledge_search, config_diff]
executor:
  type: shell
  command: "rpm -q samba 2>/dev/null || dpkg -l samba 2>/dev/null || echo 'samba not found'"
  timeout: 5
  description: "查询 Samba 是否已安装及版本. Windows 环境会输出 not found, 自动降级."
---

# Samba 文件共享服务配置与排障 Skill

## When to use

- 用户需要在 Linux 服务器上搭建 SMB/CIFS 文件共享
- 用户配置 smb.conf 后 Windows 客户端无法访问共享
- 用户需要添加/管理 Samba 用户与共享目录权限
- 用户遇到 "Permission denied" / 无法写入 / 域名解析失败等 Samba 问题
- 教学场景：Linux 服务管理课程中的 Samba 实验配置

触发关键词：samba / smb / smb.conf / smbpasswd / nmb / cifs / 共享 / 网上邻居 / 文件共享 / \\\\访问 / testparm

## Steps

1. **风险评估**：
   - `rpm -q samba / testparm / smbstatus / pdbedit -L` → L1（只读）
   - `yum install / dnf install samba` → L2（安装软件包）
   - 修改 smb.conf / 添加共享目录 → L2（配置变更，可回滚）
   - `smbpasswd -a <user>` → L2（新增用户凭据）
   - `systemctl stop smb nmb / firewall-cmd --remove-*` → L3（影响服务可用性）
   - `smbpasswd -x / pdbedit -x` → L3（删除用户）

2. **安装与状态确认**：
   - `rpm -q samba samba-client`（RHEL/CentOS）或 `dpkg -l samba`（Debian/Ubuntu）
   - 未安装：`yum install samba -y`（RHEL 系）→ L2
   - `systemctl status smb nmb` → 确认两个守护进程状态
   - `ss -tlnp | grep -E ':(139|445)'` → 确认监听端口

3. **配置 smb.conf**（主配置文件 /etc/samba/smb.conf）：
   - `[global]` 段：workgroup / server string / security = user / hosts allow
   - 共享段模板：
     ```
     [shared]
         comment = Teaching Share
         path = /srv/samba/shared
         browseable = yes
         writable = yes
         valid users = @smbusers
         create mask = 0664
         directory mask = 0775
     ```
   - `testparm` → **每次修改后必须校验语法**（只读，无副作用）
   - 修改后 `systemctl restart smb nmb`

4. **用户与权限管理**：
   - Samba 用户必须先存在系统账户：`useradd -s /sbin/nologin smbuser`
   - `smbpasswd -a smbuser` → 设置 SMB 密码（与系统密码独立）
   - `pdbedit -L` → 列出已启用的 Samba 用户
   - 目录权限：`chmod 2775 /srv/samba/shared` + `chown root:smbusers`
   - SELinux 联动（RHEL 系必查，配合 selinux-baseline skill）：
     - `semanage fcontext -a -t samba_share_t '/srv/samba/shared(/.*)?'`
     - `restorecon -Rv /srv/samba/shared`
     - 或共享家目录：`setsebool -P samba_enable_home_dirs on`

5. **防火墙放行**（访问不通必查）：
   - `firewall-cmd --permanent --add-service=samba` → `firewall-cmd --reload`
   - 或指定端口：139/tcp + 445/tcp（+137-138/udp 若需 NetBIOS）

6. **排障流程**（Windows 无法访问时）：
   - 服务端自测：`smbclient -L localhost -U smbuser` → 本地通则问题在客户端/网络
   - `testparm -s` → 确认配置实际生效
   - `smbstatus` → 查看当前连接与会话
   - 日志：`journalctl -u smb -n 50 --no-pager` / `/var/log/samba/log.*`
   - SELinux：`ausearch -m AVC -ts recent | grep smb` → 配合 selinux-baseline 处理
   - Windows 端：`\\<ip>\<share>` 访问；缓存凭据冲突用 `net use * /delete`

7. **验证闭环**：
   - Linux 挂载自测：`mount -t cifs //<ip>/<share> /mnt/test -o user=smbuser`
   - 写入测试文件 → 客户端可见 → 权限正确
   - `smbstatus` 确认连接建立

## Examples

### 示例 1：基础匿名只读共享搭建

```
用户: 搭一个所有人可读的软件共享目录
Agent:
  1. rpm -q samba → 未安装
  2. risk: yum install samba -y → L2 → 执行
  3. mkdir -p /srv/samba/public && cp 测试文件
  4. 写入 smb.conf 共享段（public = yes, writable = no）
  5. testparm → 语法 OK
  6. systemctl enable --now smb nmb
  7. firewall-cmd --permanent --add-service=samba && firewall-cmd --reload
  8. smbclient -L localhost → 共享列表可见
```

### 示例 2：Windows 访问 Permission denied

```
用户: Windows 输 \\192.168.1.10\shared 提示无权限
Agent:
  1. smbclient -L localhost -U smbuser → 本地正常 → 服务端配置问题
  2. testparm -s → writable = yes 但 valid users 未包含该用户
  3. pdbedit -L → 用户未注册
  4. smbpasswd -a smbuser → L2
  5. Windows 重新访问 → 成功（提示先 net use * /delete 清缓存）
```

### 示例 3：SELinux 导致无法写入

```
用户: Samba 配置正确但写入失败，传统权限无误
Agent:
  1. ausearch -m AVC -ts recent | grep smb → "samba_share_t" 缺失
  2. ls -Z /srv/samba/shared → "default_t"
  3. risk: semanage fcontext -a -t samba_share_t '/srv/samba/shared(/.*)?' → L3
  4. restorecon -Rv /srv/samba/shared
  5. 客户端重试写入 → 成功（配合 selinux-baseline skill 深入）
```

### 示例 4：多用户权限分组共享

```
用户: 教学班两个组分别共享目录，互不可见
Agent:
  1. groupadd class_a class_b；useradd -G class_a stu1...
  2. 两个共享段各自 valid users = @class_a / @class_b
  3. chmod 2770 + chown root:class_x（setgid 保证组继承）
  4. smbpasswd -a 逐个注册
  5. testparm + systemctl restart smb nmb
  6. 双账号客户端验证互相隔离
```
