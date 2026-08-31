---
source: philosophy
category: linux-philosophy
url: command_etymology.md
title: command_etymology · 命令中英文对照与词源
---

# 命令中英文对照与词源

> Linux 命令的名称不是随机的，每一个都能从英文推导出功能。
> 理解了词源，命令就不再是需要死记的符号，而是有意义的英文单词组合。

### 文件与目录操作

| 命令 | 英文全称 | 中文含义 |
|------|---------|---------|
| ls | list | 列出目录内容 |
| cd | change directory | 切换目录 |
| pwd | print working directory | 显示当前目录 |
| mkdir | make directory | 创建目录 |
| rmdir | remove directory | 删除空目录 |
| touch | touch | 创建空文件/更新时间戳 |
| cp | copy | 复制 |
| mv | move | 移动/重命名 |
| rm | remove | 删除 |
| ln | link | 创建链接 |
| cat | concatenate | 连接并显示文件内容 |
| echo | echo | 回显输出 |
| head | head | 显示文件头部 |
| tail | tail | 显示文件尾部 |
| more | more | 分页查看（向前） |
| less | less | 分页查看（可前后翻） |
| tee | tee（T 型管） | 同时输出到屏幕和文件 |

### 搜索与过滤

| 命令 | 英文全称 | 中文含义 |
|------|---------|---------|
| grep | global regular expression print | 全局正则表达式搜索打印 |
| find | find | 查找文件 |
| locate | locate | 定位文件 |
| which | which | 查找命令位置 |
| whereis | where is | 查找命令源码和手册位置 |
| sort | sort | 排序 |
| uniq | unique | 去重 |
| cut | cut | 截取列 |
| tr | translate | 转换/删除字符 |
| wc | word count | 统计字数/行数 |
| diff | difference | 比较差异 |

### 用户与权限

| 命令 | 英文全称 | 中文含义 |
|------|---------|---------|
| useradd | user add | 添加用户 |
| userdel | user delete | 删除用户 |
| usermod | user modify | 修改用户 |
| groupadd | group add | 添加组 |
| groupdel | group delete | 删除组 |
| groupmod | group modify | 修改组 |
| passwd | password | 密码 |
| id | identity | 身份信息 |
| whoami | who am i | 显示当前用户名 |
| read | read | 从键盘读取变量 |
| gpasswd | group password | 组密码管理 |
| chage | change age | 修改密码有效期 |
| chmod | change mode | 修改权限模式 |
| chown | change owner | 修改所有者 |
| chgrp | change group | 修改所属组 |
| umask | user mask | 用户权限掩码 |
| chattr | change attribute | 修改文件属性 |
| lsattr | list attribute | 列出文件属性 |
| getfacl | get file access control list | 获取 ACL |
| setfacl | set file access control list | 设置 ACL |

### 系统服务与管理

| 命令 | 英文全称 | 中文含义 |
|------|---------|---------|
| systemctl | system control | 系统服务控制 |
| service | service | 服务管理 |
| chroot | change root | 切换根目录（紧急模式修复用） |
| udevadm | udev admin | 设备管理器管理工具 |
| date | date | 显示/设置系统日期时间 |
| journalctl | journal control | 日志控制 |
| hostnamectl | hostname control | 主机名控制 |
| timedatectl | time date control | 时间日期控制 |
| yum | Yellowdog Updater Modified | 包管理器 |
| dnf | Dandified Yum | 新版包管理器 |
| rpm | Red Hat Package Manager | RPM 包管理 |
| firewall-cmd | firewall command | 防火墙命令 |
| export | export | 导出环境变量 |
| source | source | 在当前 shell 执行脚本 |
| alias | alias | 别名 |
| history | history | 历史命令 |

### 网络与远程

| 命令 | 英文全称 | 中文含义 |
|------|---------|---------|
| ip | internet protocol | IP 地址管理 |
| ping | packet internet groper | 网络连通测试 |
| nmcli | NetworkManager command line | 网络管理命令行 |
| nmtui | NetworkManager text user interface | 网络管理文本界面 |
| ifconfig | interface configuration | 网卡配置 |
| ssh | secure shell | 安全远程登录 |
| scp | secure copy | 安全远程复制 |
| sftp | secure file transfer protocol | 安全文件传输 |
| ssh-keygen | ssh key generate | SSH 密钥生成 |
| ssh-copy-id | ssh copy identity | SSH 公钥复制 |
| rsync | remote synchronize | 远程同步 |
| wget | web get | 网络下载 |
| curl | client URL | URL 请求工具 |
| ss | socket statistics | 套接字统计 |
| netstat | network statistics | 网络统计 |

### 进程与计划任务

| 命令 | 英文全称 | 中文含义 |
|------|---------|---------|
| ps | process status | 进程状态 |
| top | top | 实时监控 |
| kill | kill | 终止进程 |
| killall | kill all | 终止所有同名进程 |
| jobs | jobs | 作业列表 |
| fg | foreground | 前台 |
| bg | background | 后台 |
| crontab | cron table | cron 任务表 |
| crond | cron daemon | cron 守护进程 |
| at | at | 一次性定时任务 |
| atq | at queue | 查看 at 任务队列 |
| atrm | at remove | 删除 at 任务 |

### 系统调优

| 命令 | 英文全称 | 中文含义 |
|------|---------|---------|
| tuned | tuned | 系统调优守护进程 |
| tuned-adm | tuned administration | tuned 管理工具 |
| nice | nice | 进程优先级调整值 |
| renice | renice | 重新调整进程优先级 |
| chrt | change real-time | 修改实时调度策略 |

### 磁盘与文件系统

| 命令 | 英文全称 | 中文含义 |
|------|---------|---------|
| fdisk | fixed disk | 磁盘分区工具 |
| gdisk | GPT fdisk | GPT 专用分区工具 |
| parted | partition editor | 分区编辑器 |
| mkfs | make file system | 创建文件系统 |
| fsck | file system check | 文件系统检查 |
| mount | mount | 挂载 |
| umount | unmount | 卸载 |
| df | disk free | 磁盘剩余空间 |
| du | disk usage | 磁盘使用量 |
| blkid | block device ID | 块设备标识 |
| lsblk | list block | 列出块设备 |
| free | free | 显示内存使用 |
| mkswap | make swap | 创建交换分区 |
| swapon | swap on | 启用交换分区 |
| swapoff | swap off | 关闭交换分区 |
| quotacheck | quota check | 配额检查 |
| quotaon | quota on | 启用配额 |
| edquota | edit quota | 编辑配额 |
| repquota | report quota | 报告配额 |
| xfs_quota | XFS quota | XFS 配额管理 |

### LVM 逻辑卷

| 命令 | 英文全称 | 中文含义 |
|------|---------|---------|
| pvcreate | physical volume create | 创建物理卷 |
| pvdisplay | physical volume display | 显示物理卷 |
| pvremove | physical volume remove | 删除物理卷 |
| vgcreate | volume group create | 创建卷组 |
| vgdisplay | volume group display | 显示卷组 |
| vgremove | volume group remove | 删除卷组 |
| vgextend | volume group extend | 扩展卷组 |
| lvcreate | logical volume create | 创建逻辑卷 |
| lvdisplay | logical volume display | 显示逻辑卷 |
| lvremove | logical volume remove | 删除逻辑卷 |
| lvextend | logical volume extend | 扩展逻辑卷 |
| lvreduce | logical volume reduce | 缩小逻辑卷 |
| lvresize | logical volume resize | 调整逻辑卷大小 |
| pvs | physical volume summary | 物理卷摘要 |
| vgs | volume group summary | 卷组摘要 |
| lvs | logical volume summary | 逻辑卷摘要 |
| xfs_growfs | XFS grow file system | 扩展 XFS 文件系统 |
| resize2fs | resize ext2/3/4 file system | 调整 ext 文件系统大小 |

### NFS 与自动挂载

| 命令 | 英文全称 | 中文含义 |
|------|---------|---------|
| exportfs | export file systems | 导出文件系统 |
| showmount | show mount | 显示 NFS 挂载信息 |
| rpcinfo | RPC information | RPC 信息查询 |
| rpcbind | RPC bind | RPC 绑定服务 |
| vdo | virtual data optimizer | 虚拟数据优化器 |
| vdostats | VDO statistics | VDO 统计信息 |

### SELinux 安全

| 命令 | 英文全称 | 中文含义 |
|------|---------|---------|
| sestatus | SELinux status | SELinux 状态 |
| getenforce | get enforce | 获取强制模式 |
| setenforce | set enforce | 设置强制模式 |
| chcon | change context | 修改安全上下文 |
| semanage | SELinux manage | SELinux 策略管理 |
| restorecon | restore context | 恢复安全上下文 |
| setsebool | set SELinux boolean | 设置 SELinux 布尔值 |
| getsebool | get SELinux boolean | 获取 SELinux 布尔值 |
| sealert | SELinux alert | SELinux 告警分析 |
| audit2why | audit to why | 审计日志原因分析 |
| audit2allow | audit to allow | 审计日志生成策略 |

### 文本编辑与处理

| 命令 | 英文全称 | 中文含义 |
|------|---------|---------|
| vi | visual editor | 可视化编辑器 |
| vim | vi improved | 改进版 vi |
| bash | Bourne Again Shell | Bash 解释器 |
| shebang | sha-bang | 脚本开头标记 #!（告诉内核用哪个解释器） |
| nano | nano | 简易文本编辑器 |
| sed | stream editor | 流编辑器 |
| awk | Aho Weinberger Kernighan | 文本处理语言（三位发明者姓名） |
| printf | print formatted | 格式化输出 |
| fmt | format | 格式化文本 |
| column | column | 列格式化 |

### 压缩与归档

| 命令 | 英文全称 | 中文含义 |
|------|---------|---------|
| tar | tape archive | 磁带归档 |
| gzip | GNU zip | GNU 压缩 |
| gunzip | GNU unzip | GNU 解压 |
| bzip2 | Burrows-Wheeler compress 2 | bzip2 压缩 |
| xz | xz | xz 压缩 |
| zip | zip | zip 压缩 |
| unzip | unzip | zip 解压 |

### 日志与监控

| 命令 | 英文全称 | 中文含义 |
|------|---------|---------|
| logger | logger | 写入日志 |
| chronyc | Chrony client | Chrony 时间同步客户端 |
| last | last | 显示最近登录 |
| dmesg | diagnostic message | 内核诊断信息 |
| lsof | list open files | 列出打开文件 |
| pgrep | process grep | 进程搜索 |
| uptime | uptime | 系统运行时间 |

## 二、Linux 目录名含义

| 目录 | 英文全称 | 中文含义 |
|------|---------|---------|
| /etc | et cetera（后演变为 Editable Text Config） | 附加配置文件目录 |
| /var | variable | 可变数据目录（日志/缓存） |
| /usr | Unix system resources | Unix 系统资源 |
| /opt | optional | 可选软件包目录 |
| /dev | device | 设备文件目录 |
| /proc | process | 进程信息目录 |
| /sys | system | 系统硬件信息 |
| /tmp | temporary | 临时文件目录 |
| /home | home | 用户主目录 |
| /root | root | 超级用户主目录 |
| /bin | binary | 基本命令二进制文件 |
| /sbin | system binary | 系统管理命令 |
| /lib | library | 共享库文件 |
| /mnt | mount | 临时挂载点 |
| /media | media | 可移动媒体挂载点 |
| /srv | service | 服务数据目录 |
| /boot | boot | 启动文件目录 |
| /run | run | 运行时数据 |

## 三、常用选项英文来源

| 选项 | 英文来源 | 中文含义 |
|------|---------|---------|
| -a | all | 所有 |
| -l | long | 长格式 |
| -r | recursive / reverse | 递归/反转 |
| -f | force | 强制 |
| -i | interactive / inode | 交互式/inode 号 |
| -v | verbose | 详细输出 |
| -h | human-readable | 人类可读格式 |
| -p | parents / preserve | 父目录/保留属性 |
| -R | recursive | 递归 |
| -e | execute / expression | 执行/表达式 |
| -n | number / no-action | 行号/不执行 |
| -s | silent / size | 静默/大小 |
| -t | type / target | 类型/目标 |
| -u | user / update | 用户/更新 |
| -g | group | 组 |
| -d | directory / delete | 目录/删除 |
| -m | mode / modify | 模式/修改 |
| -w | write / warning | 写入/警告 |
| -x | execute / extract | 执行/解压 |
| -z | gzip | gzip 压缩 |
| -c | create / count | 创建/计数 |
| -C | directory (change to) | 切换到目录 |
| -P | port / permanent | 端口/永久 |
| -L | logical / list | 逻辑/列表 |
| -S | size / socket | 大小/套接字 |
| -T | type | 类型 |
| --now | now | 立即 |
| --delete | delete | 删除 |
| --help | help | 帮助 |
| --version | version | 版本 |
| --stdin | standard input | 从标准输入读取 |

| 文件路径 | 英文含义 | 中文作用 |
|---------|---------|---------|
| /etc/passwd | password file | 用户信息文件（7 字段） |
| /etc/shadow | shadow file | 密码哈希文件（仅 root 可读） |
| /etc/group | group file | 组信息文件 |
| /etc/fstab | file system table | 文件系统挂载表（6 字段） |
| /etc/hosts | hosts file | 主机名与 IP 映射 |
| /etc/hostname | host name | 主机名配置 |
| /etc/resolv.conf | resolve configuration | DNS 解析配置 |
| /etc/ssh/sshd_config | SSH daemon config | SSH 服务配置 |
| /etc/samba/smb.conf | Samba configuration | Samba 共享配置 |
| /etc/exports | exports file | NFS 共享配置 |
| /etc/httpd/conf/httpd.conf | HTTP daemon config | Apache Web 配置 |
| /etc/named.conf | named configuration | DNS 服务配置 |
| /etc/vsftpd/vsftpd.conf | FTP daemon config | FTP 服务配置 |
| /etc/yum.repos.d/ | yum repositories | yum 仓库配置目录 |
| /etc/profile | profile file | 全局环境变量配置 |
| /etc/profile.d/ | profile directory | 自定义环境变量脚本目录 |
| /etc/bashrc | bash resource | 全局 bash 配置 |
| /etc/shells | shells file | 有效登录 shell 列表 |
| /etc/skel/ | skeleton | 新用户家目录模板 |
| /etc/crontab | cron table | 系统计划任务配置 |
| /var/spool/cron/ | spool cron | 用户计划任务目录 |
| /var/log/messages | messages | 系统日志 |
| /var/log/secure | secure log | 安全日志（登录/认证） |
| /var/log/audit/audit.log | audit log | SELinux 审计日志 |
| /var/www/html/ | web html | Apache 默认网站目录 |
| /proc/cpuinfo | CPU information | CPU 信息 |
| /proc/meminfo | memory information | 内存信息 |
| /proc/version | version | 内核版本 |
| /boot/grub2/grub.cfg | GRUB configuration | GRUB 主配置（勿手动编辑） |
| /etc/default/grub | default GRUB | GRUB 默认配置（可编辑） |
| ~/.bashrc | bash resource | 用户 bash 配置 |
| ~/.bash_profile | bash profile | 用户 bash 登录配置 |
| ~/.ssh/authorized_keys | authorized keys | SSH 已授权公钥 |
| /etc/auto.master | auto master | autofs 主配置 |
| /etc/logrotate.conf | logrotate configuration | 日志轮转配置 |

### 操作系统核心术语

| 英文术语 | 中文含义 | 说明 |
|---------|---------|------|
| Von Neumann architecture | 冯诺依曼体系结构 | 二进制+存储程序+五大部件 |
| stored program concept | 存储程序概念 | 程序和数据统一存储 |
| CPU (Central Processing Unit) | 中央处理器 | 运算器+控制器 |
| RAM (Random Access Memory) | 随机存取存储器 | 内存 |
| ROM (Read Only Memory) | 只读存储器 | 固件存储 |
| cache | 缓存 | 高速缓冲存储器 |
| bus | 总线 | 数据传输通道 |
| interrupt | 中断 | 外部/内部中断机制 |
| kernel | 内核 | OS 核心 |
| shell | 壳/命令解释器 | 用户与内核的接口 |
| process | 进程 | 资源分配单位 |
| thread | 线程 | 调度单位 |
| daemon | 守护进程（daemon） | 后台服务进程 |
| zombie process | 僵尸进程 | 已终止但未回收的进程 |
| virtual memory | 虚拟内存 | 主存-辅存两级存储 |
| paging | 分页 | 固定大小页面 |
| segmentation | 分段 | 逻辑段 |
| swap | 交换 | 内存与磁盘交换 |
| locality of reference | 局部性原理 | 时间局部性+空间局部性 |
| POSIX | Portable Operating System Interface | 可移植操作系统接口 |

### 网络核心术语

| 英文术语 | 中文含义 | 说明 |
|---------|---------|------|
| IP (Internet Protocol) | 网际协议 | 网络层协议 |
| TCP (Transmission Control Protocol) | 传输控制协议 | 可靠传输 |
| UDP (User Datagram Protocol) | 用户数据报协议 | 不可靠但快速 |
| DNS (Domain Name System) | 域名系统 | 域名解析 |
| DHCP (Dynamic Host Configuration Protocol) | 动态主机配置协议 | 自动分配 IP |
| HTTP (HyperText Transfer Protocol) | 超文本传输协议 | Web 协议 |
| HTTPS (HTTP Secure) | 安全超文本传输协议 | 加密 Web 协议 |
| FTP (File Transfer Protocol) | 文件传输协议 | 文件传输 |
| SSH (Secure Shell) | 安全壳协议 | 安全远程登录 |
| NFS (Network File System) | 网络文件系统 | 网络共享文件 |
| SMB/CIFS | Server Message Block | Windows 文件共享 |
| subnet mask | 子网掩码 | 网络划分 |
| gateway | 网关 | 网络出口 |
| port | 端口 | 服务标识 |
| firewall | 防火墙 | 网络安全设备 |
| zone | 区域 | 防火墙区域管理 |
| masquerade | 地址伪装 | NAT 功能 |
| port forwarding | 端口转发 | 端口映射 |
| rich rule | 富规则 | 高级防火墙规则 |
| MAC address (Media Access Control) | 物理地址 | 网卡硬件地址 |
| ARP (Address Resolution Protocol) | 地址解析协议 | IP→MAC 映射 |
| loopback | 回环接口 | 127.0.0.1 |
| Ethernet | 以太网 | 局域网技术 |
| RPC (Remote Procedure Call) | 远程过程调用 | NFS 依赖的机制 |

### 存储核心术语

| 英文术语 | 中文含义 | 说明 |
|---------|---------|------|
| partition | 分区 | 磁盘划分 |
| primary partition | 主分区 | 最多 4 个 |
| extended partition | 扩展分区 | 容纳逻辑分区 |
| logical partition | 逻辑分区 | 扩展分区内 |
| format | 格式化 | 创建文件系统 |
| mount / unmount | 挂载/卸载 | 设备与目录关联 |
| block device | 块设备 | 硬盘等 |
| inode | 索引节点 | 文件元数据 |
| block | 块 | 数据存储单元 |
| superblock | 超级块 | 文件系统元信息 |
| hard link | 硬链接 | 同一 inode |
| symbolic link / soft link | 符号链接/软链接 | 独立 inode |
| GPT (GUID Partition Table) | GUID 分区表 | 新分区表，无 2TB 限制 |
| MBR (Master Boot Record) | 主引导记录 | 旧分区表，≤2TB |
| ext4 (Fourth Extended FS) | 第四代扩展文件系统 | Linux 常用 |
| xfs (X Filesystem) | X 文件系统 | 高性能文件系统 |
| swap space | 交换空间 | 内存扩展 |
| disk quota | 磁盘配额 | 用户空间限制 |
| PV (Physical Volume) | 物理卷 | LVM 底层 |
| VG (Volume Group) | 卷组 | LVM 中层 |
| LV (Logical Volume) | 逻辑卷 | LVM 上层 |
| deduplication | 去重 | VDO 功能 |
| compression | 压缩 | VDO 功能 |

### 安全核心术语

| 英文术语 | 中文含义 | 说明 |
|---------|---------|------|
| SELinux (Security-Enhanced Linux) | 安全增强型 Linux | 内核安全子系统 |
| enforcing | 强制模式 | 违反策略就拦截 |
| permissive | 宽容模式 | 违反策略只记录 |
| disabled | 禁用模式 | 完全关闭 |
| security context | 安全上下文 | 用户:角色:类型:等级:类别 |
| boolean | 布尔值 | SELinux 策略开关 |
| DAC (Discretionary Access Control) | 自主访问控制 | 传统权限，主人说了算 |
| MAC (Mandatory Access Control) | 强制访问控制 | SELinux 权限，系统说了算 |
| RBAC (Role-Based Access Control) | 基于角色的访问控制 | 角色权限管理 |
| audit | 审计 | 安全日志记录 |
| policy | 策略 | SELinux 规则集 |
| targeted | 目标策略 | 默认 SELinux 策略 |
| SUID (Set User ID) | 设置用户 ID | 以属主身份运行 |
| SGID (Set Group ID) | 设置组 ID | 继承目录属组 |
| Sticky Bit | 粘滞位 | 只有属主能删除 |
| ACL (Access Control List) | 访问控制列表 | 精细化权限控制 |
| permission | 权限 | rwx 读写执行 |
| owner | 所有者 | 文件属主 |
| group | 组 | 文件属组 |
| others | 其他用户 | 非属主非属组 |

## 六、易混淆术语对比

| 对比项 | 区别 |
|--------|------|
| process vs thread | 进程=资源分配单位，线程=调度单位 |
| hard link vs soft link | 硬链接=同一 inode，软链接=新 inode |
| SUID vs SGID vs Sticky | SUID=属主运行，SGID=继承属组，Sticky=只有属主删 |
| DAC vs MAC | DAC=主人说了算，MAC=系统说了算 |
| Enforcing vs Permissive | 强制=拦截，宽容=只记录 |
| chcon vs semanage | 临时=chcon，永久=semanage+restorecon |
| nice vs renice | 新进程=nice，已运行=renice |
| lvextend vs resize2fs | 扩逻辑卷=lvextend，扩文件系统=resize2fs |
| ext4 vs xfs | 扩容：ext4=resize2fs，xfs=xfs_growfs |
| MBR vs GPT | MBR≤2TB，GPT 无限制 |
| export vs source | export=导出变量，source=执行脚本 |
| kill vs killall | kill=按 PID，killall=按进程名 |
| /etc/passwd vs /etc/shadow | 用户信息 vs 密码哈希 |
| /etc/profile vs ~/.bashrc | 全局 vs 用户级 |
| crontab -e vs /etc/crontab | 用户任务 vs 系统任务 |
| BRE vs ERE | 基础正则 vs 扩展正则（grep -E） |
| nice 范围 | -20（最高优先级）到 19（最低优先级），默认 0 |

---
来源：command_etymology.md