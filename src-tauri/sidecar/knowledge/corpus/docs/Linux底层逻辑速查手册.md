# Linux底层逻辑速查手册（打印背诵版）

> 从哲学→设计→命令→路径，理解Linux的底层逻辑
> 理解了逻辑，命令就不再是死记硬背，而是有道理可寻的。

---

## 一、10条核心哲学（一句话总结）

| # | 哲学 | 英文 | 一句话 | 核心设计决策 |
|---|------|------|--------|-------------|
| 1 | 一切皆文件 | Everything is a file | 键盘、硬盘、进程、网络全当文件操作 | 统一接口：open/read/write/close |
| 2 | 一个工具做好一件事 | Do one thing well | 每个命令只做一件事，复杂的任务用管道组合 | 小工具+管道 > 大软件 |
| 3 | 文本是通用接口 | Text is universal | 命令之间用纯文本传递数据 | 文本 > 二进制协议 |
| 4 | 组合小工具完成大任务 | Combine small tools | 用管道`|`把小工具串起来 | stdin→pipe→stdout |
| 5 | 权限最小化 | Least privilege | 不给任何用户超出需要的权限 | DAC + MAC双重防线 |
| 6 | 沉默是金 | Silence is golden | 成功不输出，只有出错才报告 | 安静便于组合 |
| 7 | 机制与策略分离 | Mechanism, not policy | 系统提供机制，用户决定策略 | 可配置 > 硬编码 |
| 8 | KISS原则 | Keep It Simple | 能简单做的事不要搞复杂 | 简单 > 复杂 |
| 9 | 开源共享 | Open source | 源代码公开，任何人能看能改 | 透明 > 封闭 |
| 10 | 一切皆文本流 | Text stream | 文本流是进程间通信的通用方式 | 文本 > 二进制 |

---

## 二、目录结构逻辑树（按设计原因分组）

### 为什么这样分？4个设计原则

```
按功能分类：不同类型的数据放不同目录
按修改频率：常变的(/var)和不常变的(/usr)分开
按权限分离：普通用户(/bin)和管理员(/sbin)分开
按生命周期：临时的(/tmp)和永久的(/home)分开
```

### 目录速记口诀

```
"变日临虚设" = var(变) log(日) tmp(临) proc(虚) dev(设)
"配用管根启" = etc(配) usr(用) home(用户) root(根) boot(启)
```

### 每个目录的"为什么"

| 目录 | 英文全称 | 为什么存在 | 设计逻辑 |
|------|---------|-----------|---------|
| /etc | Editable Text Config | 配置文件集中管理 | 文本配置，vim就能改 |
| /var | Variable | 可变数据（日志/缓存） | 与/usr分离，可写不污染只读区 |
| /usr | Unix System Resources | 系统软件安装位置 | 可只读挂载，保护系统 |
| /home | Home | 用户家目录 | 每个用户独立空间 |
| /root | Root | 管理员家目录 | 独立在根分区，不依赖/home |
| /tmp | Temporary | 临时文件 | 重启可清空，权限1777 |
| /proc | Process | 进程虚拟文件系统 | 读取时才生成，不占磁盘 |
| /dev | Device | 设备文件 | 一切皆文件的体现 |
| /bin | Binaries | 基本命令 | 所有用户都能用 |
| /sbin | System Binaries | 系统管理命令 | 管理员专用 |
| /boot | Boot | 启动文件 | 内核、GRUB引导 |
| /lib | Library | 库文件 | bin/sbin依赖的共享库 |
| /mnt | Mount | 临时挂载点 | 手动挂载硬盘 |
| /opt | Optional | 可选软件 | 第三方大型软件 |

### 配置文件位置逻辑

```
全局 vs 用户级：
  /etc/profile    → 全局环境变量（所有用户生效）
  ~/.bashrc       → 用户级配置（只对当前用户生效）

systemd覆盖机制（优先级从高到低）：
  /etc/systemd/system/     → 管理员自定义（最高）
  /run/systemd/system/     → 运行时临时
  /usr/lib/systemd/system/ → 软件包默认（不要修改）
```

---

## 三、命令命名4种模式

### 模式1：动词+名词（一目了然）

```
useradd = user + add     添加用户
userdel = user + delete   删除用户
usermod = user + modify   修改用户
groupadd = group + add    添加组
mkdir = make + directory   创建目录
rmdir = remove + directory 删除目录
```

### 模式2：缩写组合（Unix传统，打字快）

```
chmod = change + mode     改变权限
chown = change + owner    改变所有者
chgrp = change + group    改变组
chage = change + age      改变密码有效期
passwd = password         密码
vim = vi improved         改进版vi
bash = Bourne Again Shell Bash解释器
```

**记忆**：`ch`开头都是"change"（改变）什么。

### 模式3：子命令模式（现代设计）

```
systemctl start/stop/enable/status    系统服务管理
nmcli con show/modify/up              网络连接管理
firewall-cmd --add-service/--add-port 防火墙管理
tuned-adm list/active/profile         系统调优
```

### 模式4：工具名模式（历史渊源）

```
grep = g/re/p = global/regular expression/print  全局正则搜索
sed = stream editor                              流编辑器
awk = Aho Weinberger Kernighan                   三位发明者
tar = tape archive                               磁带归档
```

---

## 四、选项字母词源表

**核心规律**：选项字母 = 英文单词首字母

| 选项 | 英文 | 中文 | 四级 | 常见于 |
|------|------|------|------|--------|
| -R | Recursive | 递归 | ⭐ | chmod/chown/cp |
| -f | Force | 强制 | ⭐ | rm/cp/mount |
| -v | Verbose | 详细 | ⭐ | tar/rsync/ssh |
| -a | All | 所有 | ⭐ | ls/ps/killall |
| -l | Long | 长格式 | ⭐ | ls/ps |
| -h | Human-readable | 人类可读 | ⭐ | df/du/free |
| -p | Parents | 父目录 | ⭐ | mkdir |
| -n | Number | 行号 | ⭐ | grep/sed |
| -e | Execute | 执行 | ⭐ | sed/chmod |
| -t | Type | 类型 | ⭐ | mount |
| -u | User | 用户 | ⭐ | chown |
| -d | Directory | 目录 | ⭐ | useradd |
| -c | Create | 创建 | ⭐ | tar |
| -z | gzip | gzip压缩 | | tar |
| -j | bzip2 | bzip2压缩 | | tar |
| -P | Permanent | 永久 | | firewall-cmd |

**短选项合并规则**：
```
- 短选项可以合并：ls -la = ls -l -a
- 长选项不能合并：ls --all --long ≠ ls --allong
```

---

## 五、易混淆概念对比表

| 对比项 | 区别 | 记忆口诀 |
|--------|------|---------|
| process vs thread | 进程=资源分配单位，线程=调度单位 | "进程有钱，线程有力" |
| hard link vs soft link | 硬链接=同一inode，软链接=新inode | "硬同软新" |
| SUID vs SGID vs Sticky | SUID=属主运行，SGID=继承属组，Sticky=只有属主删 | "4跑2承1粘" |
| DAC vs MAC | DAC=主人说了算，MAC=系统说了算 | "DAC自主，MAC强制" |
| Enforcing vs Permissive | 强制=拦截，宽容=只记录 | "强制拦，宽容记" |
| chcon vs semanage | 临时=chcon，永久=semanage+restorecon | "临chcon，永sem+res" |
| nice vs renice | 新进程=nice，已运行=renice | "nice新renice旧" |
| lvextend vs resize2fs | 扩逻辑卷=lvextend，扩文件系统=resize2fs | "先扩卷再扩文件" |
| ext4 vs xfs | 扩容：ext4=resize2fs，xfs=xfs_growfs | "ext4resize，xfs_grow" |
| MBR vs GPT | MBR≤2TB，GPT无限制 | "MBR老2T，GPT新无限" |
| export vs source | export=导出变量，source=执行脚本 | "export导，source执" |
| kill vs killall | kill=按PID，killall=按进程名 | "kill PID，killall名" |
| /etc/passwd vs /etc/shadow | 用户信息 vs 密码哈希 | "passwd公开，shadow保密" |
| /etc/profile vs ~/.bashrc | 全局 vs 用户级 | "profile全，bashrc个" |
| crontab -e vs /etc/crontab | 用户任务 vs 系统任务 | "用户crontab，系统cron" |
| BRE vs ERE | 基础正则 vs 扩展正则 | "grep BRE，grep -E ERE" |

---

## 六、"为什么"常见问题速查

| 问题 | 答案 |
|------|------|
| 为什么要有根目录"/"？ | 树形文件系统起点，所有文件有唯一绝对路径 |
| 为什么配置文件都是文本？ | 人可读、可grep、可sed、可git版本控制 |
| 为什么区分大小写？ | Unix传统，严谨设计，file.txt≠File.txt |
| 为什么隐藏文件以"."开头？ | 历史偶然（ls的bug变成feature） |
| 为什么有"-"和"--"两种选项？ | Unix System V传统 vs GNU长选项扩展 |
| 为什么有软链接和硬链接？ | 硬链接=同一inode，软链接=快捷方式，各有用途 |
| 为什么passwd和shadow分开？ | 最小权限原则：passwd可读，shadow仅root可读 |
| 为什么防火墙默认拒绝？ | 权限最小化：默认拒绝，按需放行 |
| 为什么/var和/usr分开？ | /usr可只读挂载，/var必须可写 |
| 为什么/home和/root分开？ | /home可能在单独分区，root需在根分区 |
| 为什么systemd替代init？ | 并行启动、依赖管理、统一命令接口 |
| 为什么用管道组合小工具？ | 小工具简单可靠，组合起来功能无限 |
| 为什么命令成功不输出？ | 沉默是金：安静便于组合，错误才需关注 |
| 为什么ps aux和ps -ef相同？ | BSD vs System V两种风格都保留 |
| 为什么rpm和yum都要学？ | rpm是底层工具，yum是上层封装，自动解决依赖 |

---

## 七、底层逻辑速记口诀

### 哲学口诀
```
一切文件组合文，
权限沉默机制分，
KISS开源文本流，
十条哲学记在心。
```

### 目录口诀
```
根下二sbin和etc，
home根var usr boot lib，
tmp dev proc mnt opt sys，
srv media run 要记齐。
```

### 命令模式口诀
```
动词名词一目然，
缩写组合打字快，
子命令是现代范，
工具名字有渊源。
```

### 选项口诀
```
R递归 f强制 v详细，
a所有 l长 h人读，
p父 n号 e执行，
t类型 u用户 d目录。
```

---

> **背诵建议**：
> 1. 先背10条哲学口诀（理解设计思想）
> 2. 再背目录口诀（理解文件组织逻辑）
> 3. 再背命令模式口诀（理解命名规律）
> 4. 最后背选项口诀（理解参数含义）
> 5. 每天看一遍易混淆对比表，考试不丢分
