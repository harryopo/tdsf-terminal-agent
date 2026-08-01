# Linux文件系统层次结构标准（FHS）详解

> FHS = Filesystem Hierarchy Standard（文件系统层次结构标准）
> 所有Linux发行版都遵循这个标准，所以学一次，通用所有Linux（openEuler、CentOS、Ubuntu、RHEL）

---

## 一、为什么要理解FHS？

> 💡 当你敲 `vim /etc/systemd/system/xxx.service` 时，你不是在"死记硬背一个路径"，而是在遵循一个**有逻辑的设计**：
> - `/etc` 放配置 → 因为 `etc` 的历史含义就是"可编辑的配置"
> - `/usr` 放软件 → 因为 `usr` 原本是"Unix System Resources"
> - `/var` 放日志 → 因为 `var` = variable（变化的数据）
>
> 理解了FHS，遇到任何新路径都能猜个八九不离十。

---

## 二、顶层目录全景图

```
/                        根目录（Root）——一切文件的起点
├── bin/       → Binary（二进制可执行文件）——所有用户都能用的基础命令
├── boot/      → Boot（启动文件）——内核、引导程序（grub）
├── dev/       → Device（设备文件）——一切皆文件的体现：硬盘、终端、USB
├── etc/       → Editable Text Configuration（系统配置文件）——"配置总部"
├── home/      → Home（用户家目录）——普通用户的个人空间
│   └── zhangsan/ → 用户zhangsan的家目录
├── root/      → Root（root用户家目录）——管理员的私人空间
├── lib/       → Library（系统库文件）——bin和sbin依赖的共享库
├── lib64/     → Library 64-bit（64位系统库文件）
├── media/     → Media（可移动媒体挂载点）——U盘、光盘自动挂载这里
├── mnt/       → Mount（临时挂载点）——手动挂载硬盘用
├── opt/       → Optional（可选软件包）——第三方大型软件安装位置
├── proc/      → Process（进程虚拟文件系统）——内存中的实时系统信息
├── run/       → Run（运行时数据）——进程PID、锁文件等（重启后清空）
├── sbin/      → System Binary（系统管理命令）——只有root能用的管理命令
├── srv/       → Service（服务数据）——网站、FTP等服务提供的数据
├── sys/       → System（系统虚拟文件系统）——内核、硬件信息（比proc更新）
├── tmp/       → Temporary（临时文件）——所有用户都能放，重启自动清空
├── usr/       → Unix System Resources（Unix系统资源）——软件安装的主要位置
│   ├── bin/   → 用户安装的软件命令
│   ├── sbin/  → 用户安装的系统管理命令
│   ├── lib/   → 用户软件的库文件
│   ├── lib64/ → 用户软件的64位库文件
│   ├── include/ → C/C++头文件
│   ├── share/ → 共享数据（文档、字体、图标等）
│   └── local/ → 本地管理员安装的软件（源码编译安装默认在这里）
└── var/       → Variable（可变数据）——日志、缓存、邮件等经常变化的东西
    ├── log/   → 日志文件
    ├── cache/ → 应用程序缓存
    ├── spool/ → 队列数据（打印队列、邮件队列、cron任务）
    └── www/   → Web网站默认根目录（Apache/Nginx）
```

---

## 三、核心目录深度解析

### 📁 /etc —— "配置总部"

| 英文全称 | 含义 | 为什么在这？ |
|---------|------|------------|
| Editable Text Configuration（历史上：et cetera，"等等杂物"） | 系统级配置文件集中地 | 早期Unix里这是放"各种杂项配置"的地方，后来演变为**系统配置的核心目录** |

**你学过的/etc下的文件**：
- `/etc/sysconfig/network-scripts/` — 网络配置（项目5）
- `/etc/passwd` / `/etc/shadow` — 用户账户（项目7）
- `/etc/exports` — NFS共享配置（项目9）
- `/etc/selinux/config` — SELinux配置（项目10-11）
- `/etc/samba/smb.conf` — Samba配置（项目11）
- `/etc/crontab` / `/etc/cron.d/` — 系统级定时任务（项目12）
- `/etc/systemd/system/` — systemd自定义服务（项目13）

> 🔑 **规律**：以后找任何**系统服务的配置文件**，先去 `/etc/` 下找！

### 📁 /usr —— "软件安装区"

| 英文全称 | 含义 | 为什么在这？ |
|---------|------|------------|
| Unix System Resources（历史上：Unix Shared Resources） | Unix系统资源 | 早期Unix中，这是**各主机共享的只读数据**，软件都装在这里 |

**usr目录分层逻辑**：
```
/usr/
├── bin/       → 普通用户能用的软件命令（如firefox、gcc）
├── sbin/      → 管理员用的软件命令（如httpd、sshd非核心命令）
├── lib/       → 这些软件依赖的库
└── local/     → ⭐ 你自己编译安装的软件放在这里
    ├── bin/
    ├── sbin/
    └── lib/
```

> 🔑 **规律**：`yum install` 安装的软件 → `/usr/bin/`；你自己源码编译的 → `/usr/local/bin/`

### 📁 /var —— "变化数据区"

| 英文全称 | 含义 | 为什么在这？ |
|---------|------|------------|
| Variable（可变的） | 运行时会变化的数据 | 与 `/usr` 的"只读"相对，`/var` 专门放**会变、会增长**的数据 |

**你学过的/var下的文件**：
- `/var/log/` — 系统日志（`/var/log/messages`、`/var/log/audit/audit.log`）
- `/var/spool/cron/` — crontab任务的实际存储位置
- `/var/lib/samba/` — Samba用户数据库

### 📁 /proc 和 /sys —— "虚拟文件系统"

| 目录 | 英文全称 | 含义 | 特点 |
|------|---------|------|------|
| /proc | Process | 进程+系统信息 | 存在内存中，不占硬盘；重启消失 |
| /sys | System | 硬件+内核信息 | 比/proc更新、更规范；Linux 2.6后引入 |

**你学过的/proc内容**：
- `/proc/cpuinfo` — CPU信息（lscpu读的就是这个）
- `/proc/meminfo` — 内存信息（free读的就是这个）
- `/proc/PID/` — 每个进程的详细信息目录

### 📁 /dev —— "设备文件区"

| 英文全称 | 含义 | "一切皆文件"的体现 |
|---------|------|------------------|
| Device（设备） | 硬件设备以文件形式存在 | `/dev/sda` = 第一块硬盘、`/dev/tty` = 终端、`/dev/null` = 黑洞 |

**你学过的/dev下的设备**：
- `/dev/sda`、`/dev/sdb` — SATA/SCSI硬盘
- `/dev/cdrom` — 光驱
- `/dev/null` — 丢弃一切写入的数据（像黑洞）

---

## 四、目录设计的核心逻辑：四分区原则

```
┌─────────────────────────────────────────────────────────────┐
│                        根目录 /                             │
├─────────────┬──────────────┬─────────────┬─────────────────┤
│  可执行程序  │   配置文件    │  变化数据    │   用户数据       │
│  (bin/sbin) │    (/etc)    │   (/var)    │  (/home /root)  │
├─────────────┼──────────────┼─────────────┼─────────────────┤
│ /bin        │ /etc         │ /var/log    │ /home/用户名     │
│ /sbin       │ /etc/...     │ /var/cache  │ /root           │
│ /usr/bin    │              │ /var/spool  │                 │
│ /usr/sbin   │              │ /var/www    │                 │
│ /usr/local/ │              │             │                 │
└─────────────┴──────────────┴─────────────┴─────────────────┘
```

**为什么要分开？**
1. **/usr 只读**：软件文件不需要经常改，可以只读挂载，更安全
2. **/etc 可写**：配置文件需要管理员编辑
3. **/var 可变**：日志会不断增长，单独分区防止撑爆根目录
4. **/home 独立**：用户数据与系统文件分离，重装系统不丢数据

---

## 五、文件路径的判断逻辑

遇到一个陌生路径时，按这个顺序思考：

```
这个路径是...
│
├── 以 /dev 开头？→ 这是设备文件
├── 以 /etc 开头？→ 这是系统配置文件
├── 以 /proc 或 /sys 开头？→ 这是内核/内存中的虚拟信息
├── 以 /var 开头？→ 这是运行时变化的数据（日志、缓存等）
├── 以 /usr 开头？→ 这是软件安装的文件
│   ├── /usr/bin → 普通命令
│   ├── /usr/sbin → 管理员命令
│   └── /usr/local → 本地安装的软件
├── 以 /home 开头？→ 这是普通用户的个人文件
├── 以 /root 开头？→ 这是root用户的个人文件
├── 以 /tmp 开头？→ 这是临时文件，重启消失
└── 以 /mnt 或 /media 开头？→ 这是挂载的外部存储
```

---

## 六、你学过的特殊文件/目录速查

| 路径 | 用途 | 所属类别 |
|------|------|---------|
| `/etc/sysconfig/network-scripts/ifcfg-ens33` | 网卡配置 | /etc 配置 |
| `/etc/fstab` | 开机自动挂载 | /etc 配置 |
| `/etc/passwd` | 用户信息数据库 | /etc 配置 |
| `/etc/shadow` | 用户密码（加密） | /etc 配置 |
| `/etc/group` | 用户组信息 | /etc 配置 |
| `/etc/exports` | NFS共享目录 | /etc 配置 |
| `/etc/samba/smb.conf` | Samba配置 | /etc 配置 |
| `/etc/selinux/config` | SELinux开关 | /etc 配置 |
| `/etc/ssh/sshd_config` | SSH服务配置 | /etc 配置 |
| `/etc/crontab` | 系统级定时任务 | /etc 配置 |
| `/etc/systemd/system/xxx.service` | 自定义systemd服务 | /etc 配置 |
| `/var/log/messages` | 系统主日志 | /var 变化数据 |
| `/var/log/audit/audit.log` | SELinux审计日志 | /var 变化数据 |
| `/var/spool/cron/` | 用户crontab存储 | /var 变化数据 |
| `/dev/sda1` | 第一个分区 | /dev 设备 |
| `/dev/cdrom` | 光驱 | /dev 设备 |
| `/dev/null` | 黑洞设备 | /dev 设备 |
| `/proc/cpuinfo` | CPU信息 | /proc 虚拟 |
| `/proc/meminfo` | 内存信息 | /proc 虚拟 |
| `/sys/class/net/` | 网络设备信息 | /sys 虚拟 |
| `/usr/bin/` | 用户命令目录 | /usr 软件 |
| `/usr/sbin/` | 管理员命令目录 | /usr 软件 |
| `/tmp/` | 临时目录 | /tmp 临时 |

---

## 七、重要子目录深度解析

### systemd的目录分层（项目13核心）

```
systemd相关的两个关键目录：

1. /usr/lib/systemd/system/
   → 系统自带/软件包安装的service文件
   → yum install httpd后，httpd.service就在这里
   → ⚠️ 不要手动修改这个目录！软件更新会覆盖你的修改

2. /etc/systemd/system/
   → 管理员（你）自定义的service/timer文件
   → 我们创建的pyrun.service、pyrun.timer就在这里
   → 优先级高于/usr/lib/systemd/system/（你可以覆盖软件默认配置）
   → ✅ 这是你应该编辑的地方

优先级：/etc/systemd/system/ > /run/systemd/system/ > /usr/lib/systemd/system/
（管理员自定义 > 运行时生成 > 系统自带）
```

> 💡 **为什么分两个目录？**
> 想象一下：`/usr/lib/` 是软件厂商（openEuler、Apache）给你的"出厂默认设置"，`/etc/` 是你自己的"个性化定制"。就像手机里"系统默认铃声"和"你自己设置的铃声"——系统铃声在手机出厂目录（不能改），你的铃声在个人目录（可以改）。

### cron的目录分层（项目12核心）

```
cron相关的三个关键位置：

1. /etc/crontab
   → 系统级定时任务配置文件
   → 直接编辑这个文件，需要指定用户名（root）

2. /etc/cron.d/
   → 系统级定时任务目录
   → 可以放多个文件，每个文件是一组任务
   → 软件包安装的cron任务通常放这里（如sysstat、logrotate）

3. /var/spool/cron/用户名
   → 用户级crontab
   → `crontab -e` 编辑的内容实际存在这里
   → 每个用户一个文件（如/var/spool/cron/root）
```
