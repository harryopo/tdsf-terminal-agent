---
name: selinux-baseline
description: SELinux 基线排查 Skill，处理 Enforcing/Permissive 切换、AVC denied、bool/label/fcontext 等问题
version: 1.1.0
author: TDSF
tags: [selinux, security, avc, label, boolean]
# TDSF 魔改 (P0-2 修复 2026-07-28): 添加 executor 字段, 让 Skill 真正可执行
# 默认执行 getenforce + sestatus 简版. 失败 (Windows 或无 selinux) 时输出友好提示.
executor:
  type: shell
  command: "getenforce"
  timeout: 5
  description: "查询当前 SELinux 模式 (Enforcing/Permissive/Disabled). Windows 环境下命令会失败, 输出会自动降级."
---

# SELinux 基线排查 Skill

## When to use

- 用户报告服务因 SELinux 拒绝访问（ AVC denied ）
- 用户需要查看 / 切换 SELinux 模式（ Enforcing / Permissive / Disabled ）
- 用户需要调整文件 / 端口 / 布尔值上下文标签
- 用户需要持久化 SELinux 策略（ audit2allow / semodule ）
- 用户遇到 "Permission denied" 但传统权限位无误

触发关键词：selinux / SELinux / AVC / denied / getenforce / setenforce / semanage / audit2allow / restorecon / chcon / 布尔值 / boolean / 上下文 / context

## Steps

1. **风险评估**：
   - `setenforce 0` / `setenforce 1` → L3（影响全局安全姿态）
   - `semanage port/port/login/fcontext -m -d` → L3（删除策略）
   - `semodule -r` → L4（卸载策略模块，需人工审批）
   - `getenforce` / `sestatus` / `getsebool` / `ls -Z` → L1（只读）

2. **确认当前模式**：
   - `getenforce` → 输出 Enforcing / Permissive / Disabled
   - `sestatus` → 详细策略版本 + 模式
   - `getsebool -a` → 列出所有布尔值

3. **AVC denied 分析**：
   - `journalctl -t setroubleshoot -n 50 --no-pager` → 查看 SELinux 拒绝事件
   - `ausearch -m AVC -ts recent` → 按时间检索 AVC 审计
   - `sealert -l <uuid>` → 解析 AVC 详细原因 + 建议修复
   - `audit2allow -a -w` → 预览将要生成的策略
   - `audit2why -a` → 解释 AVC 原因

4. **上下文修复**（不修改策略）：
   - `ls -Z <path>` → 查看当前上下文
   - `restorecon -Rv <path>` → 恢复默认上下文
   - `chcon -t httpd_sys_content_t <path>` → 临时修改（重启失效）
   - `semanage fcontext -a -t httpd_sys_content_t '<path>(/.*)?'` → 永久规则
   - `restorecon -Rv <path>` → 应用新规则

5. **端口标签管理**：
   - `semanage port -l | grep <port>` → 查看端口标签
   - `semanage port -a -t http_port_t -p tcp <port>` → 添加端口标签
   - `semanage port -m -t http_port_t -p tcp <port>` → 修改端口标签

6. **布尔值管理**：
   - `getsebool -a | grep <keyword>` → 查询布尔值
   - `setsebool -P httpd_can_network_connect on` → 永久开启
   - `setsebool httpd_can_network_connect on` → 临时开启（重启失效）

7. **持久化策略**（最后手段）：
   - `audit2allow -a -m <module_name> > <module_name>.te`
   - `checkmodule -M -m -o <module_name>.mod <module_name>.te`
   - `semodule_package -o <module_name>.pp -m <module_name>.mod`
   - `semodule -i <module_name>.pp` → 安装策略模块

## Examples

### 示例 1：nginx 访问非标准端口被拒

```
用户: nginx 监听 8080 启动失败，日志显示 AVC denied
Agent:
  1. risk: setenforce 0 → L3（仅诊断用，不实际执行）
  2. getenforce → "Enforcing"
  3. journalctl -t setroubleshoot -n 20 → "nginx 被拒绝绑定 8080 端口"
  4. semanage port -l | grep 8080 → "无对应标签"
  5. risk: semanage port -a -t http_port_t -p tcp 8080 → L3
  6. semanage port -a -t http_port_t -p tcp 8080
  7. systemctl restart nginx → "active (running)"
```

### 示例 2：httpd 访问家目录被拒

```
用户: httpd 无法访问 /home/user/web 目录
Agent:
  1. ls -Z /home/user/web → "user_home_t"
  2. risk: semanage fcontext -a -t httpd_sys_content_t '/home/user/web(/.*)?' → L3
  3. semanage fcontext -a -t httpd_sys_content_t '/home/user/web(/.*)?'
  4. restorecon -Rv /home/user/web
  5. systemctl restart httpd → 成功访问
```

### 示例 3：生成自定义策略模块

```
用户: 自定义应用 /opt/app/bin/server 持续 AVC denied
Agent:
  1. ausearch -m AVC -ts recent > /tmp/avc.log
  2. audit2why -a < /tmp/avc.log → 解释原因
  3. audit2allow -a -m myapp > myapp.te
  4. checkmodule -M -m -o myapp.mod myapp.te
  5. semodule_package -o myapp.pp -m myapp.mod
  6. risk: semodule -i myapp.pp → L4（需人工审批）
  7. [等待用户审批]
  8. semodule -i myapp.pp → 安装完成
  9. systemctl restart myapp → 运行正常
```

### 示例 4：临时降级排查（Permissive）

```
用户: 怀疑是 SELinux 问题，临时关闭确认
Agent:
  1. risk: setenforce 0 → L3（仅本次会话有效，重启恢复）
  2. setenforce 0
  3. 重现问题 → 问题消失 → 确认是 SELinux 导致
  4. setenforce 1 → 恢复 Enforcing
  5. 后续按示例 1/2/3 修复根因
```
