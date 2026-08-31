---
source: philosophy
category: linux-philosophy
url: command_design.md
title: command_design · Linux 命令设计——从英文词源理解命令
---

# Linux 命令设计——从英文词源理解命令

> Linux 命令的名称不是随机的，每一个都能从英文推导出功能。
> 理解了词源规律与设计模式，就能举一反三，从"背命令"升级到"理解设计"。

### 规律 1：动词+名词模式

这种模式让命令功能一目了然。

| 命令 | 词源拆解 | 英文全称 | 中文含义 |
|------|---------|---------|---------|
| useradd | user + add | user add | 添加用户 |
| userdel | user + delete | user delete | 删除用户 |
| usermod | user + modify | user modify | 修改用户 |
| groupadd | group + add | group add | 添加组 |
| groupdel | group + delete | group delete | 删除组 |
| groupmod | group + modify | group modify | 修改组 |
| mkdir | make + directory | make directory | 创建目录 |
| rmdir | remove + directory | remove directory | 删除目录 |
| ssh-keygen | SSH + key + generate | SSH key generate | SSH 密钥生成 |
| ssh-copy-id | SSH + copy + identity | SSH copy identity | SSH 公钥复制 |

**记忆技巧**：看到 `xxxadd` 就是"添加 xxx"，`xxxdel` 就是"删除 xxx"，`xxxmod` 就是"修改 xxx"。

### 规律 2：缩写组合模式（Unix 传统）

1970 年代终端速度慢（300 波特），打字效率至关重要。

| 命令 | 缩写来源 | 英文全称 | 中文含义 | 缩写逻辑 |
|------|---------|---------|---------|---------|
| chmod | ch + mod | change mode | 改变权限模式 | 取每个词的前 2-3 个字母 |
| chown | ch + own | change owner | 改变所有者 | 同上 |
| chgrp | ch + grp | change group | 改变所属组 | 同上 |
| chage | ch + age | change age | 改变密码有效期 | 同上 |
| chcon | ch + con | change context | 改变安全上下文 | 同上 |
| chroot | ch + root | change root | 改变根目录 | 同上 |
| chrt | ch + rt | change real-time | 改变实时调度 | 同上 |
| passwd | pass + wd | password | 密码 | 截断 |
| fstab | fs + tab | file system table | 文件系统表 | 截断 |
| vim | vi + m | vi improved | 改进版 vi | 缩写 |
| bash | Bourne + Again + Shell | Bourne Again Shell | Bash 解释器 | 首字母 |

**记忆技巧**：`ch` 开头的命令都是"change"（改变）什么的。

### 规律 3：子命令模式（现代设计）

现代 Linux 命令功能复杂，用一个主命令+多个子命令聚合。

| 主命令 | 英文全称 | 子命令示例 | 设计逻辑 |
|--------|---------|-----------|---------|
| systemctl | system control | start/stop/enable/status | 统一服务管理 |
| nmcli | NetworkManager CLI | con show/modify/up | 统一网络管理 |
| firewall-cmd | firewall command | --add-service/--add-port | 统一防火墙管理 |
| tuned-adm | tuned administration | list/active/profile | 统一调优管理 |
| semanage | SELinux manage | fcontext/boolean/port | 统一 SELinux 管理 |

**设计逻辑**：避免命令名爆炸（如果每个功能一个命令，会有上百个命令），用子命令聚合更清晰。

### 规律 4：工具名模式（源自 ed 编辑器历史）

这些命令的名字反映了 Unix 早期的历史。

| 命令 | 名称来源 | 英文全称 | 中文含义 | 历史背景 |
|------|---------|---------|---------|---------|
| grep | g/re/p | global/regular expression/print | 全局正则搜索打印 | 源自 ed 编辑器的 g/re/p 命令 |
| sed | - | stream editor | 流编辑器 | ed 的流式版本 |
| awk | Aho Weinberger Kernighan | 三位发明者姓名 | 文本处理语言 | 以发明者命名 |
| tar | - | tape archive | 磁带归档 | 最初用于磁带备份 |
| dd | - | data duplicator | 数据复制工具 | 名称源自 IBM JCL 的 dd 语句 |

**记忆技巧**：`grep` = "全局(g)正则(re)打印(p)"，记住这个拆解就不会忘记它的功能。

### 核心原则：选项字母 = 英文单词首字母

| 选项 | 英文全称 | 中文含义 | 使用场景 |
|------|---------|---------|---------|
| -R | Recursive | 递归 | chmod -R, chown -R, cp -R |
| -r | recursive/reverse | 递归/反转 | rm -r, sort -r |
| -f | Force | 强制 | rm -f, cp -f |
| -v | Verbose | 详细 | tar -v, rsync -v |
| -a | All | 所有 | ls -a, ps aux |
| -l | Long | 长格式 | ls -l |
| -h | Human-readable | 人类可读 | df -h, du -h |
| -p | Parents/Preserve | 父目录/保留 | mkdir -p |
| -n | Number/No-action | 行号/不执行 | grep -n, sed -n |
| -e | Execute/Expression | 执行/表达式 | sed -e |
| -t | Type/Target | 类型/目标 | mount -t |
| -u | User/Update | 用户/更新 | chown -u |
| -d | Directory/Delete | 目录/删除 | useradd -d |
| -c | Create/Count | 创建/计数 | tar -c, wc -c |
| -w | Write/Warning | 写入/警告 | chmod -w |
| -s | Silent/Size | 静默/大小 | useradd -s |
| -z | gzip | gzip 压缩 | tar -z |
| -j | bzip2 | bzip2 压缩 | tar -j |
| -P | Permanent/Port | 永久/端口 | firewall-cmd --permanent |

### 长选项与短选项对应

| 短选项 | 长选项 | 含义 |
|--------|--------|------|
| -R | --recursive | 递归 |
| -f | --force | 强制 |
| -v | --verbose | 详细 |
| -a | --all | 所有 |
| -l | --long | 长格式 |
| -h | --human-readable | 人类可读 |
| --help | - | 帮助 |
| --version | - | 版本 |
| --permanent | - | 永久（firewalld） |
| --delete | - | 删除（rsync） |

**设计逻辑**：短选项是 Unix 传统（打字快），长选项是 GNU 扩展（更清晰）。`-a -l` 可以合并为 `-al`，但 `--all --long` 不能合并。

### grep 的前世今生

```
ed 编辑器 (1969)
  ↓ g/re/p 命令（全局/正则/打印）
grep 命令 (1973)
  ↓ 增强功能
egrep（扩展正则）
fgrep（快速固定字符串搜索）
```

**为什么 grep 这么重要？**

- Unix 哲学"一切皆文本" + "一个工具做好一件事"
- grep 只做"搜索"这一件事，但做到了极致
- 配合管道可以完成复杂的文本处理

### sed 的前世今生

```
ed 编辑器 (1969) → 行编辑器
  ↓ 流式处理
sed 编辑器 (1974) → 流编辑器
  ↓
awk 语言 (1977) → 更强大的文本处理
```

**设计逻辑**：

- ed：交互式行编辑器（需要打开文件）
- sed：非交互式流编辑器（配合管道使用）
- awk：完整的文本处理语言（有变量、循环、函数）

### tar 的前世今生

```
磁带时代 (1979)
  ↓ tape archive（磁带归档）
tar 命令
  ↓ 支持压缩
tar + gzip (.tar.gz)
tar + bzip2 (.tar.bz2)
tar + xz (.tar.xz)
```

**为什么 tar 叫"磁带归档"？**

- 最初用于将文件备份到磁带
- 现在用于打包目录（但名字保留了历史）

### 案例 1：为什么 ps aux 和 ps -ef 功能相同？

```
ps aux    → BSD 风格（无短横线）
ps -ef    → System V 风格（有短横线）
```

**设计背景**：

- Unix 历史上有两大流派：BSD 和 System V
- 两种风格都保留了下来，所以功能相同但语法不同
- 现代 Linux 的 ps 命令兼容两种风格

### 案例 2：为什么 ls -la 和 ls -l -a 相同？

**设计逻辑**：

- 短选项可以合并（Unix 传统）
- `-la` = `-l -a` = 长格式 + 所有文件
- 但长选项不能合并：`ls --all --long` 不能写成 `ls --allong`

### 案例 3：为什么 systemctl 要统一服务管理？

**之前的问题**：

- 不同服务有不同的管理方式（service 命令、chkconfig、init 脚本）
- 启动顺序难以控制
- 依赖关系难以管理

**systemctl 的设计**：

- 统一的命令接口：`systemctl start/stop/enable/status`
- 声明式配置：.service 文件描述服务
- 依赖管理：自动处理服务间依赖
- 并行启动：提高启动速度

### ch 系列（change 开头）

| 命令 | 改变什么 | 记忆 |
|------|---------|------|
| chmod | mode（权限模式） | ch+mode |
| chown | owner（所有者） | ch+owner |
| chgrp | group（所属组） | ch+group |
| chage | age（密码有效期） | ch+age |
| chcon | context（安全上下文） | ch+context |
| chroot | root（根目录） | ch+root |
| chrt | real-time（实时调度） | ch+real-time |

### user/group 系列

| 命令 | 操作 | 对象 |
|------|------|------|
| useradd | add（添加） | user（用户） |
| userdel | delete（删除） | user（用户） |
| usermod | modify（修改） | user（用户） |
| groupadd | add（添加） | group（组） |
| groupdel | delete（删除） | group（组） |
| groupmod | modify（修改） | group（组） |

### fs 系列（filesystem）

| 命令 | 全称 | 含义 |
|------|------|------|
| fdisk | fixed disk | 固定磁盘（分区工具） |
| fstab | file system table | 文件系统表 |
| mkfs | make file system | 创建文件系统 |
| fsck | file system check | 文件系统检查 |
| resize2fs | resize to filesystem | 调整文件系统大小 |
| xfs_growfs | XFS grow filesystem | 扩展 XFS 文件系统 |

### LVM 系列

| 命令 | 全称 | 含义 |
|------|------|------|
| pvcreate | physical volume create | 创建物理卷 |
| vgcreate | volume group create | 创建卷组 |
| lvcreate | logical volume create | 创建逻辑卷 |
| lvextend | logical volume extend | 扩展逻辑卷 |
| pvdisplay | physical volume display | 显示物理卷 |
| vgdisplay | volume group display | 显示卷组 |
| lvdisplay | logical volume display | 显示逻辑卷 |

### ctl 系列（control 结尾，systemd 家族）

| 命令 | 全称 | 含义 |
|------|------|------|
| systemctl | system control | 服务控制 |
| hostnamectl | hostname control | 主机名控制 |
| timedatectl | time/date control | 时间日期控制 |
| localectl | locale control | 语言区域控制 |
| loginctl | login control | 登录会话控制 |
| journalctl | journal control | 日志控制 |
| resolvectl | resolve control | DNS 解析控制 |
| networkctl | network control | 网络控制 |
| busctl | bus control | 总线控制 |

**记忆技巧**：看到 `ctl` 结尾的命令，就知道是"控制工具"，用法一定是 `xxxctl 子命令 [参数]`。

---
来源：command_design.md