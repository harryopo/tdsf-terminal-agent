# 📚 已学习知识库索引

> 本索引覆盖所有已学习项目，按学期→项目→知识点三层结构组织。
> 智能体在生成新项目内容时，应参照此索引判断已学知识点，避免超前或过于简单。
> ⚠️ 所有内容基于原始PPT和Word文档提取，非虚构。

---

## 🎓 大一上学期

| 序号 | 项目 | 核心知识点 | 关键命令 | 配置文件 |
|------|------|-----------|---------|---------|
| 1 | 破解原系统、安装新系统 | rd.break破解系统密码<br>最小化系统安装<br>grub菜单操作<br>SELinux重标记(.autorelabel)<br>分区查看(fdisk -l, /etc/fstab) | mount, passwd, fdisk, cat, touch, chroot | /etc/fstab |
| 2 | 管理文件 | 文件基本管理(ls/pwd/cd)<br>查看及切换目录<br>创建目录和文件(mkdir/touch)<br>复制/删除/移动(cp/rm/mv)<br>软链接(ln -s)<br>通配符(*, ?, []) | ls, cd, pwd, cat, cp, mv, rm, mkdir, touch, ln, grep, find, alias, more, less | - |
| 3 | 配置本地yum仓库并安装工具 | 配置本地yum仓库<br>vi/vim三种工作模式<br>yum包管理器<br>安装图形界面(Server with GUI)<br>界面切换(systemctl isolate)<br>设置默认启动界面(systemctl set-default) | yum, vi, vim, mount, systemctl, df, wget, which | /etc/yum.repos.d/*.repo |
| 4 | 管理用户和组 | 创建用户(useradd)和设置密码(passwd)<br>修改/删除/查询用户(usermod/userdel/id)<br>用户组管理(groupadd/gpasswd)<br>禁止用户登录(/sbin/nologin)<br>用户配置文件(/etc/passwd, /etc/shadow)<br>密码策略(chage) | useradd, userdel, usermod, groupadd, groupmod, passwd, id, gpasswd, chage, grep, echo | /etc/passwd<br>/etc/shadow<br>/etc/group |
| 5 | Linux文件系统权限与访问控制-基础权限 | 基本权限(rwx)和归属(属主/属组)<br>chmod修改权限<br>chown/chgrp修改归属<br>umask默认权限<br>特殊权限(SUID/SGID/Sticky Bit)<br>ACL访问控制(getfacl/setfacl) | chmod, chown, chgrp, mkdir, touch, useradd, gpasswd, rm, cp, echo, id, getfacl, setfacl | - |
| 6 | 文件搜索、打包归档 | 查找文件(find/locate)<br>文件打包归档(tar)<br>压缩解压(gzip/bzip2/xz/zip)<br>文件内容统计(wc)<br>磁盘使用量(du) | find, locate, tar, gzip, bzip2, xz, zip, unzip, which, whereis, wc, du, grep, cat | - |
| 7 | 网络连接、资源共享 | 网络基本配置(ip/nmcli)<br>网卡状态修改(nmtui)<br>Samba文件共享<br>防火墙基础(firewall-cmd)<br>SELinux临时切换(setenforce) | ip, ping, nmcli, nmtui, ifconfig, ssh, scp, systemctl, yum, rpm, mkdir, chmod, chown, useradd, gpasswd, setenforce, getenforce | /etc/samba/smb.conf<br>/etc/selinux/config |
| 8 | 磁盘管理和文件系统 | 磁盘分区(fdisk)<br>文件系统创建(mkfs)<br>挂载与卸载(mount/umount)<br>磁盘使用查看(df/du)<br>交换分区(mkswap/swapon)<br>磁盘配额(quotacheck/quotaon/edquota)<br>/etc/fstab自动挂载 | fdisk, mkfs, mount, umount, df, du, free, mkswap, swapon, blkid, lsblk, quotacheck, quotaon, edquota, repquota, xfs_quota, vim | /etc/fstab |

## 🎓 大一下学期

| 序号 | 项目 | 核心知识点 | 关键命令 | 配置文件 |
|------|------|-----------|---------|---------|
| 1 | 环境变量的配置 | 环境变量的定义和作用<br>设置临时环境变量(export)<br>设置永久环境变量(.bashrc)<br>全局环境变量(/etc/profile)<br>source使配置立即生效 | echo, export, source, vim, cat | ~/.bashrc<br>/etc/profile<br>/etc/bashrc |
| 2 | sed命令的使用 | sed流编辑器定义和作用<br>sed基本语法(s///, p, d, a, i, c)<br>sed删除/增加/修改/替换文本<br>sed -i直接修改文件<br>sed -n静默输出 | sed | /etc/passwd<br>/etc/fstab |
| 3 | 配置SSH免密登录服务 | SSH口令方式登录<br>SSH免密登录(ssh-keygen/ssh-copy-id)<br>SSH服务配置(/etc/ssh/sshd_config)<br>服务器克隆与网络配置 | ssh, ssh-keygen, ssh-copy-id, scp, systemctl, vim, ping, nmcli | /etc/ssh/sshd_config |
| 4 | 系统间的文件传送和同步 | scp远程文件复制<br>sftp安全文件传输<br>rsync文件同步(-avz, --delete)<br>cron+rsync定时同步 | scp, sftp, rsync | - |
| 5 | 分析和存储日志 | rsyslog日志服务配置<br>systemd-journald日志查看(journalctl)<br>日志永久存储<br>NTP时间同步(timedatectl/chrony)<br>日志轮转(logrotate)<br>日志文件(/var/log/messages等) | journalctl, logger, systemctl, timedatectl, tail, rpm, yum, echo | /etc/rsyslog.conf<br>/etc/systemd/journald.conf<br>/etc/logrotate.conf<br>/etc/chrony.conf |
| 6 | 管理磁盘分区 | MBR和GPT两种分区方式<br>parted工具分区管理<br>GPT分区创建与格式化<br>swap交换分区<br>udevadm检测新分区 | parted, fdisk, mkfs, mount, swapon, mkswap, blkid, lsblk, free, cat, grep, ls | /etc/fstab |
| 7 | 管理逻辑卷LVM | LVM逻辑卷管理(PV/VG/LV)<br>pvcreate/vgcreate/lvcreate创建<br>lvextend扩展逻辑卷<br>xfs_growfs/resize2fs扩展文件系统<br>逻辑卷开机自动挂载(/etc/fstab)<br>缩容操作流程 | pvcreate, vgcreate, lvcreate, lvdisplay, vgdisplay, pvdisplay, lvextend, vgextend, resize2fs, xfs_growfs, mkfs, mount, mkdir, df, lsblk, parted, vim | /etc/fstab |
| 8 | VDO优化磁盘空间 | VDO虚拟数据优化器<br>创建VDO卷(vdo create)<br>查看VDO状态(vdostats)<br>去重和压缩节省空间 | vdo, vdostats, systemctl, yum, rpm | - |
| 9 | NFS访问网络存储 | NFS网络文件系统配置<br>NFS服务端共享(/etc/exports)<br>NFS客户端挂载<br>autofs按需自动挂载<br>直接映射挂载(/-)<br>间接映射挂载 | yum, systemctl, exportfs, showmount, mount, mkdir, chmod, rpm | /etc/exports<br>/etc/auto.master<br>/etc/auto.nfs |
| 10 | NFS访问网络存储（复习） | NFS复习与实践<br>autofs直接/间接映射<br>NFS故障排查 | yum, systemctl, exportfs, showmount, mount, mkdir, chmod, rpm, ping | /etc/exports<br>/etc/auto.master<br>/etc/auto.nfs |

## 🎓 当前学期

| 序号 | 项目 | 核心知识点 | 关键命令 | 配置文件 |
|------|------|-----------|---------|---------|
| 10 | NFS访问网络存储 | NFS服务器端配置(共享目录)<br>NFS客户端挂载<br>autofs自动挂载(直接映射/间接映射/通配符)<br>rpcbind服务依赖 | yum, systemctl, exportfs, showmount, mount, mkdir, chmod, rpm, ping | /etc/exports<br>/etc/auto.master<br>/etc/auto.nfs |
| 11 | 管理SELinux安全 | SELinux三种工作模式(enforcing/permissive/disabled)<br>安全上下文管理(chcon/semanage/restorecon)<br>布尔值策略(setsebool/getsebool)<br>SELinux日志分析(sealert/audit2why/audit2allow)<br>httpd服务的SELinux配置 | sestatus, getenforce, setenforce, chcon, semanage, restorecon, setsebool, getsebool, sealert, audit2why, audit2allow, yum, rpm, systemctl, ls, ps | /etc/selinux/config<br>/etc/httpd/conf/httpd.conf<br>/var/www/html/index.html |
| 12 | 管理防火墙 | firewalld区域(zone)管理<br>防火墙临时和永久规则(服务/端口)<br>端口转发(forward-port)<br>富规则(rich rules)配置<br>地址伪装(masquerade)<br>SELinux+防火墙综合排障 | firewall-cmd, systemctl, semanage, getenforce, restorecon, yum, rpm, curl, vim | /etc/firewalld/<br>/etc/httpd/conf/httpd.conf |
| 13 | 管理进程和计划任务 | 进程/前台进程/后台进程<br>查看进程(ps/top)<br>终止进程(kill/killall)<br>前后台进程切换(&/Ctrl+Z/jobs/fg/bg)<br>计划任务crond(crontab) | ps, top, kill, killall, jobs, fg, bg, crontab, systemctl, yum, cat, vim, grep, which, echo | /var/spool/cron/<br>/etc/crontab<br>/etc/cron.d/ |
| 14 | 调优系统性能 | tuned系统调优(tuned-adm)<br>调优配置文件(balanced/desktop/throughput-performance等)<br>进程优先级nice/renice<br>top交互命令r修改优先级<br>一次性定时任务at/atq/atrm | tuned, tuned-adm, nice, renice, top, ps, killall, at, atq, atrm, chrt, systemctl, yum, date, timedatectl | /etc/tuned/<br>/var/spool/at/ |
| 15 | 管理Shell脚本 | Shell脚本编写原则<br>脚本执行方式(chmod +x / bash)<br>交互方式创建用户<br>免交互方式创建用户(echo + 管道 + passwd --stdin)<br>传递参数($1, $2位置参数)<br>for循环批量操作(for...in...do...done)<br>键盘读取变量(read -p -t -s)<br>命令替换($()和反引号) | bash, vim, useradd, userdel, groupadd, groupdel, passwd, chmod, echo, cat, grep, id, read, whoami, ls | /etc/passwd<br>/etc/shadow<br>/etc/group |

---

## 📊 知识点总览

### 已学命令总数：90

| 命令 | 首次出现 | 学习深度 | 出现项目数 |
|------|---------|---------|-----------|
| `audit2allow` | 当前学期-项目11 | 基础 | 1 |
| `audit2why` | 当前学期-项目11 | 基础 | 1 |
| `bash` | 大一上学期-项目6 | 基础 | 1 |
| `blkid` | 大一下学期-项目6 | 基础 | 1 |
| `bzip2` | 大一上学期-项目6 | 基础 | 1 |
| `cat` | 大一上学期-项目1 | 高级 | 4 |
| `cd` | 大一上学期-项目2 | 高级 | 4 |
| `chage` | 大一上学期-项目4 | 基础 | 1 |
| `chgrp` | 大一上学期-项目5 | 基础 | 1 |
| `chmod` | 大一上学期-项目5 | 进阶 | 2 |
| `chown` | 大一上学期-项目5 | 进阶 | 2 |
| `cp` | 大一上学期-项目2 | 进阶 | 3 |
| `curl` | 当前学期-项目12 | 基础 | 1 |
| `dd` | 大一上学期-项目2 | 进阶 | 2 |
| `df` | 大一上学期-项目3 | 进阶 | 3 |
| `du` | 大一上学期-项目6 | 进阶 | 2 |
| `echo` | 大一上学期-项目4 | 高级 | 5 |
| `edquota` | 大一上学期-项目8 | 进阶 | 1 |
| `export` | 大一下学期-项目1 | 基础 | 1 |
| `fdisk` | 大一上学期-项目1 | 进阶 | 2 |
| `file` | 大一上学期-项目5 | 进阶 | 2 |
| `firewall-cmd` | 当前学期-项目12 | 基础 | 1 |
| `find` | 大一上学期-项目2 | 高级 | 2 |
| `free` | 大一上学期-项目8 | 进阶 | 2 |
| `getenforce` | 大一上学期-项目7 | 基础 | 1 |
| `gpasswd` | 大一上学期-项目5 | 进阶 | 2 |
| `grep` | 大一上学期-项目2 | 高级 | 5 |
| `groupadd` | 大一上学期-项目4 | 进阶 | 3 |
| `groupmod` | 大一上学期-项目4 | 基础 | 1 |
| `gzip` | 大一上学期-项目6 | 基础 | 1 |
| `id` | 大一上学期-项目4 | 基础 | 1 |
| `ifconfig` | 大一上学期-项目7 | 基础 | 1 |
| `journalctl` | 大一下学期-项目5 | 基础 | 1 |
| `logger` | 大一下学期-项目5 | 基础 | 1 |
| `ls` | 大一上学期-项目2 | 高级 | 6 |
| `lsblk` | 大一下学期-项目6 | 进阶 | 2 |
| `lvcreate` | 大一下学期-项目7 | 进阶 | 1 |
| `lvdisplay` | 大一下学期-项目7 | 基础 | 1 |
| `lvextend` | 大一下学期-项目7 | 基础 | 1 |
| `mkdir` | 大一上学期-项目5 | 高级 | 5 |
| `mkfs` | 大一上学期-项目8 | 进阶 | 2 |
| `mkswap` | 大一上学期-项目8 | 进阶 | 2 |
| `more` | 大一下学期-项目7 | 基础 | 1 |
| `mount` | 大一上学期-项目1 | 高级 | 10 |
| `mv` | 大一上学期-项目6 | 基础 | 1 |
| `nmcli` | 大一上学期-项目7 | 进阶 | 2 |
| `parted` | 大一下学期-项目6 | 进阶 | 2 |
| `passwd` | 大一上学期-项目1 | 高级 | 6 |
| `ping` | 大一上学期-项目7 | 高级 | 4 |
| `ps` | 当前学期-项目11 | 基础 | 1 |
| `pvcreate` | 大一下学期-项目7 | 基础 | 1 |
| `pvdisplay` | 大一下学期-项目7 | 基础 | 1 |
| `quotacheck` | 大一上学期-项目8 | 基础 | 1 |
| `quotaon` | 大一上学期-项目8 | 基础 | 1 |
| `repquota` | 大一上学期-项目8 | 基础 | 1 |
| `resize2fs` | 大一下学期-项目7 | 基础 | 1 |
| `rm` | 大一上学期-项目5 | 进阶 | 3 |
| `rpm` | 大一上学期-项目7 | 高级 | 8 |
| `rsync` | 大一下学期-项目4 | 基础 | 1 |
| `scp` | 大一下学期-项目4 | 基础 | 1 |
| `sealert` | 当前学期-项目11 | 基础 | 1 |
| `sed` | 大一下学期-项目2 | 进阶 | 1 |
| `setenforce` | 大一上学期-项目7 | 进阶 | 2 |
| `sftp` | 大一下学期-项目4 | 基础 | 1 |
| `showmount` | 大一下学期-项目9 | 进阶 | 3 |
| `source` | 大一下学期-项目1 | 基础 | 1 |
| `ssh` | 大一下学期-项目3 | 基础 | 1 |
| `swapon` | 大一上学期-项目8 | 进阶 | 2 |
| `systemctl` | 大一上学期-项目2 | 高级 | 9 |
| `tail` | 大一下学期-项目5 | 基础 | 1 |
| `tar` | 大一上学期-项目6 | 高级 | 1 |
| `timedatectl` | 大一下学期-项目5 | 基础 | 1 |
| `touch` | 大一上学期-项目1 | 进阶 | 3 |
| `umount` | 大一上学期-项目8 | 基础 | 1 |
| `unzip` | 大一上学期-项目6 | 基础 | 1 |
| `useradd` | 大一上学期-项目4 | 高级 | 4 |
| `userdel` | 大一上学期-项目4 | 基础 | 1 |
| `usermod` | 大一上学期-项目4 | 进阶 | 1 |
| `vdo` | 大一下学期-项目8 | 基础 | 1 |
| `vdostats` | 大一下学期-项目8 | 基础 | 1 |
| `vgcreate` | 大一下学期-项目7 | 基础 | 1 |
| `vgdisplay` | 大一下学期-项目7 | 基础 | 1 |
| `vgextend` | 大一下学期-项目7 | 基础 | 1 |
| `vi` | 大一上学期-项目2 | 进阶 | 3 |
| `vim` | 大一上学期-项目2 | 高级 | 5 |
| `wc` | 大一上学期-项目6 | 进阶 | 1 |
| `wget` | 大一上学期-项目2 | 进阶 | 2 |
| `which` | 大一上学期-项目3 | 基础 | 1 |
| `xfs_quota` | 大一上学期-项目8 | 高级 | 1 |
| `xz` | 大一上学期-项目6 | 基础 | 1 |
| `yum` | 大一上学期-项目2 | 高级 | 9 |
| `zip` | 大一上学期-项目6 | 基础 | 1 |

---

## 🔄 自动更新规则

1. 每次处理新项目后，将新项目的知识点、命令、配置文件追加到对应学期
2. 如果新命令首次出现，更新命令总览表
3. 如果已有命令出现新选项，更新命令深度和选项列表
4. 更新知识点递进图谱（concept_map.md）中的依赖关系