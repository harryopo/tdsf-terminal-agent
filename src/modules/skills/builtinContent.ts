// TDSF 魔改: builtin skill 的 SKILL.md 原文内容
// -----------------------------------------------------------------------------
// 当 Python sidecar 不可用（IPC 降级）时，registry.getBuiltinSkills() 返回的
// SkillMetadata 仍可通过 rawContent 字段提供 SKILL.md 完整内容，让
// SkillContentDialog 能预览 skill 内容，避免"内容为空"的尴尬体验。
//
// 内容来源：src-tauri/sidecar/skills/builtin/<name>/SKILL.md
// 维护规则：修改 SKILL.md 后需同步更新本文件（保持一致）。
//
// 注意：模板字符串内的反引号需用 \` 转义，$ 需用 \$ 转义避免插值。

/** docker-management skill 的 SKILL.md 原文 */
export const DOCKER_MANAGEMENT_CONTENT = `---
name: docker-management
description: Docker 管理 Skill，处理容器/镜像/网络/卷/Compose 等任务
version: 1.0.0
author: TDSF
tags: [docker, container, devops, compose]
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
   - \`docker rm -f\` / \`docker system prune -a\` → L4（必须人工审批）
   - \`docker run --privileged\` → L4
   - \`docker stop/restart\` → L3
   - \`docker ps/logs/exec\` → L1（只读）

2. **容器诊断**：
   - \`docker ps -a\` 列出所有容器（含已停止）
   - \`docker logs --tail 100 <container>\` 查看日志
   - \`docker inspect <container>\` 查看详细配置
   - \`docker exec -it <container> sh\` 进入容器

3. **镜像管理**：
   - \`docker images\` 列出本地镜像
   - \`docker pull <image>:<tag>\` 拉取镜像
   - \`docker rmi <image>\` 删除镜像
   - \`docker build -t <name>:<tag> .\` 构建镜像

4. **网络 + 卷**：
   - \`docker network ls\` / \`docker network create <name>\`
   - \`docker volume ls\` / \`docker volume create <name>\`
   - \`docker network inspect <name>\` 查看网络详情

5. **Compose 编排**：
   - \`docker-compose up -d\` 启动
   - \`docker-compose down\` 停止 + 删除
   - \`docker-compose logs -f <service>\` 跟踪日志
   - \`docker-compose config\` 验证 yml 语法

## Examples

### 示例 1：容器启动失败

\`\`\`
用户: nginx 容器启动失败
Agent:
  1. docker ps -a | grep nginx → "Exited (1) 5s ago"
  2. docker logs nginx → "bind() to 0.0.0.0:80 failed"
  3. ss -tlnp | grep :80 → "host apache2"
  4. docker run -d -p 8080:80 --name nginx nginx:alpine
  5. docker ps | grep nginx → "Up 10s"
\`\`\`

### 示例 2：清理无用镜像

\`\`\`
用户: 清理 Docker 占用空间
Agent:
  1. risk: docker system prune -a → L4（需审批）
  2. [等待用户审批]
  3. docker system df → 显示当前占用
  4. docker system prune -a --volumes → 清理
  5. docker system df → 显示清理后占用
\`\`\`

### 示例 3：Compose 调试

\`\`\`
用户: docker-compose 启动失败
Agent:
  1. docker-compose config → "ERROR: service 'web' depends on undefined service 'db'"
  2. 编辑 docker-compose.yml 修正 services.db 定义
  3. docker-compose config → OK
  4. docker-compose up -d → 启动成功
\`\`\`
`;

/** linux-ops skill 的 SKILL.md 原文 */
export const LINUX_OPS_CONTENT = `---
name: linux-ops
description: Linux 运维 Skill，处理 nginx/systemd/journalctl/iptables 等常见运维任务
version: 1.0.0
author: TDSF
tags: [linux, ops, nginx, systemd, journalctl, iptables]
---

# Linux 运维 Skill

## When to use

- 用户请求处理 nginx / apache / systemd 服务相关问题
- 用户需要查看 journalctl 系统日志
- 用户需要配置 iptables 防火墙规则
- 用户报告服务启动失败 / 端口冲突 / 权限问题

触发关键词：nginx / systemctl / journalctl / iptables / service / 启动失败 / 端口 / 防火墙

## Steps

1. **风险评估**：调用 \`risk\` tool 评估用户命令的风险等级（L0-L4）
   - L0/L1：直接执行
   - L2/L3：自动审批（agent 模式）
   - L4：必须人工审批

2. **诊断服务状态**：
   - \`systemctl status <service>\` 查看服务当前状态
   - \`journalctl -u <service> -n 100 --no-pager\` 查看最近 100 行日志
   - \`ss -tlnp | grep <port>\` 检查端口占用

3. **定位根因**：
   - 端口冲突：\`ss -tlnp | grep <port>\`
   - 配置语法：\`nginx -t\` / \`httpd -t\` / \`systemd-analyze verify\`
   - 权限问题：\`ls -la <path>\` + \`id\` + \`getenforce\`

4. **修复 + 验证**：
   - 修改配置后用 \`nginx -t\` 验证语法
   - \`systemctl restart <service>\` 重启
   - \`systemctl status <service>\` 验证服务运行

5. **持久化**：\`systemctl enable <service>\` 设置开机自启

## Examples

### 示例 1：nginx 启动失败

\`\`\`
用户: nginx 启动失败
Agent:
  1. risk: systemctl restart nginx → L3
  2. systemctl status nginx → "failed"
  3. journalctl -u nginx -n 100 → "bind() to 0.0.0.0:80 failed (98: Address already in use)"
  4. ss -tlnp | grep :80 → "PID 1234 apache2"
  5. systemctl stop apache2 && systemctl start nginx
  6. systemctl status nginx → "active (running)"
\`\`\`

### 示例 2：iptables 防火墙规则

\`\`\`
用户: 开放 8080 端口
Agent:
  1. risk: iptables -A INPUT -p tcp --dport 8080 -j ACCEPT → L3
  2. iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
  3. iptables -L INPUT -n --line-numbers → 验证规则已添加
  4. iptables-save > /etc/iptables/rules.v4 → 持久化
\`\`\`

### 示例 3：journalctl 查日志

\`\`\`
用户: 查看 sshd 最近的登录失败日志
Agent:
  1. journalctl -u sshd -n 200 --no-pager | grep -i "failed\\|invalid"
  2. 输出最近 10 条失败登录记录
\`\`\`
`;

/** python-debug skill 的 SKILL.md 原文 */
export const PYTHON_DEBUG_CONTENT = `---
name: python-debug
description: Python 调试 Skill，处理异常追踪、pdb 调试、性能分析、虚拟环境、依赖冲突等问题
version: 1.0.0
author: TDSF
tags: [python, debug, pdb, profiling, venv, pip]
---

# Python 调试 Skill

## When to use

- 用户报告 Python 脚本抛出异常 / Traceback
- 用户需要使用 pdb / ipdb 断点调试
- 用户需要性能分析（ cProfile / timeit / py-spy ）
- 用户遇到 ModuleNotFoundError / ImportError 依赖问题
- 用户需要排查虚拟环境冲突 / 包版本不兼容
- 用户需要内存分析（ tracemalloc / objgraph ）

触发关键词：python / pip / venv / virtualenv / poetry / traceback / exception / pdb / ipdb / cProfile / profile / ModuleNotFoundError / ImportError

## Steps

1. **风险评估**：
   - \`pip uninstall -y <pkg>\` → L3（移除依赖可能影响其他包）
   - \`pip install --upgrade\` → L2（可能引入不兼容变更）
   - \`python -m pip install <pkg>\` → L1（仅安装）
   - \`python <script>.py\` / \`python -c "..."\` → L1（执行用户代码）
   - \`python -m pdb\` / \`python -m cProfile\` → L1（只读分析）

2. **Traceback 分析**：
   - 提取完整 Traceback（从 \`Traceback (most recent call last):\` 开始）
   - 定位最后一个 \`File "xxx", line N, in <module>\` 帧
   - 提取异常类型 + 消息（如 \`ModuleNotFoundError: No module named 'requests'\`）
   - 查询异常类型对应的常见原因 + 修复方案

3. **依赖诊断**：
   - \`python -c "import sys; print(sys.executable)"\` → 确认当前解释器
   - \`python -c "import sys; print(sys.path)"\` → 检查模块搜索路径
   - \`pip list\` / \`pip show <pkg>\` → 查看已安装包 + 版本
   - \`pip check\` → 检测依赖冲突
   - \`python -m pipdeptree\` → 包依赖树（需安装 pipdeptree）

4. **虚拟环境管理**：
   - \`python -m venv .venv\` → 创建虚拟环境
   - \`source .venv/bin/activate\`（Linux） / \`.venv\\Scripts\\activate\`（Windows）
   - \`which python\` / \`where python\` → 确认激活成功
   - \`deactivate\` → 退出虚拟环境
   - \`pip install -r requirements.txt\` → 安装依赖

5. **pdb 断点调试**：
   - 在代码中插入 \`breakpoint()\`（Python 3.7+）
   - \`python -m pdb <script>.py\` → 从头调试
   - 常用命令：\`n\`（next）、\`s\`（step）、\`c\`（continue）、\`p <var>\`（print）、\`l\`（list）、\`b <line>\`（break）、\`q\`（quit）
   - 事后调试：\`python -m pdb -c continue <script>.py\`（异常时进入 pdb）

6. **性能分析**：
   - \`python -m cProfile -o profile.out <script>.py\` → 生成 profile
   - \`python -c "import pstats; pstats.Stats('profile.out').sort_stats('cumulative').print_stats(20)"\` → 查看 top 20
   - \`python -m timeit -n 1000 -r 5 "<code>"\` → 微基准测试
   - \`py-spy record -o profile.svg --pid <pid>\` → 火焰图（需安装 py-spy）

7. **内存分析**：
   - 在代码中插入：
     \`\`\`python
     import tracemalloc
     tracemalloc.start()
     # ... 业务代码 ...
     snapshot = tracemalloc.take_snapshot()
     for stat in snapshot.statistics('lineno')[:10]:
         print(stat)
     \`\`\`
   - \`python -c "import objgraph; objgraph.show_most_common_types()"\` → 对象类型统计

## Examples

### 示例 1：ModuleNotFoundError

\`\`\`
用户: 运行脚本报 ModuleNotFoundError: No module named 'requests'
Agent:
  1. python -c "import sys; print(sys.executable)" → "/usr/bin/python3"（非虚拟环境）
  2. pip list | grep requests → 无输出（未安装）
  3. risk: pip install requests → L1
  4. pip install requests
  5. python <script>.py → 运行成功
\`\`\`

### 示例 2：依赖冲突

\`\`\`
用户: pip install 包 A 后包 B 报 ImportError
Agent:
  1. pip check → "pkg-a 1.0 requires pkg-b>=2.0, but you have pkg-b 1.0"
  2. pip show pkg-a → "Requires: pkg-b (>=2.0)"
  3. pip show pkg-b → "Version: 1.0"
  4. risk: pip install --upgrade pkg-b → L2
  5. pip install --upgrade pkg-b
  6. pip check → "No broken requirements found"
  7. python <script>.py → 成功
\`\`\`

### 示例 3：pdb 断点调试

\`\`\`
用户: 脚本在第 50 行报错，需要查看变量值
Agent:
  1. 在第 50 行前插入 breakpoint()
  2. python <script>.py
  3. (Pdb) p user_data  → {'name': 'Alice', 'age': 30}
  4. (Pdb) p user_data['email']  → KeyError: 'email'  ← 找到根因
  5. 修复代码：user_data.get('email', 'unknown')
  6. (Pdb) c  → 继续执行
  7. 运行成功
\`\`\`

### 示例 4：性能分析

\`\`\`
用户: 脚本运行 30s 太慢，需要优化
Agent:
  1. python -m cProfile -o profile.out <script>.py
  2. python -c "import pstats; pstats.Stats('profile.out').sort_stats('cumulative').print_stats(10)"
  3. 输出 top 10 函数：
     - process_data: 25.2s (4000 次调用)
     - json.loads: 4.5s (50000 次调用)
     - re.match: 0.3s (50000 次调用)
  4. 分析：process_data 调用次数过多，需批处理
  5. 优化后重新 profile → 5.2s（5 倍加速）
\`\`\`

### 示例 5：虚拟环境隔离

\`\`\`
用户: 项目 A 依赖 Django 3，项目 B 依赖 Django 4，互相冲突
Agent:
  1. cd ~/project_a && python -m venv .venv
  2. source .venv/bin/activate
  3. pip install django==3.2
  4. cd ~/project_b && python -m venv .venv
  5. source .venv/bin/activate
  6. pip install django==4.2
  7. 两项目独立运行，互不影响
\`\`\`
`;

/** selinux-baseline skill 的 SKILL.md 原文 */
export const SELINUX_BASELINE_CONTENT = `---
name: selinux-baseline
description: SELinux 基线排查 Skill，处理 Enforcing/Permissive 切换、AVC denied、bool/label/fcontext 等问题
version: 1.0.0
author: TDSF
tags: [selinux, security, avc, label, boolean]
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
   - \`setenforce 0\` / \`setenforce 1\` → L3（影响全局安全姿态）
   - \`semanage port/port/login/fcontext -m -d\` → L3（删除策略）
   - \`semodule -r\` → L4（卸载策略模块，需人工审批）
   - \`getenforce\` / \`sestatus\` / \`getsebool\` / \`ls -Z\` → L1（只读）

2. **确认当前模式**：
   - \`getenforce\` → 输出 Enforcing / Permissive / Disabled
   - \`sestatus\` → 详细策略版本 + 模式
   - \`getsebool -a\` → 列出所有布尔值

3. **AVC denied 分析**：
   - \`journalctl -t setroubleshoot -n 50 --no-pager\` → 查看 SELinux 拒绝事件
   - \`ausearch -m AVC -ts recent\` → 按时间检索 AVC 审计
   - \`sealert -l <uuid>\` → 解析 AVC 详细原因 + 建议修复
   - \`audit2allow -a -w\` → 预览将要生成的策略
   - \`audit2why -a\` → 解释 AVC 原因

4. **上下文修复**（不修改策略）：
   - \`ls -Z <path>\` → 查看当前上下文
   - \`restorecon -Rv <path>\` → 恢复默认上下文
   - \`chcon -t httpd_sys_content_t <path>\` → 临时修改（重启失效）
   - \`semanage fcontext -a -t httpd_sys_content_t '<path>(/.*)?'\` → 永久规则
   - \`restorecon -Rv <path>\` → 应用新规则

5. **端口标签管理**：
   - \`semanage port -l | grep <port>\` → 查看端口标签
   - \`semanage port -a -t http_port_t -p tcp <port>\` → 添加端口标签
   - \`semanage port -m -t http_port_t -p tcp <port>\` → 修改端口标签

6. **布尔值管理**：
   - \`getsebool -a | grep <keyword>\` → 查询布尔值
   - \`setsebool -P httpd_can_network_connect on\` → 永久开启
   - \`setsebool httpd_can_network_connect on\` → 临时开启（重启失效）

7. **持久化策略**（最后手段）：
   - \`audit2allow -a -m <module_name> > <module_name>.te\`
   - \`checkmodule -M -m -o <module_name>.mod <module_name>.te\`
   - \`semodule_package -o <module_name>.pp -m <module_name>.mod\`
   - \`semodule -i <module_name>.pp\` → 安装策略模块

## Examples

### 示例 1：nginx 访问非标准端口被拒

\`\`\`
用户: nginx 监听 8080 启动失败，日志显示 AVC denied
Agent:
  1. risk: setenforce 0 → L3（仅诊断用，不实际执行）
  2. getenforce → "Enforcing"
  3. journalctl -t setroubleshoot -n 20 → "nginx 被拒绝绑定 8080 端口"
  4. semanage port -l | grep 8080 → "无对应标签"
  5. risk: semanage port -a -t http_port_t -p tcp 8080 → L3
  6. semanage port -a -t http_port_t -p tcp 8080
  7. systemctl restart nginx → "active (running)"
\`\`\`

### 示例 2：httpd 访问家目录被拒

\`\`\`
用户: httpd 无法访问 /home/user/web 目录
Agent:
  1. ls -Z /home/user/web → "user_home_t"
  2. risk: semanage fcontext -a -t httpd_sys_content_t '/home/user/web(/.*)?' → L3
  3. semanage fcontext -a -t httpd_sys_content_t '/home/user/web(/.*)?'
  4. restorecon -Rv /home/user/web
  5. systemctl restart httpd → 成功访问
\`\`\`

### 示例 3：生成自定义策略模块

\`\`\`
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
\`\`\`

### 示例 4：临时降级排查（Permissive）

\`\`\`
用户: 怀疑是 SELinux 问题，临时关闭确认
Agent:
  1. risk: setenforce 0 → L3（仅本次会话有效，重启恢复）
  2. setenforce 0
  3. 重现问题 → 问题消失 → 确认是 SELinux 导致
  4. setenforce 1 → 恢复 Enforcing
  5. 后续按示例 1/2/3 修复根因
\`\`\`
`;

/** ssh-troubleshoot skill 的 SKILL.md 原文 */
export const SSH_TROUBLESHOOT_CONTENT = `---
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
   - \`ping <host>\` 验证网络连通性
   - \`nc -zv <host> 22\` 验证 SSH 端口可达
   - \`traceroute <host>\` 排查网络路由

2. **SSH 服务端诊断**：
   - \`systemctl status sshd\` 查看 sshd 服务状态
   - \`journalctl -u sshd -n 100\` 查看 SSH 服务日志
   - \`ss -tlnp | grep :22\` 验证端口监听

3. **认证层诊断**：
   - \`ssh -v <user>@<host>\` 启用 verbose 模式查看握手过程
   - 检查客户端密钥权限：\`ls -la ~/.ssh/\`（要求 600/700）
   - 检查服务端 authorized_keys：\`cat ~/.ssh/authorized_keys\`
   - 检查 sshd_config：\`grep -E "PubkeyAuthentication|PasswordAuthentication" /etc/ssh/sshd_config\`

4. **known_hosts 处理**：
   - 主机指纹变化时：\`ssh-keygen -R <host>\` 清除旧指纹
   - 重新连接并接受新指纹

5. **性能优化**：
   - 关闭 DNS 反查：\`UseDNS no\`
   - 关闭 GSSAPI：\`GSSAPIAuthentication no\`
   - 启用压缩：\`Compression yes\`

## Examples

### 示例 1：连接超时

\`\`\`
用户: ssh user@192.168.1.100 连接超时
Agent:
  1. ping 192.168.1.100 → 通
  2. nc -zv 192.168.1.100 22 → "Connection refused"
  3. systemctl status sshd → "inactive (dead)"
  4. systemctl start sshd → "active (running)"
  5. ssh user@192.168.1.100 → 成功连接
\`\`\`

### 示例 2：认证失败（密钥）

\`\`\`
用户: Permission denied (publickey)
Agent:
  1. ssh -v user@host → "Authentications that can continue: publickey"
  2. ls -la ~/.ssh/ → "id_rsa 644"（权限过宽）
  3. chmod 600 ~/.ssh/id_rsa
  4. ssh user@host → 成功
\`\`\`

### 示例 3：免密登录配置

\`\`\`
用户: 配置到 192.168.1.100 的免密登录
Agent:
  1. ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
  2. ssh-copy-id -i ~/.ssh/id_ed25519.pub user@192.168.1.100
  3. ssh user@192.168.1.100 'echo OK' → "OK"（无需密码）
\`\`\`
`;

/**
 * builtin skill name → SKILL.md 原文映射
 *
 * registry.getBuiltinSkills() 通过此映射填充 rawContent 字段，
 * 让 SkillContentDialog 在降级模式下也能预览内容。
 */
export const BUILTIN_CONTENT_MAP: Record<string, string> = {
  "docker-management": DOCKER_MANAGEMENT_CONTENT,
  "linux-ops": LINUX_OPS_CONTENT,
  "python-debug": PYTHON_DEBUG_CONTENT,
  "selinux-baseline": SELINUX_BASELINE_CONTENT,
  "ssh-troubleshoot": SSH_TROUBLESHOOT_CONTENT,
};
