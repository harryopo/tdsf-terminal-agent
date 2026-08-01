# Linux设计模式——从底层逻辑理解系统设计

> Linux的设计不是随意的，每一个命令、每一个目录、每一个配置文件都有其设计逻辑。
> 理解了设计模式，就能举一反三，不再死记硬背。
> 本文档系统梳理Linux中的设计模式，帮助你从"背命令"升级到"理解设计"。

---

## 一、命令命名4种模式

### 模式1：动词+名词（操作对象明确）

**核心思想**：命令名 = 对象 + 动作，功能一目了然。

| 命令 | 拆解 | 含义 | 设计逻辑 |
|------|------|------|---------|
| useradd | user + add | 添加用户 | 操作对象(user) + 动作(add) |
| userdel | user + delete | 删除用户 | 操作对象(user) + 动作(delete) |
| usermod | user + modify | 修改用户 | 操作对象(user) + 动作(modify) |
| groupadd | group + add | 添加组 | 操作对象(group) + 动作(add) |
| groupdel | group + delete | 删除组 | 操作对象(group) + 动作(delete) |
| groupmod | group + modify | 修改组 | 操作对象(group) + 动作(modify) |
| mount | mount | 挂载文件系统 | 动作本身即含义 |
| umount | un + mount | 卸载文件系统 | 反操作 = un + 原动词 |
| hostnamectl | hostname + control | 控制主机名 | 对象(hostname) + 操作(ctl=control) |
| timedatectl | time/date + control | 控制时间日期 | 对象(time/date) + 操作(ctl=control) |
| localectl | locale + control | 控制语言区域 | 对象(locale) + 操作(ctl=control) |
| loginctl | login + control | 控制登录会话 | 对象(login) + 操作(ctl=control) |
| resolvectl | resolve + control | DNS解析控制 | 对象(resolve) + 操作(ctl=control) |
| networkctl | network + control | 网络控制 | 对象(network) + 操作(ctl=control) |
| busctl | bus + control | 总线控制 | 对象(bus) + 操作(ctl=control) |
| journalctl | journal + control | 日志控制 | 对象(journal) + 操作(ctl=control) |
| firewall-cmd | firewall + command | 防火墙命令 | 对象(firewall) + 类型(cmd) |
| mkfs | make + filesystem | 创建文件系统 | 动作(mk=make) + 对象(fs=filesystem) |
| fsck | filesystem + check | 检查文件系统 | 对象(fs=filesystem) + 动作(ck=check) |

**设计逻辑**：这种模式让命令的功能一目了然，不需要查文档就能猜到用途。现代Linux（systemd系列）特别喜欢这种命名方式，所以你看到大量 `xxxctl` 的命令。

> 💡 **记忆技巧**：看到 `ctl` 结尾的命令，就知道是"控制工具"，用法一定是 `xxxctl 子命令 [参数]`。

---

### 模式2：缩写组合（Unix传统，打字效率优先）

**核心思想**：取英文单词的前几个字母拼接，追求极致的打字效率。

| 命令 | 全称 | 缩写逻辑 | 四级 |
|------|------|---------|------|
| chmod | change mode | ch(ange) + mod(e) | ⭐ |
| chown | change owner | ch(ange) + own(er) | ⭐ |
| chgrp | change group | ch(ange) + grp | ⭐ |
| mkdir | make directory | mk + dir | ⭐ |
| rmdir | remove directory | rm + dir | |
| pwd | print working directory | p + wd | |
| df | disk free | d(isk) + f(ree) | ⭐ |
| du | disk usage | d(isk) + u(sage) | ⭐ |
| ps | process status | p(rocess) + s(tatus) | ⭐ |
| ls | list | li(st) → ls | ⭐ |
| ln | link | li(nk) → ln | |
| mv | move | mo(ve) → mv | ⭐ |
| rm | remove | re(move) → rm | ⭐ |
| cp | copy | co(py) → cp | ⭐ |
| apt | advanced package tool | a(dvanced) + p(ackage) + t(ool) | |
| dnf | dandified yum | DNF = next-generation yum | |
| ssh | secure shell | s(ecure) + sh(ell) | |
| scp | secure copy | s(ecure) + cp(copy) | |
| tar | tape archive | t(ape) + ar(chive) | |
| wc | word count | w(ord) + c(ount) | |
| id | identity | id(entity) → id | ⭐ |
| bg | background | ba(ck)g(round) → bg | ⭐ |
| fg | foreground | fo(re)g(round) → fg | ⭐ |
| vmstat | virtual memory statistics | vm + stat | |
| iostat | I/O statistics | io + stat | |
| netstat | network statistics | net + stat | |

**设计逻辑**：1970年代终端速度只有300波特（约30字节/秒），打字效率至关重要。Unix程序员在电传打字机上工作，每一个多余的字母都意味着更多的等待时间。所以Unix命令都追求极致的短。

> 💡 **缩写规律总结**：
> - `ch` = change（改变）：chmod, chown, chgrp, chroot
> - `mk` = make（创建）：mkfs, mkdir, mknod
> - `rm` = remove（删除）：rm, rmdir
> - `stat` = statistics（统计）：vmstat, iostat, netstat, mpstat
> - `ctl` = control（控制）：systemctl, hostnamectl, timedatectl
> - `sys` = system（系统）：sysctl, systemctl, systemd

---

### 模式3：子命令模式（现代设计，功能聚合）

**核心思想**：一个主命令 + 多个子命令，像一把瑞士军刀。

| 主命令 | 子命令 | 含义 | 设计逻辑 |
|--------|--------|------|---------|
| systemctl | start | 启动服务 | 一个主命令管理所有服务 |
| systemctl | stop | 停止服务 | 子命令统一动词 |
| systemctl | restart | 重启服务 | |
| systemctl | status | 查看状态 | |
| systemctl | enable | 设为开机启动 | |
| systemctl | disable | 取消开机启动 | |
| systemctl | list-units | 列出所有单元 | |
| systemctl | list-unit-files | 列出所有单元文件 | |
| systemctl | mask | 彻底禁用服务 | |
| systemctl | unmask | 解除禁用 | |
| systemctl | daemon-reload | 重新加载配置 | |
| systemctl | get-default | 获取默认目标 | |
| systemctl | set-default | 设置默认目标 | |

| 主命令 | 子命令 | 含义 | 设计逻辑 |
|--------|--------|------|---------|
| nmcli | device status | 查看设备状态 | NetworkManager命令行工具 |
| nmcli | device show | 显示设备详情 | |
| nmcli | connection show | 显示连接列表 | |
| nmcli | connection up | 激活连接 | |
| nmcli | connection down | 断开连接 | |
| nmcli | connection add | 添加连接 | |
| nmcli | connection modify | 修改连接 | |
| nmcli | connection delete | 删除连接 | |
| nmcli | general status | 查看总体状态 | |

| 主命令 | 子命令 | 含义 | 设计逻辑 |
|--------|--------|------|---------|
| firewall-cmd | --state | 查看防火墙状态 | firewalld管理工具 |
| firewall-cmd | --list-all | 列出所有规则 | |
| firewall-cmd | --add-port | 添加端口规则 | |
| firewall-cmd | --remove-port | 移除端口规则 | |
| firewall-cmd | --add-service | 添加服务规则 | |
| firewall-cmd | --reload | 重新加载规则 | |
| firewall-cmd | --permanent | 持久化规则 | |

| 主命令 | 子命令 | 含义 | 设计逻辑 |
|--------|--------|------|---------|
| tuned-adm | active | 查看当前激活的调优方案 | tuned性能调优工具 |
| tuned-adm | list | 列出所有可用方案 | |
| tuned-adm | profile | 切换调优方案 | |
| tuned-adm | off | 关闭调优 | |
| tuned-adm | recommend | 推荐方案 | |

| 主命令 | 子命令 | 含义 | 设计逻辑 |
|--------|--------|------|---------|
| ip | addr | 管理IP地址 | iproute2工具集 |
| ip | link | 管理网络接口 | |
| ip | route | 管理路由表 | |
| ip | neigh | 管理ARP缓存 | |
| ip | netns | 管理网络命名空间 | |

| 主命令 | 子命令 | 含义 | 设计逻辑 |
|--------|--------|------|---------|
| git | add | 添加到暂存区 | 版本控制工具 |
| git | commit | 提交变更 | |
| git | push | 推送到远程 | |
| git | pull | 从远程拉取 | |
| git | branch | 分支管理 | |

| 主命令 | 子命令 | 含义 | 设计逻辑 |
|--------|--------|------|---------|
| docker | run | 运行容器 | 容器管理工具 |
| docker | build | 构建镜像 | |
| docker | pull | 拉取镜像 | |
| docker | ps | 列出容器 | |
| docker | images | 列出镜像 | |

**设计逻辑**：现代Linux命令功能越来越复杂，如果每个功能都单独一个命令，命令名会爆炸式增长。子命令模式把相关功能聚合在一个主命令下，形成统一的接口。这也是面向对象思想在命令行设计中的体现——主命令是"类"，子命令是"方法"。

> 💡 **子命令模式的共同特征**：
> - `主命令 子命令 [参数]` 的三段式结构
> - 子命令通常跟动词：start/stop/status/add/remove/list...
> - 一般都有 `--help` 查看所有子命令
> - 一般都有 `主命令 子命令 --help` 查看子命令用法

---

### 模式4：工具名模式（源自历史传承）

**核心思想**：命令名本身就是专有名词，来自发明者、技术来源或历史典故。

| 命令 | 来源 | 含义 | 背景故事 |
|------|------|------|---------|
| grep | g/re/p (global/regular expression/print) | 全局正则搜索打印 | 源自ed编辑器的命令格式 `g/re/p`，1973年由Ken Thompson编写 |
| sed | stream editor | 流编辑器 | 行编辑器ed的流式版本，一次处理一行 |
| awk | Aho Weinberger Kernighan | 模式扫描处理语言 | 三位发明者Alfred Aho、Peter Weinberger、Brian Kernighan的姓氏首字母 |
| tee | T型管 | 分流输出 | 命名来自管道工程中的T型接头，水流一分为二 |
| bash | Bourne Again Shell | 再生的Shell | 向Bourne Shell致敬 + "born again"（重生）的双关语 |
| zsh | Z Shell | Z Shell | Z是最后一个字母，暗示"终极Shell" |
| cron | chronos（希腊语：时间） | 定时任务调度器 | 来自希腊语的时间之神 |
| daemon | daemon（守护进程） | 后台服务进程 | 源自Maxwell's demon（麦克斯韦妖），一个看不见的助手 |
| tar | tape archive | 磁带归档 | 1979年为磁带备份设计 |
| dd | data definition / disk dump | 数据转换复制 | 名字来自IBM JCL语言的DD（Data Definition）语句 |
| yacc | yet another compiler compiler | 编译器编译器 | "又一个"编译器生成器 |
| lex | lexical analyzer | 词法分析器 | lexical的缩写 |
| m4 | macro processor version 4 | 宏处理器 | 第4版宏处理器 |
| troff | typesetter roff | 排版程序 | "typesetter roff"的缩写 |
| groff | GNU roff | GNU排版程序 | GNU版本的roff |
| at | at（在某时） | 一次性定时任务 | `at 3pm` = 在下午3点执行 |
| bash | Born Again Shell | 再生Shell | 双关语：Bourne Again + Born Again |

**设计逻辑**：这些命令源自Unix早期的ed行编辑器、贝尔实验室的研究文化以及程序员的幽默感。名字虽然不直观，但一旦了解渊源，就再也不会忘记。

> 💡 **工具名模式的规律**：
> - grep/sed/awk 是Unix三剑客，名字都源自1970年代
> - 名字中带"GNU"前缀的是GNU项目的自由软件版本（如gcc, gdb, gawk）
> - 名字中带"y"开头的常表示"Yet Another..."（程序员的自嘲）

---

## 二、选项设计模式

### 短选项（Unix System V传统）

**核心思想**：一个连字符 + 一个字母，追求极致的打字效率。

| 选项 | 英文来源 | 含义 | 使用频率 | 四级 |
|------|---------|------|---------|------|
| -R | Recursive | 递归处理目录及其子目录 | ⭐⭐⭐ | ⭐ |
| -r | recursive | 递归（小写版本，部分命令用小写） | ⭐⭐⭐ | ⭐ |
| -f | Force | 强制执行，不提示确认 | ⭐⭐⭐ | ⭐ |
| -v | Verbose | 显示详细执行过程 | ⭐⭐⭐ | ⭐ |
| -a | All | 显示所有文件（包括隐藏文件） | ⭐⭐⭐ | ⭐ |
| -l | Long | 长格式显示 | ⭐⭐⭐ | ⭐ |
| -h | Human-readable | 人类可读格式（KB/MB/GB） | ⭐⭐⭐ | ⭐ |
| -d | Directory | 仅对目录操作 | ⭐⭐ | ⭐ |
| -p | Parents | 递归创建父目录 | ⭐⭐ | |
| -i | Interactive | 交互式，覆盖前提示确认 | ⭐⭐ | ⭐ |
| -n | Number | 显示行号 | ⭐⭐ | ⭐ |
| -q | Quiet | 静默模式，减少输出 | ⭐⭐ | ⭐ |
| -s | Silent | 静默模式（同-q） | ⭐⭐ | ⭐ |
| -w | Word | 按单词统计 | ⭐⭐ | ⭐ |
| -c | Count | 计数模式 | ⭐⭐ | ⭐ |
| -e | Expression | 指定表达式/模式 | ⭐⭐ | ⭐ |
| -o | Output | 指定输出文件 | ⭐⭐ | ⭐ |
| -t | Type | 按类型筛选 | ⭐⭐ | ⭐ |
| -u | User | 按用户筛选 | ⭐⭐ | ⭐ |
| -x | eXclude | 排除某些内容 | ⭐ | ⭐ |
| -z | compress | 压缩（常用于tar） | ⭐ | ⭐ |
| -j | bzip2 | 使用bzip2压缩 | ⭐ | |
| -J | xz | 使用xz压缩 | ⭐ | |
| -C | Create/Create | 创建/切换目录 | ⭐ | ⭐ |
| -A | Append | 追加模式 | ⭐ | ⭐ |
| -B | Before | 显示匹配行之前的内容 | ⭐ | ⭐ |
| -E | Extended regex | 使用扩展正则表达式 | ⭐ | ⭐ |
| -P | Port | 指定端口号 | ⭐ | |

**设计逻辑**：短选项用单字母，打字快，是Unix传统的精髓。但字母有限（26个），不同命令的同一个字母可能含义不同（如 `ls -a` vs `tar -a`），所以需要记忆。

---

### 长选项（GNU扩展，1990年代）

**核心思想**：两个连字符 + 完整英文单词，可读性优先。

| 长选项 | 对应短选项 | 含义 | 典型命令 |
|--------|-----------|------|---------|
| --recursive | -R | 递归 | ls, cp, rm, chmod |
| --force | -f | 强制 | rm, cp, mv |
| --verbose | -v | 详细 | ls, cp, mv, tar |
| --all | -a | 所有 | ls, ps |
| --long | -l | 长格式 | ls |
| --human-readable | -h | 人类可读 | ls, df, du |
| --help | -h | 显示帮助 | 几乎所有命令 |
| --version | -V | 显示版本 | 几乎所有命令 |
| --quiet | -q | 静默 | wget, curl |
| --silent | -s | 静默 | wget |
| --number | -n | 编号 | cat, head, tail |
| --ignore-case | -i | 忽略大小写 | grep |
| --count | -c | 计数 | grep |
| --invert-match | -v | 反向匹配 | grep |
| --dereference | -L | 跟随符号链接 | find, ls |
| --no-preserve-root | | 不保护根目录 | rm |
| --preserve-root | | 保护根目录（默认） | rm |
| --one-file-system | | 不跨越文件系统 | rsync, find |
| --archive | -a | 归档模式 | rsync |
| --dry-run | -n | 模拟运行 | rsync, make |

**设计逻辑**：长选项是GNU对Unix的扩展，解决了短选项难以记忆的问题。`--help` 能看到所有选项，`--recursive` 比 `-R` 更直观。在脚本中建议用长选项（可读性好），在交互式终端用短选项（打字快）。

---

### 选项合并规则

**规则1：短选项可以合并**
```bash
# 以下三种写法完全等价：
ls -l -a -h
ls -lah
ls -l -ah     # 也可以部分合并
```

**规则2：长选项不能合并**
```bash
# ❌ 错误写法：
ls --allong        # 不存在这个选项

# ✅ 正确写法：
ls --all --long    # 必须分开写
```

**规则3：带参数的选项要注意位置**
```bash
# 短选项带参数，合并时参数紧跟：
grep -e 'pattern' -i   # ✅ 正确
grep -ei 'pattern'     # ✅ 正确（-e的参数是下一个字符'pattern'时不行，这种情况需分开）

# 更清晰的写法（推荐）：
grep --ignore-case --regexp='pattern'
```

**规则4：-- 终止选项解析**
```bash
# -- 表示"选项到此结束，后面都是参数"
rm -- -filename     # 删除名为 -filename 的文件
# 如果不用 --，rm 会把 -filename 当作选项
```

---

## 三、配置文件组织模式

### 全局 vs 用户级（分层设计）

**核心思想**：管理员管全局默认，用户管个人偏好。

| 范围 | 配置文件 | 生效范围 | 设计逻辑 |
|------|---------|---------|---------|
| 全局 | /etc/profile | 所有用户登录时 | 管理员统一设置环境变量 |
| 全局 | /etc/bashrc | 所有用户的bash | 统一的bash行为定义 |
| 全局 | /etc/environment | 所有用户所有Shell | 最底层的环境变量 |
| 全局 | /etc/ssh/sshd_config | SSH服务端 | 服务端安全策略 |
| 全局 | /etc/fstab | 所有文件系统挂载 | 系统级挂载配置 |
| 全局 | /etc/hosts | 主机名解析 | 本地DNS |
| 全局 | /etc/resolv.conf | DNS解析 | DNS服务器配置 |
| 全局 | /etc/sysctl.conf | 内核参数 | 系统级内核调优 |
| 用户级 | ~/.bashrc | 当前用户每次终端 | 用户自定义bash行为 |
| 用户级 | ~/.bash_profile | 当前用户登录时 | 用户登录脚本 |
| 用户级 | ~/.profile | 当前用户登录时 | 通用登录脚本 |
| 用户级 | ~/.bash_history | 当前用户的命令历史 | 历史记录配置 |
| 用户级 | ~/.vimrc | 当前用户的vim | 编辑器偏好 |
| 用户级 | ~/.ssh/config | 当前用户的SSH客户端 | 用户级SSH配置 |
| 用户级 | ~/.ssh/authorized_keys | 当前用户的免密登录 | 允许哪些公钥登录 |
| 用户级 | ~/.gitconfig | 当前用户的git | git用户配置 |
| 用户级 | ~/.ssh/known_hosts | 当前用户的已知主机 | SSH主机指纹 |

**设计逻辑**：这种分层设计是Linux的核心模式之一。管理员在 `/etc/` 下配置全局默认，用户在 `~/` 下覆盖自己的偏好。每个用户都可以有自己的个性化设置，而不会影响其他用户。

---

### 覆盖机制（优先级从高到低）

```
优先级层次（从高到低）：

┌─────────────────────────────────────────┐
│ 第1层：命令行参数          （最高优先级） │  ← 临时覆盖，用完即弃
├─────────────────────────────────────────┤
│ 第2层：用户级配置 ~/       （用户偏好）  │  ← 用户自己设置
├─────────────────────────────────────────┤
│ 第3层：全局配置 /etc/      （系统默认）  │  ← 管理员设置
├─────────────────────────────────────────┤
│ 第4层：编译时默认值        （最低优先级） │  ← 软件出厂设置
└─────────────────────────────────────────┘
```

**典型示例**：

```bash
# 以 grep 的 alias 为例：
# 第4层：grep 默认行为是 --color=auto（编译时）
# 第3层：/etc/profile.d/colorgrep.sh 全局设置了 alias grep='grep --color=auto'
# 第2层：~/.bashrc 里 alias grep='grep --color=always'（用户偏好）
# 第1层：命令行直接 grep --color=never（临时覆盖）

# 以 SSH 配置为例：
# 第4层：OpenSSH 默认端口 22
# 第3层：/etc/ssh/sshd_config 设置 Port 22
# 第1层：ssh -p 2222 user@host（命令行覆盖端口）
```

---

### 分层加载模式

**Shell配置的分层加载**（登录时按顺序执行）：

```
┌──────────────────────────────────────────────────────┐
│ 用户登录 (login shell)                                │
│   ↓                                                   │
│ /etc/profile          ← 全局：所有用户登录时执行       │
│   ↓                                                   │
│ ~/.bash_profile       ← 用户级：如果存在，执行它       │
│   │                   （若不存在则找 ~/.bash_login）    │
│   │                   （若再不存在则找 ~/.profile）     │
│   ↓                                                   │
│ ~/.bashrc             ← 用户级：被上面的文件 source     │
│   ↓                                                   │
│ /etc/bashrc            ← 全局：被 ~/.bashrc source     │
└──────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────┐
│ 打开新终端 (non-login shell)                          │
│   ↓                                                   │
│ ~/.bashrc             ← 用户级：每次打开终端执行       │
│   ↓                                                   │
│ /etc/bashrc            ← 全局：被 ~/.bashrc source     │
└──────────────────────────────────────────────────────┘
```

**为什么这样设计？**
- `/etc/profile` 只在登录时执行一次（全局初始化开销大）
- `~/.bashrc` 每次打开终端都执行（用户自定义需要即时生效）
- 用户可以 source 任何配置文件，形成链式加载

---

### 配置文件命名模式

| 模式 | 示例 | 含义 |
|------|------|------|
| `.xxxrc` | .bashrc, .vimrc, .nanorc | "rc" = run commands，运行时配置 |
| `.xxx.conf` | .gitconfig (内部格式) | 配置文件 |
| `xxx.conf` | sshd_config, my.cnf | 服务配置文件 |
| `xxx.d/` | /etc/profile.d/, /etc/yum.repos.d/ | 配置片段目录 |
| `.xxx_profile` | .bash_profile | 登录时配置 |
| `.xxx_history` | .bash_history | 历史记录 |
| `.xxx_logout` | .bash_logout | 登出时脚本 |

**配置片段目录模式**（/etc/xxx.d/）：

```
/etc/profile.d/          ← /etc/profile 会遍历此目录下所有 .sh 文件
├── colorgrep.sh         ← grep 颜色设置
├── colorls.sh           ← ls 颜色设置
├── lang.sh              ← 语言设置
└── vim.sh               ← vim 别名设置

/etc/yum.repos.d/        ← yum 会读取此目录下所有 .repo 文件
├── CentOS-Base.repo
├── CentOS-Extras.repo
└── epel.repo

/etc/logrotate.d/        ← logrotate 会读取此目录下所有配置
├── nginx
├── syslog
└── boot.log
```

**设计逻辑**：`xxx.d/` 目录模式是"关注点分离"的体现——每个软件包安装自己的配置片段，互不干扰，升级也不会覆盖管理员的自定义配置。

---

## 四、服务管理模式

### systemd unit文件类型

| 类型 | 扩展名 | 用途 | 设计逻辑 |
|------|--------|------|---------|
| Service | .service | 服务单元 | 定义如何启动/停止/重启一个服务 |
| Timer | .timer | 定时器单元 | 定义何时触发服务（替代crontab） |
| Socket | .socket | 套接字单元 | 按需启动服务（延迟加载/懒加载） |
| Mount | .mount | 挂载单元 | 定义文件系统挂载点 |
| Automount | .automount | 自动挂载单元 | 按需自动挂载（懒挂载） |
| Swap | .swap | 交换分区单元 | 定义交换空间 |
| Target | .target | 目标单元 | 一组单元的集合（类似运行级别） |
| Path | .path | 路径监控单元 | 监控文件/目录变化，触发其他单元 |
| Device | .device | 设备单元 | udev设备管理 |
| Slice | .slice | 资源切片 | cgroup资源限制分组 |
| Scope | .scope | 作用域单元 | 外部创建的进程组 |

**Service单元示例**：
```ini
# /etc/systemd/system/myservice.service
[Unit]
Description=My Custom Service          # 服务描述
After=network.target                    # 在网络就绪之后启动
Requires=network.target                 # 依赖网络服务

[Service]
Type=simple                             # 进程类型
ExecStart=/usr/bin/myapp                # 启动命令
ExecReload=/bin/kill -HUP $MAINPID      # 重载命令
Restart=on-failure                      # 失败时自动重启
RestartSec=5                            # 重启间隔5秒

[Install]
WantedBy=multi-user.target              # 属于multi-user目标
```

**Timer单元示例**（替代crontab）：
```ini
# /etc/systemd/system/backup.timer
[Unit]
Description=Daily Backup Timer

[Timer]
OnCalendar=*-*-* 02:00:00              # 每天凌晨2点
Persistent=true                          # 错过的任务开机后补执行

[Install]
WantedBy=timers.target
```

**Socket单元示例**（按需启动）：
```ini
# /etc/systemd/system/myapp.socket
[Unit]
Description=My App Socket

[Socket]
ListenStream=/run/myapp.sock            # 监听Unix域套接字
Accept=false

[Install]
WantedBy=sockets.target
```

---

### target依赖关系

**运行级别 → target 对照表**：

| SysVinit运行级别 | systemd target | 含义 |
|-----------------|---------------|------|
| 0 | poweroff.target | 关机 |
| 1 | rescue.target | 单用户救援模式 |
| 2 | multi-user.target | 多用户（无网络） |
| 3 | multi-user.target | 多用户（有网络，无图形） |
| 4 | multi-user.target | 多用户（自定义） |
| 5 | graphical.target | 图形界面 |
| 6 | reboot.target | 重启 |

**target依赖树**：

```
graphical.target（图形界面）
  │
  ├── wants: multi-user.target（多用户模式）
  │     │
  │     ├── wants: basic.target（基础服务）
  │     │     │
  │     │     ├── wants: sysinit.target（系统初始化）
  │     │     │     │
  │     │     │     ├── wants: local-fs.target（本地文件系统）
  │     │     │     ├── wants: swap.target（交换分区）
  │     │     │     └── wants: timers.target（定时器）
  │     │     │
  │     │     ├── wants: sockets.target（套接字）
  │     │     ├── wants: paths.target（路径监控）
  │     │     └── wants: slices.cgroup（资源控制）
  │     │
  │     ├── wants: network.target（网络就绪）
  │     ├── wants: network-online.target（网络完全就绪）
  │     ├── wants: remote-fs.target（远程文件系统）
  │     └── wants: getty.target（登录终端）
  │
  └── wants: display-manager.service（显示管理器/GDM）
```

**常用target操作**：
```bash
# 查看当前默认目标
systemctl get-default

# 设置默认目标为多用户（无图形）
systemctl set-default multi-user.target

# 设置默认目标为图形界面
systemctl set-default graphical.target

# 临时切换到救援模式
systemctl isolate rescue.target

# 查看某个target依赖的所有单元
systemctl list-dependencies graphical.target

# 查看反向依赖（哪些target依赖某个单元）
systemctl list-dependencies --reverse sshd.service
```

---

### 配置文件分层

```
优先级从高到低：

┌───────────────────────────────────────────────────────────┐
│ /etc/systemd/system/           （最高优先级）              │
│   → 管理员自定义配置                                       │
│   → 软件包升级不会覆盖                                     │
│   → 这里放 override.conf 或完整自定义 unit                 │
├───────────────────────────────────────────────────────────┤
│ /run/systemd/system/           （运行时临时）              │
│   → 系统运行时生成的配置                                   │
│   → 重启后丢失                                             │
│   → 一般不需要手动修改                                     │
├───────────────────────────────────────────────────────────┤
│ /usr/lib/systemd/system/       （最低优先级）              │
│   → 软件包安装时自带的默认配置                              │
│   → 不要直接修改！升级会被覆盖                              │
│   → 想修改就复制到 /etc/systemd/system/ 再改               │
└───────────────────────────────────────────────────────────┘
```

**正确的配置覆盖方式**：

```bash
# 方法1：使用 drop-in 文件（推荐，不修改原文件）
sudo systemctl edit nginx.service
# 这会在 /etc/systemd/system/nginx.service.d/ 下创建 override.conf

# 方法2：复制并修改
cp /usr/lib/systemd/system/nginx.service /etc/systemd/system/nginx.service
vim /etc/systemd/system/nginx.service

# 修改后必须重新加载
sudo systemctl daemon-reload
sudo systemctl restart nginx
```

**设计逻辑**：管理员的配置永远覆盖默认配置，这样升级软件包不会丢失自定义设置。这是"配置分离"原则的体现——软件包管代码，管理员管配置。

---

## 五、权限设计模式

### 三组权限模型

```
          rwx        rwx        rwx
          ─┬─        ─┬─        ─┬─
           │          │          │
        文件所有者    所属组      其他人
        (owner)     (group)    (others)
           │          │          │
         uid=0       gid=X      其余用户
```

**设计逻辑**：三个角色 × 三种权限 = 9位权限位。这是Unix最早的权限设计，简单但够用。

### 权限的数字表示（八进制）

```
rwx rwx rwx
111 111 111 = 7 7 7  (所有权限)

rw- rw- r--
110 110 100 = 6 6 4  (常见文件权限)

rwx r-x r-x
111 101 101 = 7 5 5  (常见目录权限)
```

**设计逻辑**：3位二进制 = 1位八进制，所以9位权限正好用3位八进制数表示。这是二进制和八进制的巧妙对应。

### 特殊权限位

| 权限 | 位置 | 数字 | 效果 | 典型应用 |
|------|------|------|------|---------|
| SUID | 所有者的x位 | 4xxx | 执行时以文件所有者身份运行 | /usr/bin/passwd (root) |
| SGID | 所属组的x位 | 2xxx | 执行时以文件所属组身份运行 | /usr/bin/wall |
| Sticky | 其他人的x位 | 1xxx | 只有文件所有者能删除 | /tmp 目录 |

```bash
# SUID 示例：passwd 命令需要修改 /etc/shadow
ls -l /usr/bin/passwd
# -rwsr-xr-x 1 root root ... /usr/bin/passwd
#   ^^^
#   s = SUID，普通用户执行时临时获得root权限

# Sticky Bit 示例：/tmp 目录
ls -ld /tmp
# drwxrwxrwt 1 root root ... /tmp
#          ^^^
#          t = Sticky Bit，所有人能写但只有所有者能删
```

---

## 六、文件系统层次结构模式

### 顶层目录的设计逻辑

| 目录 | 全称 | 存放内容 | 设计逻辑 |
|------|------|---------|---------|
| /bin | binaries | 基础用户命令 | 所有用户都需要的基础命令 |
| /sbin | system binaries | 系统管理命令 | 只有root才需要的命令 |
| /usr/bin | user binaries | 用户程序命令 | 安装的软件命令 |
| /usr/sbin | user system binaries | 系统管理程序 | 安装的管理程序 |
| /lib | libraries | 基础共享库 | /bin 和 /sbin 需要的库 |
| /usr/lib | user libraries | 用户程序库 | /usr/bin 和 /usr/sbin 需要的库 |
| /etc | et cetera | 配置文件 | "其他东西"→所有配置文件 |
| /home | home directories | 用户主目录 | 每个用户一个子目录 |
| /root | root home | root用户主目录 | root的家不放在/home下（安全考虑） |
| /var | variable | 可变数据 | 日志、缓存、邮件等经常变化的数据 |
| /tmp | temporary | 临时文件 | 重启后可能清空 |
| /opt | optional | 可选软件 | 第三方大型软件 |
| /proc | process | 进程信息（虚拟） | 内核暴露的进程和系统信息 |
| /sys | system | 系统信息（虚拟） | 内核暴露的设备和驱动信息 |
| /dev | devices | 设备文件 | 所有硬件设备的文件接口 |
| /boot | boot | 启动文件 | 内核、引导加载器 |
| /mnt | mount | 临时挂载点 | 手动挂载用 |
| /media | media | 媒体挂载点 | 自动挂载的U盘、光盘等 |
| /srv | services | 服务数据 | Web/FTP等服务的数据目录 |
| /run | runtime | 运行时数据 | PID文件、套接字等（重启清空） |

**设计逻辑**：
- `/bin` vs `/usr/bin`：历史上是两个分区（根分区小，/usr大），现在已合并但保留了目录名
- `/etc` 名字的来源：最早存放"其他所有不属于/bin或/lib的文件"
- `/proc` 和 `/sys` 是虚拟文件系统，不占磁盘空间，是内核向用户空间暴露信息的窗口

---

## 七、日志管理模式

### systemd journal 分层

```
日志来源                        存储位置
┌─────────────────────────────────────────────────┐
│ 内核日志 (dmesg)            → /dev/kmsg          │
│ systemd 服务日志            → systemd-journald   │
│ 传统syslog                  → rsyslogd           │
└─────────────────────────────────────────────────┘
                ↓
    systemd-journald 统一收集
                ↓
    ┌────────────────────────────────┐
    │ /var/log/journal/              │
    │   → 持久化存储（二进制格式）    │
    │   → 结构化查询                  │
    │   → 支持优先级过滤              │
    └────────────────────────────────┘
                ↓
    rsyslog 转发到传统日志文件
                ↓
    ┌────────────────────────────────┐
    │ /var/log/messages              │ → 通用系统日志
    │ /var/log/secure                │ → 安全/认证日志
    │ /var/log/cron                  │ → 定时任务日志
    │ /var/log/boot.log              │ → 启动日志
    │ /var/log/dmesg                 │ → 内核日志
    └────────────────────────────────┘
```

**journalctl 查询模式**：
```bash
# 按服务查
journalctl -u nginx.service

# 按时间查
journalctl --since "2024-01-01" --until "2024-01-02"

# 按优先级查（0=emergency, 7=debug）
journalctl -p err            # 只看错误及以上

# 实时跟踪
journalctl -f                # 类似 tail -f

# 按PID查
journalctl _PID=1234

# 按启动查
journalctl -b -1             # 上次启动的日志
journalctl -b 0              # 本次启动的日志

# 磁盘占用管理
journalctl --disk-usage      # 查看日志占用空间
journalctl --vacuum-size=500M  # 清理到500M以内
```

---

## 八、网络配置模式

### 配置文件层次

```
第1层：内核参数
  /proc/sys/net/ipv4/ip_forward     → IP转发开关
  /proc/sys/net/ipv4/conf/all/...   → 网络接口参数
  /etc/sysctl.conf                  → 持久化内核参数

第2层：NetworkManager（现代推荐）
  /etc/NetworkManager/system-connections/  → 连接配置文件
  nmcli / nmtui                              → 命令行/文本界面工具

第3层：传统配置（RHEL7及以前）
  /etc/sysconfig/network-scripts/ifcfg-eth0  → 接口配置
  /etc/sysconfig/network                     → 全局网络配置

第4层：DNS配置
  /etc/resolv.conf                  → DNS服务器（由NetworkManager管理）
  /etc/hosts                        → 本地主机名解析
  /etc/nsswitch.conf                → 解析顺序配置

第5层：防火墙配置
  /etc/firewalld/                   → firewalld 配置目录
  /usr/lib/firewalld/               → 默认服务/区域定义
```

**设计逻辑**：网络配置从底层到高层，从内核参数到用户工具，层层叠加。现代推荐用 NetworkManager 管理，它会自动维护 `/etc/resolv.conf` 和 `/etc/sysconfig/network-scripts/`。

---

## 九、进程管理模式

### 进程生命周期

```
         fork()
父进程 ────────→ 子进程
  │                │
  │                ├── exec() → 新程序
  │                │
  │                ├── exit() → 变成僵尸(zombie)
  │                │               │
  │                │               ↓
  │                │          wait() by parent
  │                │               │
  │                │               ↓
  │                │          彻底清除(PCB释放)
  │                │
  │                └── 信号 → 改变行为
  │                     ├── SIGHUP   (1)  → 重新加载配置
  │                     ├── SIGINT   (2)  → Ctrl+C 终止
  │                     ├── SIGQUIT  (3)  → Ctrl+\ 退出并core dump
  │                     ├── SIGKILL  (9)  → 强制终止(不可捕获)
  │                     ├── SIGTERM (15)  → 优雅终止(默认)
  │                     ├── SIGSTOP (19)  → 暂停(不可捕获)
  │                     ├── SIGCONT (18)  → 继续执行
  │                     └── SIGCHLD (17)  → 子进程状态变化
  │
  └── 僵尸子进程需要 wait() 回收
```

### 进程状态

| 状态码 | 含义 | 场景 |
|--------|------|------|
| R (Running) | 运行中或就绪 | 正在CPU上运行或在运行队列中 |
| S (Sleeping) | 可中断睡眠 | 等待事件（如I/O完成、信号） |
| D (Disk sleep) | 不可中断睡眠 | 等待磁盘I/O（不能被信号打断） |
| T (Stopped) | 停止 | 收到 SIGSTOP 或 Ctrl+Z |
| Z (Zombie) | 僵尸 | 已终止但父进程未回收 |
| X (Dead) | 死亡 | 已终止，即将被回收 |

---

## 十、Shell管道与重定向模式

### 三种流

| 文件描述符 | 名称 | 默认设备 | 含义 |
|-----------|------|---------|------|
| 0 | stdin | 键盘 | 标准输入 |
| 1 | stdout | 终端 | 标准输出 |
| 2 | stderr | 终端 | 标准错误输出 |

### 重定向模式

```bash
# 输出重定向
command > file         # stdout写入file（覆盖）
command >> file        # stdout追加到file
command 2> file        # stderr写入file
command 2>> file       # stderr追加到file
command &> file        # stdout和stderr都写入file
command > file 2>&1    # 同上（老式写法）
command 2>&1 > file    # 先重定向stderr到stdout，再重定向stdout到file

# 输入重定向
command < file         # 从file读取stdin
command << EOF         # Here Document：从脚本内嵌输入
内容...
EOF

# 管道
command1 | command2    # command1的stdout → command2的stdin
command1 |& command2   # command1的stdout和stderr → command2的stdin
```

### 常用管道组合模式

```bash
# 模式1：搜索 → 过滤 → 统计
ps aux | grep nginx | grep -v grep | wc -l

# 模式2：搜索 → 排序 → 去重
cat /var/log/messages | sort | uniq -c | sort -rn | head -20

# 模式3：搜索 → 截取 → 格式化
df -h | awk '{print $5, $6}' | sort -rn

# 模式4：批量处理
find /var/log -name "*.log" -mtime +30 | xargs rm -f

# 模式5：tee 分流（同时输出到屏幕和文件）
dmesg | tee dmesg.log | grep error
```

---

## 十一、设计模式速记口诀

```
命令命名四种法，动词名词加缩写，
子命令集功能大，工具名承历史。

选项短长各有利，短快长明可合并，
带参选项需注意，双横线后选项止。

配置分层有优先，命令行胜用户文件，
用户文件胜全局，全局胜过编译值。

服务管理 systemd，unit 类型有七种，
service 管启停，timer 替 cron，
socket 按需起，target 做分组。

配置目录分三层，usr/lib 最底层，
run 是运行时，etc 最优先。

权限三组九位码，rwx 对应 421，
SUID SGID 特殊位，八进制前面放。

文件系统有层次，bin 放命令 lib 放库，
etc 放配置 var 放日志，proc 暴露内核数。

日志管理 journalctl，按服务时间优先级，
网络配置 NM 为首，防火墙用 firewall-cmd。
```

---

## 十二、设计模式总结表

| 设计模式 | 核心原则 | 代表例子 | 学习价值 |
|---------|---------|---------|---------|
| 命令命名 | 动词+名词/缩写/子命令/工具名 | useradd/chmod/systemctl/grep | 看到命令名就能猜用途 |
| 选项设计 | 短选项快/长选项明/可合并 | -R/--recursive/ls -lah | 掌握选项规律，举一反三 |
| 配置分层 | 全局→用户→命令行 | /etc/profile → ~/.bashrc | 知道去哪改配置 |
| 服务管理 | unit类型/target依赖/配置分层 | .service/graphical.target | 系统化管理服务 |
| 权限模型 | 三组×三权/特殊位 | 755/SUID/Sticky | 理解安全机制 |
| 文件系统 | 功能分层/挂载点设计 | /bin /etc /var /proc | 理解目录结构逻辑 |
| 日志管理 | 统一收集/结构化查询 | journalctl -u | 高效排查问题 |
| 网络配置 | 层层叠加/NM为主 | nmcli/firewall-cmd | 系统化配置网络 |
| 进程管理 | fork+exec/信号/状态 | kill -15/ps aux | 理解进程生命周期 |
| 管道重定向 | 三种流/管道组合 | \|/>/2>&1 | 组合小工具做大任务 |

> 💡 **终极学习法**：不要背命令，要理解设计模式。理解了"分层覆盖"模式，你就知道为什么配置文件有优先级；理解了"动词+名词"模式，你看到 `xxxctl` 就知道怎么用；理解了"一切皆文件"，你就能用 `cat` 读取内核信息。设计模式是Linux的DNA，掌握了DNA，就掌握了整个系统。
