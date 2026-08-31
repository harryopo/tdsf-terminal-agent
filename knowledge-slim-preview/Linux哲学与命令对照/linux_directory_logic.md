---
source: philosophy
category: linux-philosophy
url: linux_directory_logic.md
title: linux_directory_logic · Linux 目录结构设计逻辑——为什么要这样组织？
---

# Linux 目录结构设计逻辑——为什么要这样组织？

> Linux 目录结构不是随意创建的，每一个目录的存在都有其设计原因。
> 理解了设计逻辑，就能推导出配置文件应该放在哪里，而不是死记硬背。

### 核心设计原则

1. **按功能分类**：不同类型的数据放在不同目录
2. **按修改频率分离**：经常变的（/var）和不常变的（/usr）分开
3. **按权限分离**：普通用户需要的（/bin）和管理员需要的（/sbin）分开
4. **按生命周期分离**：临时的（/tmp）和永久的（/home）分开

### 为什么要这样设计？

**Unix/Linux 的设计哲学是"一切皆文件"**，那么文件如何组织就成了关键问题。

想象一下，如果所有文件都放在一个目录里：

- 找配置文件？在海量文件中大海捞针
- 备份系统？不知道哪些是系统文件，哪些是用户数据
- 权限管理？无法批量设置不同类型的文件权限
- 升级软件？不知道哪些文件是软件包安装的

**所以目录结构的核心目的是：分类、隔离、可管理。**

## 二、FHS 顶层目录全景图

FHS = Filesystem Hierarchy Standard（文件系统层次结构标准）。所有 Linux 发行版都遵循这个标准，所以学一次，通用所有 Linux（openEuler、CentOS、Ubuntu、RHEL）。

```
/                        根目录（Root）——一切文件的起点
├── bin/       → Binary（二进制可执行文件）——所有用户都能用的基础命令
├── boot/      → Boot（启动文件）——内核、引导程序（grub）
├── dev/       → Device（设备文件）——一切皆文件的体现：硬盘、终端、USB
├── etc/       → Editable Text Configuration（系统配置文件）——"配置总部"
├── home/      → Home（用户家目录）——普通用户的个人空间
├── root/      → Root（root 用户家目录）——管理员的私人空间
├── lib/       → Library（系统库文件）——bin 和 sbin 依赖的共享库
├── lib64/     → Library 64-bit（64 位系统库文件）
├── media/     → Media（可移动媒体挂载点）——U 盘、光盘自动挂载这里
├── mnt/       → Mount（临时挂载点）——手动挂载硬盘用
├── opt/       → Optional（可选软件包）——第三方大型软件安装位置
├── proc/      → Process（进程虚拟文件系统）——内存中的实时系统信息
├── run/       → Run（运行时数据）——进程 PID、锁文件等（重启后清空）
├── sbin/      → System Binary（系统管理命令）——只有 root 能用的管理命令
├── srv/       → Service（服务数据）——网站、FTP 等服务提供的数据
├── sys/       → System（系统虚拟文件系统）——内核、硬件信息（比 proc 更新）
├── tmp/       → Temporary（临时文件）——所有用户都能放，重启自动清空
├── usr/       → Unix System Resources（系统资源）——软件安装的主要位置
└── var/       → Variable（可变数据）——日志、缓存、队列等经常变化的数据
```

理解了 FHS，遇到任何新路径都能猜个八九不离十：`vim /etc/systemd/system/xxx.service` 不是在"死记硬背一个路径"，而是在遵循一个**有逻辑的设计**——`/etc` 放配置（etc 的历史含义就是"可编辑的配置"）、`/usr` 放软件（Unix System Resources）、`/var` 放日志（variable = 变化的数据）。

### / — 根目录（Root）

- 整个文件系统是一棵"倒置的树"，根目录是这棵树的根节点
- 所有其他目录都是从根目录"生长"出来的
- 用 `/` 表示，是唯一没有父目录的目录

### /bin — Binary（基本命令）

- Binary 的缩写，存放二进制可执行文件
- 所有用户都需要的基本命令：`ls`, `cp`, `mv`, `cat`, `grep`

**为什么独立出来？**

- 系统启动早期就需要这些命令（单用户模式、救援模式）
- 如果放在 /usr/bin，而 /usr 分区挂载失败，系统就无法启动
- **设计原则**：启动必需的文件放在根分区

### /sbin — System Binary（系统管理命令）

**为什么和 /bin 分开？**

- s = System，系统管理专用
- `fdisk`（分区）、`iptables`（防火墙）、`systemctl`（服务管理）
- 普通用户通常不需要，也不应该有权限执行
- **权限分离原则**：减少普通用户的误操作风险

记忆：`/bin` → 基础（Basic）→ 所有人用；`/sbin` → 系统（System）→ 管理员用。

### /etc — Editable Text Config（可编辑文本配置）

**为什么叫 etc？** 历史原因：最初是"et cetera"（等等），因为放不进其他目录的配置都扔这里；后来演变为"Editable Text Config"（可编辑文本配置）。这是一个有趣的"民间词源"，虽然不是官方定义，但很好地描述了其功能。

**为什么配置文件用文本？**

- 人可读：`cat` 就能看；可编辑：`vim` 就能改
- 可搜索：`grep` 就能找；可版本控制：`git` 能追踪变化
- 可比较：`diff` 就能对比两个配置

### /home — 用户家目录

- 每个用户有自己的"私人空间"，存放个人文件、配置、文档
- 多用户系统必须隔离用户数据：用户 A 不能访问用户 B 的文件（权限隔离）
- 用户可以在自己的目录里自由操作，不影响系统

### /root — 超级用户家目录

**为什么 root 的家目录不在 /home/root？**

- 安全考虑：/home 可能在单独的分区，如果分区挂载失败，root 仍需能登录
- 独立性：root 的家目录应该在根分区上，不依赖其他分区
- **特权用户需要特权位置**

### /var — Variable（可变数据）

**为什么要和 /usr 分开？**

- /usr 可以只读挂载（保护系统文件不被修改）
- /var 必须可写（日志、缓存、邮件队列等经常变化）
- 分离后可以对 /usr 做快照备份，/var 单独处理
- **修改频率分离原则**

**子目录逻辑**：

```
/var/log/    → 日志文件（不断增长，需要轮转）
/var/cache/  → 缓存文件（可清空重建）
/var/spool/  → 队列文件（邮件、打印、计划任务）
/var/tmp/    → 重启后保留的临时文件
/var/lib/    → 程序运行时状态数据（数据库文件）
/var/run/    → 运行时数据（PID 文件、socket）
```

**为什么 /var/log 是独立的？** 日志增长很快，可能撑爆磁盘；独立分区可以限制日志大小；日志需要独立备份策略；日志轮转（logrotate）需要专门管理。

### /usr — Unix System Resources（Unix 系统资源）

**为什么叫"用户"目录却放系统文件？** 历史原因：最初是 "user" 的缩写，放用户家目录；后来用户家目录移到 /home，/usr 改为放系统软件；现在理解为 "Unix System Resources" 更准确。这是 Unix 历史演变的典型例子。

**子目录逻辑**：

```
/usr/bin/    → 用户安装的软件命令
/usr/sbin/   → 用户安装的系统管理命令
/usr/lib/    → 软件的库文件
/usr/share/  → 架构无关的共享数据（文档、图标）
/usr/local/  → 本地管理员安装的软件（源码编译默认位置）
/usr/include/ → C/C++ 头文件（开发用）
```

**为什么要有 /usr/local？** 系统包管理器安装的软件在 /usr/bin；源码编译安装的软件在 /usr/local/bin；避免与系统包管理器冲突；方便管理员区分"系统软件"和"手动安装的软件"。

### /tmp — Temporary（临时文件）

**为什么要独立？**

- 所有用户都能写入（权限 1777，Sticky Bit）
- 系统重启时可以清空
- 独立分区可以限制大小，防止撑爆磁盘

**Sticky Bit 是什么？** 权限位中的特殊标志：设置后，只有文件所有者、目录所有者、root 才能删除文件，防止用户 A 删除用户 B 的临时文件。`chmod 1777 /tmp` 或 `chmod +t /tmp`。

### /proc — Process（进程虚拟文件系统）

**为什么"虚拟"？** 不是真实存储的文件，而是内核动态生成的信息：读取时才生成内容（如 `cat /proc/cpuinfo`）；提供统一的接口获取系统信息；不占用磁盘空间（存在于内存中）。

```bash
cat /proc/cpuinfo    # 查看 CPU 信息
cat /proc/meminfo    # 查看内存信息
cat /proc/version    # 查看内核版本
cat /proc/loadavg    # 查看系统负载
ls /proc/PID/        # 查看进程详情
cat /proc/PID/status # 查看进程状态
cat /proc/PID/cmdline # 查看进程启动命令
```

**设计哲学**："一切皆文件" → 进程信息也是文件；统一接口 → 用 cat/grep 就能获取系统信息；动态生成 → 不需要额外的系统调用。

### /dev — Device（设备文件）

**为什么设备也是文件？** "一切皆文件"哲学的体现：用统一的 read/write 接口操作设备；程序不需要知道底层硬件细节。

```bash
/dev/sda      # 第一块 SCSI 硬盘
/dev/sda1     # 第一块 SCSI 硬盘的第一个分区
/dev/tty      # 当前终端
/dev/null     # 黑洞（丢弃所有输出）
/dev/zero     # 零设备（输出无限零字节）
/dev/random   # 随机数设备
```

- `/dev/null`：丢弃不需要的输出，常用于抑制错误信息——`command 2>/dev/null`
- `/dev/zero`：生成空数据，常用于创建固定大小的文件——`dd if=/dev/zero of=file bs=1M count=100`

### /boot — 启动文件

- BIOS/UEFI 需要能访问启动文件
- 包含内核镜像、initramfs、GRUB 配置
- **启动必需原则**：启动相关的文件不能依赖其他分区

```
/boot/vmlinuz-*        → Linux 内核镜像
/boot/initramfs-*      → 初始内存文件系统
/boot/grub2/grub.cfg   → GRUB 引导配置
```

### /lib — Library（库文件）

**为什么和 /bin 放在一起？** /bin 中的命令依赖这些库文件；启动早期就需要加载库；如果库在 /usr/lib，而 /usr 分区未挂载，命令就无法执行。**依赖就近原则**：被依赖的文件和依赖它的文件放在一起。

### /mnt 与 /media — 挂载点

- Linux 是单一目录树结构，外部存储设备需要"挂载"到目录树上才能访问
- /mnt 是传统的临时挂载位置（手动挂载）
- /media 是现代桌面环境的自动挂载位置（插入 U 盘、光盘时自动挂载）

```bash
mount /dev/sdb1 /mnt/usb    # 手动挂载 U 盘
umount /mnt/usb              # 卸载 U 盘
```

### /opt — Optional（可选软件）

- 第三方大型软件的安装位置（如 /opt/google/chrome/）
- 与系统软件分离，每个软件有自己的子目录，不干扰系统包管理器

### /sys — Sysfs（系统信息）

**为什么有 /proc 还要 /sys？**

- /proc：进程和系统信息（传统，有些混乱）
- /sys：硬件和内核参数（现代，结构清晰）
- /sys 是 /proc 的"继任者"，专门用于设备和驱动

### /srv — Service（服务数据）

- 存放 Web、FTP、数据库等服务的数据（如 /srv/www/、/srv/ftp/）
- 与系统软件分离，方便备份和迁移

### 按用户范围分

| 范围 | 位置 | 示例 |
|------|------|------|
| 全局配置 | /etc/ | /etc/profile, /etc/ssh/sshd_config |
| 用户配置 | ~/. | ~/.bashrc, ~/.ssh/config |

**设计逻辑**：全局配置影响所有用户，需要 root 权限修改；用户配置只影响当前用户，用户可以自由修改；用户配置优先级高于全局配置（覆盖机制）。

### 按服务类型分

| 服务 | 配置文件 | 设计逻辑 |
|------|---------|---------|
| SSH | /etc/ssh/sshd_config | 按服务名建子目录 |
| Samba | /etc/samba/smb.conf | 按服务名建子目录 |
| Apache | /etc/httpd/conf/httpd.conf | 按服务名建子目录 |
| Nginx | /etc/nginx/nginx.conf | 按服务名建子目录 |
| NFS | /etc/exports | 单文件（简单服务） |
| 防火墙 | /etc/firewalld/ | 复杂配置用目录 |
| 网络 | /etc/sysconfig/network-scripts/ | 按功能建子目录 |

**设计逻辑**：简单服务用单文件（如 NFS 的 exports）；复杂服务用目录（如防火墙的 firewalld/）；按服务名组织，方便查找和管理。

### systemd 配置的覆盖机制

```
优先级从高到低：
1. /etc/systemd/system/   → 管理员自定义（最高优先级）
2. /run/systemd/system/   → 运行时临时配置
3. /usr/lib/systemd/system/ → 软件包默认配置（不要修改）
```

**设计逻辑**：管理员配置永远覆盖默认配置；升级软件包不会丢失自定义设置；运行时配置可以临时覆盖（重启后失效）。

```bash
# 查看服务配置来源
systemctl cat sshd.service

# 创建自定义配置（覆盖默认）
systemctl edit sshd.service  # 在 /etc/systemd/system/sshd.service.d/ 创建覆盖文件

# 重新加载配置
systemctl daemon-reload
```

### 为什么日志在 /var/log/？

- 日志是"可变数据"（Variable），不断增长
- 需要写权限，不能放在只读分区
- 需要轮转（logrotate），定期清理
- 日志增长可能撑爆磁盘，需要独立管理

### 重要日志文件

| 文件 | 内容 | 设计逻辑 |
|------|------|---------|
| /var/log/messages | 系统通用日志 | 默认日志位置（所有非关键日志） |
| /var/log/secure | 安全日志（登录、认证） | 安全相关单独存放，便于审计 |
| /var/log/audit/audit.log | SELinux 审计日志 | 安全子系统独立日志 |
| /var/log/cron | 计划任务日志 | 服务独立日志 |
| /var/log/boot.log | 系统启动日志 | 启动过程独立记录 |
| /var/log/dmesg | 内核启动信息 | 硬件检测和驱动加载信息 |

### 日志轮转（logrotate）的设计

**为什么需要轮转？** 日志文件会不断增长；单个大文件难以管理；需要保留历史日志，但不能无限增长；需要压缩节省空间。

```
/etc/logrotate.conf          → 全局配置
/etc/logrotate.d/            → 按服务的独立配置
```

**设计逻辑**：全局配置定义默认策略；每个服务可以有自己的轮转规则；灵活配置，满足不同需求。

### 速记

```
/           根（一切的起点）
├── bin     基本命令（所有人都能用）
├── sbin    系统命令（管理员专用）
├── etc     配置文件（Editable Text Config）
├── home    用户家目录
├── root    管理员家目录（独立在根分区）
├── var     可变数据（日志、缓存、队列）
├── usr     系统资源（软件安装位置）
├── tmp     临时文件（重启可清空）
├── dev     设备文件（一切皆文件）
├── proc    进程信息（虚拟文件系统）
├── boot    启动文件（内核、GRUB）
├── lib     库文件（bin/sbin 依赖）
├── mnt     临时挂载点
├── opt     可选软件（第三方大型软件）
├── sys     系统信息（硬件、内核参数）
├── srv     服务数据（Web、FTP）
└── media   媒体设备（自动挂载）
```

助记（把 Linux 系统想象成一个**公司**）：

- **/**（根）= 公司总部
- **/bin**（基本命令）= 前台接待（所有人都需要接触）
- **/sbin**（系统命令）= IT 部门（只有管理员能进）
- **/etc**（配置文件）= 规章制度（公司运营规则）
- **/home**（用户目录）= 员工工位（每人有自己的空间）
- **/root**（管理员目录）= CEO 办公室（独立、特权）
- **/var**（可变数据）= 文件柜（不断积累的资料）
- **/usr**（系统资源）= 公司资产（软件、工具）
- **/tmp**（临时文件）= 会议室白板（用完就擦）
- **/dev**（设备文件）= 办公设备（打印机、电话）
- **/proc**（进程信息）= 监控摄像头（实时查看状态）
- **/boot**（启动文件）= 公司大门钥匙（启动必需）

### 设计原则总结

**1. 分离原则**

- 系统与用户分离：/usr vs /home
- 可变与不变分离：/var vs /usr
- 临时与永久分离：/tmp vs /home
- 全局与用户分离：/etc vs ~/.config

**2. 权限原则**

- 最小权限原则：普通用户只需要 /bin，不需要 /sbin
- 隔离原则：用户之间互相隔离（/home/user）
- 特权分离：root 有独立位置（/root）

**3. 启动原则**

- 启动必需文件在根分区：/bin, /sbin, /lib, /boot
- 非启动必需可以独立分区：/home, /var, /usr

**4. 可维护性原则**

- 按服务组织配置：/etc/ssh/, /etc/nginx/
- 日志独立管理：/var/log/
- 软件包管理器友好：/usr/bin vs /usr/local/bin

**5. "一切皆文件"原则**

- 设备是文件：/dev/
- 进程信息是文件：/proc/
- 系统信息是文件：/sys/
- 配置是文本文件：/etc/

### Q1：为什么 /usr/bin 和 /usr/sbin 不在 /bin 和 /sbin？

历史演变。最初所有命令都在 /bin 和 /sbin，后来软件越来越多，就移到了 /usr 下。现在 /bin 和 /sbin 是指向 /usr/bin 和 /usr/sbin 的符号链接（在现代系统中）。

### Q2：为什么不把所有配置都放在 /etc？

- 用户配置需要在用户目录下（~/.config）
- systemd 配置有自己的覆盖机制
- 有些软件把配置放在自己的安装目录下（如 /opt）

### Q3：/var 和 /tmp 有什么区别？

- /var：重启后保留，用于日志、缓存、数据库
- /tmp：重启时清空，用于临时文件

### Q4：/proc 和 /sys 有什么区别？

- /proc：进程信息、系统信息（传统，有些混乱）
- /sys：硬件、驱动、内核参数（现代，结构清晰）
- /sys 是 /proc 的"继任者"

### 常用场景

```bash
# 场景 1：查找配置文件
find /etc -name "*ssh*" -type f
# 结果：/etc/ssh/sshd_config, /etc/ssh/ssh_config

# 场景 2：查看系统信息
cat /proc/cpuinfo
cat /proc/meminfo

# 场景 3：管理日志
tail -f /var/log/messages
tail -f /var/log/secure

# 场景 4：理解软件安装位置
which vim        # /usr/bin/vim（包管理器安装）
which myapp      # /usr/local/bin/myapp（源码编译安装）

# 场景 5：理解挂载
mount | grep "^/dev"
df -h
```

### 延伸阅读

- **FHS 标准**：Filesystem Hierarchy Standard，定义了 Linux 目录结构的规范，确保不同发行版的兼容性
- `man hier`：查看目录结构说明

### 学习建议

1. **理解原则**：记住 5 个设计原则，而不是死记目录
2. **动手实践**：用 `ls -l /` 查看每个目录的权限和所有者
3. **实际应用**：在实际工作中理解目录用途

> **总结**：Linux 目录结构的设计逻辑是**分类、隔离、可管理**。理解了设计原则，就能推导出任何文件应该放在哪里。不要死记硬背，要理解"为什么"。

---
来源：linux_directory_logic.md