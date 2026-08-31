---
source: archwiki
category: basic-ops
url: consolidated/basic-ops/系统核心概念（Arch Wiki）.md
title: 系统核心概念（Arch Wiki）
---

- 系统核心：`cgroups` 资源隔离，`cron` 定时，`D-Bus` 消息，`init`/`getty` 启动，`rsyslog`/`syslog-ng` 日志，`udisks` 设备。

**cgroups**：内核功能，管理/限制进程组。

- 查看：`systemd-cgls`、`systemd-cgtop`、`cat /proc/PID/cgroup`。
- 自定义 slice：`/etc/systemd/system/my.slice`：

```ini
[Slice]
CPUQuota=30%
```

改后 `daemon-reload`。服务 drop-in 可用：`MemoryMax=1G`、`Slice=my.slice`。
- 运行：`systemd-run --slice=my.slice command`；用户级加 `--user`，配置放 `~/.config/systemd/user/`。
- 控制器：cpu/io 需委派；memory/pids 可用；rdma/eBPF 不可用。关键参数：CPUQuota、MemoryMax、TasksMax。非 root 需 cgroups v2。
- 委派：`Delegate=cpu cpuset io` 放 `user@1000.service.d/delegate.conf`；验证 `cat /sys/fs/cgroup/user.slice/user-1000.slice/cgroup.controllers`。
- 调整：`systemctl set-property` 动态调整。
- **易错**：不加 `--runtime` 永久保存到 `/etc/systemd/system.control/`（系统）或 `~/.config/systemd/user.control/`（用户）。

- 改变资源属性并不总是立即生效（如 `TaskMax` 仅对新建进程生效）
- systemd 管理示例：切断所有用户会话网络：
  ```bash
  systemctl set-property user.slice IPAddressDeny=any
  ```

- 更低层管理用 cgroup 虚拟文件系统 + libcgroup 工具；systemd 不覆盖所有接口文件，只读读取无妨

- **单写者规则**：一个 cgroup 只能有一组程序写入，避免竞态；内核不强制但强烈建议。用 `Delegate=` 划定 systemd 停止管理子 cgroup 的边界

- **临时组**（ad hoc）仅用于测试，生产环境应通过 systemd 创建并设置 `Delegate=yes`

- 创建临时组命令（`groupname` 为 cgroup 名）：
  ```bash
  cgcreate -a user -t user -g memory,cpu:groupname
  ```
- cgroup v2 下 `memory,cpu` 参数无效，所有控制器都直接位于根 cgroup 下，可仅写 `cpu` 或 `\*`；创建后 `groupname` 下所有可调参数归该用户可写

---

- 核心工具：GNU/Linux 基础命令，多为 POSIX 扩展；文档来源：man pages、Info manuals、shell 内置 `help`、`--help` 参数
- 熟悉 Arch Linux 用户应掌握的实用工具列表参见 `intro(1)`

## 核心工具分类

**Shell 内建**
- `cd` — 切换目录

**GNU coreutils**
- `ls` — 列目录（替代：`tree`）
- `cat` — 输出文件内容（反向：`tac`）
- `mkdir` / `rmdir` — 建/删空目录
- `rm` — 删除文件/目录（替代：`shred`、`unlink`）
- `cp` / `mv` — 复制/移动
- `ln` — 创建硬/软链接
- `chown` / `chgrp` — 改属主/属组
- `chmod` — 改权限
- `dd` — 转换并复制文件
- `df` / `du` — 磁盘空间/目录占用

**归档与文本处理**
- `tar` — 归档器（GNU tar）
- `less` — 终端分页器
- `find` — 查找文件/目录（findutils；替代：`fd` 等）
- `diff` — 逐行比较文件（diffutils）
- `grep` — 按模式打印匹配行
- `sed` — 流编辑器（替代：`sd`）
- `awk` (gawk) — 模式扫描处理语言

**系统管理 (util-linux)**
- `dmesg` — 打印内核环形缓冲区
- `lsblk` — 列出块设备
- `mount` / `umount` — 挂载/卸载文件系统
- `su` — 切换用户（替代：`sudo`、`doas`）
- `kill` — 终止进程（替代：`pkill`、`killall`）

**进程/内存 (procps-ng)**
- `pgrep` — 按名称/属性查进程（`pidof`）
- `ps` — 显示进程信息（替代：`top`）
- `free` — 显示内存使用量

## 防数据丢失

- `rm`、`mv`、`cp` 默认不询问即覆盖/删除，均支持 `-i` 逐次确认
- 勿依赖 alias 自动加 `-i`：换系统/用户即失效，反致误删
- 根本防护：定期备份

## cron

基于时间的任务调度器，用于按指定时间/日期/间隔周期执行命令或脚本。Arch 默认不安装，基础系统使用 systemd timers。

### 安装

可选实现：cronie、fcron、dcron(AUR)、scron-git(AUR)。比较见 Gentoo:Cron。

### 配置

守护进程解析 crontab 文件。每个用户有独立 crontab；root 的 crontab 用于系统级任务，也可用 `/etc/crontab` 或 `/etc/cron.d/`。

### 启动

安装后默认不启用。以 cronie 为例：

```bash
systemctl enable --now cronie.service
```

查看 `/etc/cron.daily/` 等目录了解已有任务，启用服务会触发执行。

### 基本命令

不要直接编辑 crontab 文件，用 `crontab` 程序：

```bash
crontab -l                    # 查看当前用户的 crontab
crontab -e                    # 编辑
crontab -r                    # 删除全部
crontab saved_file            # 用文件覆盖
crontab -                     # 从标准输入覆盖
crontab -u user -e            # 编辑其他用户的 crontab（root）
```

**易错点**：
- 编辑必须用 `crontab -e`，避免语法/权限问题。
- 系统级任务区分用户字段（`/etc/crontab` 需指定用户名，用户 crontab 不需要）。
- 服务未启用时，错过的任务默认不会补执行（需看异步处理机制，如 cronie 的 anacron）。

- `crontab -u username -e` 编辑指定用户任务；`-l` 列出，`-r` 删除。
- 格式：`minute hour day_of_month month day_of_week command`
  - minute 0–59，hour 0–23，day 1–31，month 1–12，day_of_week 0–6（0=周日）
- 符号：`*` 任意，`,` 多值，`-` 范围，`/` 频率
- 示例：`*/5 9-16 * 1-5,9-12 1-5 ~/bin/i_love_cron.sh`（周一至五 9:00–16:55 每 5 分钟，6–8 月除外）
- 特殊关键字：`@reboot`、`@yearly`、`@monthly`、`@weekly`、`@daily`、`@hourly`
- Cronie 易错点：
  - 用户限制：默认读 `/etc/cron.deny`；若无此文件，仅 `/etc/cron.allow` 中用户可用。
  - `run-parts` 执行目录脚本时，文件名不能含 `.`，只能含字母、数字、下划线、连字符；用 `run-parts --test --debug /etc/cron.daily` 验证。
  - `systemctl status cronie` 显示 `CAN'T OPEN (/etc/crontab)` 可忽略。
  - `/etc/cron.d/0hourly` 损坏会导致所有 `/etc/cron.d/` 任务不执行，用 `pacman -Qkk cronie` 检查。
  - 禁止输出/邮件：命令末尾加 `>/dev/null 2>&1` 或设 `MAILTO=""`。例：`0 1 5 10 * /path/to/script.sh >/dev/null 2>&1`
- Dcron：支持标准格式，可额外用 `ID=jobname`、`AFTER=`。
- Fcron：替代 cronie 后 spool 为 `/var/spool/fcron`，用 `fcrontab` 编辑，任务以二进制存储；手动改 crontab 需适配。

### crontab 字段
- 格式：`分 时 日 月 周 命令`；周 0–6（0=周日）
- 通配符：`*`、`,`、`-`、`*/n`；特殊：`@yearly` 等
- 示例：
```
0 6 1,15 * *    # 每月1、15日06:00
*/15 9-17 * * 1-5   # 工作日09–17点每15分钟
```

### 默认编辑器
- 定义 `EDITOR` 变量；用 `su -c "crontab -e"` 而非 `sudo`（正确带入变量）
- 别名：`alias scron="su -c $(printf "%q " "crontab -e")"`

### 邮件输出
- cron 发 stdout/stderr 邮件；Cronie 无 `/usr/bin/sendmail` 则禁用
- 需 SMTP 守护进程（如 opensmtpd）或 `-m` 自定义脚本；亦可 Postfix 本地投递

### sSMTP
- 安装 `ssmtp`（自动建 sendmail 链接）→ 编辑 `/etc/ssmtp/ssmtp.conf` → 重启 `cronie.service`
- 仅发送，无守护、不接收/排队

### msmtp
- 安装 `msmtp-mta`（提供 sendmail 链接）→ 重启 `cronie.service`
- crontab 加 `MAILFROM=your@email.com`（防报头错误）
- 收件人：`MAILTO=your@email.com` 或在 `/etc/msmtprc` 设 `aliases /etc/aliases`，并在该文件映射 `your_username: your@email.com`

### Cronie 邮件发送
- 修改 cronie 服务单元的 `ExecStart`，改用 msmtp 发送邮件：
  ```
  ExecStart=/usr/bin/crond -n -m '/usr/bin/msmtp -t'
  ```
- 可选：在 msmtp 配置中设置默认发件人（如 `default: your@email.com`）。
- 也可用 esmtp：安装 `esmtp`、`procmail`，配置 `/etc/esmtprc` 路由。

### D-Bus
- 进程间通信消息总线；作为 systemd 依赖自动安装，用户会话总线自动启动。
- 两种实现：`dbus-broker`（默认，高性能，兼容参考实现，但不支持 AppArmor）与 `dbus-daemon` 参考实现（官方支持）。安装 systemd 时选择 dbus-units 提供者，只能装一个。
- 屏蔽服务：复制服务文件到 `~/.local/share/dbus-1/services`，将 `Exec=` 改为 `/bin/false`。若服务已运行，需先终止进程。
  示例（屏蔽 gvfsd）：
  ```sh
  cp /usr/share/dbus-1/services/org.gtk.vfs.Daemon.service ~/.local/share/dbus-1/services
  sed -i 's|^Exec=.*|Exec=/bin/false|' ~/.local/share/dbus-1/services/org.gtk.vfs.Daemon.service
  ```
- 调试工具：Bustle（时序图）、D-Spy、Qt D-Bus Viewer（`qt6-tools`）、`busctl`。

### Docker
- 安装 `docker` 包。
- 启用/启动 `docker.service`（开机自启）或 `docker.socket`（首次使用时启动，加快启动）。
- 验证状态：`systemctl status docker`。

- 易错：VPN 活跃时启动 docker 服务失败（bridge/overlay 网络 IP 冲突）。
- 解决：断开 VPN 启动后再重连；或网络去冲突。
- 验证：`docker run` 下载 Arch Linux 镜像运行 Hello World。

- 运行测试：`docker run -it --rm archlinux bash -c "echo hello world"`（`--rm` 退出即删）。
- 非 root：加入 `docker` 组→重登+重启 `docker.service`；**警告** 组员等同 root（`docker run --privileged` 提权）。
- 构建：装 `docker-buildx`。Compose：`compose.yaml` 声明配置，装 `docker-compose`。
- Docker Desktop（Linux 版）：
  - 官方包与 `docker-compose`、`docker-buildx` 冲突，需先移除；或 AUR `docker-desktop`。
  - 需 KVM；GNOME 托盘装 `gnome-shell-extension-appindicator`。
  - 文件共享需映射 `/etc/subuid`、`/etc/subgid`。
  - 使用 context `desktop-linux`，与原有引擎隔离。
  - 性能差、CPU 高。
  - 默认用户级 systemd 自启；禁用 Autostart 无效，需禁 `docker-desktop.service` 用户单元。
- 前端：Lazydocker（终端TUI）、Podman Desktop、Portainer 等。
- 组成：`docker.service`（守护进程）+ `docker` CLI + 容器；CLI 走 API；守护进程停/重启会连带容器；可直接调 API。
- 配置：`/etc/docker/daemon.json` 优先于 flags；要 flags 用 systemd drop-in 覆盖 `ExecStart`；选项见 `dockerd` 文档。

**存储驱动**

- 存储驱动控制镜像/容器的存储方式；默认 `overlay2` 性能良好。
- btrfs/ZFS 用户可使用对应 `btrfs` / `zfs` 驱动。

**Daemon Socket**

- 默认 Docker API 监听 Unix socket `/var/run/docker.sock`。
- 可额外配置 TCP socket 以支持远程访问（如宿主机访问 VM 内的 Docker）。
- ⚠️ 默认 API 未加密、未认证；远程 TCP 访问等同于不安全的 root 权限，必须搭配 SSH 或 TLS。
- ⚠️ 未认证 TCP 连接已在 Docker 26 弃用，计划 Docker 28 移除。
- 默认 `docker.service` 已含 `-H` 标志；若同一选项同时出现在 flags 和 `/etc/docker/daemon.json`，Docker 将无法启动。推荐用 drop-in 文件覆盖。

示例（添加 TCP 2376）：

```
/etc/systemd/system/docker.service.d/docker.conf
```

```
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd -H unix:///var/run/docker.sock -H tcp://0.0.0.0:2376
```

### 全局环境变量
- `/etc/environment` 最先读取；`~/.pam_environment` 已废弃。格式 `VARIABLE=value`，不支持展开。
- `/etc/security/pam_env.conf`：`VARIABLE [DEFAULT=] [OVERRIDE=]`；`@{HOME}` 展开自 `/etc/passwd`，`${VAR}` 展开已定义变量；普通 `VARIABLE=value` 不展开。
  ```
  XDG_CONFIG_HOME DEFAULT=@{HOME}/.config
  ```

### 用户级
- 写于 shell 配置文件或 `~/.config/environment.d/*.conf`。
  ```
  export PATH="${PATH}:/home/my_user/bin"
  ```
  更新：`source ~/.bash_profile` 或重新登录。
- 易错：dbus/systemd 用户实例不读 `~/.bashrc`（如 GNOME Files 不生效）。查看：`export -p`

### 图形环境
作用域：会话 > DE > 应用。
- **Xorg**：DM 用 `xprofile`；`startx`/`SLiM` 用 `xinitrc`；`XDM` 用 `~/.xsession`；LightDM/Plasma/SDDM 额外 source 登录 shell。通用：
  ```
  export GUI_VAR=value
  ```
- **Wayland**：GDM/Plasma 用 `~/.config/environment.d/envvars.conf`（`GUI_VAR=value`）；SDDM 不支持。
- greetd 默认 source `/etc/profile`、`~/.profile`（`source_profile` 控制）。若 DM 仅 source 登录 shell，可手动加载 `environment.d`。

## udisks（核心要点）

**定位**：udisks2 是桌面环境的**磁盘管理守护进程**（D-Bus 服务 org.freedesktop.UDisks2），让文件管理器（Nautilus/Dolphin）免 root 挂载/卸载/格式化 U 盘与移动硬盘。

**命令行工具 `udisksctl`**：

```bash
udisksctl status                     # 块设备概览
udisksctl info -b /dev/sdb1          # 设备详情（文件系统/挂载点/UUID）
udisksctl mount -b /dev/sdb1         # 挂载（polkit 授权，桌面会话免密）
udisksctl unmount -b /dev/sdb1       # 卸载
udisksctl lock/unlock -b /dev/sdb1   # LUKS 加密卷
udisksctl loop-setup -f image.iso    # 挂载 ISO 镜像
```

**与传统工具关系**：底层仍是 mount/umount；udisks 加了 polkit 权限层与桌面通知。服务器/脚本场景直接用 mount（无需 udisks 依赖）。

**屏蔽桌面自动挂载**：udev 规则 `ENV{UDISKS_IGNORE}="1"`（隐藏分区/恢复分区常用）或 `ENV{UDISKS_AUTOOPEN}="0"`。

**易错点**：①SSH 会话里 udisksctl 报 "Not authorized"——polkit 规则限制活动会话才免密（`loginctl` 看 session active）；②卸载报 busy 用 `lsof +f -- /dev/sdb1` 找占用进程；③NTFS 读写需 ntfs-3g。

## 通用故障排除

### 通用流程
- 先读错误信息，在终端运行应用查看输出。
- 用 `--verbose`/`-v` 或 `--debug` 提高详细度；查日志目录 `/var/log`、`$HOME/.cache`、`$HOME/.local`；仍不足用 `strace`。
- 内核/磁盘问题用 `dmesg`；`journalctl` 过滤更强、时间戳可读。
- 查上游 issue tracker；Arch 打包问题用 [Arch Linux bug tracker](https://gitlab.archlinux.org/groups/archlinux/packaging/-/issues)。

### 请求支持
- **仅支持 Arch Linux**，不支持衍生版。
- 贴**完整输出**，勿自行截取。来源：命令输出、systemd journal（用 `-b` 只取当前启动；勿用 `-x`；内核日志用 `journalctl -k` 或 `dmesg`）、Xorg 日志（系统 journal、`/var/log/`、`$HOME/.local/share/xorg/`）、Pacman 升级问题看 `/var/log/pacman.log`。
- 大段输出用 pastebin 粘贴。

### 启动问题
- 确认失败阶段：
  - 固件：禁用 Secure Boot。
  - 引导加载程序：改内核参数调试；ACPI 问题可致启动循环。
  - initramfs：紧急 shell 内有 dmesg/journal。
  - 实际系统：启用调试 shell。
- 工具不足时用最新 Arch ISO U 盘启动修复。

### 控制台消息
- 屏幕被清空时用 `journalctl -k` 或 `dmesg`；`journalctl -b` 看当前启动。
- 流量控制：`Ctrl+s` 暂停输出，`Ctrl+q` 恢复；暂停时程序阻塞于 `write()`，init 看似冻结先检查是否被暂停。

### 内核日志调试参数

- `debug`：内核提升控制台日志级别，打印内核日志缓冲区全部消息；同时 systemd 提升日志级别输出调试信息。
- `ignore_loglevel`：与 `debug`/`loglevel=8` 等效（调试消息级别为 7），但可防止后续启动阶段再次提高日志级别。
- `earlyprintk=vga,keep`：极早打印内核消息（崩溃前输出）。EFI 系统需将 `vga` 改为 `efi`。
- `log_buf_len=16M`：扩大内核消息缓冲区为 16 MiB，防止调试输出被覆盖。

### 动态调试（dynamic debug）

`pr_debug()` 及相关函数（`dev_dbg()`、`drm_dbg()`、`bt_dev_dbg()`）默认不输出，需满足：

- 内核配置 `CONFIG_DYNAMIC_DEBUG`（`linux` 内核已默认启用），或
- 修改内核源码定义 `DEBUG`。

查询格式：

```
match_type match_parameter flags
```

- `match_type`：`module` 或 `file`
- `match_parameter`：模块名或文件路径，路径支持 `*` 通配符
- `flags`：`+p` 启用打印，`-p` 禁用

常用示例：

- `module i915 +p`：打印 i915 模块调试信息
- `file drivers/gpu/drm/* +p`：打印所有 DRM 驱动调试信息
- `file * +p`：打印全部调试信息

运行时启用：

```bash
echo "query" > /sys/kernel/debug/dynamic_debug/control
```

需确认 debugfs 已挂载到 `/sys/kernel/debug`。

- getty 由 systemd 启动，Arch 默认 agetty（util-linux）。
- 楼梯效应（换行错位）：登录后执行 `stty onlcr` 修复。
- 虚拟控制台默认 6 个；修改 `/etc/systemd/logind.conf` 的 `NAutoVTs=<数量>`；临时启动 `getty@ttyN.service`。
- 自动登录（tty1）drop-in `/etc/systemd/system/getty@tty1.service.d/autologin.conf`：
  ```ini
  [Service]
  ExecStart=
  ExecStart=-/usr/bin/agetty --noreset --noclear --autologin username - ${TERM}
  ```
- 串口：drop-in 位于 `serial-getty@ttyS0.service.d`，ExecStart 加 `--keep-baud 115200,57600,38400,9600`。
- nspawn：覆盖 `console-getty.service`（带 `--keep-baud`）；`machinectl login` 时覆盖 `container-getty@.service`（无 `--keep-baud`）。
- 跳过用户名：drop-in `getty@tty1.service.d/skip-username.conf`：
  ```ini
  [Service]
  ExecStart=
  ExecStart=-/usr/bin/agetty -o '-- username' --skip-login --noreset --noclear - ${TERM}
  ```
- 保留 tty1 启动消息：drop-in 设 `TTYVTDisallocate=no`；移除内核参数 `quiet`；Late KMS 仍可能清屏。

- Init为PID1，内核硬编码启动，失败panic；进程祖先/收养孤儿。Arch仅支持systemd，其他init须注明。
- `systemctl list-units --state=running "*.service" > daemons.list`；另配systemd-tmpfiles/kernel modules/sysctl。
- logind需systemd为init，否则seat权限不可用。
- 设备组: `# usermod -a -G video,audio,power,disk,storage,optical,lp,scanner,input user`重启。
- Xorg.wrap不查logind，非systemd下给Xorg root。
- 电源:pm-utils+acpid；定时:默认timer非cron。
- dbus:用户实例由systemd/User启动；桌面IPC:

```bash
# /etc/X11/xinit/xinitrc.d/30-dbus.sh
#!/bin/bash
if [ -z "${DBUS_SESSION_BUS_ADDRESS-}" ] && type dbus-launch >/dev/null; then
  eval $(dbus-launch --sh-syntax --exit-with-session)
fi
```

### PID 命名空间与 systemd

- systemd 要求新 PID 命名空间内的根文件系统为 chroot 挂载，否则服务启动失败。
- 错误信息：
```
"Failed at step NAMESPACE spawning" due to "Invalid operation"
```
- 原因：systemd 尝试以 `private` 选项重新挂载根目录。
- 解决：使用 `jchroot` 工具创建 chroot + 新 PID 命名空间。
- 注意：chroot 前不要挂载 `/proc`，否则 systemd 会检测到 chroot 环境；可在 systemd 运行后再挂载。

### 替换 udev

警告：非必需。`systemd-udev` 无需 systemd 作 PID 1 即可工作。部分替代品无法与 systemd 共存——确保先启动替代 init 再安装。

- **mdev** — 嵌入式设备管理器。 (busybox 提供)
- **smdev** — mdev 兼容的简单设备节点管理程序。 (smdev AUR)

## 持久块设备命名

总线命名（`/dev/sda`、`/dev/nvme0n1`）多盘下顺序随机，重启可能互换，导致引导失败。udev 持久命名解决。

- 规则：`60-persistent-storage.rules` 提供 by-label/uuid/id/path，GPT 另有 by-partlabel/partuuid；`90-image-dissect.rules` 提供 by-designator/gpt-auto。对应 `/dev/disk/` 动态创建。LVM 路径本身持久。
- 易错：磁盘克隆产生同名设备。
- 查看：`lsblk -f`；`blkid -o export`。

**by-label**（`/dev/disk/by-label/`）
- 支持几乎所有文件系统；标签须唯一，≤16 字符；dm-crypt 锁定后不可见。
- 修改标签：
```bash
e2label /dev/sda2 "new"          # ext
xfs_admin -L "new" /dev/sda2     # xfs
btrfs filesystem label /dev/sda2 "new"
swaplabel -L "new" /dev/sda2     # swap
fatlabel /dev/sda2 "new"         # vfat
ntfslabel /dev/sda2 "new"        # ntfs
cryptsetup config --label="new" /dev/sda2  # LUKS2
```

**by-uuid**（`/dev/disk/by-uuid/`）
- UUID 由 mkfs 生成，冲突概率极低；swap/LUKS 支持。FAT/exFAT/NTFS 不支持 UUID，以短 UID（如 `CBB6-24F2`）列于同目录。

## 设备持久命名

- UUID 获取：`lsblk -dno UUID /dev/sda1` 或 `blkid -s UUID -o value /dev/sda1`
- 优点：冲突少、自动生成、跨系统唯一；缺点：过长难读，格式化后需手动更新配置。易错：swap 无 UUID 需 `mkswap` 重设。
- by-id 基于硬件序列号，by-path 基于 sysfs 物理路径；二者绑定控制器，换端口/控制器即变，不适合跨硬件迁移，仅用于定位设备。注意：仅对磁盘持久，分区按分区表编号引用；NVMe by-path 可因 PCIe 枚举变化；NVMe by-id 需用带 NSID 版本（如 `_1`、`_1-part1`）。
- 查看：`ls -l --time-style=+ /dev/disk/by-id/`，如 `ata-... -> ../../sda`、`nvme-..._1 -> ../../nvme1n1`。

## 电源管理

- 组成：内核配置（参数/模块/udev）+ 用户空间工具。
- 易错：用户空间工具功能重叠，只能运行一个。
- 常用命令行工具：acpid、power-profiles-daemon、powertop、TLP、TuneD、systemd、UPower、libsmbios、powerstat、Laptop Mode Tools。图形工具：batsignal（低电量警告）。

- **用户空间电源工具**：常用 cbatticon、Power Statistics、Power Devil、Xfce Power Manager 等。

- **ACPI 事件（systemd）**：配置 `/etc/systemd/logind.conf` 或 `/etc/systemd/logind.conf.d/*.conf`，可替代 acpid。动作：`ignore/poweroff/reboot/halt/suspend/hibernate/hybrid-sleep/suspend-then-hibernate/lock/kexec`。  
  默认：`HandlePowerKey=poweroff`、`HandleSuspendKey=suspend`、`HandleLidSwitch=suspend`、`HandleLidSwitchDocked=ignore`、`HandleLidSwitchExternalPower=同 HandleLidSwitch`。  
  修改后 reload `systemd-logind.service`。易错：systemd 不处理 AC/电池事件，需 acpid；合盖延迟最多 90s，可设 `HoldoffTimeoutSec=30s`（v220+）。

- **电源管理器**：桌面管理器会 inhibit systemd 的 ACPI 设置；若运行，只在管理器中配置，否则可能双挂起。用 acpid 时需将 `Handle*` 设为 `ignore`。

- **xss-lock**：订阅 `suspend/hibernate/lock-session/unlock-session` 事件，自动运行/终止锁屏。示例：
```sh
xss-lock -- i3lock -n -i background_image.png &
```

- **省电**：自定义脚本/udev 省电须避免与现有管理器冲突；所列特性值得启用，性能影响小；未默认启用多为兼容性问题。

- rsyslog 是 syslog 实现，可从 systemd journal 导入日志处理/转发。
- 安装：`rsyslog`（AUR）；建议先卸载/禁用 `syslog-ng` 避免冲突。
- 启用并启动：`systemctl enable --now rsyslog.service`。若先 start 会因缺少 `syslog.service` 符号链接报 dependency 错误，需先 enable。

- 主机名：rsyslog 用 glibc `gethostname()/gethostbyname()` 取 FQDN；非 BIND/NIS 时读取 `/etc/hosts`。
  检查：`hostname --fqdn`；日志中主机名取 `hostname --short`。
  如需完整 FQDN 写入日志，需在配置开头加：`$PreserveFQDN on`（rsyslog 从上到下即时生效）。
  `/etc/hosts` 中 IP 后第一项即 FQDN。调整顺序即可改名：
  ```
  127.0.0.1  somehost.localdomain localhost.localdomain localhost somehost
  ::1        somehost.localdomain localhost.localdomain localhost somehost
  ```

- 配置：`/etc/rsyslog.conf`。默认所有 syslog 消息由 journal 处理；rsyslog 获取日志两种方式：
  1. 加载 imjournal 模块：
  ```
  $ModLoad imjournal
  ```
  2. 开启 journald 转发：
  ```
  /etc/systemd/journald.conf
  ForwardToSyslog=yes
  ```

- 日志过滤/放置根据 Facility 级别在 `/etc/rsyslog.conf` 中调整。

# rsyslog
- 规则：`设施.级别 目标`
- `-` 前缀表示缓冲不同步，如 `auth.* -/var/log/auth`
- Facility 常用：kern=0, user=1, mail=2, daemon=3, auth=4, syslog=5, lpr=6, news=7, authpriv=10, cron=15, local0-7=16-23。
- Severity（RFC5424）：0 emerg, 1 alert, 2 crit, 3 err, 4 warning, 5 notice, 6 info, 7 debug。
- 记录内核日志到文件：
  - journald 异常关机不落盘，内核 panic 会丢。
  - 安装 rsyslog；在 `/etc/logrotate.d/rsyslog` 加 `/var/log/kernel.log`。
  - `/etc/rsyslog.conf` 保留 `$ModLoad imklog`，加 `kern.*  /var/log/kernel.log;RSYSLOG_TraditionalFileFormat`
  - 移除 systemd 共享 socket：`sed 's/^Sockets=/#&/' /usr/lib/systemd/system/rsyslog.service > /etc/systemd/system/rsyslog.service`，启用 rsyslog.service。
  - rsyslog 读 `/proc/kmsg`，journald 读 `/dev/kmsg`，不冲突。

# sSMTP
- 轻量转发到 mailhost，非完整服务器；已停止维护，建议 msmtp/OpenSMTPD。
- 安装 AUR 包 ssmtp；配置 `/etc/ssmtp/ssmtp.conf`。
- Gmail 旧 lesssecureapps 失效，需双因素认证。

- Gmail 开启两步验证：生成 App Password；`AuthUser` 填 Gmail 用户名（非 App 名），`AuthPass` 填 16 位密码（空格可省略）
- 未开启两步验证：需允许“不够安全的应用”
- 配置文件：`/etc/ssmtp/ssmtp.conf`

```conf
AuthUser=user@gmail.com
AuthPass=16位密码
```

- `FromLineOverride=yes`：覆盖默认发件域  
- 注意：示例为Gmail，其他查`man ssmtp(8)`  
- 测试：`echo -e 'Subject: test\n\nTesting ssmtp' | sendmail -v tousername@example.com`

## SSMTP
- 密码明文存 `/etc/ssmtp/ssmtp.conf`；仅 root/mail 组可访问，ssmtp 以 mail 组运行，勿加用户入 mail 组。
- 本地收件人：UID<1000 用 `root=` 替换；UID≥1000/未知加 `rewriteDomain=`；用户不在 rewriteDomain 收不到系统邮件。可用 `/etc/mail.rc` 别名：`alias git git<user@example.com>`，`echo -e "Hey" | mail git`。
- 勿将 sendmail 链接到 mail，语法不同。
- 发送：`echo -e "Subject: 主题\n\n正文" | mail user@example.com`；`sendmail -t < file`；`uuencode file.txt out.txt | sendmail user@example.com`（附件需 sharutils）。

## syslog-ng
- 流程：source→filter→destination；典型 source：`/dev/log`、internal、`/proc/kmsg`；仅本地日志用 journal 即可。
- 安装/启用：`pacman -S syslog-ng`；`syslog-ng@default.service`。
- 配置：`/etc/syslog-ng/syslog-ng.conf`；实例 `/etc/default/syslog-ng@default`；logrotate `/etc/logrotate.d/syslog-ng`。
- 默认不写日志，需定义 destination 并启用 log 路径，如 `log { source(s_local); ... }`。

- 启用本地日志：取消注释 `destination(d_local);`，勿动 `source(s_network)`。
- journald：`Storage=volatile` 只留 syslog-ng；`Storage=none` 必须 `ForwardToSyslog=yes`。
- 默认源：`source src { system(); };`
- 本地源：`source s_local { unix-stream("/dev/log"); };`
- 网络源：`source s_net { network(transport(udp)); };`（TCP 用 `transport(tcp)`，默认端口 514）
- 目标：`destination d_file { file("/var/log/auth.log"); };` 须用 `log{}` 连接。
- 网络目标：`destination d_net { network("10.0.0.2" port(514) transport(udp)); };`
- 过滤器：`filter f_messages { severity(info..warn) and not facility(auth, authpriv, mail, news); };` 支持 `match("failed")`。

过滤器表达式支持预定义宏（hard）与用户自定义宏（soft），完整清单见 syslog-ng 文档。

- 时间：`DATE`/`ISODATE`/`FULLDATE`/`HOUR`/`MIN`/`SEC`/`MSEC`（支持`C_`/`R_`/`S_`前缀）
- 主机：`HOST`/`FULLHOST`/`HOST_FROM`/`SOURCEIP`
- 消息：`MSG`/`MESSAGE`/`MSGONLY`/`MSGID`/`PROGRAM`/`PID`
- 级别：`PRI`/`PRIORITY`/`LEVEL`/`FACILITY`/`FACILITY_NUM`
- 其他：`SDATA`/`BSDTAG`

## 系统时间
- 含时间值、标准（localtime/UTC）、时区/DST；两个时钟：硬件时钟(RTC)存日期时间，系统时钟为内核自 1970-01-01 UTC 起的秒数。
- 默认标准：Windows 用 localtime，macOS 用 UTC，Linux 各异。

### 硬件时钟
- `hwclock --show` 读取；`hwclock --systohc` 将系统时钟写入硬件时钟。
- Arch 内核默认每 11 分钟自动同步 RTC→系统时钟；RTC 严重不准时，开机后 SSL/OCSP 报错。

### 系统时钟
- `timedatectl` 查看；`timedatectl set-time "2014-05-26 11:13:54"` 设置本地时间。

### 多系统共存
- 硬件时钟应设 UTC：`timedatectl | grep local` 输出 `RTC in local TZ: no` 即 UTC。
- 改 localtime：`timedatectl set-local-rtc 1`；改回 UTC：`timedatectl set-local-rtc 0`；自动更新 `/etc/adjtime`。
- 易错：systemd 216 起 RTC 为 localtime 时不回写 RTC，FAT 时间戳按 UTC；`timedatectl` 依赖 D-Bus，chroot 下改用 `hwclock`；`/etc/adjtime` 不存在时假定 RTC 为 UTC。

### Windows 双系统
- 推荐 Windows 改 UTC（默认 localtime）。管理员命令行执行：
  `reg add "HKEY_LOCAL_MACHINE\System\CurrentControlSet\Control\TimeZoneInformation" /v RealTimeIsUniversal /d 1 /t REG_DWORD /f`

- **硬件时钟 UTC**：Windows 设为 UTC：导入注册表 `[HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\TimeZoneInformation] "RealTimeIsUniversal"=dword:00000001`；设置后更新硬件/系统时钟；时间异常时用 `timedatectl set-timezone Area/Location` 重设。
- **Ubuntu/Fedora**：检测到 Windows 时默认按 `localtime` 解释硬件时钟；修改同上。
- **多 NTP 客户端**：只允许一个系统启用同步；Windows 关闭同步：设置中取消或 `w32tm /unregister`；AD 机器可能强制同步；Windows 时钟精度有限。
- **时区设置**：`timedatectl status` 查看；`timedatectl list-timezones` 列出；`timedatectl set-timezone America/Toronto` 设置；chroot 中不可用时：`ln -sf /usr/share/zoneinfo/Area/Location /etc/localtime`；`/etc/localtime` 必须是符号链接。
- **自动时区**：`timedatectl set-timezone $(curl https://ipapi.co/timezone)`；GNOME 等桌面已内置自动时区。

- **核心组件**：`udisks2` 提供 `udisksd` + `udisksctl`，D-Bus 按需启动。
- **权限**：polkit；无激活会话需调规则。
- **命令**：
```bash
udisksctl mount -b /dev/sdc1
udisksctl unmount -b /dev/sdc1
udisksctl loop-setup -r -f image.iso
udisksctl loop-delete -b /dev/loop0
```
- **配置** `/etc/udisks2/mount_options.conf`（参考 `.example`，覆盖内建默认值）：
```ini
[defaults]
btrfs_defaults=compress=zstd
ntfs_drivers=ntfs   # 默认 ntfs3,ntfs
```
- **udev 规则**（文件名在 `60-persistent-storage.rules` 之后，如 `61-*`）：
  - `/media`：`ENV{ID_FS_USAGE}=="filesystem|other|crypto", ENV{UDISKS_FILESYSTEM_SHARED}="1"`
  - 隐藏：`ENV{UDISKS_IGNORE}="1"`
  - 清理：tmpfiles.d `D /media 0755 root root 0 -`

## 核心配置
- 开机/接入设备时，udisksd 读取 `/etc/udisks2/IDENTIFIER.conf`（IDENTIFIER 为 Drive:Id）。当前仅支持 ATA 设置，等效 hdparm，守护进程自启即持久生效。

```ini
# /etc/udisks2/DriveId.conf
[ATA]
StandbyTimeout=240
```

- 获取 DriveId：  
```bash
udevadm info --query=property --name=sdx | sed -n 's/^ID_SERIAL=//p' | tr '_' '-'
```
- GUI 工具：`gnome-disk-utility`。
- 为所有 Udisks 挂载设置默认 `noatime`（适合闪存介质）：编辑 `/etc/udisks2/mount_options.conf`：

```ini
[defaults]
defaults=noatime
```

- 特定挂载如需 atime，可用 udev 规则覆盖：`ENV{UDISKS_MOUNT_OPTIONS_DEFAULTS}="relatime"`。
- 启用 VeraCrypt/TCRYPT：创建空文件 `/etc/udisks2/tcrypt.conf`（默认关闭）。

## 故障排查
- **隐藏设备**：复制 `/usr/lib/udev/rules.d/80-udisks2.rules` 到 `/etc/udev/rules.d/`，在副本中删除 “Devices which should not be display in the user interface” 段落。
- **待机定时器失效**：udisks 定期轮询 S.M.A.R.T.，待机超时大于轮询间隔可能导致硬盘无法待机。目前无法修改轮询间隔。可设超时低于 10 分钟，或 `hdparm -y /dev/sdx` 手动停转。

# 用户和组

- 用户和组用于访问控制（文件、目录、外设）。默认机制简单/粗粒度；更高级：ACL、Capabilities、PAM。
- `root` 为超级用户，仅用于管理；普通用户通过提权工具（如 sudo）获得受限权限。组是用户的集合，用于共享权限。

## 权限与所有权
- 一切皆文件；每个文件属于一个用户和一个组。
- 权限：读 `r`、写 `w`、执行 `x`；三组字符分别表示属主、属组、其他用户，首字符为文件类型（如 `d` 目录）。
- 查看：`ls -l`（第1列权限，第3列属主，第4列属组）：

```
$ ls -l /boot/
-rw-r--r-- 1 root root 8570335 Jan 12 00:33 initramfs-linux.img
```

- 用 `stat` 查看：
  - 属主：`stat -c %U file`
  - 属组：`stat -c %G file`
  - 权限：`stat -c %A file`
- 查找文件：`find / -user user`、`find / -group group`
- 修改属主/属组：`chown`；修改权限：`chmod`

## 用户数据库文件
- **警告**：不要手动编辑 `/etc/passwd`、`/etc/shadow`、`/etc/group`、`/etc/gshadow`；应使用管理命令，避免锁问题和格式损坏。
- 文件用途：
  - `/etc/passwd`：用户账户信息
  - `/etc/shadow`：安全用户信息
  - `/etc/group`：定义组及成员
  - `/etc/gshadow`：组账户影子信息

## 用户管理
- 管理工具来自 `shadow` 包（`base` 元包依赖）。
- 当前登录用户：`who`
- 列出所有用户账户（root 运行）：`passwd -Sa`

- 新建用户核心命令：`useradd -m -G 附加组列表 -s 登录Shell 用户名`
- 关键参数：
  - `-m`：创建家目录 `/home/用户名`，并复制骨架目录文件。
  - `-G`：指定附加组（逗号分隔），默认仅属初始组。
  - `-s`：指定登录 Shell；默认值见 `/etc/default/useradd`。
  - `-g`：指定初始主组，组必须已存在。
- 警告：登录 Shell 必须存在于 `/etc/shells`，否则 PAM 的 `pam_shells` 拒绝登录。
- 新建用户后必须用 `passwd 用户名` 设置密码。
- 初始组规则：若未指定 `-g`，由 `/etc/login.defs` 中 `USERGROUPS_ENAB` 决定；默认 `yes` 时创建与用户名同名组。
- 服务账号可指定 `/usr/bin/nologin` 拒绝登录。
- 示例：
  ```bash
  # useradd -m archie
  # passwd archie
  ```
- 经验：每个用户独立同名校组为佳；避免多用户共用 `users` 主组（配合 `umask 002` 会默认写共享）。

- XDG Base Directory 规范定义用户配置/数据存放路径，便于迁移与管理。
- 默认仅 `XDG_RUNTIME_DIR` 由 `pam_systemd` 设置，其余需手动定义；改动可能影响 Chromium 屏幕共享/PipeWire。

### 用户目录

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `XDG_CONFIG_HOME` | 配置文件（类似 `/etc`） | `$HOME/.config` |
| `XDG_CACHE_HOME` | 缓存（类似 `/var/cache`） | `$HOME/.cache` |
| `XDG_DATA_HOME` | 数据（类似 `/usr/share`） | `$HOME/.local/share` |
| `XDG_STATE_HOME` | 状态（类似 `/var/lib`） | `$HOME/.local/state` |
| `XDG_RUNTIME_DIR` | 套接字/管道等临时文件 | `pam_systemd` 设为 `/run/user/$UID` |

### 系统目录

- `XDG_DATA_DIRS`：冒号分隔目录列表，默认 `/usr/local/share:/usr/share`
- `XDG_CONFIG_DIRS`：冒号分隔目录列表，默认 `/etc/xdg`

### 易错点

- `XDG_RUNTIME_DIR` 无默认值；必须属主为用户、权限 `0700`、位于本地文件系统、可定期清理；不宜存大文件（可能为 tmpfs）
- 支持状态分类（支持/部分/硬编码），硬编码指需补丁、编译期选项或环境变量代码才能兼容；工作区方案应避免这些方式以保证可移植性

## XDG 路径迁移要点

- 通用：`XDG_CONFIG_HOME/<应用名>`（act、btop 等）
- ALSA：`XDG_CONFIG_HOME/alsa/asoundrc`；anaconda：`XDG_CONFIG_HOME/conda/condarc`
- Android Studio：`XDG_CONFIG_HOME|DATA|CACHE_HOME/Google/AndroidStudioX.X`
- Anki：`$XDG_DATA_HOME/Anki2`；`anki -b <dir>`
- aria2/audacity/calcurse：config 与 cache/data 均在 `XDG_*_HOME/<应用名>`
- atuin：`XDG_CONFIG_HOME/atuin/config.toml`、`XDG_DATA_HOME/atuin/history.db`
- asunder：config/cache 均在 `XDG_*_HOME/asunder/asunder*`，旧文件需手动清理
- bitwarden-cli：`XDG_CONFIG_HOME/Bitwarden CLI`；`BITWARDENCLI_APPDATA_DIR` 优先

### 易错点
- byobu、calcurse：旧目录存在时优先旧路径
- 显式环境变量优先于 XDG

---
来源：consolidated/basic-ops/系统核心概念（Arch Wiki）.md