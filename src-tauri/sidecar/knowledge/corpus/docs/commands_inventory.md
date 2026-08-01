# 📋 已学命令清单

> 按项目记录所有已学命令，包含命令名、常用选项、来源项目、学习深度。
> 智能体在生成内容时，应参照此清单判断命令是否已学，调整注释深度。
> ⚠️ 所有内容基于原始PPT和Word文档提取，非虚构。

---

## 🎓 大一上学期

### 项目1：破解原系统、安装新系统

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `mount` | -o | 高级 |
| `passwd` | 基础用法 | 高级 |
| `fdisk` | -l | 进阶 |
| `cat` | 基础用法 | 高级 |
| `touch` | 基础用法 | 进阶 |
| `chroot` | 基础用法 | 基础 |

### 项目2：管理文件

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `ls` | -a, -l, -ld, -R | 高级 |
| `cd` | 基础用法 | 高级 |
| `pwd` | 基础用法 | 基础 |
| `cat` | 基础用法 | 高级 |
| `cp` | -a, -r | 进阶 |
| `mv` | 基础用法 | 基础 |
| `rm` | -f, -r, -rf, -i | 进阶 |
| `mkdir` | -p | 高级 |
| `touch` | 基础用法 | 进阶 |
| `ln` | -s | 基础 |
| `grep` | 基础用法 | 高级 |
| `find` | -name, -type, -user, -exec, -mtime | 高级 |
| `alias` | 基础用法 | 基础 |
| `more` | 基础用法 | 基础 |
| `less` | 基础用法 | 基础 |

### 项目3：配置本地yum仓库并安装工具

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `yum` | -y, install, repolist, grouplist, groupinstall, remove, clean | 高级 |
| `vi` | 基础用法 | 进阶 |
| `vim` | 基础用法 | 高级 |
| `mount` | 基础用法 | 高级 |
| `systemctl` | isolate, set-default, get-default, enable, status | 高级 |
| `df` | -Th, -h | 进阶 |
| `wget` | 基础用法 | 进阶 |
| `which` | 基础用法 | 基础 |

### 项目4：管理用户和组

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `useradd` | -u, -d, -G, -s, -m | 高级 |
| `userdel` | -r | 基础 |
| `usermod` | -u, -d, -G, -s, -e | 进阶 |
| `groupadd` | 基础用法 | 进阶 |
| `groupmod` | 基础用法 | 基础 |
| `passwd` | --stdin | 高级 |
| `id` | 基础用法 | 基础 |
| `gpasswd` | -a, -M | 进阶 |
| `chage` | -l, -E | 基础 |
| `grep` | 基础用法 | 高级 |
| `echo` | 基础用法 | 高级 |

### 项目5：Linux文件系统权限与访问控制-基础权限

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `chmod` | -R | 进阶 |
| `chown` | -R | 进阶 |
| `chgrp` | 基础用法 | 基础 |
| `mkdir` | -p, -m | 高级 |
| `touch` | 基础用法 | 进阶 |
| `useradd` | 基础用法 | 高级 |
| `gpasswd` | 基础用法 | 进阶 |
| `rm` | -rf | 进阶 |
| `cp` | 基础用法 | 进阶 |
| `echo` | 基础用法 | 高级 |
| `id` | 基础用法 | 基础 |
| `getfacl` | 基础用法 | 基础 |
| `setfacl` | -m, -x | 基础 |

### 项目6：文件搜索、打包归档

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `find` | -name, -type, -user, -exec, -mtime, -size, -ok | 高级 |
| `locate` | 基础用法 | 基础 |
| `tar` | -cvf, -czf, -cjf, -xvf, -xzvf, -C | 高级 |
| `gzip` | -d | 基础 |
| `bzip2` | -d | 基础 |
| `xz` | -d | 基础 |
| `zip` | -r | 基础 |
| `unzip` | -d | 基础 |
| `which` | 基础用法 | 基础 |
| `whereis` | 基础用法 | 基础 |
| `wc` | -l, -w, -c | 进阶 |
| `du` | -sh | 进阶 |
| `grep` | 基础用法 | 高级 |
| `cat` | 基础用法 | 高级 |

### 项目7：网络连接、资源共享

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `ip` | a, addr | 基础 |
| `ping` | -c | 高级 |
| `nmcli` | 基础用法 | 进阶 |
| `nmtui` | 基础用法 | 基础 |
| `ifconfig` | 基础用法 | 基础 |
| `ssh` | 基础用法 | 基础 |
| `scp` | 基础用法 | 基础 |
| `systemctl` | enable, --now, status, stop | 高级 |
| `yum` | -y | 高级 |
| `rpm` | -qa | 高级 |
| `mkdir` | 基础用法 | 高级 |
| `chmod` | 基础用法 | 进阶 |
| `chown` | 基础用法 | 进阶 |
| `useradd` | 基础用法 | 高级 |
| `gpasswd` | 基础用法 | 进阶 |
| `setenforce` | 基础用法 | 进阶 |
| `getenforce` | 基础用法 | 基础 |

### 项目8：磁盘管理和文件系统

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `fdisk` | -l | 进阶 |
| `mkfs` | -t | 进阶 |
| `mount` | -a, -o | 高级 |
| `umount` | 基础用法 | 基础 |
| `df` | -Th, -h | 进阶 |
| `du` | -sh | 进阶 |
| `free` | -h, -m | 进阶 |
| `mkswap` | 基础用法 | 进阶 |
| `swapon` | -s | 进阶 |
| `blkid` | 基础用法 | 基础 |
| `lsblk` | -f | 进阶 |
| `quotacheck` | -ugcv | 基础 |
| `quotaon` | -ugv | 基础 |
| `edquota` | -u, -g, -t | 进阶 |
| `repquota` | 基础用法 | 基础 |
| `xfs_quota` | -x, -c | 高级 |
| `vim` | 基础用法 | 高级 |

## 🎓 大一下学期

### 项目1：环境变量的配置

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `echo` | 基础用法 | 高级 |
| `export` | 基础用法 | 基础 |
| `source` | 基础用法 | 基础 |
| `vim` | 基础用法 | 高级 |
| `cat` | 基础用法 | 高级 |

### 项目2：sed命令的使用

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `sed` | -i, -n, -e | 进阶 |

### 项目3：配置SSH免密登录服务

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `ssh` | 基础用法 | 基础 |
| `ssh-keygen` | -t | 基础 |
| `ssh-copy-id` | 基础用法 | 基础 |
| `scp` | 基础用法 | 基础 |
| `systemctl` | enable, --now, status, restart | 高级 |
| `vim` | 基础用法 | 高级 |
| `ping` | -c | 高级 |
| `nmcli` | 基础用法 | 进阶 |

### 项目4：系统间的文件传送和同步

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `scp` | -r | 基础 |
| `sftp` | 基础用法 | 基础 |
| `rsync` | -avz, --delete | 基础 |

### 项目5：分析和存储日志

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `journalctl` | -u, -f, --since | 基础 |
| `logger` | -p, -t | 基础 |
| `systemctl` | status, restart | 高级 |
| `timedatectl` | set-timezone, set-ntp | 基础 |
| `tail` | -f | 基础 |
| `rpm` | 基础用法 | 高级 |
| `yum` | -y | 高级 |
| `echo` | 基础用法 | 高级 |

### 项目6：管理磁盘分区

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `parted` | mklabel, mkpart, print, rm | 进阶 |
| `fdisk` | -l | 进阶 |
| `mkfs` | -t | 进阶 |
| `mount` | -a | 高级 |
| `swapon` | -s | 进阶 |
| `mkswap` | 基础用法 | 进阶 |
| `blkid` | 基础用法 | 基础 |
| `lsblk` | -f | 进阶 |
| `free` | -h | 进阶 |
| `cat` | 基础用法 | 高级 |
| `grep` | 基础用法 | 高级 |
| `ls` | 基础用法 | 高级 |

### 项目7：管理逻辑卷LVM

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `pvcreate` | 基础用法 | 基础 |
| `vgcreate` | -s | 基础 |
| `lvcreate` | -L, -l, -n | 进阶 |
| `lvdisplay` | 基础用法 | 基础 |
| `vgdisplay` | 基础用法 | 基础 |
| `pvdisplay` | 基础用法 | 基础 |
| `lvextend` | -L, -r | 基础 |
| `vgextend` | 基础用法 | 基础 |
| `resize2fs` | 基础用法 | 基础 |
| `xfs_growfs` | 基础用法 | 基础 |
| `mkfs` | -t | 进阶 |
| `mount` | -a | 高级 |
| `mkdir` | 基础用法 | 高级 |
| `df` | -h | 进阶 |
| `lsblk` | 基础用法 | 进阶 |
| `parted` | 基础用法 | 进阶 |
| `vim` | 基础用法 | 高级 |

### 项目8：VDO优化磁盘空间

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `vdo` | create, --name, --device, --vdoLogicalSize | 基础 |
| `vdostats` | --human-readable | 基础 |
| `systemctl` | enable, --now, status | 高级 |
| `yum` | -y | 高级 |
| `rpm` | 基础用法 | 高级 |

### 项目9：NFS访问网络存储

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `yum` | -y | 高级 |
| `systemctl` | enable, --now, status | 高级 |
| `exportfs` | -r, -v | 基础 |
| `showmount` | -e | 进阶 |
| `mount` | -t | 高级 |
| `mkdir` | -p | 高级 |
| `chmod` | 基础用法 | 进阶 |
| `rpm` | -qa | 高级 |

### 项目10：NFS访问网络存储（复习）

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `yum` | -y | 高级 |
| `systemctl` | enable, --now, status | 高级 |
| `exportfs` | -r, -v | 基础 |
| `showmount` | -e | 进阶 |
| `mount` | -t | 高级 |
| `mkdir` | -p | 高级 |
| `chmod` | 基础用法 | 进阶 |
| `rpm` | -qa | 高级 |
| `ping` | -c | 高级 |

## 🎓 当前学期

### 项目10：NFS访问网络存储

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `yum` | -y | 高级 |
| `systemctl` | enable, --now, status | 高级 |
| `exportfs` | -r, -v | 基础 |
| `showmount` | -e | 进阶 |
| `mount` | -t | 高级 |
| `mkdir` | -p | 高级 |
| `chmod` | 基础用法 | 进阶 |
| `rpm` | -qa | 高级 |
| `ping` | -c | 高级 |

### 项目11：管理SELinux安全

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `sestatus` | -v | 基础 |
| `getenforce` | 基础用法 | 基础 |
| `setenforce` | 0, 1 | 进阶 |
| `chcon` | -t, -R, --reference | 基础 |
| `semanage` | fcontext, -a, -t, -m, -d | 基础 |
| `restorecon` | -R, -v | 基础 |
| `setsebool` | -P | 基础 |
| `getsebool` | -a | 基础 |
| `sealert` | -a | 基础 |
| `audit2why` | 基础用法 | 基础 |
| `audit2allow` | -w, -M | 基础 |
| `yum` | -y | 高级 |
| `rpm` | 基础用法 | 高级 |
| `systemctl` | enable, --now, status, restart | 高级 |
| `ls` | -Z, -ld | 高级 |
| `ps` | -Z | 基础 |

### 项目12：管理防火墙

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `firewall-cmd` | --get-zones, --get-default-zone, --set-default-zone, --get-active-zones, --list-services, --list-ports, --list-all, --add-service, --add-port, --remove-service, --remove-port, --add-forward-port, --add-rich-rule, --list-rich-rules, --list-forward-ports, --add-masquerade, --query-masquerade, --permanent, --reload, --state | 进阶 |
| `systemctl` | start, stop, restart, enable, status, disable | 高级 |
| `semanage` | port, -a, -t, -p | 基础 |
| `getenforce` | 基础用法 | 基础 |
| `restorecon` | -v | 基础 |
| `yum` | -y | 高级 |
| `rpm` | -q | 高级 |
| `curl` | 基础用法 | 基础 |

### 项目13：管理进程和计划任务

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `ps` | aux, -ef, -e, -f, -a, -u, -x | 进阶 |
| `top` | 基础用法, > 重定向 | 基础 |
| `kill` | -9, %作业号 | 进阶 |
| `killall` | 基础用法, -9 | 基础 |
| `jobs` | -l | 基础 |
| `fg` | %作业号 | 基础 |
| `bg` | %作业号 | 基础 |
| `crontab` | -e, -l, -r, -u, -i | 进阶 |
| `systemctl` | start, status, enable, restart | 高级 |
| `yum` | -y, provides, install | 高级 |
| `which` | 基础用法 | 基础 |
| `echo` | >> 追加重定向 | 基础 |

### 项目14：调优系统性能

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `tuned-adm` | list, active, profile, profile_info, recommend, off, auto_profile | 进阶 |
| `tuned` | systemctl status/start/enable | 基础 |
| `nice` | -n | 进阶 |
| `renice` | -n, -p, -g, -u | 进阶 |
| `top` | 交互命令r（修改优先级） | 进阶 |
| `ps` | -l, axo pid,comm,pcpu,nice | 进阶 |
| `killall` | -u（按用户终止） | 进阶 |
| `at` | 时间格式（11:30） | 基础 |
| `atq` | 基础用法 | 基础 |
| `atrm` | 任务号 | 基础 |
| `chrt` | -f, -p | 基础 |
| `date` | 基础用法 | 基础 |
| `timedatectl` | set-ntp | 基础 |

### 项目14：管理Shell脚本

| 命令 | 已学选项 | 学习深度 |
|------|---------|---------|
| `bash` | 基础用法（执行脚本） | 进阶 |
| `useradd` | -g, -s | 高级 |
| `userdel` | -r | 进阶 |
| `groupadd` | 基础用法 | 进阶 |
| `groupdel` | 基础用法 | 基础 |
| `passwd` | --stdin | 高级 |
| `chmod` | a+x, 0+x | 高级 |
| `whoami` | 基础用法 | 基础 |
| `read` | -p, -t, -s, -n | 进阶 |
| `echo` | -e, $(), 管道 | 高级 |
| `cat` | 基础用法 | 高级 |
| `grep` | 基础用法 | 高级 |
| `id` | 基础用法 | 进阶 |
| `vim` | 基础用法（编写脚本） | 高级 |
| `ls` | -la | 高级 |

---

## 📊 命令学习进度总览

### 命令首次出现与深化记录

| 命令 | 英文全称 | 首次出现 | 后续深化项目 | 学习深度 |
|------|---------|---------|-------------|---------|
| `alias` | alias | 大一上学期-项目2 | - | 基础 |
| `at` | at | 当前学期-项目14 | - | 基础 |
| `atq` | at queue | 当前学期-项目14 | - | 基础 |
| `atrm` | at remove | 当前学期-项目14 | - | 基础 |
| `audit2allow` | audit to allow | 当前学期-项目11 | - | 基础 |
| `audit2why` | audit to why | 当前学期-项目11 | - | 基础 |
| `bash` | Bourne Again Shell | 当前学期-项目14 | - | 进阶 |
| `bg` | background | 当前学期-项目13 | - | 基础 |
| `blkid` | block ID | 大一上学期-项目8 | 大一下学期-项目6 | 基础 |
| `bzip2` | Burrows-Wheeler compress | 大一上学期-项目6 | - | 基础 |
| `cat` | concatenate | 大一上学期-项目1 | 大一上学期-项目2, 大一上学期-项目6, 大一下学期-项目2, 大一下学期-项目6, 当前学期-项目14 | 高级 |
| `cd` | change directory | 大一上学期-项目2 | 大一上学期-项目3, 大一上学期-项目5, 大一上学期-项目6 | 高级 |
| `chage` | change age | 大一上学期-项目4 | - | 基础 |
| `chcon` | change context | 当前学期-项目11 | - | 基础 |
| `chgrp` | change group | 大一上学期-项目5 | - | 基础 |
| `chmod` | change mode | 大一上学期-项目5 | 大一上学期-项目7, 当前学期-项目14 | 进阶 |
| `chown` | change owner | 大一上学期-项目5 | 大一上学期-项目7 | 进阶 |
| `chrt` | change real-time | 当前学期-项目14 | - | 基础 |
| `chroot` | change root | 大一上学期-项目1 | - | 基础 |
| `cp` | copy | 大一上学期-项目2 | 大一上学期-项目5, 大一上学期-项目6 | 进阶 |
| `crontab` | cron table | 当前学期-项目13 | - | 进阶 |
| `curl` | client URL | 当前学期-项目12 | - | 基础 |
| `date` | date | 当前学期-项目14 | - | 基础 |
| `dd` | data duplicator | 大一上学期-项目2 | 大一上学期-项目3 | 进阶 |
| `df` | disk free | 大一上学期-项目3 | 大一上学期-项目8, 大一下学期-项目7 | 进阶 |
| `du` | disk usage | 大一上学期-项目6 | 大一上学期-项目8 | 进阶 |
| `echo` | echo | 大一上学期-项目4 | 大一上学期-项目5, 大一下学期-项目1, 大一下学期-项目5, 当前学期-项目14 | 高级 |
| `edquota` | edit quota | 大一上学期-项目8 | - | 进阶 |
| `export` | export | 大一下学期-项目1 | - | 基础 |
| `exportfs` | export file systems | 大一下学期-项目9 | - | 基础 |
| `fdisk` | fixed disk | 大一上学期-项目1 | 大一上学期-项目8, 大一下学期-项目6 | 进阶 |
| `fg` | foreground | 当前学期-项目13 | - | 基础 |
| `file` | file | 大一上学期-项目5 | 大一上学期-项目6 | 进阶 |
| `find` | find | 大一上学期-项目2 | 大一上学期-项目6 | 高级 |
| `firewall-cmd` | firewall command | 当前学期-项目12 | - | 进阶 |
| `free` | free | 大一上学期-项目8 | 大一下学期-项目6 | 进阶 |
| `getenforce` | get enforce | 大一上学期-项目7 | 当前学期-项目11 | 基础 |
| `getsebool` | get SELinux boolean | 当前学期-项目11 | - | 基础 |
| `gpasswd` | group password | 大一上学期-项目5 | 大一上学期-项目7 | 进阶 |
| `grep` | global regular expression print | 大一上学期-项目2 | 大一上学期-项目4, 大一上学期-项目6, 大一上学期-项目7, 大一下学期-项目6, 当前学期-项目14 | 高级 |
| `groupadd` | group add | 大一上学期-项目4 | 大一上学期-项目5, 大一上学期-项目7, 当前学期-项目14 | 进阶 |
| `groupdel` | group delete | 当前学期-项目14 | - | 基础 |
| `groupmod` | group modify | 大一上学期-项目4 | - | 基础 |
| `gzip` | GNU zip | 大一上学期-项目6 | - | 基础 |
| `id` | identity | 大一上学期-项目4 | 当前学期-项目14 | 进阶 |
| `ifconfig` | interface config | 大一上学期-项目7 | - | 基础 |
| `ip` | internet protocol | 大一上学期-项目7 | - | 基础 |
| `jobs` | jobs | 当前学期-项目13 | - | 基础 |
| `journalctl` | journal control | 大一下学期-项目5 | - | 基础 |
| `kill` | kill | 当前学期-项目13 | - | 进阶 |
| `killall` | kill all | 当前学期-项目13 | 当前学期-项目14 | 进阶 |
| `less` | less | 大一上学期-项目2 | - | 基础 |
| `ln` | link | 大一上学期-项目2 | - | 基础 |
| `locate` | locate | 大一上学期-项目6 | - | 基础 |
| `logger` | logger | 大一下学期-项目5 | - | 基础 |
| `ls` | list | 大一上学期-项目2 | 大一上学期-项目3, 大一上学期-项目6, 大一上学期-项目7, 大一下学期-项目6, 当前学期-项目11, 当前学期-项目14 | 高级 |
| `lsblk` | list block | 大一上学期-项目8 | 大一下学期-项目6, 大一下学期-项目7 | 进阶 |
| `lvcreate` | logical volume create | 大一下学期-项目7 | - | 进阶 |
| `lvdisplay` | logical volume display | 大一下学期-项目7 | - | 基础 |
| `lvextend` | logical volume extend | 大一下学期-项目7 | - | 基础 |
| `mkdir` | make directory | 大一上学期-项目2 | 大一上学期-项目5, 大一上学期-项目6, 大一上学期-项目7, 大一上学期-项目8, 大一下学期-项目7 | 高级 |
| `mkfs` | make filesystem | 大一上学期-项目8 | 大一下学期-项目6, 大一下学期-项目7 | 进阶 |
| `mkswap` | make swap | 大一上学期-项目8 | 大一下学期-项目6 | 进阶 |
| `more` | more | 大一上学期-项目2 | 大一下学期-项目7 | 基础 |
| `mount` | mount | 大一上学期-项目1 | 大一上学期-项目2, 大一上学期-项目3, 大一上学期-项目7, 大一上学期-项目8, 大一下学期-项目6, 大一下学期-项目7, 大一下学期-项目9, 当前学期-项目10 | 高级 |
| `mv` | move | 大一上学期-项目2 | 大一上学期-项目6 | 基础 |
| `nice` | nice | 当前学期-项目14 | - | 进阶 |
| `nmcli` | NetworkManager CLI | 大一上学期-项目7 | 大一下学期-项目3 | 进阶 |
| `nmtui` | NetworkManager TUI | 大一上学期-项目7 | - | 基础 |
| `parted` | partition editor | 大一下学期-项目6 | 大一下学期-项目7 | 进阶 |
| `passwd` | password | 大一上学期-项目1 | 大一上学期-项目2, 大一上学期-项目4, 大一上学期-项目5, 大一上学期-项目7, 当前学期-项目14 | 高级 |
| `ping` | packet internet groper | 大一上学期-项目7 | 大一下学期-项目3, 当前学期-项目10 | 高级 |
| `ps` | process status | 当前学期-项目11 | 当前学期-项目13, 当前学期-项目14 | 进阶 |
| `pvcreate` | physical volume create | 大一下学期-项目7 | - | 基础 |
| `pvdisplay` | physical volume display | 大一下学期-项目7 | - | 基础 |
| `quotacheck` | quota check | 大一上学期-项目8 | - | 基础 |
| `quotaon` | quota on | 大一上学期-项目8 | - | 基础 |
| `read` | read | 当前学期-项目14 | - | 进阶 |
| `renice` | renice | 当前学期-项目14 | - | 进阶 |
| `repquota` | report quota | 大一上学期-项目8 | - | 基础 |
| `resize2fs` | resize ext filesystem | 大一下学期-项目7 | - | 基础 |
| `restorecon` | restore context | 当前学期-项目11 | 当前学期-项目12 | 基础 |
| `rm` | remove | 大一上学期-项目2 | 大一上学期-项目5, 大一上学期-项目6, 当前学期-项目14 | 进阶 |
| `rpm` | Red Hat Package Manager | 大一上学期-项目7 | 大一下学期-项目5, 大一下学期-项目8, 大一下学期-项目9, 当前学期-项目10, 当前学期-项目11, 当前学期-项目12 | 高级 |
| `rsync` | remote synchronize | 大一下学期-项目4 | - | 基础 |
| `scp` | secure copy | 大一上学期-项目7 | 大一下学期-项目4 | 基础 |
| `sealert` | SELinux alert | 当前学期-项目11 | - | 基础 |
| `sed` | stream editor | 大一下学期-项目2 | - | 进阶 |
| `semanage` | SELinux manage | 当前学期-项目11 | 当前学期-项目12 | 基础 |
| `setenforce` | set enforce | 大一上学期-项目7 | 大一上学期-项目8, 当前学期-项目11 | 进阶 |
| `setfacl` | set file ACL | 大一上学期-项目5 | - | 基础 |
| `setsebool` | set SELinux boolean | 当前学期-项目11 | - | 基础 |
| `sftp` | secure FTP | 大一下学期-项目4 | - | 基础 |
| `showmount` | show mount | 大一下学期-项目9 | 当前学期-项目10 | 进阶 |
| `source` | source | 大一下学期-项目1 | - | 基础 |
| `ssh` | secure shell | 大一上学期-项目7 | 大一下学期-项目3 | 基础 |
| `ssh-copy-id` | SSH copy identity | 大一下学期-项目3 | - | 基础 |
| `ssh-keygen` | SSH key generate | 大一下学期-项目3 | - | 基础 |
| `swapon` | swap on | 大一上学期-项目8 | 大一下学期-项目6 | 进阶 |
| `systemctl` | system control | 大一上学期-项目3 | 大一上学期-项目7, 大一下学期-项目3, 大一下学期-项目5, 大一下学期-项目8, 大一下学期-项目9, 当前学期-项目10, 当前学期-项目11, 当前学期-项目12, 当前学期-项目13, 当前学期-项目14 | 高级 |
| `tail` | tail | 大一下学期-项目5 | - | 基础 |
| `tar` | tape archive | 大一上学期-项目6 | - | 高级 |
| `timedatectl` | time date control | 大一下学期-项目5 | 当前学期-项目14 | 基础 |
| `top` | top | 当前学期-项目13 | 当前学期-项目14 | 进阶 |
| `touch` | touch | 大一上学期-项目2 | 大一上学期-项目5, 大一上学期-项目6 | 进阶 |
| `tuned` | tuned | 当前学期-项目14 | - | 基础 |
| `tuned-adm` | tuned administration | 当前学期-项目14 | - | 进阶 |
| `umount` | unmount | 大一上学期-项目8 | - | 基础 |
| `unzip` | unzip | 大一上学期-项目6 | - | 基础 |
| `useradd` | user add | 大一上学期-项目4 | 大一上学期-项目5, 大一上学期-项目7, 当前学期-项目14 | 高级 |
| `userdel` | user delete | 大一上学期-项目4 | 当前学期-项目14 | 进阶 |
| `usermod` | user modify | 大一上学期-项目4 | - | 进阶 |
| `vdo` | virtual data optimizer | 大一下学期-项目8 | - | 基础 |
| `vdostats` | VDO statistics | 大一下学期-项目8 | - | 基础 |
| `vgcreate` | volume group create | 大一下学期-项目7 | - | 基础 |
| `vgdisplay` | volume group display | 大一下学期-项目7 | - | 基础 |
| `vgextend` | volume group extend | 大一下学期-项目7 | - | 基础 |
| `vi` | visual editor | 大一上学期-项目2 | 大一上学期-项目3, 大一上学期-项目7 | 进阶 |
| `vim` | vi improved | 大一上学期-项目2 | 大一上学期-项目3, 大一上学期-项目8, 大一下学期-项目3, 大一下学期-项目7, 当前学期-项目14 | 高级 |
| `wc` | word count | 大一上学期-项目6 | - | 进阶 |
| `wget` | web get | 大一上学期-项目2 | 大一上学期-项目3 | 进阶 |
| `whereis` | where is | 大一上学期-项目6 | - | 基础 |
| `which` | which | 大一上学期-项目3 | 当前学期-项目13 | 基础 |
| `whoami` | who am I | 当前学期-项目14 | - | 基础 |
| `xfs_growfs` | XFS grow filesystem | 大一下学期-项目7 | - | 基础 |
| `xfs_quota` | XFS quota | 大一上学期-项目8 | - | 高级 |
| `xz` | xz | 大一上学期-项目6 | - | 基础 |
| `yum` | Yellowdog Updater Modified | 大一上学期-项目3 | 大一上学期-项目7, 大一下学期-项目5, 大一下学期-项目8, 大一下学期-项目9, 当前学期-项目10, 当前学期-项目11, 当前学期-项目12, 当前学期-项目13 | 高级 |
| `zip` | zip | 大一上学期-项目6 | - | 基础 |

