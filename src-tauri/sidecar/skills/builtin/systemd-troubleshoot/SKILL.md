---
name: systemd-troubleshoot
description: systemd 服务故障排查 Skill，覆盖 failed 服务定位、journalctl 日志分析、unit 文件修改与开机自启管理
version: 2.0.0
author: TDSF
tags: [systemd, service, journalctl, systemctl, linux, ops]
allowed-tools: [ssh_command, get_terminal_output, read_remote_file, log_analyzer, suggest_command, knowledge_search]
# TDSF 魔改 (P0-2 修复 2026-07-28): executor 让 Skill 真正可执行
# systemctl list-units --state=failed = 排障第一命令: 一屏列出所有 failed 单元.
executor:
  type: shell
  command: "systemctl list-units --type=service --state=failed"
  timeout: 5
  description: "列出所有 failed 状态的服务. 无输出行 + '0 loaded units listed' 说明当前没有失败服务."
---

# systemd 服务故障排查 Skill

## When to use

- 用户报告服务启动失败 / 异常退出 / `systemctl status` 显示 **failed**
- 用户遇到 "Job for xxx.service failed because the control process exited with error code"
- 用户需要查看服务日志定位报错原因（journalctl 深度使用）
- 用户需要修改 unit 文件（override / 依赖 / 资源限制）后不生效
- 用户需要配置开机自启或排查服务启动顺序
- 服务反复重启（restart loop）或启动很慢

触发关键词：systemctl / systemd / journalctl / service / unit / daemon-reload / enable / status / failed / inactive / 服务 / 开机自启 / 启动失败 / restart loop

## 核心概念

- **unit（单元）**：systemd 管理的基本对象，类型由后缀区分——`.service` 服务、`.socket` 套接字、`.timer` 定时器、`.target` 目标组（类似旧运行级别）。日常排障 90% 是 service。
- **unit 文件查找顺序**：`/etc/systemd/system/`（管理员，优先）> `/run/systemd/system/`（运行时）> `/usr/lib/systemd/system/`（软件包安装）。`systemctl cat <unit>` 显示实际生效内容与 override。
- **journal（日志）**：systemd 二进制日志（`/var/log/journal/` 或 `/run/log/journal/`），`journalctl` 统一查询；带索引，可按 unit / 优先级 / 时间窗过滤。
- **daemon-reload**：unit 文件被增删改后，systemd **不会自动重读**——必须 `systemctl daemon-reload` 刷新管理器配置，再 restart 服务才生效。
- **依赖与顺序**：`After=` 只管启动顺序；`Requires=` 强依赖（对方失败则本服务也停）；`Wants=` 弱依赖（尽力拉起）。配置错会导致启动顺序问题。
- **enable vs start**：`enable` 只建自启符号链接（不会立即启动）；`enable --now` = enable + start；`mask` 则把 unit 链接到 /dev/null 彻底禁起（比 disable 更强硬）。

## 常用命令速查

### 状态查询（只读）

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `systemctl status nginx` | 服务状态+主 PID+最近日志行 | `-l` 不截断长行 |
| `systemctl list-units --type=service --state=failed` | 列出全部 failed 服务 | `--all` 含 inactive |
| `systemctl is-active nginx` / `is-enabled nginx` | 单点快速判断 | 退出码可用于脚本 |
| `systemctl cat nginx` | 查看实际生效的 unit 内容（含 override） | — |
| `systemctl list-dependencies nginx` | 列出依赖树 | `--reverse` 看谁依赖我 |

### 日志（journalctl）

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `journalctl -u nginx -n 50 --no-pager` | 某服务最近 50 行 | `-r` 倒序（最新在上） |
| `journalctl -xeu nginx` | 带解释的最新日志（排障首选） | `-x` 补充说明、`-e` 跳到末尾 |
| `journalctl -u nginx --since "1 hour ago" --no-pager` | 时间窗过滤 | `--until "2026-08-29 12:00"`、`-b` 本次开机起 |
| `journalctl -u nginx -f` | 实时跟踪（tail -f 等价） | Ctrl-C 退出 |
| `journalctl -p err -b --no-pager` | 本次开机所有 err 级及以上 | `-p warning` 更宽 |

### 管理操作（变更类）

| 命令 | 作用 | 常用参数 |
|------|------|----------|
| `systemctl restart nginx` | 重启 | `reload` 重读配置不断连（支持的服务） |
| `systemctl enable --now nginx` | 自启+立即启动 | `disable` 取消自启 |
| `systemctl daemon-reload` | 重读全部 unit 文件 | 改 unit 后必执行 |
| `systemctl edit nginx` | 创建 override（drop-in） | `--full` 编辑完整 unit 副本 |
| `systemctl mask nginx` / `unmask` | 彻底禁起 / 解禁 | 链接到 /dev/null，防被依赖拉起 |
| `systemd-analyze verify /etc/systemd/system/myapp.service` | 校验 unit 语法 | 报错含行号 |

## Steps

**前置动作——风险评估**：status/cat/is-active/list-units/journalctl 为 L1 只读；start/stop/restart/reload 为 L2（改变运行态）；disable/mask 及 daemon-reload+restart 组合为 L3（影响开机自启或全局），须说明影响。

**场景 1：服务启动失败（标准排查链）**

```
1. systemctl status <svc>           → 记下 active/failed、退出码(status=1/FAILURE)、最近日志
2. journalctl -xeu <svc> --no-pager → 读完整报错（-x 会给官方解释）
3. 按报错分型处理:
   a. 配置语法错 → systemd-analyze verify <unit> / 应用自带校验(nginx -t / sshd -t)
   b. 端口被占   → ss -tlnp | grep <port> 找占用进程 → 停占用者或改端口
   c. 依赖未起   → systemctl list-dependencies <svc> → 核对 After=/Requires=
   d. 权限/路径  → 核对 User=/ExecStart= 路径存在性, ls -l 查属主权限
   e. 资源限制   → journalctl -u <svc> | grep -i oom → 调 MemoryMax=
4. 修复 unit 后: systemctl daemon-reload && systemctl restart <svc>
5. systemctl status <svc> → active (running) 验证
```

**场景 2：改了配置不生效（最高频踩坑）**

```
1. systemctl cat <svc> → 看实际生效内容（含 drop-in override 路径）
2. 分辨改的是什么:
   - unit 文件([Unit]/[Service] 段) → 必须 daemon-reload → restart
   - 应用自身配置(如 nginx.conf)   → restart 或 reload 即可
3. systemctl edit <svc> 建 override（优于直接改 /usr/lib 下的原文件, 升级不丢）
4. daemon-reload + restart → systemctl show <svc> -p <改动属性> 确认已生效
```

**场景 3：开机自启不生效**

```
1. systemctl is-enabled <svc> → disabled? enabled? masked?
2. disabled → systemctl enable <svc>（建符号链接）
3. masked → systemctl unmask <svc>（先解禁）
4. enabled 但开机没起 → journalctl -b -u <svc> 看启动时刻报错（多为依赖顺序/启动失败）
5. 重启机器或 systemctl start <svc> 实测
```

## Examples

### 示例 1：nginx 启动失败（端口占用）

```
用户: nginx 起不来，status 显示 failed
Agent:
  1. systemctl status nginx → "code=exited, status=1/FAILURE"
  2. journalctl -xeu nginx --no-pager → "bind() to 0.0.0.0:80 failed (98: Address already in use)"
  3. ss -tlnp | grep :80 → httpd 占用
  4. 给出两案: 停 httpd / nginx 改端口 → 用户选 A → risk: systemctl stop httpd (L2)
  5. systemctl restart nginx → active (running) + curl -I localhost 验证 200
```

### 示例 2：改 unit 加环境变量不生效

```
用户: 给 myapp 加了 Environment= 但程序读不到
Agent:
  1. systemctl cat myapp → override 写在 /etc/systemd/system/myapp.service.d/override.conf
  2. 询问得知改完没 reload → 解释: unit 变化必须 daemon-reload
  3. risk: systemctl daemon-reload && systemctl restart myapp → L2
  4. systemctl show myapp -p Environment → 环境变量已生效
```

### 示例 3：服务反复重启（restart loop）

```
用户: myapp 一直自动重启
Agent:
  1. systemctl show myapp -p NRestarts,Restart → "NRestarts=12, Restart=on-failure"
  2. journalctl -u myapp -b --no-pager | grep -B2 -A5 -i error → Python ImportError
  3. 修复依赖 → restart → 稳定运行
  4. 建议: Restart=on-failure 配 StartLimitIntervalSec/StartLimitBurst 防无限重启
```

## 易错点

- **改 unit 后必须 `daemon-reload`**：systemd 缓存 unit 内容，不 reload 则 edit/cat 的修改永远不生效——这是本技能最高频的坑。
- **`enable` 不等于立即启动**：它只管开机自启；要现在就跑用 `enable --now` 或补一条 `start`。
- **journalctl 默认进分页器**：管道/脚本里必须加 `--no-pager`，否则卡在 less 等待交互。
- **`reload` 与 `restart` 区别**：支持的服务（如 nginx）`reload` 重读配置不断连接；不支持 reload 的服务会报错——先 `systemctl cat` 或文档确认。
- **`mask` 比 `disable` 强硬**：mask 后连手动 start 都被拒（unit 链接到 /dev/null），常用于"确保某服务永远不起"；忘记 unmask 会莫名无法启动。
- **直接改 `/usr/lib/systemd/system/` 原文件**：软件包升级会覆盖丢失——规范做法是 `systemctl edit` 生成 `/etc/systemd/system/<svc>.d/override.conf`。

## 验证方法

- 状态：`systemctl is-active <svc>` 返回 active；`systemctl status` 无报错行、主 PID 稳定不跳变。
- 日志：`journalctl -u <svc> --since "5 min ago" --no-pager` 无新 error/traceback。
- 属性：`systemctl show <svc> -p <属性>` 确认 unit 修改已加载（如 Environment、Restart）。
- 自启：`systemctl is-enabled <svc>` 返回 enabled；重启机器后服务自动 running（`systemd-analyze critical-chain <svc>` 可看启动链耗时）。

## 参考

- systemd.unit(5) 官方手册（unit 文件权威定义）：https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html
- systemctl(1) 官方手册：https://man7.org/linux/man-pages/man1/systemctl.1.html
- journalctl(1) 官方手册：https://man7.org/linux/man-pages/man1/journalctl.1.html
- systemd 官方项目主页（文档总入口）：https://www.freedesktop.org/wiki/Software/systemd/
- RHEL 9《Configuring basic system settings》systemd 章节：https://access.redhat.com/documentation/en-us/red_hat_enterprise_linux/9/html/configuring_basic_system_settings/assembly_working-with-systemd_configuring-basic-system-settings
