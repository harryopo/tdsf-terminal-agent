---
source: ssh-docs
category: net-remote
url: consolidated/net-remote/终端与 Shell 工具手册.md
title: 终端与 Shell 工具手册
---

- 文件：`cat` 显示/连接，`chroot` 切根（需 root），`fsync` 落盘，`glob` 通配
- 环境：`environ` 变量，`sh` Shell
- 网络：`nc -z` 扫描
- 日志：`syslog`
- 其他：`/dev/null` 丢弃，fd `0/1/2` 重定向

- `cat` 顺序读取文件并输出到标准输出；文件参数为 `-` 或缺省时从标准输入读取。
- 选项：
  - `-b`：给非空行编号
  - `-e`：行尾显示 `$`，隐含 `-v`
  - `-n`：从 1 开始给所有输出行编号
  - `-s`：压缩连续空行为单空行
  - `-t`：Tab 显示为 `^I`，隐含 `-v`
  - `-u`：保证输出无缓冲
  - `-v`：显示非打印字符：控制字符显示为 `^X`，DEL 显示为 `^?`，非 ASCII 显示为 `M-x`
- 退出状态：成功为 0，出错为 >0
- 常用示例：
  ```sh
  cat file1                 # 打印 file1
  cat file1 file2 > file3   # 合并 file1、file2 到 file3（截断）
  cat file1 - file2 - file3 # '-' 处读 stdin，直到 EOF（^D）
  ```
- 易错点：`cat file1 file2 > file1` 会先截断 file1 导致数据丢失；追加应用 `cat file2 >> file1`。
- 兼容 POSIX.1；`-benstv` 为 OpenBSD 扩展。

`chroot(2)` — 改变根目录，仅限超级用户调用。

**语法**
```c
#include <unistd.h>
int chroot(const char *dirname);
```

**核心要点**
- 使 `dirname` 成为进程根目录，作为 `/` 开头路径的搜索起点
- 进程必须对目标目录具有执行（搜索）权限
- 若进程此前未处于改根状态，当前工作目录不变；若已改根，当前目录会被设为新根目录，防止当前目录位于新根之外
- 仅超级用户可调用

**返回值**
- 成功返回 0；失败返回 -1，并设置 `errno`

**典型用法（改根 + 切目录 + 降权）**
```c
if (chroot(newroot) != 0 || chdir("/") != 0)
	err(1, "%s", newroot);
setresuid(getuid(), getuid(), getuid());
```

**主要错误**
- `ENOTDIR`：路径组件不是目录
- `ENOENT`：目录不存在
- `EACCES`：路径组件无搜索权限
- `ELOOP`：符号链接过多
- `EPERM`：调用者非超级用户
- `ENAMETOOLONG`：路径名超长
- `EFAULT`：`dirname` 越界
- `EIO`：文件系统 I/O 错误

**易错点（Caveats）**
- root 进程可逃出 chroot jail
- 从 jail 外部修改目录层次，或经 `recvmsg(2)` 传入目录文件描述符，均可能导致受限进程逃逸

- 环境变量由 `execve(2)` 在进程启动时提供，形式为 `name=value`。
- 常用变量：
  - `BLOCKSIZE`：df/du/ls 块大小；数字=字节，`K`/`M`/`G` 为 KB/MB/GB；<512B 或 >1GB 忽略。
  - `HOME`：登录目录。
  - `LOGNAME`：登录名。
  - `PATH`：冒号分隔搜索目录；OpenBSD 默认含 `/usr/bin:/bin:/usr/sbin:/sbin:/usr/X11R6/bin:/usr/local/bin:/usr/local/sbin`。
  - `PRINTER`：默认打印机（lpq/lpr/lprm）。
  - `PWD`：当前工作目录。
  - `SHELL`：登录 shell 完整路径。
  - `TERM`：终端类型；列表见 `/usr/share/misc/termcap`。
  - `TERMCAP`：描述 `TERM` 的字符串，或以 `/` 开头表示 termcap 文件路径。
  - `TERMPATH`：冒号/空格分隔 termcap 路径序列；默认 `$HOME/.termcap:/etc/termcap`；若 `TERMCAP` 含完整路径则忽略。
  - `TMPDIR`：临时文件目录，默认 `/tmp` 或 `/var/tmp`。
  - `TZ`：时区，相对 `/usr/share/zoneinfo`；例：`env TZ=America/Los_Angeles date`。
  - `USER`：`LOGNAME` 的废弃同义词。
  - `EXINIT`：ex/vi 启动命令列表。
- 设置：sh/ksh 用 `export` 或 `name=value`；csh 用 `setenv`。
- 易错：勿随意改 `.profile` 中导出的 `MAIL`、`PS1`、`PS2`、`IFS`。
- 查看：`env`、`printenv`。

- `/dev/fd/#` 通过文件系统访问文件描述符；`/dev/stdin`、`/dev/stdout`、`/dev/stderr` 分别对应 0、1、2。
- 若打开模式是已有描述符模式的子集，则：
  ```c
  open("/dev/fd/0", mode);          // 等价于
  fcntl(0, F_DUPFD, 0);
  ```
- 打开 `/dev/stdin`、`/dev/stdout`、`/dev/stderr` 等价于：
  ```c
  fcntl(STDIN_FILENO,  F_DUPFD, 0);
  fcntl(STDOUT_FILENO, F_DUPFD, 0);
  fcntl(STDERR_FILENO, F_DUPFD, 0);
  ```
- `open()` 中除 `O_RDONLY`、`O_WRONLY`、`O_RDWR` 外的标志被忽略。
- setuid/setgid 导致的 tainted 进程无法打开这些设备，返回 `EPERM`。

```markdown
**函数原型**：
```c
#include <unistd.h>

int fsync(int fd);
int fdatasync(int fd);
```

**作用**：
- `fsync()`：将所有已修改的数据和文件属性写入永久存储设备。
- `fdatasync()`：仅保证数据和读取所需元数据落盘，其他修改可不同步。

**适用场景**：需要文件处于已知状态，如构建简单事务功能。

**返回值**：成功返回 `0`；失败返回 `-1` 并设置 `errno`。

**错误码**：
| 错误 | 含义 |
|------|------|
| `EBADF` | `fd` 不是有效描述符 |
| `EINVAL` | `fd` 指向的文件无法同步 |
| `EIO` | 读写文件系统时发生 I/O 错误 |

**易错点**：
- 若返回 `EIO`，盘上数据可能仅部分写入；后续调用将持续失败，直到所有引用该文件的描述符关闭。

**实现差异**：OpenBSD 中 `fdatasync()` 是 `fsync()` 的包装，实际同步的状态多于标准要求。

**标准**：IEEE Std 1003.1-2008（POSIX.1）。
```

- `#include <glob.h>`，`int glob(const char *pattern, int flags, int (*errfunc)(const char *, int), glob_t *pglob);`，`void globfree(glob_t *pglob);`
- `glob_t` 关键字段：`gl_pathc`（匹配总数）、`gl_matchc`（本次匹配数）、`gl_offs`（预留 NULL 数）、`gl_pathv`（结果数组，末尾 NULL）
- 按 shell 通配符（`*`/`?`/`[]`）展开；需对路径各级有搜索权限；默认 ASCII 排序；无匹配时 `gl_pathc=0`；`pglob` 内部空间由 `glob()` 分配，`globfree()` 释放
- flags（按位或）：
  - `GLOB_ERR`：遇不可读目录立即返回
  - `GLOB_MARK`：目录加 `/`
  - `GLOB_NOCHECK`：无匹配返回 pattern 本身（`gl_pathc=1`, `gl_matchc=0`）
  - `GLOB_NOESCAPE`：`\` 不转义（默认 `\x`→`x`）
  - `GLOB_NOSORT`：不排序
  - `GLOB_DOOFFS`：结果前留 `gl_offs` 个 NULL
  - `GLOB_APPEND`：追加上次结果；期间不得改 `gl_offs`/`GLOB_DOOFFS`，不得 `globfree`
  - `GLOB_BRACE`：展开 `{a,b}`；`GLOB_TILDE`：展开 `~`
  - `GLOB_LIMIT`：限制内存/stat/readdir 次数
- 成功返回 0；失败 `GLOB_ABORTED`
- 易错点：`errfunc` 可能因非目录路径被调（如 `*/Makefile` 对 `foo/Makefile` stat 得 `ENOENT`），可据此抑制；但 `GLOB_ERR` 仍立即返回。`GLOB_APPEND` 是追加，非合并

## glob() 核心要点

### 输出结构（glob_t）

- `gl_flags`：含 `GLOB_MAGCHAR` 位表示 pattern 含特殊字符 `*`、`?`、`[`
- `gl_pathv`：匹配路径名的 null 结尾列表；`gl_pathc` 为 0 时内容未定义
- `gl_statv`：设置 `GLOB_KEEPSTAT` 时，对应路径的 `stat(2)` 对象列表

### 错误码（<glob.h>）

- `GLOB_NOSPACE`：内存分配失败；或设 `GLOB_LIMIT` 且匹配 ≥ `ARG_MAX` 个 pattern
- `GLOB_ABORTED`：扫描因错误停止（`GLOB_ERR` 已设或 `errfunc` 返回非零）
- `GLOB_NOMATCH`：无匹配且未设 `GLOB_NOCHECK`
- `GLOB_NOSYS`：当前版本不支持

### 示例（等价 `ls -l *.c *.h`）

```c
glob_t g;
g.gl_offs = 2;
glob("*.c", GLOB_DOOFFS, NULL, &g);
glob("*.h", GLOB_DOOFFS | GLOB_APPEND, NULL, &g);
g.gl_pathv[0] = "ls";
g.gl_pathv[1] = "-l";
execvp("ls", g.gl_pathv);
```

### 易错点

- 可能因 `stat`/`opendir`/`readdir`/`malloc` 等错误失败
- 严格 POSIX.2/XPG4.2 下勿用 `GLOB_ALTDIRFUNC`、`GLOB_BRACE`、`GLOB_KEEPSTAT`、`GLOB_MAGCHAR`、`GLOB_NOMAGIC`、`GLOB_QUOTE`、`GLOB_TILDE`、`GLOB_LIMIT` 及 `gl_matchc`/`gl_statv`/`gl_flags`
- `LC_COLLATE` 影响排序
- 超过 `PATH_MAX` 的 pattern 可能产生未检查错误

## glob(7) — shell 风格模式匹配

**用途**：csh/ksh/sh 及 C 库 `fnmatch(3)`/`glob(3)` 中的路径名与参数匹配。**与正则表达式不同**，特殊字符含义有区别。

### 通配符

| 模式 | 含义 |
|---|---|
| `?` | 匹配任意单个字符 |
| `*` | 匹配零个或多个字符的任意序列 |
| `[..]` | 匹配括号内任一字符 |
| `[!..]` | 匹配不在括号内的任一字符 |
| `\` | 转义后续字符，使其失去特殊含义 |

### 括号表达式要点

- 范围用 `-` 分隔，如 `[a0-9]` 匹配 `a` 或任意数字
- 字面量 `-`：须转义，或置于列表首/尾
- 字面量 `]`：须转义，或置于列表首位
- 字面量 `!`：须转义，或置于非首位（因开头 `!` 表示取反）
- 字符类：`[:name:]` 形式，支持 `alnum`、`alpha`、`blank`、`cntrl`、`digit`、`graph`、`lower`、`print`、`punct`、`space`、`upper`、`xdigit`（对应 `isalnum(3)` 等宏）
- **字符类不能作为范围的端点**

### 关键规则：路径分隔符

匹配路径名时，`/` **不会被** `?`、`*` 或 `[..]` 匹配：

```sh
/usr/*/*/X11      # 匹配 /usr/X11R6/lib/X11
/usr/*/X11        # 不匹配上述路径
/usr/*/bin        # 匹配 /usr/local/bin，不匹配 /usr/bin
```

### 易错点

1. 通配符必须**不带引号**才生效；用 `\` 转义 `?`、`*`、`[`、`\` 本身
2. glob 与 grep 正则中的 `*`、`[..]` 语义不同，勿混淆

# login.conf(5) 核心知识点

`login.conf` 是登录类能力数据库，定义认证方式、会话资源限制、环境设置，供 `login(1)`、`ftpd(8)` 等使用。

- 无有效类的用户使用 `default` 记录。
- `/etc/login.conf.d/${class}` 存在时覆盖 `/etc/login.conf` 中同名类。
- 构建数据库版：

```sh
# cap_mkdb /etc/login.conf
```

每次编辑后必须重跑以同步。

## 常用能力

- `auth`：允许的认证风格列表，第一项为默认。
- `localcipher`：密码加密算法，默认 `bcrypt,a`。
- `minpasswordlen`：最小密码长度，默认 6；≤0 不限制。
- `passwordtime`：密码有效期；`password-warn` 过期前警告；`password-dead` 过期后宽限登录。
- `setenv`：设置环境变量；`path` 默认搜索路径；`umask` 默认 `022`，必须前导 `0` 按八进制解释。
- 资源限制：`cputime`、`filesize`、`datasize`、`stacksize`、`coredumpsize`、`memoryuse`、`memorylocked`、`maxproc`、`openfiles`，可加 `-max`/`-cur` 区分最大/当前限制（如 `openfiles-max`）。
- `tc`：继承其他登录类记录。

## 能力值类型

- `envlist`：逗号分隔 `var=value`；`~` 在尾部或后随 `/` 时展开为家目录，`$` 展开为登录名。
- `file`：文本文件路径。
- `number`：数字或 `infinity`；`0x` 为十六进制，前导 `0` 为八进制，其余十进制。

## 易错点

- `login-timeout` 仅对 `default` 记录有效。
- `x-`/`X-` 前缀保留给外部扩展，OpenBSD 不会定义。
- 资源限制同时设置最大与当前值，用户可自行将当前值提升至最大值。

## login.conf 参数

- **`path`**：空格分隔的路径列表。`~` 仅在路径开头展开；登录名和目录替换规则同 `envlist`。
- **`program`**：程序路径名。
- **`size`**：大小值或 `infinity`。默认单位字节；尾缀：
  - `b` = 512字节块，`k`/`m`/`g`/`t` = KB/MB/GB/TB
- **`time`**：秒数或 `infinity`。可写为多个数字串联相加，单位尾缀：
  - `y`(365天), `w`(7天), `d`(24小时), `h`(小时), `m`(分钟), `s`(秒)
  - 示例：`1h30m` = 1.5 小时。

## BSD Authentication

**认证风格**（对应 `login_*(8)` 程序）：

`activ`, `chpass`, `crypto`, `lchpass`, `ldap`, `passwd`, `radius`, `reject`, `skey`, `snk`, `token`, `yubikey`

**自定义本地风格**：

- 脚本路径：`/usr/libexec/auth/login_-slick`
- 风格名：`-slick`（必须以 `-` 开头，避免与官方小写字母开头的风格冲突）
- 登录语法：`user:-slick`

**认证所需信息**：

- `class`：登录类
- `service`：默认 `login`；`challenge`、`response` 供 `ftpd(8)`/`radiusd(8)` 使用
- `style`：认证风格
- `type`：决定可用风格的认证类型
- `username`：可包含实例；若风格不支持实例则认证失败

- `nc`：任意 TCP/UDP/Unix 域套接字连接与监听，可做端口扫描、代理、HTTP 测试；比 telnet 更易脚本化，错误输出到 stderr。
- 语法：`nc [选项] [destination] [port]`

**常用选项**
- `-l`：监听；不可与 `-p`/`-s`/`-x`/`-z` 同用；`-w` 对监听无效。
- `-k`：连接结束后继续监听（需 `-l`）；配合 `-u` 可接收多主机 UDP。
- `-u`：UDP（不可与 `-c`/`-x` 同用）；`-U`：Unix 域套接字（不可与 `-c`/`-F`/`-x` 同用）。
- `-4`/`-6`：仅 IPv4/IPv6；`-n`：不解析 DNS；`-p`：源端口；`-s`：源地址。
- `-N`：stdin EOF 后 shutdown socket；`-d`：不读 stdin；`-w`：连接/空闲超时；`-i`：行间/多端口间隔；`-v`：详细输出；`-r`：随机源/目的端口；`-W`：收满 N 包后退出。
- TLS 需 `-c`：`-C` 证书、`-K` 私钥、`-R` CA、`-H` 证书哈希、`-e` 验证书名；`-T` 可接 `noverify`、`noname`、`clientcert`、`muststaple`、`alpn=`、`ciphers=`、`protocols=`。
- 其他：`-F` 配合 ssh `ProxyUseFdpass`；`-T` 可设 IPv4 TOS/DSCP（`lowdelay`、`ef`、`af11`）；`-S` TCP MD5 签名；`-t` 响应 telnet DO/WILL；`-M`/`-m` TTL；`-V` 路由表。

**易错点**
- 互斥：`-l`×`-p/-s/-x/-z`；`-u`×`-c/-x`；`-U`×`-c/-F/-x`。
- `-k` 必须与 `-l` 同用；`-w` 对监听无效；`-H` 不能与 `-T noverify` 同用。

- `-X protocol`：指定代理协议，取值 `4`、`4A`、`5`（SOCKS）、`connect`（HTTPS）。默认 SOCKS v5。易错点：SOCKS v4 只能用于 IPv4 目标地址。
- `-x proxy_address[:port]`：经代理连接目标。未指定端口时默认：SOCKS 1080，HTTPS 3128。IPv6 地址需加 `[]`。不能与 `-l -s -u -U` 同用。
- `-Z peercertfile`：保存对端证书为 PEM 格式，需与 `-c` 配合。
- `-z`：仅扫描监听端口，不发送数据；不能与 `-l` 同用。

**目标与端口**
- 目标可为 IP 或主机名；`-n` 禁用域名解析。除 `-l` 监听本地外，必须指定目标。Unix 域套接字目标为路径。
- 端口支持数字或服务名，范围格式 `nn-mm`。除非 `-U`（Unix 套接字），否则必须指定目标端口。端口 `0` 表示由系统分配。

**常用模式**

```bash
# 客户端/服务器：一端监听，一端连接（-N 使 EOF 后关闭连接）
nc -l 1234
nc -N 127.0.0.1 1234
```

```bash
# 文件传输：监听端重定向输出，发送端重定向输入，完成后自动关闭
nc -l 1234 > filename.out
nc -N host.example.com 1234 < filename.in
```

```bash
# 手工协议交互（HTTP / SMTP）
printf "GET / HTTP/1.0\r\n\r\n" | nc host.example.com 80
nc localhost 25 << EOF
HELO host.example.com
MAIL FROM:<user@host.example.com>
RCPT TO:<user2@host.example.com>
DATA
Body of email.
.
QUIT
EOF
```

```bash
# 端口扫描（-z 报出开放端口）
nc -z host.example.com 20-30
```

- `null(4)`：空设备，读写如普通文件但数据丢弃，长度恒为 0。
- 设备文件：`/dev/null`，读返回 EOF，写成功但无存储。
- 历史：V4 UNIX 为只读空文件（EOF）；V5 起支持写入。

- 伪终端 = master/slave 字符设备对：写 master → slave 输入；写 slave → master 输入
- 配置：`pseudo-device pty [count]`；count 缺省或 <2 时取 8；按需动态扩展，上限 992

- 以下 ioctl 仅适用于 pty master：
  - `TIOCEXT`：开启外部处理，禁用行编辑、回显、控制字符→信号映射
  - `TIOCSTOP` / `TIOCSTART`：停止 / 恢复输出
  - `TIOCPKT`：包模式。每次 read 返回“0 字节前缀 + 数据”（`TIOCPKT_DATA`）或单字节控制状态（位或：`TIOCPKT_FLUSHREAD`/`FLUSHWRITE`/`STOP`/`START`/`DOSTOP`/`NOSTOP`/`IOCTL`）；置 `TIOCPKT_IOCTL` 时剩余数据为 termios 结构副本；用 `select(2)` 异常条件检测
  - `TIOCUCNTL`：用户 ioctl 透传，与 `TIOCPKT` 互斥；命令为 `UIOCCMD(n)`（n=1-255），`UIOCCMD(0)` 为探测 no-op；slave 的 `TIOCSBRK`/`TIOCCBRK` 转为 `TIOCUCNTL_SBRK`/`TIOCUCNTL_CBRK`
  - `TIOCREMOTE`：输入流控且不做行编辑；每次 write 为记录边界，0 字节写 = EOF

- 标准分配：openpty(3) 内部通过 `PTMGET` ioctl 访问 /dev/ptm，返回：
```c
struct ptmget { int cfd; int sfd; char cn[16]; char sn[16]; };
```

- 设备文件：master `/dev/pty[p-zP-T][0-9a-zA-Z]`；slave `/dev/tty[p-zP-T][0-9a-zA-Z]`；`/dev/ptm` 管理设备
- 易错点：ptm 仅适用于按 OpenBSD 命名规则正确填充的 /dev 目录，且 /dev 需超级用户可写

- `rtable`：路由查找表，用于策略路由；每 `rdomain` 至少含一个，ID 上限 255。
- `rdomain`：内核独立地址空间；同 IP 可在不同域复用，同域内不可。接口只属一个域，入站包所属域由接口决定；虚拟接口可与父接口不同域。流量默认不跨域，用 pf 转移。
- 接口指定到不存在的域时，自动创建该域及同 ID 的 `rtable`、`lo<ID>`。删除域：移出接口后 `ifconfig lo<ID> destroy`。

关键命令：

```sh
# 放入 rdomain 4
ifconfig em0 rdomain 4
ifconfig lo4 inet 127.0.0.1/8
ifconfig em0 192.0.2.100/24
netstat -R
# rtable 4 路由
route -T4 -qn add -net 127 127.0.0.1 -reject
route -T4 -n add default 192.0.2.1
# 在 rtable 4 启动 sshd
route -T4 exec /usr/sbin/sshd
# 查看进程/当前 rtable
ps aux -o rtable
id -R
# 删除 rdomain 4
ifconfig em0 -rdomain
ifconfig lo4 destroy
```

pf 示例：

```
block in on rdomain 4 proto tcp to any port 80
match out on rdomain 4 to !$internal_net nat-to (em1) rtable 0
```

易错点：
- 无工具可为 rdomain 分配多个 rtable（除默认域 0）。
- `rtable` 无法删除；删除 rdomain 后其 rtable 并入默认域。

## `sh` 核心知识点

- 本质：命令语言解释器（实为 `ksh`，兼容 POSIX 模式 `-o posix`）。
- 输入：`-c string` 读字符串；`-s` 读 stdin（默认）；`file` 读脚本。

### 常用选项（`+` 取消 / `set` 设置）

- `-a`：赋值自动导出；`-C`：禁止覆盖已有文件
- `-e`：出错即退出（管道/`&&`/`||` 仅看末项；`while`/`if` 等及 `!` 管道忽略）
- `-f` 禁用通配；`-n` 只读不执行；`-u` 未设变量报错（`*`/`@` 忽略）
- `-v` 读入回显；`-x` 执行前跟踪（stderr）
- `-o ignoreeof` 忽略 `^D`；`-o vi` 命令行编辑；`-m` 作业控制

### 特殊内建命令（语法错误可中止 shell；赋值保留）

`.` `:` `break` `continue` `eval` `exec` `exit` `export` `readonly` `return` `set` `shift` `times` `trap` `unset`

### 关键内建

- `.` file：当前环境执行；无斜杠按 PATH 找；失败非交互退出。
- `:`：空操作。
- `alias`：定义/查看；值尾空白则检查下一词。
- `bg`/`fg`：后台/前台恢复，默认 `%+`。
- `break`/`continue [n]`：跳出/继续 n 层。
- `cd [-L|-P] [dir]`：`-L` 不解析符号链接；`-P` 解析；`-` 回前目录；无斜杠查 `CDPATH`。
- `command [-p|-V|-v] cmd`：绕过函数；`-p` 默认 PATH；`-V` 类型；`-v` 路径；127 未找到。

### 易错点

- 特殊内建赋值保留于当前环境；普通命令不保留。
- `-e` 在条件/`!` 管道中不触发。
- `-u` 不检查 `*`/`@`；`ignoreeof` 需 `exit`。

- `eval [arg ...]`：拼接参数为命令执行；退出状态即命令状态；无参返回0，解析失败>0。
- `exec [command [arg ...]]`：替换当前 shell，不建新进程；无法调用返回126，找不到127；仅重定向未给命令返回1-125，否则0。
- `exit [n]`：退出 shell，状态为 n 或最后命令状态。
- `export [-p] name[=value]`：使变量对后续命令可见；`-p` 以可重输入格式列出已导出变量。
- `false`：返回非零。
- `fc [-lnr] [-e editor] [-s [old=new]] [first [last]]`：编辑/重放历史命令。`-l` 列出；`-ln` 无编号；`-r` 反向；`-s old=new` 免编辑器重执行并替换首次出现 old。范围：数字、`-n`、字符串；默认最后一条，`-l` 前16条；first 比 last 新则反向。
- `fg [id ...]`：作业置前台，默认 `%+`。
- `getopts optstring name [arg ...]`：解析选项；optstring 冒号表示选项需参；未识别设 name 为 `?`，若 optstring 首字符为冒号则 `OPTARG` 存未知选项，否则报错。注意 `OPTIND` 指向下一待处理参数，需 `shift` 跳过选项。
- `hash [-r | utility]`：添加 utility 到哈希表；`-r` 清空；无参显示当前哈希。
- `jobs [-l | -p] [id ...]`：显示作业状态；`-l` 加进程组 ID，`-p` 仅进程组 ID。

- **函数族**：`syslog()` / `vsyslog()` / `openlog()` / `closelog()` / `setlogmask()`；可重入版本加 `_r`，需 `struct syslog_data` 并用 `SYSLOG_DATA_INIT` 初始化。
- **核心用法**：`syslog(priority, format, ...)` 类似 printf；`vsyslog(priority, format, va_list)` 接受已捕获参数；`%m` 展开为当前 `errno` 错误消息。
- **priority** = facility | level。
  - facility 默认 `LOG_USER`，常用 `LOG_AUTH`、`LOG_DAEMON`、`LOG_KERN`、`LOG_LOCAL0~7` 等；`LOG_KERN` 仅内核可产生。
  - level 重要性递减：`LOG_EMERG`、`LOG_ALERT`、`LOG_CRIT`、`LOG_ERR`、`LOG_WARNING`、`LOG_NOTICE`、`LOG_INFO`、`LOG_DEBUG`。
- **openlog(ident, logopt, facility)**：`ident` 字符串必须持久存在且不可修改；`logopt` 位或：`LOG_CONS`（送 console）、`LOG_NDELAY`（立即连接，chroot 必需）、`LOG_PERROR`（同时输出 stderr）、`LOG_PID`（记录 PID）。
- **setlogmask(maskpri)**：设置优先级掩码，返回旧值；宏 `LOG_MASK(pri)`、`LOG_UPTO(toppri)`。
- **示例**：
```c
openlog("ftpd", LOG_PID | LOG_NDELAY, LOG_FTP);
setlogmask(LOG_UPTO(LOG_ERR));
syslog(LOG_INFO|LOG_LOCAL2, "foobar error: %m");
```

**扩展与兼容**
- `LOG_AUTHPRIV`、`LOG_FTP`、`LOG_SYSLOG`、`LOG_PERROR`、`LOG_UPTO()` 为扩展，非常规标准
- `LOG_NOWAIT` 在 OpenBSD 已弃用，无效果

**历史**
- `syslog()`/`openlog()`/`closelog()` 出自 4.2BSD；`setlogmask()` 4.3BSD；`vsyslog()` 4.3BSD-Net/1
- `*_r()` 系列（`syslog_r` 等）始于 OpenBSD 3.1

**安全警告**
- 禁止将含用户输入的字符串直接作为 format，会遭格式串攻击破坏栈
- 即使经 `snprintf()` 拼接过仍危险
- 正确写法：
```c
syslog(priority, "%s", string);
```

**可重入**
- 信号处理器等需要重入的场景用 `syslog_r()`，`syslog()` 不可重入

# 终端通用接口（tty/cua）

- 硬件端口：`/dev/ttyXX`；拨出设备 `/dev/cuaXX`（minor 号大 128）。`tty` 需活动信号，`cua` 不需，可与 modem 直连；getty 等待拨入，拨出不干扰。
- 网络登录（ssh）用伪终端 `pty`。
- 每终端关联**行规程**，默认 `termios`；其他：`TTYDISC`、`PPPDISC`、`NMEADISC`、`MSTSDISC`。

## 关键 ioctl

需 `#include <sys/ioctl.h>`，用 `ioctl(fd, request, argp)` 调用：

```c
int ldisc = TTYDISC;
ioctl(0, TIOCSETD, &ldisc);
```

| 请求 | 参数 | 作用 |
|---|---|---|
| `TIOCSETD`/`TIOCGETD` | `int *ldisc` | 设置/获取行规程 |
| `TIOCGPGRP`/`TIOCSPGRP` | `int *tpgrp` | 获取/设置进程组 |
| `TIOCGETA` | `struct termios *term` | 读 termios |
| `TIOCSETA` | `struct termios *term` | 立即设置 |
| `TIOCSETAW` | `struct termios *term` | 等输出完成后设置 |
| `TIOCSETAF` | `struct termios *term` | 等输出完成并清输入后设置 |
| `TIOCOUTQ` | `int *num` | 输出队列字符数 |
| `TIOCSBRK`/`TIOCCBRK` | `void` | 置/清硬件 BREAK |
| `TIOCSDTR`/`TIOCCDTR` | `void` | 置/清 DTR |

易错点：非 `termios` 行规程下部分 ioctl 可能无意义或不受硬件/pty 支持；多数应用应优先使用 `termios(4)` 封装函数而非直接 ioctl。

## 终端 ioctl 核心知识点

**TIOCNOTTY**（`void`）— 已废弃，用于脱离控制终端。旧机制：打开 `/dev/tty` 后调用。现代替代：`fork(2)` + `setsid(2)`；新系统 `open(2)` 不再自动分配控制终端，需用 `TIOCSCTTY` 显式设置。

**认证相关**
- `TIOCSETVERAUTH`（`int *secs`）：标记当前用户已验证，`secs` 秒后过期；仅 root 可调用。
- `TIOCCLRVERAUTH`（`void`）：清除已验证状态。
- `TIOCCHKVERAUTH`（`void`）：检查验证状态；调用者须与设置者同 real UID 且同父进程；返回 0 为成功。

**输出控制**
- `TIOCSTOP`：停止输出（等同键盘 ^S）。
- `TIOCSTART`：恢复输出（等同 ^Q）。
- `TIOCDRAIN`：等待输出排空。

**终端控制**
- `TIOCSCTTY`：使终端成为进程的控制终端（进程须无控制终端）。
- `TIOCEXCL`：独占终端，禁止进一步 open；**root/setuid 程序不受限**，实用性受限。
- `TIOCNXCL`：取消独占。

**队列清空**
- `TIOCFLUSH`（`int *what`）：
```c
FREAD  // 清输入队列
FWRITE // 清输出队列
// what 为 0 时等效两者都清
```

**窗口大小**
- `TIOCGWINSZ`（`struct winsize *ws`）：获取终端窗口行列数（含像素），全屏程序据此确定屏幕尺寸。
- `TIOCSWINSZ`（`struct winsize *ws`）：设置窗口大小。

**内核控制台**
- `TIOCCONS`（`int *on`）：`on` 非零时将内核 console 输出重定向到本终端；为零时恢复。常用于工作站将内核消息显示到特定窗口。

---
来源：consolidated/net-remote/终端与 Shell 工具手册.md