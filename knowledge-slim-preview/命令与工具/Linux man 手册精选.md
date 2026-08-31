---
source: systemd-docs
category: cmd-tools
url: consolidated/cmd-tools/Linux man 手册精选.md
title: Linux man 手册精选
---

- 压缩：`bzip2 -k`
- 权限：capabilities/credentials
- 环境/错误：environ/errno
- 宏：`_GNU_SOURCE`
- 系统调用：syscall(2)/libc(7)
- IPC：pipe/socket/MQ/Sem/Shm/SysV
- 线程/信号：`pthread_create`（`-pthread`）/signal(7) `SIGKILL`
- 文件/时间/数学：Path resolution/symlink/pty/clock_gettime/Math error
- 标准/类型：standards/System data types

## bzip2 核心知识点

**功能**：块排序（Burrows-Wheeler）+ Huffman 压缩，压缩率优于 gzip。命令族：`bzip2`（压缩/解压）、`bunzip2`（解压）、`bzcat`（解压至 stdout）、`bzip2recover`（修复损坏文件）。同一程序按调用名决定行为，可用 `-d`/`-z` 强制。

**命令**：
```
bzip2 [options] [文件...]
bunzip2 [options] [文件...]
bzcat [options] [文件...]
bzip2recover 文件
```

**关键参数**：
- `-c` 输出到 stdout
- `-d` 强制解压；`-z` 强制压缩
- `-t` 完整性测试
- `-f` 覆盖已有文件；强制透传非 bzip2 文件
- `-k` 保留输入文件（默认删除）
- `-s` 小内存模式（约 2.5 字节/块，速度减半；压缩块固定 200k）
- `-1`~`-9` 压缩块大小 100k~900k（仅压缩有效）
- `-q`/`-v` 静默/显示压缩比；`-L`/`-V` 显示版本许可
- `--` 后接以 `-` 开头的文件名

**行为与易错点**：
- 默认不覆盖已有输出文件；无参数时 stdin→stdout，拒绝输出到终端。
- 解压后缀识别：`.bz2`/`.bz`→去后缀；`.tbz2`/`.tbz`→`.tar`；其他→追加 `.out`。
- 支持解压多个 bzip2 文件拼接的流。
- 小文件（<100 字节）压缩后变大；随机数据膨胀约 0.5%。
- 32 位 CRC 仅检测错误不修复；损坏文件用 `bzip2recover` 尝试恢复。
- 环境变量 `BZIP2`/`BZIP` 可提供默认参数，先于命令行处理。

**返回码**：0 正常；1 环境错误（文件缺失、非法选项、I/O）；2 压缩文件损坏；3 内部错误。

- `--repetitive-fast`/`--repetitive-best` 在 0.9.5+ 已冗余，旧版用于粗略控制排序行为，现算法已改进。

- 块大小决定压缩率与内存：`-1`~`-9` 对应块 100,000~900,000 字节（默认）。
- 解压时从压缩文件头读取块大小，`-1`~`-9` 在解压时被忽略。

**内存估算**  
压缩：`400k + (8 × block size)`  
解压：`100k + (4 × block size)` 或 `100k + (2.5 × block size)`

- 块越大收益递减，前 200~300k 贡献大部分压缩率；解压内存由压缩时块大小决定。
- 默认 900k 块解压需约 3700k；`-s` 用约一半内存（约 2300k）但解压速度减半，仅在必要时用。
- 内存允许时应尽量用最大块；压缩/解压速度几乎不受块大小影响。
- 单块文件实际内存触及量按文件大小：如 20,000 字节文件用 `-9`，压缩分配 7600k 但仅触及 `400k+20000*8=560k`；解压分配 3700k 但仅触及 `100k+20000*4=180k`。

**恢复损坏文件**  
- 多块独立，每块有 48-bit 边界标记和 32-bit CRC，损坏块可区分。
- 使用 `bzip2recover` 提取块到独立 `.bz2` 文件，再用 `bzip2 -t` 测试完整性，解压未损坏块。

**易错点**  
- 解压时块大小由文件头决定，不要试图用 `-1`~`-9` 改变解压内存。
- `-s` 只影响解压内存与速度，压缩时无效。

Linux 2.2 起将 root 特权细化为线程级 capabilities，不再以 euid=0 一律放行，而检查具体能力。

- 文件/权限：CAP_CHOWN（改 UID/GID）、CAP_DAC_OVERRIDE（绕过读写执行）、CAP_DAC_READ_SEARCH（绕过读/目录检索）、CAP_FOWNER（绕过属主）、CAP_FSETID（不清 suid/sgid）
- 网络：CAP_NET_ADMIN（接口/防火墙/路由）、CAP_NET_BIND_SERVICE（<1024）、CAP_NET_RAW（RAW/PACKET）
- 进程/内存：CAP_KILL（信号）、CAP_SETGID（GID/伪 GID）、CAP_SETFCAP（文件 cap；5.12 起映射 UID 0 也需）、CAP_SETPCAP（bounding set/securebits）、CAP_IPC_LOCK（锁内存/大页）
- 系统：CAP_BPF（5.8 拆分）、CAP_PERFMON（perf_event_open，5.8）、CAP_CHECKPOINT_RESTORE（C/R，5.9）

- **CAP_SETPCAP**：仅内核 <2.6.24（不支持文件 capabilities）时，可将自身 permitted 中任一 capability 授予/移除给其他进程。

- **CAP_SETUID**：任意操纵 UID（`setuid(2)`、`setreuid(2)`、`setresuid(2)`、`setfsuid(2)`）；可伪造 UNIX 域套接字凭据 UID；可写用户命名空间 UID 映射。

- **CAP_SYS_ADMIN**：重载能力，覆盖大量系统管理操作；现代内核拆分出 `CAP_SYSLOG`、`CAP_BPF`、`CAP_PERFMON`、`CAP_CHECKPOINT_RESTORE` 等，优先使用。核心操作：`mount(2)`/`umount(2)`、`pivot_root(2)`、`sethostname(2)`/`setdomainname(2)`、`swapon(2)`/`swapoff(2)`、System V IPC 任意 `IPC_SET`/`IPC_RMID`、命名空间创建（`clone(2)`/`unshare(2)` 用 `CLONE_*`；`setns(2)` 需目标命名空间内有此能力，≥3.8 创建用户命名空间无需）。还可操作 `trusted`/`security` xattr、伪造 UNIX 域套接字凭据 PID、超 `fs.file-max` 打开文件、安装 seccomp 无需 `no_new_privs`、特权 ioctl 等。**易错点**：权限过大，避免滥用。

### 进程标识
- PID：`fork(2)` 分配，`getpid(2)` 获取，类型 `pid_t`；用于 `kill(2)`、`waitpid(2)`；`execve(2)` 后不变。
- PPID：`getppid(2)` 获取；`execve(2)` 后不变。

### 进程组/会话/终端
- 均用 `pid_t`；`getpgrp(2)`/`getsid(2)`；`fork(2)` 继承，`execve(2)` 不变。
- 进程组：共享 PGID；`setpgid(2)` 设置；PID==PGID 者为组 leader。
- 会话：进程组集合；`setsid(2)` 创建新会话。
- 控制终端：session leader 首次打开终端时建立，除非指定 `O_NOCTTY`；一个终端至多属一个会话。
- 前台可读终端；后台读触发 `SIGTTIN`；终端设 `TOSTOP` 后后台写触发 `SIGTTOU`；Ctrl-C 发往前台进程组。
- 进程组操作：`kill(2)`、`killpg(3)`、`waitpid(2)`。

### 用户/组标识
- Real UID/GID：`getuid(2)`/`getgid(2)`。
- Effective UID/GID：访问共享资源（消息队列、共享内存、信号量）的权限依据；`geteuid(2)`/`getegid(2)`。
- Saved set-UID/GID：特权副本；`seteuid(2)`/`setreuid(2)`/`setresuid(2)` 切换；`getresuid(2)`/`getresgid(2)`。
- Filesystem UID/GID（Linux 特有）：检查文件访问权限；effective 改变时自动跟随；`setfsuid(2)`/`setfsgid(2)`。
- Supplementary group IDs：`getgroups(2)` 获取；上限用 `sysconf(_SC_NGROUPS_MAX)` 查询。

- 子进程经 `fork(2)` 继承父进程用户/组 ID；`execve(2)` 时 real/supplementary 保留，effective/saved-set 可能改变。
- 用户 ID 还用于信号发送（`kill(2)`）、调度（`setpriority` 等）、资源限制、inotify 实例数检查。

### 修改进程凭证 API
- `setuid(2)` (`setgid`)：改 real（可含 effective、saved-set）
- `seteuid(2)` (`setegid`)：改 effective
- `setfsuid(2)` (`setfsgid`)：改 filesystem ID
- `setreuid(2)` (`setregid`)：改 real+effective（可含 saved-set）
- `setresuid(2)` (`setresgid`)：改 real、effective、saved-set
- `setgroups(2)`：改 supplementary group 列表

### 关键影响
- effective ID 变化**自动同步**到 filesystem ID
- effective 用户/组 ID 变化可能影响进程 `dumpable`（`prctl(2)`）及 capabilities（`capabilities(7)`）

### 标准与实现
- POSIX.1 规定 PID、PPID、进程组/会话 ID、real/effective/saved-set 用户/组 ID、supplementary group ID
- filesystem ID 为 Linux 扩展
- `/proc/<pid>/status` 显示进程凭证
- POSIX 线程要求共享凭证；内核每线程独立，NPTL 确保 `setuid`/`setresuid` 等传播到所有线程

# environ(7)

- `extern char **environ;`：环境指针数组，以 NULL 结尾；`execve(2)` 为新程序提供环境，`fork(2)` 继承父环境副本。
- 格式 `name=value`；name 区分大小写且不可含 `=`，name/value 不可含 `\0`。

```c
extern char **environ;
```

- 设置：`export`（sh） / `setenv`（csh）；`NAME=value command` 仅对命令有效；登录环境由 `/etc/environment`（经 `pam_env(8)`）及 `/etc/profile` 等初始化。
- C 操作：`getenv(3)` `putenv(3)` `setenv(3)` `unsetenv(3)`。

## 常用变量

- `PATH`：可执行文件搜索路径，冒号分隔；零长度前缀（相邻/首尾冒号）表示当前目录，已废弃，应显式 `.`。
- `HOME`、`USER`/`LOGNAME`、`SHELL`、`PWD`（规范绝对路径）、`TERM`、`PAGER`、`EDITOR`/`VISUAL`。
- `LANG` 与 `LC_*`（如 `LC_ALL`、`LC_CTYPE`）控制 locale。

## 影响行为

- `LD_LIBRARY_PATH`、`LD_PRELOAD`：动态链接器。
- `TMPDIR`：临时文件；`TZ`/`TZDIR`：时区。
- `POSIXLY_CORRECT`、`MALLOC_*`、`HOSTALIASES`、`TERMCAP`、`COLUMNS`/`LINES`、`PRINTER`/`LPDEST`。

## 易错点

- `environ` 需自行声明；定义 `_GNU_SOURCE` 后 `<unistd.h>` 已声明。
- `prctl(2)` 的 `PR_SET_MM_ENV_START`/`END` 可控制环境内存位置。

- 切换用户时，`HOME`、`LOGNAME`、`SHELL`、`USER` 由会话管理程序（如 `login(1)`）从用户数据库设置。
- 用 `su(1)` 切到 root 可能产生混合环境：`LOGNAME`/`USER` 保留旧用户值，详见 su 手册。

**安全风险**
- 恶意设置 `IFS`、`LD_LIBRARY_PATH` 等环境变量可欺骗系统命令，造成安全漏洞。

**命名空间污染**
- `make`/`autoconf` 允许用同名大写环境变量覆盖默认工具名，如 `CC` 选择 C 编译器；同类还有 `MAKE`、`AR`、`AS`、`FC`、`LD`、`LEX`、`RM`、`YACC` 等。
- 传统用法中此类变量用于传递选项而非路径，如 `MORE`、`LESS`；新程序应避免此种用法。

## errno(3) 核心要点

**头文件**：`#include <errno.h>`

**功能**：记录最后一次错误号；由系统调用/库函数出错时设置。

**关键规则**：
- 仅当调用返回值指示错误时，`errno` 才有意义（多数系统调用返回 `-1`，库函数返回 `-1` 或 `NULL`）。
- 成功调用也**可以**修改 `errno`；系统调用/库函数从不将其清零。
- 对成功可返回 `-1` 的调用（如 `getpriority(2)`）：调用前先 `errno = 0`，若返回 `-1` 且 `errno != 0` 才视为出错。
- `errno` 是 ISO C 定义的 `int` 可修改左值，可能实现为宏；**禁止显式声明**；线程局部，各线程互不影响。

**错误号与名称**：
- 错误号均为正数，符号名定义在 `<errno.h>`。
- 错误码数值因系统/架构而异，不能硬编码；文本转换用 `perror(3)` / `strerror(3)`。
- `EAGAIN` 与 `EWOULDBLOCK` 在 Linux 上恒等。

**查询命令**（`errno(1)`，moreutils 包）：
```bash
$ errno -l                     # 列出所有错误码
$ errno 2                      # 按数字查：ENOENT 2 No such file or directory
$ errno ESRCH                  # 按符号名查
$ errno -s permission          # 按描述搜索，如 EACCES 13 Permission denied
```

**完整错误列表**：见 `<errno.h>` / `errno(1)`。常见示例：`EPERM`、`ENOENT`、`EINTR`、`EIO`、`EACCES`、`EBADF`、`EINVAL`、`EMFILE`、`ECONNREFUSED` 等；标准来源有 POSIX.1-2001、POSIX.1-2008、C99 及 Linux 扩展。

## errno 错误码速查

多数为 POSIX.1-2001。返回 -1 并设置 errno。

| errno | 含义 |
|-------|------|
| ENOENT | 无此文件/目录（路径组件缺失或悬空符号链接）|
| EPERM | 操作不允许 |
| ENOMEM | 内存不足/无法分配 |
| ENOSPC | 设备无空间 |
| EROFS | 只读文件系统 |
| EPIPE | 管道破裂（常伴 SIGPIPE）|
| ENOTDIR | 不是目录 |
| ENAMETOOLONG | 文件名过长 |
| ENODEV | 无此设备 |
| ENOSYS | 功能未实现 |
| ENOEXEC | 执行格式错误 |
| EOVERFLOW | 值超出数据类型范围 |
| ENOTEMPTY | 目录非空 |
| ENOLCK | 无可用锁 |
| ENOBUFS | 无缓冲空间 |

**网络/套接字**

- ENETDOWN 网络关闭 / ENETUNREACH 网络不可达
- ENOTSOCK 非套接字 / ENOTCONN 套接字未连接
- EOPNOTSUPP/ENOTSUP 操作不支持（Linux 上同值）
- EPROTO 协议错误

**易错点**

- Linux 上 `ENOTSUP` 与 `EOPNOTSUPP` 数值相同
- `ENFILE`：系统打开文件过多，与 `/proc/sys/fs/file-max` 相关
- `ENODATA`：在 xattr(7) 中表示属性不存在或无访问权限
- `ERANGE`：结果过大；`ENXIO` 无此设备或地址

**feature_test_macros(7) 核心要点**
- 必须在包含任何头文件之前定义宏；可用 `cc -DMACRO=value` 或源码 `#define`；勿直接包含 `<features.h>`。
- `_POSIX_C_SOURCE`：`1`=POSIX.1-1990，`2`=POSIX.2-1992，`199309L`=POSIX.1b，`199506L`=POSIX.1c，`200112L`=POSIX.1-2001，`200809L`=POSIX.1-2008；大值隐含 C99。
- `_XOPEN_SOURCE`：`1`=POSIX/XPG4，`500`=SUSv2，`600`=SUSv3，`700`=SUSv4（含 XSI）。
- `_GNU_SOURCE`：GNU/Linux 特有定义。
- `_DEFAULT_SOURCE`：提供默认定义。
- `_FILE_OFFSET_BITS=64`：32 位系统支持 >2GB 文件，自动将 I/O 转为 64 位，重编译即可。
- 已弃用：`_POSIX_SOURCE`（等价 `_POSIX_C_SOURCE=1`）、`_LARGEFILE64_SOURCE`（改用 `_FILE_OFFSET_BITS=64`）、`_LARGEFILE_SOURCE`（改用 `_XOPEN_SOURCE`）、`_XOPEN_SOURCE_EXTENDED`；不要直接定义 `_ISOC*_SOURCE`，用 `-std=c99`/`-ansi`（隐式定义 `__STRICT_ANSI__`）。
- 易错：手册页如 `acct()` 要求 `_BSD_SOURCE || (_XOPEN_SOURCE && _XOPEN_SOURCE < 500)`，满足任一即可；部分宏默认已定义；`#define` 须位于所有 `#include` 之前，反例：
```c
#include <abc.h>
#define _GNU_SOURCE /* 无效：应位于所有 #include 之前 */
#include <xyz.h>
```

### 特性测试宏

- `_FILE_OFFSET_BITS=64`：支持 >2GB 文件；64 位系统天然支持，此宏无效。
- `_TIME_BITS=64`：`time_t` 扩为 64 位，处理 2038 年问题；需与 `_FILE_OFFSET_BITS` 同设；glibc ≥2.34。
- `_GNU_SOURCE`：启用 GNU 扩展及常见特性宏；glibc ≥2.19 同时定义 `_DEFAULT_SOURCE`。
- `_DEFAULT_SOURCE`（glibc ≥2.19）：`-std=c99` 等标准模式下仍提供默认定义；≤2.19 需 `cc -D_BSD_SOURCE -D_SVID_SOURCE -D_POSIX_C_SOURCE=200809`。
- `_ATFILE_SOURCE`（glibc ≥2.4）：暴露 `*at()` 函数；`_POSIX_C_SOURCE ≥ 200809L` 时隐式定义。
- `_BSD_SOURCE`/`_SVID_SOURCE`/`_REENTRANT`（弃用）：glibc ≥2.20 等同 `_DEFAULT_SOURCE`（有警告）。

### Linux 入门

- Shell 是独立命令解释器，标准 `sh`，用 `chsh` 更换；Ctrl-D 结束。
- 提示符 `$` 用 `PS1="..."` 自定义；login(1) 验证后启动 shell。

```shell
date       # 日期时间
ls [-l]    # 列表；-l 长格式
cat file   # 查看文件
cp src dst # 复制
mv src dst # 移动/重命名
rm file    # 删除
grep pat f # 搜索
chown/chmod # 改属主/权限
```

### 核心命令速查
```bash
diff file1 file2    # 比较文件差异，无输出=相同
rm file             # 删除文件，立即永久丢失，无回收站
grep pattern file... # 在文件中查找字符串
pwd                 # 显示当前目录
cd /path            # 切换目录；cd . 原地，cd .. 上级，cd / 根，cd ~ 主目录
mkdir dir           # 建目录
rmdir dir           # 删空目录（非空报错）
find . -name tel    # 从当前目录查找；用 / 代替 . 从根查找
mount               # 挂载文件系统
umount              # 卸载文件系统
df                  # 查看磁盘剩余空间
ps                  # 列出进程及PID
kill [-9] PID       # 终止进程；-9 强制
man command         # 查看手册（空格翻页，q退出）
info                # 阅读GNU info文档
```

### 易错/要点
- `rm` 不可恢复；`rmdir` 仅空目录；`find` 全盘搜索慢，可用 `locate`。
- 前台进程常用 `Ctrl-C` 终止。
- 手册章节写法如 `man(1)`；`info info` 可入门。

### 系统调用 intro(2)
- 系统调用是内核入口，通常经C库wrapper调用：复制参数和调用号到寄存器→陷入内核→出错时设置 `errno`。
- 系统调用出错返回负错误码，wrapper将其绝对值存入 `errno` 并返回 -1；成功返回值因调用而异（多为0）。
- 某些调用要求先定义特征测试宏，且必须在包含任何头文件之前。
- 无wrapper时可用 `syscall(2)` 手动调用。

## intro 手册章节核心知识点

**intro(3) — 库函数**
- 第 3 节描述库函数，但不含第 2 节实现的系统调用封装（wrapper）
- 多数函数属标准 C 库 `libc`；其他库需显式链接：
  - 数学库：`-lm`
  - 实时库：`-lrt`
- 易错点：部分函数声明需先定义功能测试宏（feature test macro），且**必须在使用任何头文件之前定义**，详见 `feature_test_macros(7)`
- 子节：`3const`、`3head`、`3type`，反映 C 标准库的复杂结构
- 设计原则：每个头文件对应一个 API；跨 API 共享的类型/常量应放在不声明函数的头文件中

**intro(3attr) — C/C++ 属性**
- 属性用于修改类型、变量、函数等源码构造的性质
- 标准语法（C23/C++23）：
```c
[[attr]]
[[vendor::attr]]        // 非标准属性需指定 vendor
```
- 编译器专用语法：
```c
__attribute__((attr))   // GNU 语法，GCC/Clang 支持
__declspec(attr)        // MSVC 语法，Clang 支持
```
- 历史：`[[attr]]` 自 C++11/C23；GNU/MSVC 语法更早

**intro(4) — 特殊文件（设备）**
- 描述设备文件，位于 `/dev/*`
- 相关命令：`mknod(1)`、`mknod(2)`

**intro(5) — 文件格式与文件系统**
- 描述文件格式及对应的 C 结构体，并含文件系统文档页

**intro(7) — 概览与杂项**
- 主题概览：约定、协议、字符集标准、标准文件系统布局等

**intro(8) — 管理与特权命令**
- 系统管理员手册，面向管理类及特权命令

## 手册页章节

- 第 8 节：超级用户专用命令（系统管理、守护进程、硬件相关），退出状态表示成败，参见 `intro(1)`。

## intro(1) 用户命令

- 登录启动 shell；可换 shell（`chsh`）；常见：sh、bash、zsh 等。
- 基本命令：

```bash
ls -l   # 长列表：权限/所有者/大小/日期
cat     # 显示文件内容
cp      # 复制
mv      # 重命名
diff    # 比较差异
rm      # 删除（无回收站，不可恢复）
grep    # 搜索字符串
chown/chmod  # 修改所有者和权限
```

- 路径与目录：完整路径以 `/` 开头，相对路径基于当前目录；`pwd` 显示当前；`cd` 改变目录（`.` 当前，`..` 上级，`/` 根，`~` 家）。
- 目录操作：`mkdir` 创建，`rmdir` 删除空目录；`find . -name tel` 按名查找，大范围用 `locate`。
- 磁盘与进程：`mount`/`umount` 挂载/卸载，`df` 查看剩余空间；`ps` 列出进程，`kill` 停止，`kill -9` 强制杀死，Ctrl-C 杀前台。
- 获取信息：`man kill` 查手册，空格翻页，`q` 退出；`info` 程序；HOWTO 在 `/usr/share/doc/howto/en`。

## libc(7) 标准 C 库

- libc 即标准 C 库；glibc 为主流发行版所用。
- glibc 文档：man 第 3 节，`info libc`。
- `/lib/libc.so.6` 符号链接指向 glibc，执行可见版本。
- 历史：Linux libc 曾分支自 glibc 1.x；libc4 用 a.out，libc5 用 ELF（soname `libc.so.5`）；glibc 2.0 后反超，发行版回归；glibc 2.0+ 用 soname `libc.so.6` 以避免混淆。

## Linux libc 与 man-pages
- man-pages 已不再记录 Linux libc 细节，仅残留 libc4/libc5 引用
- 其他 C 库（uClibc、dietlibc、musl libc）更小，适合嵌入式/小型二进制

## math_error(7)
- 数学函数错误检测机制：`errno`（旧）和浮点异常（新）
- 检测步骤：
```c
errno = 0;
feclearexcept(FE_ALL_EXCEPT);
// 调用数学函数
if (errno != 0 || fetestexcept(FE_INVALID | FE_DIVBYZERO | FE_OVERFLOW | FE_UNDERFLOW))
    // 出错
```
- 错误类型：
  - 定义域错误：返回 NaN，`errno=EDOM`，异常 `FE_INVALID`
  - 极点错误：返回 `HUGE_VAL`/`HUGE_VALF`/`HUGE_VALL`，`errno=ERANGE`，异常 `FE_DIVBYZERO`
  - 溢出：同上返回值，`errno=ERANGE`，异常 `FE_OVERFLOW`
  - 下溢：返回 0.0，`errno` 可能为 `ERANGE`，异常可能 `FE_UNDERFLOW`
- 注意：glibc 不支持 `math_errhandling`；建议调用前检查参数；复数函数不适用；gcc 的 `-fno-math-errno` 使 `errno` 不设置，但仍可用 `fetestexcept` 检查

## mq_overview(7)
- POSIX 消息队列：进程间以消息形式交换数据
- 与 System V 消息队列（`msgget`/`msgsnd`/`msgrcv`）类似但 API 不同

- 核心 API：`mq_open()` 创建/打开队列，返回 `mqd_t`；队列名格式 `/somename`（≤255 字符，初始斜杠后不能再含斜杠）。`mq_send()`/`mq_receive()` 收发，按优先级传递（0 ~ `sysconf(_SC_MQ_PRIO_MAX)-1`，Linux 32768）。`mq_close()` 关闭，`mq_unlink()` 删除；`mq_getattr()`/`mq_setattr()` 读写属性，`mq_notify()` 异步通知。`fork()` 后子进程继承描述符。
- 系统调用映射：`mq_close`→`close`；`mq_getattr`/`mq_setattr`→`mq_getsetattr`；`mq_receive`→`mq_timedreceive`；`mq_send`→`mq_timedsend`；其余 `mq_*` 同名。
- 内核/编译：Linux 2.6.6+，glibc 2.3.4+；内核配置 `CONFIG_POSIX_MQUEUE`（默认开启）。队列有内核持久性，不 unlink 则存至关机；基于虚拟文件系统。编译需 `cc -lrt`。
- /proc 调优（`/proc/sys/fs/mqueue/`）：`msg_max` 队列消息数上限，默认 10，硬上限 65536；`msg_default` 默认 `mq_maxmsg`，默认 10；`msgsize_max` 消息大小上限，默认 8192，硬上限 16777216；`msgsize_default` 默认 `mq_msgsize`，默认 8192；`queues_max` 系统队列总数上限，默认 256；`RLIMIT_MSGQUEUE` 限制真实用户 ID 队列总占用。
- 易错：队列名只能有一个前导斜杠；`attr=NULL` 使用 `/proc` 默认值；忘记 `-lrt` 链接失败。

## POSIX 消息队列 (mqueue)

- 挂载：`mount -t mqueue none /dev/mqueue`（目录自动启用 sticky bit）
- 队列文件内容为单行，字段：`QSIZE`（消息数据字节）、`NOTIFY_PID`（非零表示已注册 `mq_notify(3)`）、`NOTIFY`（通知方式：0=`SIGEV_SIGNAL`，1=`SIGEV_NONE`，2=`SIGEV_THREAD`）、`SIGNO`（信号编号）
- Linux 实现：描述符本质为 fd，可被 `select(2)`/`poll(2)`/`epoll(7)` 监视（不可移植）；`mq_open(2)` 返回 fd 自动 close-on-exec
- 对比 System V：设计更好，但可用性不如；Linux 无 ACL
- 已知 BUG：Linux 3.5–3.14 `queues_max` 有 1024 上限；3.5–4.1 `QSIZE` 误计内核开销（4.2 修复）

## 路径解析 (path_resolution)

- **起点**：绝对路径从根目录（可被 `chroot(2)` 改变；`openat2(2)` 加 `RESOLVE_IN_ROOT` 临时改变）；相对路径基于 cwd，可用 `openat(2)` 的 `dfd` 指定（`AT_FDCWD` 表示 cwd）；`clone(2)` 加 `CLONE_NEWNS` 创建私有挂载命名空间
- **遍历非最终组件**：
  - 无搜索权限 → `EACCES`
  - 组件不存在 → `ENOENT`
  - 组件不是目录/符号链接 → `ENOTDIR`
  - 符号链接解析失败或递归过深 → `ENOTDIR` / `ELOOP`

## 路径解析

- 符号链接解析上限：整个路径名最多 40 次；2.6.18 前递归深度 5，2.6.18 起 8，4.2 重写后仅剩总数 40
- 可用 `openat2(2)` + `RESOLVE_NO_SYMLINKS` 阻止符号链接解析
- 最终分量：不要求是目录；不存在不算错误（可能正创建）
- `.` 和 `..` 按约定含义处理，与物理文件系统是否真实存在无关；不能越过根：`/..` = `/`
- 挂载点：挂载后 `path` 指新文件系统根；`path/..` 可走出挂载点；`RESOLVE_NO_XDEV` 阻止遍历挂载点（同时限制 bind mount）
- 尾部 `/`：强制前一分量解析为目录，否则忽略
- 最后符号链接：`lstat(2)` 操作链接本身，`stat(2)` 操作目标
- 路径过长返回 `ENAMETOOLONG`；空路径名返回 `ENOENT`
- 权限检查：三组三位；euid=文件属主用第一组，egid/补充组匹配用第二组，否则第三组
- Linux 用 fsuid/fsgid 代替 euid/egid（`setfsuid(2)`/`setfsgid(2)`，已过时勿用）
- 超级用户权限拆分：`CAP_DAC_OVERRIDE` 覆盖全部权限检查（执行权限需至少一个执行位）；`CAP_DAC_READ_SEARCH` 授予目录读/搜索、普通文件读

## 管道

- pipe 与 FIFO：单向 IPC 通道，分读端/写端
- `pipe(2)` 创建管道，返回两个 fd；FIFO 经 `mkfifo(3)` 命名创建，`open(2)` 打开：读端 `O_RDONLY`、写端 `O_WRONLY`
- FIFO 虽有路径名，但 I/O 不涉及底层设备操作
- 创建/打开后二者 I/O 语义相同：读空管道 `read(2)` 阻塞；写满管道 `write(2)` 阻塞

- 非阻塞 I/O：`fcntl(fd, F_SETFL, O_NONBLOCK)` 或打开 FIFO 时加 `O_NONBLOCK`。
- 无数据且写端存在 → `read()` 返回 `EAGAIN`；写端全关 → 返回 0（EOF）。
- 管道是字节流，无消息边界；不支持 `lseek()`。
- 所有写端关闭后 `read()` 返回 0；所有读端关闭后 `write()` 产生 `SIGPIPE`，忽略则返回 `EPIPE`。`pipe()+fork()` 后须关闭不需要的 fd。
- 容量有限：满时 `write()` 阻塞或失败（依据 `O_NONBLOCK`）。
- 容量：Linux 2.6.11 前 = 页大小；2.6.11 起 = 16 页；2.6.35 起可用 `fcntl()` 的 `F_GETPIPE_SZ`/`F_SETPIPE_SZ` 查询/设置。
- 查询未读字节数：
```c
ioctl(fd, FIONREAD, &nbytes);
```
- `/proc/sys/fs/pipe-max-size`：非特权用户单管道最大字节数，默认 1048576；小于页大小设置返回 `EINVAL`。Linux 4.9 起也是新管道默认上限。
- `/proc/sys/fs/pipe-user-pages-hard`：单用户所有管道总页数硬限制，默认 0（无限制）；超限禁止新建/扩容。
- `/proc/sys/fs/pipe-user-pages-soft`：软限制，默认 16384 页；超限后新管道容量限 2 页，扩容被拒。
- `PIPE_BUF`：Linux 为 4096。
- 写入 `n ≤ PIPE_BUF`：原子。阻塞模式空间不足则等待；非阻塞模式空间不足返回 `EAGAIN`，有空间一次写全。
- 写入 `n > PIPE_BUF`：非原子，可交错。阻塞模式写满 n 字节；非阻塞模式满则 `EAGAIN`，非满可部分写。
- 管道/FIFO 仅支持 `O_NONBLOCK` 与 `O_ASYNC`。
- `O_ASYNC`：读端有新数据时产生 `SIGIO`，用 `fcntl(fd, F_SETOWN, pid)` 指定进程。

POSIX 线程 (pthreads)

- **概念**：单进程可含多线程，共享全局内存（数据段、堆），各线程独立栈。
- **共享属性**：进程/父进程ID、进程组/会话/控制终端、用户/组ID、打开文件描述符、fcntl锁、信号处置、umask、工作目录/根目录、定时器、nice值、资源限制、CPU时间等。
- **每线程独立**：线程ID（`pthread_t`）、信号掩码（`pthread_sigmask`）、`errno`、备选信号栈、实时调度策略/优先级；Linux特有：capabilities、CPU亲和性。
- **返回值**：pthreads 函数成功返回0，失败返回错误号（同 `errno` 含义），但**不设置 `errno`**；不返回 `EINTR`。
- **线程ID**：仅进程内唯一；线程被 join 或 detached 终止后 ID 可复用；使用已结束生命周期的 ID 未定义。
- **线程安全例外**（标准函数多数安全，以下不保证）：`asctime, ctime, localtime, gmtime, strtok, getenv, readdir, rand, dlerror, inet_ntoa` 等；完整列表见 `man 7 pthreads`。
- **异步取消安全函数**：可在启用异步取消（`pthread_setcancelstate`）时安全调用。

## 线程取消

POSIX 规定仅以下函数 **async-cancel-safe**：
```c
pthread_cancel()
pthread_setcancelstate()
pthread_setcanceltype()
```

**取消点**：可取消线程 + 取消类型为 deferred（延迟）+ 有挂起取消请求 → 调用取消点函数时被取消。

**必须取消点**（节选）：`accept() close() connect() open() read() write() pread() pwrite() fsync() msync() nanosleep() pause() select() poll() wait() waitpid() sem_wait() pthread_cond_wait() pthread_join() pthread_testcancel()`

**可能取消点**（节选）：`fopen() fclose() fread() fwrite() printf() scanf() opendir() readdir() getaddrinfo() ioctl() lseek() mkstemp() glob()`；实现还可标记其他可能阻塞的函数。

**易错点**：即使不用异步取消，在异步信号处理器中调用上述函数也可能等效异步取消，破坏用户数据一致性；延迟取消区域慎用信号。

**Linux 编译**：
```sh
cc -pthread
```

**线程实现**：LinuxThreads（旧，glibc 2.4 起不再支持）；NPTL（Native POSIX Threads Library，当前）。

## pty(7) 伪终端

- 一对虚拟字符设备，提供双向通信：**master** 端 + **slave** 端。
- slave 端行为等同经典终端：期望连接终端的进程打开 slave，由打开 master 的程序驱动。
- 写 master → slave 进程如同终端键入；如写中断字符 Ctrl-C 到 master，向前台进程组产生 `SIGINT`。
- 写 slave → master 端进程可读取。

# 伪终端（pty）

- 主从异步流：slave→master 及时但非立即；master→slave 有处理延迟。
- 两套 API：BSD 与 System V；SUSv1 标准化 System V（UNIX 98），新程序应使用；BSD 型自 2.6.4 废弃（可 `CONFIG_LEGACY_PTYS` 禁用）。
- UNIX 98 主从打开流程：
```c
fd = posix_openpt(O_RDWR);
grantpt(fd);
unlockpt(fd);
sfd = open(ptsname(fd));
```
- 数量：`/proc/sys/kernel/pty/max` 动态调整，`nr` 显示当前数。
- BSD 对：`/dev/ptyXY`（主）/`/dev/ttyXY`（从），逐个 open 找空闲。
- 典型：ssh、xterm、script、screen/tmux、expect。
- 易错：Linux 未实现 BSD `TIOCSTOP`/`TIOCSTART`/`TIOCUCNTL`/`TIOCREMOTE`；包模式用 `TIOCPKT`。

# POSIX 信号量

- 计数器永不为负；`sem_post` 加 1；`sem_wait` 减 1，为 0 时阻塞。
- 命名信号量：名 `/somename`，≤251 字符，首字符 `/` 且其余不含 `/`；API：`sem_open`/`sem_post`/`sem_wait`/`sem_close`/`sem_unlink`。
- 未命名：须在共享内存；线程共享用全局变量，进程共享用 `shmget`/`shm_open` 区；`sem_init`/`sem_destroy`。
- 持久性：命名信号量除非 `sem_unlink`，否则存在至系统关机。
- 链接：`cc -pthread`。

### POSIX 信号量
- 命名信号量存于 `/dev/shm`，名称格式 `sem.`+名称，长度上限 `NAME_MAX-4`。
- 核心 API：`sem_open()`、`sem_wait()`、`sem_post()`、`sem_close()`、`sem_unlink()`。
- Linux 2.6.19+ 支持 ACL；相比 System V 接口更简单，旧系统支持度低。

### POSIX 共享内存
```c
fd = shm_open(name, flags, mode);
ftruncate(fd, size);
addr = mmap(NULL, size, PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0);
// 访问共享内存
munmap(addr, size);
shm_unlink(name);
```
- 辅助接口：`fstat()`（获取 `st_size`/`st_mode`/`st_uid`/`st_gid`）、`fchown()`、`fchmod()`。
- 对象存于 `/dev/shm`（tmpfs）；内核持久，需 `shm_unlink()` 且所有进程 unmap 后才消失。
- 编译链接：`cc -lrt prog.c`；常需配合 POSIX 信号量同步。

### 信号
- 分标准与实时信号；用 `sigaction()`/`signal()` 修改处置，可用 `sigaltstack()` 设备用栈。
- 默认动作：`Term` 终止、`Ign` 忽略、`Core` 终止并转储、`Stop` 停止、`Cont` 继续。
- 处置是进程属性：多线程共享；`fork()` 继承，`execve()` 后捕获的信号重置为默认，忽略的信号保持不变。
- 发送：`raise()`（调用线程）、`kill()`（进程/进程组/全体）、`killpg()`（进程组）、`pidfd_send_signal()`（PID 文件描述符）。

### 信号发送
- `pthread_kill(3)`：向同进程指定线程发信号；`tgkill(2)` 是其系统调用实现
- `sigqueue(3)`：向进程发送实时信号并附带数据

### 等待信号
- `pause(2)`：挂起直到捕获任意信号
- `sigsuspend(2)`：临时改变掩码并挂起，直到未屏蔽信号被捕获

### 同步接收
- `sigwaitinfo(2)` / `sigtimedwait(2)` / `sigwait(3)`：挂起直到指定信号集有信号
- `signalfd(2)`：返回 fd，`read(2)` 阻塞直到信号送达

### 掩码与 pending
- 信号被阻塞则不投递，生成到投递间为 **pending**
- 线程独立掩码：`pthread_sigmask(3)`；单线程可用 `sigprocmask(2)`
- `fork(2)` 继承掩码，pending 清空；`execve(2)` 保留掩码与 pending
- 进程定向信号（`kill`/`sigqueue`）投递给任一未阻塞线程；线程定向信号（硬件异常、`tgkill`/`pthread_kill`）投递给指定线程
- `sigpending(2)` 获取当前线程 pending 集

### handler 执行
- 内核→用户态转换时检查未阻塞 pending
1. 从 pending 集移除该信号
2. 若 `SA_ONSTACK` 且已定义备选栈，则切换（`sigaltstack(2)`）
3. 保存上下文（PC、寄存器、掩码、备选栈设置）；`SA_SIGINFO` 时 handler 第三参为 `ucontext_t`
4. `sa_mask` 与当前信号加入掩码（除非 `SA_NODEFER`），执行期间阻塞
5. 返回地址指向 trampoline，handler 返回后 `sigreturn(2)` 恢复状态

### Linux socket(7) 核心知识点

- socket 是用户进程与内核网络协议栈的统一接口。
- 协议族：`AF_INET` 等；类型：`SOCK_STREAM`、`SOCK_DGRAM`。
- 创建套接字：

```c
#include <sys/socket.h>
sockfd = socket(int socket_family, int socket_type, int protocol);
```

- 核心系统调用：`connect`/`bind`/`listen`/`accept`；收发 `send`/`recv`（UDP 用 `sendto`/`recvfrom`），也可用 `read`/`write`；等待 `poll`/`select`；选项 `getsockopt`/`setsockopt`；关闭 `close`/`shutdown`。
- 套接字**不支持** `seek`、`pread`、`pwrite`。
- 非阻塞 I/O：`fcntl` 设置 `O_NONBLOCK`；阻塞操作返回 `EAGAIN`；`connect` 返回 `EINPROGRESS`，用 `poll`/`select` 等待。
- poll 事件：`POLLIN`（数据或连接完成）、`POLLOUT`（可写）、`POLLHUP`（对端断开，写可能触发 `SIGPIPE`）、`POLLERR`（异步错误）。
- 地址结构：各结构以 `sa_family_t` 开头；`struct sockaddr` 仅作通用类型转换；通用存储用 `struct sockaddr_storage`（足够大且对齐，可容纳 IPv6）。
- 通用选项：`level=SOL_SOCKET`，`optval` 指向 `int`。

- **SO_ACCEPTCONN**：只读；1=已监听，0=未监听。

- **SO_ATTACH_FILTER / SO_ATTACH_BPF**：附加 BPF 过滤器；返回值：0 丢包，<包长截断，≥包长放行。`SO_ATTACH_FILTER` 用 `struct sock_fprog`；`SO_ATTACH_BPF` 用 `bpf()` fd，程序类型须为 `BPF_PROG_TYPE_SOCKET_FILTER`。多次设置后替前，同 socket 仅一个过滤器。

- **SO_ATTACH_REUSEPORT_CBPF/EBPF**：配合 `SO_REUSEPORT` 自定义选 socket。CBPF/EBPF 返回索引 0~N-1，非法回退默认；EBPF `BPF_PROG_TYPE_SK_REUSEPORT`（4.19+）返回 `SK_PASS`/`SK_DROP`，可用 `bpf_sk_select_reuseport`。新 socket 继承，移除补位，可替换；UDP 4.5+、TCP 4.6+。

- **SO_BINDTODEVICE**：绑定接口（如 `eth0`）；空串/optlen=0 解绑，名限 `IFNAMSIZ`。仅处理该接口包；不支持 packet socket（用 `bind(2)`）。3.8 前仅可设置；读取 optlen 建议 `IFNAMSIZ`。

- **SO_BROADCAST**：允许数据报 socket 广播地址；对流 socket 无效。

`standards(7)` 列出 man 手册 STANDARDS 部分引用的标准：

- **Unix 分支**：`V7`（1979）为分水岭，后分化为 BSD 与 System V。BSD：`4.2BSD`（1983，TCP/IP + sockets）、`4.3BSD`（1986）、`4.4BSD`（1993）。System V：`System III`（1981）、`SVr1`（1983）、`SVr2`（1985，SVID 1）、`SVr3`（1986，SVID 2）、`SVr4`（1989，SVID 3，权威版）、`SVID 4`（1995）；内部版 `Unix/TS 4` 未公开。
- **C 标准**：`K&R`（1978）；`C89`（ANSI X3.159-1989，ISO 版 `C90`）；`C94`/`C95`/`C96` 为 C90 修订，`C95` 增加国际字符集；`C99`、`C11`、`C17`、`C23`。
- **POSIX**：`POSIX.1-1988`（IEEE 1003.1，首个 POSIX，术语由 Stallman 创造）；`POSIX.1-1990`（ISO 9945-1）；`POSIX.2`（命令与工具，1992/1993）；`POSIX.1b`（实时扩展，原 POSIX.4）；`POSIX.1c`（线程接口，原 POSIX.4a）。
- **易错**：`C89` 勿简称 ANSI C；`POSIX.1-1988` 年份勿误写 1998。

## 标准演进
- POSIX.1d（1999）：实时扩展；POSIX.1g（2000）：网络 API；POSIX.1j（2000）：高级实时扩展
- POSIX.1-1996：合并 POSIX.1b/1c；ISO/IEC 9945-1:1996
- XPG3（1989）：首个基于 POSIX.1-1988 的 X/Open 指南；XPG4（1992）：并入 POSIX.2
- XPG4v2（1994）：即 Spec 1170（1170 接口）
- SUSv1：XPG4v2 + X/Open Curses + XNS；符合系统标识为 UNIX 95
- SUSv2（Issue 5, 1997）：标识为 UNIX 98
- POSIX.1-2001/SUSv3：Austin Group 合并 POSIX.1/2/SUS 为单文档；对齐 C99

## POSIX.1-2001 四部分
- XBD：定义、术语、头文件
- XSH：函数规范（系统调用/库函数）
- XCU：命令与工具（原 POSIX.2）
- XRAT：说明性文本

## 符合级别
- POSIX conformance：基线接口集
- XSI Conformance：额外强制 XSI 扩展，标识为 UNIX 03
- SUSv3 = Base Specifications（XBD/XSH/XCU/XRAT）+ X/Open Curses Issue 4 v2

## 修订版
- POSIX.1-2002：Cor1（IEEE 1003.1-2001/Cor1-2002）
- POSIX.1-2004：Cor2
- POSIX.1-2008/SUSv4：新增接口并修订细节，变化小于 2001 版

## 符号链接 (symlink)

- 硬链接共享同一 inode，无法区分；不能指向目录、不能跨文件系统。
- 符号链接存路径字符串，有自身 inode；可指向目录、跨文件系统；悬空链接指向不存在路径。

### 魔术链接

- 位于伪文件系统（`/proc/*/exe`、`/proc/*/fd/*`）；不按路径解析，直接引用内核句柄；可访问已 unlink 但仍被进程引用的文件，可绕过 mount namespace。

### 属主/权限/时间戳

- 属主用 `lchown(2)`；时间戳用 `utimensat(2)`/`lutimes(3)`。
- 普通链接权限恒为 0777，Linux 不参与操作；魔术链接可有非 0777。

### 获取链接自身 fd

```c
fd = open(path, O_PATH | O_NOFOLLOW);
```

- 该 fd 可作 `fstatat`、`fchownat`、`fchmodat`、`linkat`、`readlinkat` 的 dirfd。
- `name_to_handle_at` 默认返回链接自身 handle；`open_by_handle_at` 加 `O_PATH` 得链接自身 fd。

### 路径处理

路径 `a/b/c`：`a/b` 为 dirname，`c` 为 basename。

- dirname 组件：几乎都跟随链接；唯一例外 `openat2(2)` 可阻止。
- basename 组件：默认跟随；如 `open("slink")` 返回目标 fd。
- 链式解析直至非链接/不存在/循环（上限限制）。
- 易错：跟随与否取决于组件位置和标志；`O_PATH|O_NOFOLLOW` 是操作链接自身关键。

## 符号链接处理：系统调用与命令

### 系统调用

**不跟随 basename 符号链接（操作链接本身）**：
`lchown(2)`、`lgetxattr(2)`、`llistxattr(2)`、`lremovexattr(2)`、`lsetxattr(2)`、`lstat(2)`、`readlink(2)`、`rename(2)`、`rmdir(2)`、`unlink(2)`

- `remove(3)` 是 `unlink(2)` 别名，同样不跟随
- `rmdir(2)` 作用于符号链接时失败，错误为 `ENOTDIR`

**可选跟随**：`faccessat(2)`、`fchownat(2)`、`fstatat(2)`、`linkat(2)`、`name_to_handle_at(2)`、`open(2)`、`openat(2)`、`open_by_handle_at(2)`、`utimensat(2)`

**`link(2)` 特例**：POSIX.1-2001 要求解引用 `oldpath`，Linux 不执行；POSIX.1-2008 允许任一行为。

### 命令行为

**非遍历命令**：默认跟随参数中的符号链接（`cat slink` 显示目标文件内容）。`-h` 操作链接本身：

```bash
chown root slink     # 修改目标文件属主
chown -h root slink  # 修改符号链接本身属主
```

**例外**：
- `mv`、`rm`：不跟随，直接重命名/删除链接（相对路径链接移动后可能失效）
- `ls`：指定 `-H`/`-L` 时跟随；未指定 `-F`/`-d`/`-l` 时也跟随
- `file`：默认不跟随，指定 `-L` 才跟随

**遍历文件树的命令**：`chgrp`、`chmod`、`chown`、`cp`、`du`、`find`、`ls`、`pax`、`rm`、`tar`

## syscall(2) — 间接系统调用

**用途**：当 C 库无对应 wrapper 时，按编号直接发起系统调用。

**头文件与原型**：
```c
#include <sys/syscall.h>   /* SYS_* 常量 */
#include <unistd.h>
long syscall(long number, ...);
```

**返回值**：0 成功；-1 失败，错误码存入 errno。

**错误**：`ENOSYS` 表示该系统调用号未实现；其余错误由被调用的系统调用定义。

**核心要点**：

- 系统调用号常量定义于 `<sys/syscall.h>`。
- 各架构 ABI 对参数传递要求不同；32 位架构上，64 位参数（如 `long long`）必须按偶数寄存器对对齐，使用 syscall() 时需手动拆分。
- ARM EABI 小端模式调用 readahead 示例（offset 为 64 位，需插入哑元对齐 r2/r3 寄存器对）：
```c
syscall(SYS_readahead, fd, 0,
        (unsigned int)(offset & 0xFFFFFFFF),
        (unsigned int)(offset >> 32),
        count);
```
- 受影响系统调用：`fadvise64_64`、`ftruncate64`、`posix_fadvise`、`pread64`、`pwrite64`、`readahead`、`sync_file_range`、`truncate64`。
- 同样问题存在于 MIPS O32、PowerPC/parisc 32-bit、Xtensa；parisc 通过 shim 层对用户空间隐藏了该问题。
- 各架构调用约定不同（陷入内核指令、系统调用号寄存器、返回/错误寄存器）；x32 ABI 与 x86-64 共享调用表，但需将 `__X32_SYSCALL_BIT` 按位或入系统调用号。

### x32 ABI 系统调用差异
- x32 中 `long` 与指针大小不同，部分结构体布局改变（如 `struct timeval`/`struct rlimit` 仍为 64 位）
- 额外系统调用从编号 512 开始（不带 `__X32_SYSCALL_BIT`）
- 例：`__NR_readv` 在 x86-64 为 19，在 x32 为 `__X32_SYSCALL_BIT | 515`
- 多数与 i386 compat 相同；例外如 `preadv2`：用 `compat_iovec`（4 字节指针/长度），但 8 字节 `pos` 用单寄存器传递

### 第二返回值寄存器
- 用于 `pipe(2)`；涉及 Alpha、IA-64、MIPS、SuperH、sparc/32、sparc/64
- Alpha 还用于 `getxpid`、`getxuid`、`getxgid`
- 其他架构即使 ABI 定义也不使用

### 参数寄存器（部分）
- x86-64/x32：`rdi, rsi, rdx, r10, r8, r9`
- i386：`ebx, ecx, edx, esi, edi, ebp`
- arm64：`x0..x5`
- mips/o32：`a0..a3`；参数 5-8 经用户栈传递
- 表未覆盖全部约定，某些架构可能随意 clobber 其他寄存器

### 示例
```c
#define _GNU_SOURCE
#include <signal.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

int main(void) {
    pid_t tid;
    tid = syscall(SYS_gettid);
    syscall(SYS_tgkill, getpid(), tid, SIGHUP);
}
```

```markdown
- `_syscall(2)`：在无库支持时直接调用系统调用的宏，**已废弃**（Linux 2.6.18 起从用户空间头文件移除），改用 `syscall(2)`；ia64 等架构从未提供。

- 宏形式：
  - `_syscallX(type, name, type1, arg1, type2, arg2, ...)`
  - `X` = 0–6，表示系统调用参数个数
  - `type`：返回值类型；`name`：系统调用名；`typeN/argN`：第 N 个参数的类型/名称
  - 使用前需 `#include <linux/unistd.h>`

- 返回值语义：
  - 系统调用返回非负 `r` → 宏返回 `r`
  - 返回负值 → 宏返回 `-1`，并置 `errno = -r`
  - 错误码见 `errno(3)`

- 关键注意：
  - 宏**不生成函数原型**，C++ 用户需手动声明
  - 参数必须按值或按指针传递（结构体等聚合类型用指针）
  - 不能假定返回值只表示正/负错误，需查源码确认

- 替代：始终优先使用 `syscall(2)`。

- 示例（获取系统信息）：
```c
#include <linux/unistd.h>
#include <linux/kernel.h>
_syscall1(int, sysinfo, struct sysinfo *, info);

struct sysinfo s_info;
int error = sysinfo(&s_info);
```
```

- **系统调用**：应用程序与 Linux 内核之间的基本接口，见 `syscalls(2)`。
- 系统调用一般不直接调用，而是通过 glibc 等库的**包装函数（wrapper）**间接调用，如 glibc 的 `chdir()` 包装底层 `chdir` 系统调用。
- 包装函数典型流程：
  1. 将参数复制到正确的寄存器；
  2. 发起系统调用；
  3. 内核失败时返回**负错误号**；包装函数将其取反（转正）存入 `errno`，并向调用者返回 `-1`。

```c
// 失败路径：内核返回负值 → 包装函数处理
if (ret < 0) {
    errno = -ret;
    return -1;
}
```

- 部分包装函数有额外逻辑：如 `truncate()` 会先检测内核支持 `truncate` 还是 `truncate64`，再决定调用哪个。
- 无包装函数的系统调用可用 `syscall(2)` 直接发起；直接调用细节见 `intro(2)`。

**系统调用列表的内核版本列约定：**
- 未标版本：Linux 1.0 或更早已有。
- 标 "1.2"/"2.0"/"2.2"/"2.4"/"2.6"：先出现于相应不稳定系列（1.1.x/1.3.x/2.1.x/2.3.x/2.5.x），再进入所列稳定版。
- Linux 2.6.0 后采用新开发模型，标注**精确版本号**；3.x/4.x/5.x/6.x 沿用此约定。
- 若系统调用被 backport 到较早稳定系列，则同时列出两个系列中的出现版本。

## 系统调用表（内核版本速查）

用于兼容性判断。

- **1.0**：`fork`/`execve`/`exit`/`open`/`close`/`read`/`write`/`brk`/`fcntl`
- **2.0**：socket 系列（`accept`/`bind`/`connect` 等）、`getdents`
- **2.6**：`epoll_*`、`futex`、`eventfd`、`timerfd`
- **3.x**：`bpf`(3.18)、`getrandom`(3.17)、`finit_module`(3.8)
- **5.x**：`clone3`(5.3)、`fsopen`/`fsmount`/`fsconfig`/`fspick`(5.2)、`close_range`(5.9)、`faccessat2`(5.8)

**已移除/废弃**：`_sysctl`(5.5 移除)、`bdflush`(2.6 废弃、5.15 移除)、`create_module`/`get_kernel_syms`(2.6 移除)、`alloc_hugepages`/`free_hugepages`(2.5.44 移除)

**架构专属**：`arch_prctl`(x86_64)、`atomic_*`(m68k)、`clone2`(IA-64)、`cacheflush`(非 x86)、ARM OABI 的 `get_tls`/`breakpoint`(`__ARM_NR` 前缀)

**易错点**：
- 2.0 早期 socket 调用经 `socketcall(2)` 分发，新架构为直接系统调用
- 同名新版：`dup2`→`dup3`(2.6.27)；`epoll_create`→`epoll_create1`(2.6.27)
- 带 `32`/`64` 后缀（`chown32`/`fstat64`/`fcntl64`/`getgid32`）为 32 位进程/大文件兼容

## system_data_types(7) 系统数据类型

- **siginfo_t（信号信息结构）**
  - 头文件：`<signal.h>`（或 `<sys/wait.h>`）
  - 描述信号附带信息；核心成员：`si_signo`、`si_code`、`si_pid`、`si_uid`、`si_addr`、`si_status`、`si_value`；详见 `sigaction(2)`。
- **sigset_t（信号集类型）**
  - 头文件：`<signal.h>`（或 `<spawn.h>`、`<sys/select.h>`）
  - 表示一组信号，POSIX 下为整数或结构体。
- **易错点：无长度修饰符的整数类型**
  - 多数整数类型没有对应的 `printf(3)`/`scanf(3)` 长度修饰符。
  - 打印：先转为 `intmax_t`/`uintmax_t`，用 `%jd` 等格式。
  - 读取：先读入 `intmax_t`/`uintmax_t` 临时变量，**拷贝前检查值是否在目标类型范围内**，防止溢出。

```c
suseconds_t us;
intmax_t tmp;

sscanf(str, "%jd", &tmp);
if (tmp < -1 || tmp > 1000000)
    exit(EXIT_FAILURE);
us = (suseconds_t) tmp;
printf("%jd", (intmax_t) us);
```

- **其他**：本页仅涉及 C99 及 POSIX.1-2001 以后的标准；结构体成员顺序不固定。

System V IPC：UNIX 上三种进程间通信机制的总称。

## 消息队列（Message queues）
- 按“消息”为单位交换数据，每条消息可带优先级。
- 替代 API：POSIX 消息队列（`mq_overview(7)`）。
- 系统调用：
  - `msgget(2)`：创建新队列或获取已有队列 ID
  - `msgsnd(2)`：向队列添加消息
  - `msgrcv(2)`：从队列取出消息
  - `msgctl(2)`：控制操作（含删除）

## 信号量集（Semaphore sets）
- 以“集合”为单位分配，每个信号量为计数信号量。
- 替代 API：POSIX 信号量（`sem_overview(7)`）。
- 系统调用：
  - `semget(2)`：创建新集合或获取已有集合 ID
  - `semop(2)`：对集合内信号量执行操作
  - `semctl(2)`：控制操作（含删除）

## 共享内存段（Shared memory segments）
- 多个进程共享同一内存区域。
- 替代 API：POSIX 共享内存（`shm_overview(7)`）。
- 系统调用：
  - `shmget(2)`：创建新段或获取已有段 ID
  - `shmat(2)`：将段附加到调用进程地址空间
  - `shmdt(2)`：从进程地址空间分离段
  - `shmctl(2)`：控制操作（含删除）

## 相关
- IPC 命名空间交互：`ipc_namespaces(7)`
- 常用命令：`ipcmk(1)`、`ipcrm(1)`、`ipcs(1)`、`lsipc(1)`
- 键生成：`ftok(3)`

- 时间分类：实时时间（固定点起）；进程时间（CPU 时间，分用户/系统态）。查看 `time(1)`；接口 `times(2)`、`getrusage(2)`、`clock(3)`。
- 硬件时钟：电池供电，内核启动时读取；`hwclock(8)`。
- 软件时钟：内核维护，以 jiffy 为单位，受 `HZ` 限制。Linux ≤2.4.x：`HZ=100`；2.6.0 起：`HZ=1000`；≥2.6.13：100/250(默认)/1000；≥2.6.20 增 300。`times(2)` 粒度由 `USER_HZ` 决定，用户空间用 `sysconf(_SC_CLK_TCK)` 获取。
- 时钟类型：见 `clock_gettime(2)`，部分可 `clock_settime(2)`；时间命名空间见 `time_namespaces(7)`。
- HRT：≥2.6.21 支持（`CONFIG_HIGH_RES_TIMERS`），睡眠/定时器精度不受 jiffy 限制，可达微秒级。检查：`clock_getres(2)`、`cat /proc/timer_list`。
- Epoch：`1970-01-01 00:00:00 +0000 (UTC)`。日历时间用 `CLOCK_REALTIME`（秒+纳秒），`time(2)` 仅秒级。
- 分解时间：`tm` 结构体；转换函数 `ctime(3)`、`strftime(3)`、`strptime(3)`。
- 睡眠/定时器：`nanosleep(2)`、`clock_nanosleep(2)`、`sleep(3)`；`alarm(2)`、`getitimer(2)`、`timerfd_create(2)`、`timer_create(2)`。
- Timer slack（≥2.6.28）：允许延迟唤醒以合并事件、省电；`prctl(2)` 的 `PR_SET_TIMERSLACK` 控制。

---
来源：consolidated/cmd-tools/Linux man 手册精选.md