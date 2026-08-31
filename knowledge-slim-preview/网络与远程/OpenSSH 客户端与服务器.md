---
source: ssh-docs
category: net-remote
url: consolidated/net-remote/OpenSSH 客户端与服务器.md
title: OpenSSH 客户端与服务器
---

- ssh/scp，~/.ssh/config；sshd，/etc/ssh/sshd_config
- ssh-keygen 生成，ssh-agent 缓存，私钥权限严格
- X11 转发需 -X，known_hosts 校验主机

`/etc/moduli`：存放 Diffie-Hellman 素数模数与生成元，供 sshd(8) 的 DH Group Exchange 密钥交换使用。

生成分两步：

```bash
ssh-keygen -M generate   # 候选生成
ssh-keygen -M screen     # 素性测试
```

每行一条记录，7 个空格分隔字段：

| 字段 | 说明 |
|---|---|
| timestamp | 最后处理时间 YYYYMMDDHHMMSS |
| type | 素数结构类型 |
| tests | 已做素性测试的位掩码 |
| trials | 素性测试次数 |
| size | 素数位数(bit) |
| generator | 推荐生成元(hex) |
| modulus | 模数本身(hex) |

type 取值：

- `0`：未知/未测试
- `2`：安全素数，(p-1)/2 亦为素数；**OpenSSH 仅使用此型**
- `4`：Sophie Germain 素数，2p+1 亦为素数（generate 初始产出；screen 后转为 type 2）

tests 位掩码：

- `0x02`：Eratosthenes 筛法（generate 阶段）
- `0x04`：Miller-Rabin 概率测试（screen 阶段）
- `0x01`：合数

sshd 先按所选对称加密所需密钥长度估算模数位数，再从 /etc/moduli 中随机选取最匹配的模数。

### scp(1) 核心知识点

`scp` 基于 SSH 的安全复制，默认走 SFTP 协议。源/目标为本地路径、`[user@]host:[path]` 或 `scp://[user@]host[:port][/path]`。

```
scp [-346ABCOpqRrsTv] [-c cipher] [-D sftp_server_path] [-F ssh_config] [-i identity_file] [-J destination] [-l limit] [-o ssh_option] [-P port] [-S program] [-X sftp_option] source ... target
```

关键参数：
- `-P port` 远程端口（大写 P）。
- `-p` 保留时间戳/权限。
- `-r` 递归复制目录。
- `-i identity_file` 指定私钥。
- `-C` 开启压缩。
- `-J destination` 跳板机。
- `-O` 强制传统 SCP 协议（兼容旧服务器）。
- `-o ssh_option` 传递 `ssh_config` 选项。

易错点：
- 文件名含 `:` 会被误判为主机，需用路径明确。
- 两远程复制默认绕本地；`-R` 直连且 URI 格式时 target 不能指定端口。
- `-P` 是端口，`-p` 是保留属性。
- 默认 SFTP，`-O` 才强制传统 scp。

- `buffer=value`：单次 SFTP 读写操作最大缓冲，默认 32KB。
- 退出状态：`scp` 成功返回 0，失败返回 >0。
- 历史：基于 BSD rcp；OpenSSH 9.0 起默认改用 SFTP 协议传输。
- 易错点：旧 SCP 协议（`-O`）依赖远程 shell 执行 glob 匹配，需对引号等特殊字符小心转义。

## SFTP 客户端核心知识点

**基本概念**
- `sftp`：OpenSSH 安全文件传输，基于加密 ssh 传输，支持公钥认证
- 目标格式：

```bash
sftp user@host:/path
sftp sftp://user@host:2222/path
```

- path 为非目录文件且非交互认证时自动下载；否则进入交互模式
- IPv6 地址须加方括号 `[addr]` 避免歧义

**关键选项**
- `-P port`：远程端口（sftp 用大写，区别于 ssh 的 `-p`）
- `-o opt`：传 ssh 选项，如 `-oPort=24`
- `-C`：压缩；`-c cipher`：加密算法
- `-i file`：公钥认证私钥
- `-J dest`：跳板机，逗号分隔多跳（等同 ProxyJump）
- `-l kbps`：限速；`-p`：保留时间戳/权限；`-q`：静默
- `-r`：递归复制目录（不跟随符号链接）
- `-a`：断点续传（内容不一致可能损坏）
- `-B size`：传输缓冲（默认 32768）；`-R n`：并发请求（默认 64）

**批量模式 `-b batchfile`**
- 从文件读命令，`-` 为 stdin；须配非交互认证
- 失败即中止：`get put reget reput rename ln rm mkdir chdir ls lchdir copy cp chmod chown chgrp lpwd df symlink lmkdir`
- 前缀 `-` 忽略单命令错误，`@` 抑制回显，可组合如 `-@ls /bsd`

## 启动选项
- `-s subsystem|sftp_server`：指定 SSH2 子系统或远程 sftp 服务器路径（远程 sshd 未配置 sftp 子系统时用路径）
- `-v`：提高日志级别（同时传给 ssh）
- `-X sftp_option`：控制 SFTP 协议行为
  - `nrequests=value`：并发读/写请求数，默认 64
  - `buffer=value`：单次读/写缓冲区上限，默认 32KB

```bash
sftp -s /usr/libexec/sftp-server -X nrequests=128 -X buffer=64K user@host
```

## 交互命令
通用规则：命令不区分大小写；含空格路径用引号；glob 特殊字符用 `\` 转义。

- `bye` / `exit`：退出
- `cd [path]`：切换远程目录，无参返回会话起始目录
- `chgrp [-h] grp path` / `chmod [-h] mode path` / `chown [-h] own path`：改组/权限/属主；`grp` 必须为数字 GID，`own` 必须为数字 UID；`-h` 不跟随符号链接
- `copy oldpath newpath` / `cp`：远程复制文件
- `df [-hi] [path]`：显示磁盘使用；`-h` 人类可读，`-i` 显示 inode 信息
- `get [-afpR] remote-path [local-path]`：下载；本地路径缺省用远程名；多文件匹配时 `local-path` 必须为目录

易错点：`-h`（chgrp/chmod/chown）需服务器支持 `lsetstat@openssh.com`；`copy` 需 `copy-data` 扩展；`df` 需 `statvfs@openssh.com`。

## sftp-server

OpenSSH SFTP 服务器子系统，由 `sshd` 通过 `Subsystem` 间接调用，不可直接运行。配置写在 `sshd_config` 的 `Subsystem` 声明中。

### 核心参数

- `-d`：指定启动目录，支持 `%%`→`%`、`%d`→家目录、`%u`→用户名，常与 `ChrootDirectory` 合用。
- `-R`：只读模式，拒绝所有写操作及文件系统状态变更。
- `-l`：日志级别，默认 `ERROR`；`INFO`/`VERBOSE` 记录事务。
- `-P`：逗号分隔的禁止请求列表，被禁请求回复失败。
- `-p`：逗号分隔的允许请求列表，不在列表中的请求日志后失败。

### 易错点

- `-P` 和 `-p` 同时使用时，**denied 列表先于 allowed 列表生效**。
- 使用 `-p` 时需确保客户端隐式请求（如查询属性）在允许列表中，否则异常。
- chroot 环境下日志需访问 `/dev/log`，必须在 chroot 目录内建立 syslog socket。
- 可用 `-Q requests` 查询全部支持的操作，以构造允许/禁止列表。

### 示例配置

```ssh
Subsystem sftp /usr/lib/ssh/sftp-server -d /srv/%u -R -l INFO
```

## SSH 客户端配置 (ssh_config)

- 配置来源优先级（首个值生效）：命令行选项 > `~/.ssh/config` > `/etc/ssh/ssh_config`；同一指令，最先获得的值被采用
- 语法：每行 `指令 值`；`#` 注释（引号内的 `#` 不解释为注释）；值含空格可加双引号；分隔符用空白或单个 `=`（后者适合 `ssh -o` 传参）
- 关键字不区分大小写，参数值区分大小写
- `Host`：条件段，按主机名模式匹配（支持 `*` 通配、`!` 否定）；`Host *` 设全局默认
- `Match`：按条件匹配，条件可用 `!` 否定、可组合；可用条件：`all`、`canonical`、`final`、`exec`、`localnetwork`、`host`、`originalhost`、`tagged`、`command`、`user`、`localuser`、`version`、`sessiontype`
- `Match exec`：执行命令返回 0 才匹配，命令含空格必须引号；`localnetwork` 用 CIDR 匹配本地网卡
- `Include`：包含其他配置文件，支持通配符、token、`~`；相对路径在用户配置为 `~/.ssh`，系统配置为 `/etc/ssh`；可在 `Host`/`Match` 块内条件包含

配置顺序：特定主机声明放前，全局默认放后；`Host`/`Match` 作用至下一同类关键字。

```sshconfig
Host myserver
    HostName 192.168.1.10
    User admin
    Port 2222

Host *.example.com !old.example.com
    User web

Host *
    User guest
    ConnectTimeout 10
```

易错点：`Host`/`Match` 块影响后续所有声明，不要漏掉 `Host *` 收尾。

## SSH 客户端核心知识点

- `ssh` 远程登录/执行命令，格式 `[user@]hostname` 或 `ssh://[user@]hostname[:port]`；带命令则远程执行，否则登录 shell

### 常用选项
- `-4`/`-6`：强制 IPv4/IPv6
- `-A`：启用 agent 转发；**风险**：远程可操作 agent 中密钥认证（不能窃取密钥），更安全用 `-J` 跳板
- `-a`：禁用 agent 转发
- `-B 接口`/`-b 地址`：指定源接口/地址（多地址主机）
- `-J 目标`：跳板主机
- `-i 文件`：指定身份文件
- `-o 选项`：直接指定配置项

### 关键配置
- `AddKeysToAgent`：是否自动添加密钥到 agent；值：`no`(默认)、`yes`、`ask`、`confirm`（每次使用需确认）或时间间隔（如 `10m`）
- `AddressFamily`：`any`(默认)、`inet`(仅IPv4)、`inet6`(仅IPv6)
- `BatchMode`：`yes` 禁用密码/主机密钥确认等交互，适合脚本；默认 `no`
- `BindAddress`/`BindInterface`：对应 `-b`/`-B`
- `CanonicalizeHostname`：`no`(默认)、`yes`（非代理连接规范化）、`always`（代理连接也规范化）；启用后按新主机名重新解析配置；相关参数有 `CanonicalDomains`、`CanonicalizeMaxDots`、`CanonicalizePermittedCNAMEs`、`CanonicalizeFallbackLocal`
- `CASignatureAlgorithms`：CA 签名算法白名单，默认包含多种常见算法（如 `ssh-ed25519`、`ecdsa-sha2-nistp256` 等）

- -C：压缩所有数据（同gzip）；慢网加速、快网变慢；对应Compression。
- -c：指定加密算法列表，对应Ciphers。
- -D：动态转发（SOCKS4/5）：[bind_address:]port；localhost仅本地，空/*所有接口；仅root特权端口；IPv6[]。
- -E：调试日志写文件。
- -e：转义符默认~，.断连，Ctrl-Z挂起，none禁用。
- -F：指定配置文件（默认~/.ssh/config），none不读。
- -f：转后台，隐含-n；ExitOnForwardFailure=yes时等转发。
- -G：打印实际配置并退出。
- -g：允许远程连本地转发端口；多路复用须master指定。
- -I：指定PKCS#11库。
- -i：指定私钥；可多次；自动尝试-cert.pub。
- -J：跳板机，逗号多跳；命令行配置仅目标机，跳板参数写~/.ssh/config。
- -K/-k：启用/禁用GSSAPI认证及转发。
- -L：本地转发：[bind_address:]port:host:hostport（socket变体）；仅root特权端口；IPv6[]。
- -l：远程登录用户名。
- -M：master模式；多-M需ssh-askpass；对应ControlMaster。
- -m：指定MAC算法列表，对应MACs。

- `ssh -N`：不执行远程命令，仅端口转发；`-n`：stdin 重定向自 /dev/null，用于后台运行（`ssh -n host emacs &`）；`-O ctl_cmd`：控制连接复用主进程（`check`/`conninfo`/`channels`）。
- `ssh-add`：向 ssh-agent 添加私钥身份。无参数时加载 `~/.ssh` 下 `id_rsa`、`id_ecdsa`、`id_ecdsa_sk`、`id_ed25519`、`id_ed25519_sk`、`id_mldsa44_ed25519`（及同名 `-cert.pub`）。前置：agent 运行且 `SSH_AUTH_SOCK` 指向其 socket；需 passphrase 时从 tty 读取。
- 选项：`-C` 仅证书；`-k` 仅私钥；`-c` 使用前经 ssh-askpass 确认；`-D` 删全部；`-d` 删指定（无参删默认；无 .pub 自动补；`-` 从 stdin 读公钥）；`-E` 指纹哈希 `md5|sha256`（默认 sha256）；`-e pkcs11` 移除 / `-s pkcs11` 加载 PKCS#11 密钥；`-l`/`-L` 列指纹/公钥；`-Q` 查 agent 扩展；`-K` 从 FIDO 加载常驻密钥，`-S provider` 指定 FIDO 库；`-N` 添加证书时禁止到期自动删除；`-q` 静默。
- `-h`（目的约束）：格式 `[user@]dest-hostname` 或 `src-hostname>[user@]dst-hostname`；经 known_hosts 识别主机，`-H` 指定文件（可多次）；需 OpenSSH 8.9+，仅由 agent 或协作 ssh(1) 强制；不能阻止持远程 `SSH_AUTH_SOCK` 者再次转发，但只能访问允许目的地。

## ssh-add

- `-t life`：设置身份最大存活期（秒或 `sshd_config(5)` 时间格式）
- `-s pkcs11`：从 PKCS#11 共享库加载密钥
- 环境变量：`SSH_AUTH_SOCK` 指定 socket；`SSH_ASKPASS`+`DISPLAY` 无终端时用图形程序读密码，`SSH_ASKPASS_REQUIRE=force|prefer|never` 控制
- 易错点：`~/.ssh/id_ecdsa`、`id_ed25519`、`id_rsa` 等私钥文件若对其他用户可读，`ssh-add` 直接忽略

## ssh-agent

- `-t life`：默认身份最大存活期（`ssh-add` 可覆盖，不设则永久）
- `-a bind_address`：绑定 Unix socket，默认 `$HOME/.ssh/agent/s.*`
- `-c` / `-s`：输出 C-shell / Bourne shell 命令
- `-D`：前台不 fork；`-d`：调试模式
- `-E md5|sha256`：指纹哈希算法，默认 `sha256`
- `-k`：杀掉当前代理（用 `SSH_AGENT_PID`）
- `-O allow-remote-pkcs11`：允许远程客户端加载 PKCS#11/FIDO 库；`-O no-restrict-websafe`：允许 FIDO 签名非 ssh 应用字符串；`-O websafe-allow=pat-list` 自定义允许模式
- `-P allowed_providers`：中间库路径模式，默认 `/usr/lib/*,/usr/local/lib/*`

## ssh-agent

- 选项：`-u` 仅清理 `$HOME/.ssh/agent/` 下陈旧 socket 后退出；连用两次删除所有陈旧 socket（忽略主机名）。`-V` 显示版本并退出。`command [arg ...]` 作为 agent 子进程运行，命令结束 agent 自动退出。
- 启动：X 会话 `ssh-agent xterm &`；登录会话 `eval \`ssh-agent -s\`` 导出生效环境变量。
- 密钥管理：默认无私钥；`ssh-add` 添加/删除/查询；`ssh_config` 中 `AddKeysToAgent` 可自动添加；`ssh -A` 转发 agent 连接（私钥/口令不经网络传输）。
- 安全/易错点：`SIGUSR1` 删除全部已加载密钥。`SSH_AGENT_PID`（agent PID）、`SSH_AUTH_SOCK`（socket 路径，仅当前用户可访问）。Socket 文件 `$HOME/.ssh/agent/s.*` 应仅属主可读，agent 退出自动删除。

## ssh-askpass

- X11 口令对话框，由 `ssh-add` 调用，勿直接运行。
- 用法：`ssh-askpass [options] [label]`。不支持 `-geometry`、`-borderwidth`、`-iconic`、`-rv`、`-title`。单参数作标签，含 `\n` 换行显示。
- 界面/操作：LED 亮点反馈，不显示真实字符长度。OK 接受（可为空），stdout 输出，退出 0；Cancel 丢弃，退出非 0。`Backspace`/`Delete` 删前一字符；`Ctrl+U`/`Ctrl+X` 清空；`Enter`/`Ctrl+M`/`Ctrl+J` 确认；`Escape` 取消。
- X resources：`grabKeyboard`(True)、`grabPointer`(False)、`grabServer`(False)、`inputTimeout`(0=永远)、`defaultXResolution`(75/in)。

## 10. SSH 密钥工具

### ssh-askpass

- 通过 X resources 配置界面（标题/标签/字体/3D 配色等），默认配置文件 `/usr/X11R6/share/X11/app-defaults/SshAskpass`。

### ssh-keygen

**生成密钥**

```bash
ssh-keygen -t ed25519 [-b bits] -C comment -f output_keyfile -N passphrase
```

支持类型：`ecdsa`、`ecdsa-sk`、`ed25519`、`ed25519-sk`、`mldsa44-ed25519`、`rsa`。

**密钥管理**

- `-p` 改口令（`-P` 旧/`-N` 新）、`-c` 改注释、`-y` 私钥导公钥
- `-l` 显示指纹（`-E` 哈希）、`-i`/`-e` 导入/导出（`-m` 格式）
- `-F` 查找、`-R` 删除、`-H` 哈希化 `known_hosts`、`-A` 生成全部主机密钥

**证书**

```bash
ssh-keygen -I identity -s ca_key -n principals -V interval -z serial file...
```

- `-L` 查看证书；`-k` 生成 KRL、`-Q` 查询；`-Y find/match-principals` 验证 SSH 签名

# ssh-keygen 核心要点

- **功能**：生成/管理/转换 SSH 认证密钥，也可生成 DH-GEX 模数组、Key Revocation Lists。
- **默认行为**：无参数生成 **Ed25519** 密钥，路径 `~/.ssh/id_ed25519`；公钥为私钥名 + `.pub`；默认 OpenSSH 格式，`-m` 可输出 PEM；注释默认 `user@host`，`-c` 可修改。
- **口令要点**：可为空，**主机密钥必须为空口令**；推荐 10–30 字符；**丢失无法恢复**。

## 关键选项

| 选项 | 说明 |
|---|---|
| `-t type` | 密钥类型 |
| `-b bits` | RSA 最小 1024、默认 3072；ECDSA 仅 256/384/521 |
| `-a rounds` | KDF 轮数，默认 16，越高越抗暴力破解 |
| `-E hash` | 指纹算法 md5/sha256，默认 sha256 |
| `-p` | 修改口令 |
| `-c` | 修改注释 |
| `-A` | 生成全部默认主机密钥（rsa/ecdsa/mldsa44-ed25519/ed25519） |
| `-H` | 哈希 known_hosts（原内容存 `.old`） |
| `-F 主机[:端口]` | 在 known_hosts 中查找主机 |
| `-e` / `-i` | 导出/导入密钥，默认 RFC4716 格式 |
| `-K` | 从 FIDO 认证器下载常驻密钥 |
| `-h` | 签主机证书（默认用户证书） |

## 签名/验证

```bash
ssh-keygen -Y sign -f key_file -n namespace file ...
ssh-keygen -Y verify -f allowed_signers_file -I identity -n namespace -s sig_file [-r revocation_file]
ssh-keygen -Y check-novalidate -n namespace -s sig_file
```

## ssh-keygen

- `-k`：生成 KRL；`-L` 打印证书；`-l` 显示指纹（加 `-v` 附 ASCII 艺术图）。
- `-M generate`/`screen`：生成/筛选 DH-GEX 参数。
- `-m key_format`：指定密钥格式（用于生成、导入导出、改口令，可做 OpenSSH 格式转换）。

## ssh-keyscan

- 并行扫描主机收集公开密钥，无需登录，支持主机名、IP、CIDR（如 `192.168.0.64/25`）。
- 易错点：无法验证密钥真实性，输出需带外校验，防中间人攻击。

常用选项：

- `-t` 指定密钥类型（如 `rsa`、`ed25519`）。
- `-p` 端口；`-T` 超时（默认 5s）。
- `-f file`：从文件读取主机列表（`-` 读标准输入）。
- `-H`：对输出主机名/地址哈希。
- `-D`：输出 SSHFP DNS 记录；`-O hashalg=sha1|sha256` 配合选择哈希。

## ssh-keysign

- 由 `ssh(1)` 调用，访问主机密钥生成认证签名；用户不应直接运行。
- 默认禁用，需在 `/etc/ssh/ssh_config` 设置 `EnableSSHKeysign yes`。
- 主机密钥位于 `/etc/ssh/ssh_host_*_key`（如 `ssh_host_ed25519_key`）。

## sshd_config 核心要点

**主机密钥文件**
- 私钥 `/etc/ssh/ssh_host_rsa_key` 等：属主 root、仅 root 可读；启用基于主机认证时 `ssh-keysign` 需 set-uid root
- `ssh_host_*_key-cert.pub`：对应私钥的证书公钥

**配置基础**
- 路径 `/etc/ssh/sshd_config`（或 `-f` 指定）
- 每行 `关键字 参数`，首个值生效；`#` 注释；含空格参数可用双引号
- 关键字不区分大小写，参数区分大小写

**关键指令**
- `AcceptEnv`：接受客户端环境变量，支持 `*`/`?` 通配符；`TERM` 始终接受；默认不接受任何变量；⚠️ 某些变量可绕过受限用户环境
- `AddressFamily`：`any`(默认)/`inet`(仅IPv4)/`inet6`(仅IPv6)
- `AllowAgentForwarding`：默认 `yes`；禁用并不提升安全性（除非同时禁止 shell 访问）
- `AllowGroups`：仅接受组名（不识别数字 GID），默认允许所有组
- `AllowTcpForwarding` / `AllowStreamLocalForwarding`：`yes`/`all`/`no`/`local`/`remote`，默认 `yes`
- `AllowUsers`：用户名模式，支持 `USER@HOST` 及 CIDR 地址；默认允许所有用户
- `AuthenticationMethods`：多组逗号分隔方法列表，完成任一列表全部方法即通过；`any` 恢复默认单方法；例 `publickey,password publickey,keyboard-interactive`；重复 `publickey` 要求不同密钥；`keyboard-interactive:pam` 可限定认证设备
- 可用认证方法：`gssapi-with-mic`、`hostbased`、`keyboard-interactive`、`password`、`publickey`

- sshd：OpenSSH守护进程；选项覆盖配置；SIGHUP重读配置。
- AuthorizedKeysCommand：查公钥；须root、不可写、绝对路径；命中则不执行；默认不运行。
- AuthorizedKeysCommandUser / AuthorizedPrincipalsCommandUser：有Command无User拒绝启动。
- AuthorizedKeysFile：默认.ssh/authorized_keys .ssh/authorized_keys2；none跳过。
- AuthorizedPrincipalsCommand：生成主体；同AuthorizedKeysCommand；设了则证书须含主体。
- AuthorizedPrincipalsFile：CA证书主体；默认none（用户名须在主体）；不用于authorized_keys的CA（用principals=）。
- Banner：认证前发送文件内容；none不显示；默认无。
- CASignatureAlgorithms：CA证书允许算法；默认含ssh-ed25519,rsa-sha2-512/256等。
- 命令行：-4/-6 IP；-C用于-T测试（addr,user,host,laddr,lport,rdomain；invalid-user）；-c cert须匹配-h/HostKey；-D前台。

**sshd 选项**
- `-f file`：配置文件，默认 /etc/ssh/sshd_config，缺失拒绝启动
- `-t`：验证配置与密钥；`-G`：打印生效配置（配 `-C` 应用 Match）
- `-p port`：默认22，可多个；命令行优先于配置 Port，ListenAddress 优先
- `-d`：调试，前台单连接
- `-h file`：主机密钥（非 root 必用）；默认 ssh_host_{ecdsa,ed25519,mldsa44_ed25519,rsa}_key
- `-g sec`：认证宽限，默认120，0=不限
- `-u0`：仅用 IP 免 DNS（除非认证/配置需要）
- `-o opt`：传配置格式选项

**认证**
- 仅 SSH2；主机公钥校验；DH 前向保密；对称加密+MAC
- 认证：host-based、公钥、challenge-response、密码
- 可申请伪终端、X11/TCP/agent 转发；shell/命令经用户 shell `-c` 执行
- 退出时服务端回传命令退出状态

**登录流程**
1. tty：记录登录时间；无命令时打印上次登录+motd（~/.hushlogin 抑制）
2. /etc/nologin 存在→拒绝（root 除外）
3. 降权；设环境；读 ~/.ssh/environment（需 PermitUserEnvironment）；进家目录
4. 运行 ~/.ssh/rc（PermitUserRC）→ /etc/ssh/sshrc → xauth；rc 从 stdin 收 X11 proto/cookie
5. 经登录 shell 执行 shell/命令

**~/.ssh/rc**
- 环境后、shell 前；禁 stdout，仅 stderr
- X11 转发：stdin 收 proto/cookie，环境含 DISPLAY；须自行调 xauth
- 用途：家目录可用前初始化（如 AFS）

- SSH 登录后若存在 `~/.ssh/rc` 则执行；否则执行 `/etc/ssh/sshrc`；均不存在则由 `xauth` 添加 cookie。典型脚本按 `$DISPLAY` 是否为 `localhost:` 选择 unix socket 或 TCP 方式注册 X11 转发认证。
- `AuthorizedKeysFile` 指定公钥认证文件，默认 `~/.ssh/authorized_keys` 与 `~/.ssh/authorized_keys2`。
- 每行一个 key；空行和 `#` 注释忽略。格式：`[options] keytype base64-key [comment]`；options 可选，comment 仅作标识。
- 支持的 keytype：
  ```text
  sk-ecdsa-sha2-nistp256@openssh.com
  ecdsa-sha2-nistp256/384/521
  sk-ssh-ed25519@openssh.com
  ssh-ed25519
  ssh-mldsa44-ed25519@openssh.com
  ssh-rsa
  ```
- 行上限 8KB，允许 RSA 最大 16k bits；应从 `id_*.pub` 复制而非手输。
- `sshd` 强制 RSA 模数 ≥1024 bits。
- options 字段可含多种限制（原文未列完）。

---
来源：consolidated/net-remote/OpenSSH 客户端与服务器.md