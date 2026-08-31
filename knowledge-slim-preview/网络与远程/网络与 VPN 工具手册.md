---
source: ssh-docs
category: net-remote
url: consolidated/net-remote/网络与 VPN 工具手册.md
title: 1. OpenBSD手册页服务器
---

`ftp` 是 OpenBSD FTP 客户端，支持 `ftp://`、`http(s)://`、`file:` 及 `host:/file`。

## 常用参数
- `-4`/`-6`：强制 IPv4/IPv6
- `-A`：强制主动模式（默认被动）
- `-a`：匿名登录
- `-C`：断点续传（HTTP 需 `Range`）
- `-c file`：加载 Netscape cookie
- `-n`：禁止自动登录（不读 `.netrc`）
- `-o file`：输出文件；`-o -` 到 stdout
- `-P port`：指定端口
- `-p`：被动模式（默认）
- `-r sec`：失败重试间隔
- `-T`：发送 `If-Modified-Since`
- `-U ua`：自定义 User-Agent
- `-v`/`-V`：开启/关闭 verbose
- `-w sec`：连接超时
- `-k sec`：控制连接保活（默认60s）
- `-i`：多文件关闭交互
- `-m`/`-M`：强制/禁止进度条
- `-s addr`：源地址
- `-u`：不用远端时间戳

## SSL/TLS（`-S`）
- `cafile=`/`capath=`：CA 证书（默认 `/etc/ssl/cert.pem`）
- `ciphers=`：密码套件
- `depth=`：证书链深度
- `do`/`dont`：执行/跳过证书校验（默认执行）
- `muststaple`：要求 OCSP stapling
- `protocols=`：TLS 协议
- `session=`：会话恢复文件

## 易错点
- 默认被动模式；`-A` 强主动，`-E` 禁用 IPv4 EPSV/EPRT
- `-C` 续传依赖服务器 `Range`
- `-n` 不读 `.netrc`，否则自动登录会检查 `~/.netrc`

- 启动：命令行指定主机则立即连接；否则进入 `ftp>` 交互提示符。`ftp [host [port]]` 是 `open` 的同义词。
- 会话：`open host [port]` 连接；`close`/`disconnect` 断开并保留客户端，但清除已定义宏；`bye`/`exit` 断开并退出；`?`/`help` 帮助。

- 传输类型：`ascii` 设为网络 ASCII；`binary` 为二进制（默认）；`form format` 设置格式（默认 `file`）。
- 文件操作：`append local [remote]` 追加，远程名缺省用本地名（受 `ntrans`/`nmap` 影响）；`delete remote-file` 删除；`chmod mode file` 改远程权限；`cd`/`cdup` 切换/上级；`dir` 列目录（同 `ls`）。

- 开关/配置：`bell on|off` 传输完成响铃；`case on|off` 使 `mget` 将全大写远程名转小写（默认 off）；`cr on|off` ASCII 获取时剥离回车（默认 on），非 UNIX 系统遇单个换行应设 off；`debug [level]` 显示 `-->` 后的发送命令；`edit on|off` 命令行编辑/补全（终端下自动开）；`epsv4 on|off` IPv4 使用 EPSV/EPRT。

- 其他：`! [cmd [args]]` 本地 shell 或直接执行命令；`$ macro [args]` 执行 `macdef` 宏（参数不 glob）；`account [password]` 登录后补充密码，无参数时非回显输入。

`ipsecctl` — 控制 IPsec 数据流（flows），管理内核 SPD（安全策略库）与 SAD（安全关联库），可配置规则集、读取状态、控制 isakmpd(8) 及自动建隧道。

### 主要选项

- `-c`：与 `-s` 联用，折叠输出
- `-D macro=value`：命令行定义宏，覆盖规则集内定义
- `-d`：从 SPD 删除指定 flows（默认是添加）
- `-F`：清空 SPD 和 SAD
- `-f file`：加载规则文件
- `-i fifo`：指定与 isakmpd 通信的替代 FIFO（默认 `/var/run/isakmpd.fifo`）
- `-k`：显示 SAD 条目中的密钥材料
- `-m`：持续显示与内核交换的 `PF_KEY` 消息
- `-n`：仅解析规则，不实际加载
- `-s modifier`：显示内核数据库，modifier 可简写
  - `flow`：显示 SPD 中的规则集
  - `sa`：显示活动的 SAD 条目
  - `all`：显示以上全部
- `-v`：增加输出详细度，`-vv` 更详细

### 语法

```text
ipsecctl [-cdFkmnv] [-D macro=value] [-f file] [-i fifo] [-s modifier]
```

### 易错点

- 默认行为是添加 flows；删除需显式加 `-d`
- `-s` 的 modifier 可省略为前缀，如 `-s f`
- 规则语法详见 `ipsec.conf(5)`，隧道自动密钥依赖 isakmpd(8)
- `ipsecctl` 首次出现于 OpenBSD 3.8

- `isakmpd` 是 OpenBSD 的 IKEv1 守护进程，为 IPsec 建 SA（IKEv2 用 `iked(8)`）。事件驱动，父进程读配置，子进程 chroot 至 `/var/empty`。
- 配置：支持 `isakmpd.conf(5)` 或简化 `ipsec.conf(5)`；`-c` 仅适用于前者。

常用选项：
- `-4`/`-6`：仅用 IPv4/IPv6
- `-a`：不自动设 flows（手动或由 bgpd 管理）
- `-c file`：指定配置文件（需仅属主可读）
- `-D class=level`：调试，class 可用 `A` 全部
- `-d`：前台运行
- `-K`：跳过 keynote 策略检查（配 ipsecctl/bgpd）
- `-L`：捕获 IKE 包到 `/var/run/isakmpd.pcap`
- `-p port`：监听端口
- `-S`：冗余模式（sasyncd/carp），被动启动
- `-T`：禁用 NAT-T
- `-v`：详细日志，输出阶段 1/2 成功
- `-i pid-file`：默认 `/var/run/isakmpd.pid`

FIFO 命令：
```
C add [section]:tag=value
C rmv [section]:tag=value
C rm [section]:tag
C rms [section]
```

易错点：
- `-i`/`-l`/`-R` 路径必须以 `/var/run` 开头
- 传统 `isakmpd.conf` 需严格权限
- `-K` 跳过策略检查，需确保 flows 已由其他程序配置

- `C` 命令：`set section:tag=value [force]` 原子更新（已存在失败，`force` 覆盖）；`add` 追加（已存在失败）；`rm` 删 tag；`rms` 删 section；`rmv` 从列表移除条目。`get section:tag` 读配置，结果存 `/var/run/isakmpd.result`。
- `c name` 启动连接；`t [phase] name` 拆除连接（name 为 tag 或远端 IP；phase：`main`/`quick`，默认 `quick`）；`T` 拆除所有 active quick。
- `d cookies msgid` 删除指定 SA，`msgid` 用 `-` 匹配 Phase 1；`D class level` 设调试级别，`D A level` 所有 class，`D T` 清零再 `D T` 恢复；`M active`/`M passive` 设主动/被动模式，被动不发包。
- `p on[=path]` 启用明文抓包（默认 `/var/run/isakmpd.pcap`，仅允许 `/var/run` 路径）；`p off` 关闭；`Q` 关闭；`R` 重初始化；`r` 报告状态到 syslog；`S` 报告所有 SA 到 `/var/run/isakmpd.result`。
- 注意：`SIGHUP` 或 FIFO 写 `R` 会使配置更新失效。
- PKI：用 `openssl(1)` 生成 CSR 提交 CA；认证方式：Passphrase、Host Keys、X.509、Keynote；密钥/证书认证时 Transforms 需含 `RSA_SIG`，如 `3DES-SHA-RSA_SIG`。
- 公钥 PEM 存储：IPv4 `/etc/isakmpd/pubkeys/ipv4/A.B.C.D`，IPv6 `/etc/isakmpd/pubkeys/ipv6/<地址>`。

- 字符设备，连接用户态与内核网络栈：读设备取包，写设备注入内核
- 创建：`ifconfig ifaceN create` 或打开 `/dev/tunN`/`/dev/tapN`
- 独占打开（已开则 EBUSY）；最后关闭丢弃排队包；设备文件创建的接口自动销毁
- 读：每次最多 1 包，缓冲不足截断；写：每次 1 包，不阻塞，队列满丢包返回 ENOBUFS

**tun（L3）**：包前缀 4 字节网络字节序地址族；支持 `AF_INET`/`AF_INET6`/`AF_MPLS`
**tap（以太网）**：读写 Ethernet 帧（CRC 不要求）；ioctl `SIOCGIFADDR`/`SIOCSIFADDR` 读写 MAC

**ioctl（`<net/if_tun.h>`）**
- `TUNGIFINFO`/`TUNSIFINFO`：struct tuninfo（mtu/type/flags/baudrate）；flags、type 须与内核创建时一致
- `TUNSCAP`/`TUNGCAP`/`TUNDCAP`：启用/查询/禁用卸载头与接口卸载能力；TUNGCAP 未配置时返回 ENODEV

**offload 头（主机字节序）**
```c
struct tun_hdr { uint16_t th_flags, th_pad, th_vtag, th_mss; };
```
- 标志：`TUN_H_VTAG`（仅 tap）、`TUN_H_TCP_MSS`、`TUN_H_IPV4_CSUM`、`TUN_H_TCP_CSUM`、`TUN_H_UDP_CSUM`、`TUN_H_ICMP_CSUM`
- TCP/UDP/ICMP 校验标志互斥；th_pad 写时置 0

**易错点**
- 最大包 16384 字节，否则 `EMSGSIZE`
- 读返回 `EIO`=接口已销毁；`EWOULDBLOCK`=非阻塞无包
- `TUNSIFMODE` 仅向后兼容
- 卸载头可原样转写至另一设备
- tap 自 OpenBSD 5.9 从 tun 分离

---
来源：consolidated/net-remote/网络与 VPN 工具手册.md