---
source: iptables-docs
category: security
url: consolidated/security/netfilter 与 iptables.md
title: netfilter 与 iptables
---

- netfilter：Linux 内核数据包处理框架；iptables：用户态配置工具。
- 目录覆盖：NAT、包过滤、内核开发、扩展、FAQ、双重 NAT、libnetfilter 系列、nftables、ipset、conntrack-tools 等。
- 核心子项目：nftables（继任者）、xtables-addons、ulogd、libnftnl、libmnl。
- 文档类型：HOWTO、FAQ、开发指南、许可信息。
- 易错点：区分 netfilter（内核）/iptables（用户态）；NAT 指南与包过滤指南独立；双重 NAT 需额外配置。

- 官网/下载：`netfilter.org/pub/`
- Git：`git.netfilter.org`
- Bug：`bugzilla.netfilter.org`
- Wiki：`wiki.nftables.org`

## 联系 netfilter 项目

### 邮件列表（首选）
- 几乎所有项目交流都在邮件列表进行；使用/开发问题、评论、建议请发对应列表

### 缺陷追踪系统
- 适用场景：发现 bug、功能/增强请求
- 地址：`http://bugzilla.netfilter.org`

### IRC
- `#netfilter` 频道（Libera chat），可与用户和开发者交流

### 核心团队（coreteam）
- 团队极小，面对数百万 Linux 安装，**不**为个人用户提供防火墙配置帮助；此类问题将被忽略，请发用户邮件列表
- **仅以下情况**联系 `coreteam@netfilter.org`（附 GPG 密钥）：
  - 发现安全相关严重 bug，公开前通知厂商
  - 需要 netfilter/iptables 专业支持、开发或咨询
  - 许可证条款与合规问题

### 网站管理员
- 网站相关问题（死链、错别字、建议）：`webmaster@netfilter.org`

- netfilter/iptables 采用 GNU GPL v2 许可。
- 允许自由使用、修改、分发，衍生作品须保持 GPL 兼容。

## netfilter/iptables 许可证核心要点

**许可证性质**
- 与 Linux 内核相同，为自由软件，遵循 **GNU GPLv2 only**（仅限 GPL v2，非 "v2 or later"）
- 个别源码文件许可可能不同，以每个文件头部显式声明为准

**"Free" 的含义**
- Free 指自由（freedom），非免费；明确**不意味着"无任何义务"**
- 受版权保护，不等同于 freeware 或 public domain

**分发义务（易错点）**
- 以二进制形式分发 netfilter/iptables 代码时，**必须同时提供源代码**
- 适用所有分发介质：CD-ROM、固件镜像（flash/ROM）、网络下载等

**关键资源**
```text
许可证全文: http://www.gnu.org/licenses/old-licenses/gpl-2.0.txt
GPL FAQ:    http://www.fsf.org/licenses/gpl-faq.html
许可详解文章(PDF): https://www.netfilter.org/documentation/licensing/netfilter-licensing.pdf
产品手册免责声明模板: https://www.netfilter.org/documentation/licensing/netfilter-disclaimer.pdf
```

- 商业产品集成时，建议在产品手册附录使用官方 disclaimer 模板
- 疑问联系核心团队：`coreteam@netfilter.org`

- netfilter/iptables 使用 **GNU GPLv2**，分发即须遵守全部条件，否则侵权。
- 分发原始源码：提供版权声明与免责声明；保留所有许可声明；随程序附 GPL 许可证副本。
- 分发修改源码：每个修改文件须注明变更内容及日期；修改版本整体须以 GPLv2 免费授权给所有第三方。
- 分发目标码/可执行文件：履行上述 1、2 条义务，并二选一：
  - 随附完整对应机器可读源码；
  - 提供书面要约，有效期至少 3 年，向第三方提供源码副本，收费不超过实际分发成本。
- 嵌入式防火墙示例：设备含 netfilter/iptables 目标码并提供固件更新，若修改过源码，可立即提供源码：
  - 附带 GPLv2 许可证文本；
  - 附版权声明，如 `(C) Copyright 2000-2004 netfilter project https://www.netfilter.org/`；
  - 附免责声明（GPLv2 第 11/12 条）；
  - 若混合其他许可证，需标明各许可证覆盖部分；
  - 提供完整修改源码，并标识与原始源码的差异；
  - 提供编译、安装目标码的控制脚本，尤其是 makefile 及构建固件镜像所需工具。
- 另一合规方式是书面要约，但 netfilter 项目更推荐立即提供源码。

- Linux 2.4 NAT HOWTO：基于 2.4 内核的 netfilter 地址转换指南。
- NAT 定义：网络地址翻译，用于伪装、透明代理、端口转发等。
- 两种 NAT：源 NAT（SNAT）改源地址；目的 NAT（DNAT）改目的地址。
- 2.0/2.2 内核迁移：旧工具需换成 iptables 体系。
- 控制要 NAT 的数据包：用 iptables 规则选择，支持简单条件和精细匹配。
- 如何修改包：SNAT/DNAT 规则；映射细节（地址、端口、连接跟踪）。
- 特殊协议：需额外处理，如 FTP 等多通道协议。
- NAT 注意事项：防止分片问题、地址重叠等。
- SNAT 与路由：源地址转换影响路由决策，需注意规则顺序。
- DNAT 到同一网络：需配置路由避免回环。

## Linux 2.4 包过滤指南——核心知识点

- 主题：在 Linux 2.4 内核下使用 `iptables` 进行包过滤。
- 包过滤：概念、用途、Linux 下的实现方式。
- 数据包遍历：理解包如何流过内核过滤链是配置规则的基础。
- `iptables` 使用：
  - 启动时的默认行为。
  - 单规则操作：添加、删除、修改规则。
  - 过滤规格：匹配协议、接口、地址等条件。
  - 目标规格：规则匹配后执行的动作。
  - 整链操作：清空链、设置默认策略等。
- 兼容与迁移：
  - 旧工具 `ipchains`、`ipfwadm` 仍可继续使用。
  - 注意 `iptables` 与 `ipchains` 的差异。
- 混合场景：包过滤与 NAT（网络地址转换）同时使用时的交互。
- 设计建议：先规划过滤策略，再落实到具体链和规则。

**netfilter 内核开发核心知识点**

- 文档定位：Linux 内核 netfilter 架构及编程指南，覆盖包过滤、连接跟踪（Connection Tracking）与 NAT 三大子系统
- 作者/维护：Rusty Russell、Harald Welte；邮件列表：`netfilter@lists.samba.org`
- 背景动机：2.0/2.2 内核包过滤机制存在缺陷，netfilter 为其替代架构

**核心子系统**
- Netfilter 基础：内核层 hook 框架
- 包选择：ip_tables
- 连接跟踪：基于流状态跟踪
- NAT：基于连接跟踪实现地址转换

**程序员要点**
- 理解 `ip_tables` 内部实现（表、链、规则结构）
- 扩展 iptables 用户态工具
- 理解并扩展连接跟踪/NAT
- 编写新的 netfilter 模块
- 用户态包处理

**迁移与测试**
- 2.0/2.2 包过滤模块移植到 netfilter 的注意事项
- 隧道（tunnel）编写者使用 netfilter hook
- 测试套件：测试编写方法、环境变量与辅助工具

- netfilter 资源：官网（下载/Git）、邮件列表、Bugzilla、Patchwork、Wiki  
- 邮件列表：`https://www.netfilter.org/mailinglists.html`  
- 补丁管理：`patchwork.ozlabs.org/project/netfilter-devel/list/`

- **netfilter 邮件列表**：志愿者社区、免费；仅作经验交流。企业支持/培训/咨询请直接联系 coreteam。选对列表可减少项目成员负担、缩短等待。

- **发帖前必读规则**：
  - **主题行**：需概括内容，禁用 `Help!!!`、`HELP ME PLEEEEEASE`、`Urgent` 等无意义词。
  - **禁止 top-posting**：回复时不得在引用全文上方追加新内容，会破坏阅读流。
  - **控制引用**：只引用需要回应部分，并在其下方插入评论；引用量 ≤ 自己的回复量。禁止“引用几十行+底部加一行”。
  - **禁止 HTML**：邮件必须纯文本（7-bit），关闭 HTML 格式。含 HTML 会被过滤拒收。
  - **新帖/回复分离**：新帖用 `New`，回复用 `Reply`；不得通过“回复+改主题”伪造新线程，否则破坏线程阅读。
  - **禁用伪法律免责声明**：不得在邮件中附加此类内容。

- **netfilter-announce**：发布/安全公告，低流量，建议订阅。订阅：`netfilter-announce+subscribe@lists.netfilter.org?subject=subscribe`
- **netfilter**（用户列表）：使用/配置/调试提问。订阅：`netfilter+subscribe@vger.kernel.org`；发送：`netfilter@vger.kernel.org`
- **netfilter-devel**：开发讨论。订阅：`netfilter-devel+subscribe@vger.kernel.org`；发送：`netfilter-devel@vger.kernel.org`
- **netfilter-buglog**：仅收取 bug 跟踪通知。

**易错点**
- 使用问题发 user，开发问题发 devel，勿混。
- 本地时间必须正确，否则归档错乱。
- 勿加法律免责声明；公司强制时用 webmail 或别发。

## 双重 NAT 核心知识点

- **用途/架构**：子网冲突时，双 NAT 经中间网重映射，两侧各做 DNAT+SNAT。
- **关键**：NAT 盒创建别名 IP 作映射入口。

### 示例（NAT BOX 1）
```
ifconfig eth0:0 192.168.180.181 netmask 255.255.255.0
iptables -t nat -A PREROUTING -d 192.168.180.181 -i eth0 -j DNAT --to-destination 10.15.15.181
iptables -A POSTROUTING -s 192.168.150.0/255.255.255.0 -d 10.15.15.0/255.255.255.0 -j SNAT -o eth1 --to-source 10.15.15.1
```
NAT BOX 2 对称，映射到真实内网 IP；`.182/.183 → .11/.12` 同理。

### 易错点
- 开启转发：`echo 1 > /proc/sys/net/ipv4/ip_forward`
- DNAT 入口：Box1 用别名地址，Box2 用中间地址，顺序不可颠倒；目标不能是别名
- 单 NAT 因路由优先直连失效
- 放行 FORWARD NEW
- 保存：`iptables-save > /etc/sysconfig/iptables`

- Netfilter 扩展默认不编译，需用 **patch-o-matic-ng** 打补丁。
- 获取最新源码：
```bash
svn co https://svn.netfilter.org/netfilter/trunk/iptables
svn co https://svn.netfilter.org/netfilter/trunk/patch-o-matic-ng
```
- 若内核不在 `/usr/src/linux/`，指定：
```bash
export KERNEL_DIR=/path/to/linux
```
- 确保内核依赖已生成：
```bash
cd /usr/src/linux/ && make dep
```
- 运行补丁工具（`extra` 套件会附带 `pending`、`base`）：
```bash
./runme extra
```
- 交互命令：
  - `y` 应用补丁
  - `n` 跳过
  - `t` 测试补丁是否可干净应用
  - `f` 测试失败也强制应用
  - `r` 反转模式卸载补丁
  - `a` 重启为 apply 模式
  - `b`/`w` 前后浏览补丁
  - `q` 退出
- 非交互常用参数：
```bash
./runme --batch pending
./runme --reverse --exclude patch-dir
```
- 打补丁后重新编译内核，启用新选项；再编译 iptables：
```bash
make && make install
```
- 查看某匹配模块的选项：
```bash
iptables -m 模块名 --help
```
- **ah-esp 补丁**：按 SPI 匹配 AH/ESP 包。
  - AH：`-p 51 -m ah --ahspi 500 -j DROP`
  - ESP：`-p 50 -m esp --espspi 500 -j DROP`
  - 选项支持范围：`--ahspi[!] spi[:spi]`、`--espspi[!] spi[:spi]`
  - 易错点：必须显式指定 `-p 50`/`-p 51`，否则规则插入失败。

- **condition 匹配**：通过 `/proc/net/ipt_condition/` 控制规则启用/禁用；变量仅 `0`/`1`，可影响多条规则；首次引用自动创建，最后移除自动删除。
  - 选项：`--condition [!] conditionfile`
  ```bash
  iptables -A FORWARD -p tcp -d 192.168.1.10 --dport http -m condition --condition webdown -j REJECT --reject-with tcp-reset
  echo 1 > /proc/net/ipt_condition/webdown
  ```

- **conntrack 匹配**：`state` 超集，支持额外连接跟踪信息。
  - 关键选项：`--ctstate`（含 `SNAT`/`DNAT` 虚拟状态）、`--ctproto`、`--ctorigsrc/--ctorigdst/--ctreplsrc/--ctrepldst`、`--ctstatus`、`--ctexpire`
  ```bash
  iptables -A FORWARD -m conntrack --ctstate RELATED --ctproto tcp -j ACCEPT
  ```

- **fuzzy 匹配**：基于 TSK 模糊逻辑，按包速率动态匹配；采样约 100ms。
  - 低于 `lower-limit` 不匹配；`lower-limit`→`upper-limit` 匹配率递增；达到上限后匹配率最高 99%（接受率 1%）。
  - 选项：`--upper-limit n`、`--lower-limit n`
  ```bash
  iptables -A INPUT -m fuzzy --lower-limit 100 --upper-limit 1000 -j REJECT
  ```

- **iplimit 匹配**：限制来自特定主机/网络的并行 TCP 连接数。

未提供文档正文，无法提炼。

## Patch-O-Matic

- netfilter 扩展补丁管理工具，自动选择/应用内核补丁。
- 获取最新源码：

```bash
mkdir netfilter_svn && cd netfilter_svn
svn co https://svn.netfilter.org/netfilter/trunk/iptables
svn co https://svn.netfilter.org/netfilter/trunk/patch-o-matic-ng
```

- 内核源码默认在 `/usr/src/linux/`，可用环境变量指定：

```bash
export KERNEL_DIR=/the/path/linux
cd /usr/src/linux/ && make dep   # 确保依赖已生成
```

### 运行方式

```bash
cd patch-o-matic-ng
./runme extra
```

- 依次提示每个补丁，交互选项：
  - 回车/N：跳过
  - `t`：测试补丁是否可干净应用
  - `y`：应用
  - `f`：测试失败也强制应用
  - `a`：切换为自动应用模式
  - `r`：切换为反向（撤销）模式
  - `b`/`w`：后退/前进一个补丁
  - `q`：退出

### 命令行参数

```bash
./runme [--batch] [--reverse] [--exclude suite/patch-dir] [--test] [--check] suite|suite/patch-dir
```

- `--batch`：批处理自动应用
- `--reverse`：撤销补丁
- `--exclude`：排除指定补丁，可多次使用
- `--check`：检查已应用状态，输出 `rune.out-check`
- `--test`：只测试不应用

### 补丁套件（suite）

- `pending`、`base`、`extra` 三个仓库。
- 指定 `extra` 时自动先展示 `pending` 和 `base` 补丁。
- 只应用需要的补丁，切勿全部应用；可后续按需重编。

### Netfilter/iptables 扩展安装与新增匹配

- 内核配置启用所需选项，重编安装后，在 `iptables/` 目录：
```
make && make install
```
- 查看 match 帮助：
```
iptables -m <match_name> --help
```

#### ah-esp 匹配
- 按 SPI 匹配，用于 IPSEC：
```
iptables -A INPUT -p 51 -m ah --ahspi 500 -j DROP
iptables -A INPUT -p 50 -m esp --espspi 500 -j DROP
```
- 参数：`--ahspi [!] spi[:spi]`、`--espspi [!] spi[:spi]`
- 易错：必须用 `-p 51`（AH）或 `-p 50`（ESP），否则失败。

#### condition 匹配
- 变量存于 `/proc/net/ipt_condition/`，值 `0`/`1`；首次引用自动创建，最后引用移除。
- 参数：`--condition [!] conditionfile`
- 示例：
```
iptables -A FORWARD -p tcp -d 192.168.1.10 --dport http -m condition --condition webdown -j REJECT --reject-with tcp-reset
echo 1 > /proc/net/ipt_condition/webdown
```

#### conntrack 匹配
- 是 state 的超集。
- 参数：
  - `[!] --ctstate [INVALID|ESTABLISHED|NEW|RELATED|SNAT|DNAT][,...]`
  - `[!] --ctproto <协议>`
- 示例：
```
iptables -A FORWARD -m conntrack --ctstate RELATED --ctproto tcp -j ACCEPT
```

无原文，无法提炼。

# netfilter 核心

- netfilter：独立于 BSD socket 的内核包处理框架，四部分：协议 hook、内核注册监听、用户态排队、文档/实验支撑。
- IPv4 定义 5 个 hook（PRE_ROUTING / LOCAL_IN / FORWARD / LOCAL_OUT / POST_ROUTING）。
- 每个注册者返回判决：`NF_ACCEPT`、`NF_DROP`、`NF_STOLEN`、`NF_QUEUE`。
- 排队包由 `ip_queue` 异步送用户态，再决定处理。
- 上层系统：iptables（过滤 / NAT / mangle）、connection tracking、其他扩展。

## 2.0/2.2 主要缺陷

- 无用户态包传递基础设施：重注入慢，且受 sanity 检查限制。
- transparent proxy 侵入内核：2.2.1 中 `CONFIG_IP_TRANSPARENT_PROXY` 出现 34 处 / 11 文件，脆弱。
- 过滤规则依赖接口地址，不能独立区分本地与转发包。
- Masquerading 与包过滤耦合，导致 input/output/forward 各点看到不一致包。
- ipchains 既不模块化也不可扩展。
- 无原子读包过滤计数器。
- `CONFIG_IP_ALWAYS_DEFRAG` 是编译选项，分发不便。

## 可扩展点

- iptables：新增 match、target、table；内核侧 + 用户态 `libiptc`。
- NAT / conntrack：新协议、新 NAT target、conntrack helper、NAT helper。
- 裸 netfilter：注册 hook、处理排队包、从用户态接收命令。
- 隧道编写者可利用 netfilter hooks。
- 测试套件：`gen_ip`、`rcv_ip`、`gen_err`、`local_ip`。

## 获取最新源码

```bash
cvs -d :pserver:cvs@pserver.netfilter.org:/cvspublic login   # 密码: cvs
cvs -d :pserver:cvs@pserver.netfilter.org:/cvspublic co netfilter/userspace
cvs update -d -P
```

## Netfilter 架构

协议栈（IPv4/IPv6/DECnet）中的钩子集合。IPv4 遍历路径：

```
--->[1]--->[ROUTE]--->[3]--->[4]--->
     |                 ^
     v                 |
    [2]               [5]
```

- `1`=NF_IP_PRE_ROUTING：入口检查后
- `2`=NF_IP_LOCAL_IN：发往本机
- `3`=NF_IP_FORWARD：转发
- `4`=NF_IP_POST_ROUTING：出口前
- `5`=NF_IP_LOCAL_OUT：本地生成包，hook 后路由；**改路由须改 `skb->dst`**

## Netfilter 基础

- 注册钩子须指定**优先级**，按序调用
- 五类返回：
  - `NF_ACCEPT` 继续；`NF_DROP` 丢弃；`NF_STOLEN` 接管；`NF_QUEUE` 排队（交用户空间）；`NF_REPEAT` 重入该钩子

## IP Tables

- 基于 netfilter 的包选择系统，可扩展（模块可注册新表）
- 三大表：
  - `filter` — 包过滤
  - `nat` — 地址转换
  - `mangle` — 包修改
- 钩子注册顺序：
  - PRE：Conntrack → Mangle → NAT(Dst)
  - FWD：Mangle → Filter
  - POST：Mangle → NAT(Src) → Conntrack

## netfilter.org 项目体系

netfilter.org 是 Linux 内核网络包处理（防火墙/NAT/连接跟踪）的官方项目组织，旗下核心子项目按功能分层：

**防火墙工具**
- `iptables`：传统 xtables 防火墙，仍在维护（1.8.x）
- `nftables`：新一代防火墙，替代 iptables，语法更简洁，为当前主力

**用户态库（内核通信层）**
- `libmnl`：极简 netlink 消息库，nftables 底层依赖
- `libnftnl`：nftables 用户态对象（规则/表/链）库
- `libnfnetlink`：旧版 netlink 库，iptables 使用
- `libnetfilter_*` 系列：`acct`（记账）、`log`（日志）、`queue`（包队列到用户态）、`conntrack`（连接跟踪）、`cttimeout`（跟踪超时）、`cthelper`（跟踪辅助模块）

**辅助工具**
- `conntrack-tools`：连接跟踪表查看/管理（`conntrack` 命令）
- `ipset`：IP 集合，配合 iptables/nftables 高效匹配大批量地址
- `nfacct`：内核记账对象用户态工具
- `ulogd`：用户态日志采集守护进程
- `xtables-addons`：iptables 第三方扩展插件合集

**关键资源入口**：源码 `git.netfilter.org`、补丁 `patchwork`、文档 `wiki.nftables.org`、发布 `netfilter.org/pub`。

# netfilter/iptables FAQ 核心要点

## 通用
- ip6tables 不支持 IPv6 NAT；无内置 HA/failover
- 旧 `ip_masq_*` 已废弃，用 `ip_nat_ftp`/`ip_nat_irc` 辅助模块

## 编译
- iptables 必须与内核版本匹配（如 1.1.1 需 kernel≥2.4.0-test4；补丁需 2.4.4+）
- 源码树不完整 → `ipt_BALANCE`/`ip_nat_ftp`/`ipt_SAME`/`ipt_NETMAP` 编译失败

## 运行期
- 日志：`NAT: X dropping untracked packet` → NAT 丢未跟踪包；`ip_conntrack: maximum limit...` → 调大 `/proc/sys/net/ipv4/ip_conntrack_max`
- 连接查看：`cat /proc/net/ip_conntrack`；`iptables -L` 慢加 `-n`
- `iptables-save/restore` 段错误：版本不匹配
- 透明代理：`iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 3128`
- LOG 后 DROP：先 LOG 再 DROP（LOG 不终止）
- REJECT 仅 filter，不能用于 PREROUTING
- `iptables -C` 未实现，内核不支持
- 内核升级后 nat 报 `Invalid argument`：同步升级 iptables

## 开发
- QUEUE 目标用 libipq；`No buffer space available` → netlink 缓冲不足
- 增删规则 API：libiptc

（原文未提供，无法提炼）

无法从提供的 PostScript 文件中提取文档内容。

该内容为 LaTeX/TeX 生成的 PostScript 内嵌代码（PDF 内部编码），用于定义 CMYK 颜色映射与 PDF 超链接标记，不包含可供提炼的 Linux 技术知识点。无要点，无核心概念。

- netfilter 项目动态核心资源：官网、下载、Git、邮件列表、Bugzilla、Workshop、Patchwork、Wiki。
- 代码仓库见 `git.netfilter.org`；文档见 `wiki.nftables.org`。
- Patchwork 追踪补丁；Bugzilla 提交 Bug。

- **netfilter.org** 是 Linux 内核网络过滤框架（Netfilter）的官方项目组织，核心工具为 **iptables** 与 **nftables**。
- 主要子项目：`iptables`、`nftables`、`libnftnl`、`libnetfilter_conntrack`、`conntrack-tools`、`libmnl`、`ipset`、`ulogd`、`xtables-addons` 等。

## 版本动态（近期）

| 项目 | 版本 | 日期 |
|---|---|---|
| iptables | 1.8.13 | 2026-03-04 |
| iptables | 1.8.12 | 2026-02-19 |
| conntrack-tools | 1.4.9 | 2026-02-04 |
| libnetfilter_conntrack | 1.1.1 | 2026-02-04 |
| nftables | 1.1.6 | 2025-12-05 |
| libnftnl | 1.3.1 | 2025-12-03 |
| nftables | 1.0.6.1 (stable) | 2025-09-02 |
| libnftnl | 1.3.0 | 2025-08-06 |
| ulogd | 2.0.9 | 2025-05-19 |

## 重要提示

- ⚠️ **iptables 1.8.12 存在回归缺陷**，会破坏 Docker 网络功能；建议升级至 **1.8.13**。
- `nftables 1.0.6.1` 为稳定版，包含 412 个反向移植提交，**依赖 `libnftnl >= 1.2.4`**。
- 所有版本均通过官方下载页发布，需关注各项目对应 downloads 链接。

- Netfilter 主要项目版本发布（2022–2024）：
  - `nftables`：1.1.1（2024-10-03）、1.1.0、1.0.9、1.0.8、1.0.7、1.0.6
  - `libnftnl`：1.2.8（2024-10-03）、1.2.7、1.2.6、1.2.5、1.2.4
  - `libnetfilter_conntrack`：1.1.0（2024-09-25）
  - `iptables`：1.8.11（2024-10-03）、1.8.10、1.8.9
  - `conntrack-tools`：1.4.8（2023-09-29）——修复 1.4.7 中 `-U/--update`、`-D/--delete` 命令的回归
  - `ulogd`：2.0.8（2022-11-02）

- 团队变动（2023-11-17）：Arturo Borrero、Eric Leblond 转为荣誉成员；分别对 nftables 早期开发和 `nfnetlink_*`、ulogd2 维护有重要贡献。

未提供正文内容，无法提炼。

- **iptables**：Linux 包过滤工具。表/链：`filter`(INPUT/OUTPUT/FORWARD)、`nat`(PREROUTING/POSTROUTING/OUTPUT)、`mangle`(改 TTL/TOS)。

- 常用命令：
  ```bash
  iptables -L -n -v
  iptables -A INPUT -p tcp --dport 22 -j ACCEPT
  iptables -P INPUT DROP
  ```

- 参数：`-s/-d` IP，`--sport/--dport` 端口，`-i/-o` 接口，`-p` 协议，`-j` 动作(ACCEPT/DROP/REJECT/LOG/SNAT/DNAT)。

- 状态匹配 `-m state --state`（NEW/ESTABLISHED/RELATED/INVALID）。常用：
  ```bash
  iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  ```

- NAT：
  ```bash
  iptables -t nat -A POSTROUTING -s 192.168.1.0/24 -o eth0 -j SNAT --to-source 1.2.3.4
  iptables -t nat -A PREROUTING -d 1.2.3.4 -p tcp --dport 80 -j DNAT --to-destination 192.168.1.10:8080
  ```

- 持久化：
  ```bash
  iptables-save > /etc/iptables/rules.v4
  iptables-restore < /etc/iptables/rules.v4
  ```

- 易错点：默认 DROP 先加 ACCEPT；规则顺序敏感（`-A` 末尾、`-I` 开头）；须用 `-m state` 允许回包；`-p tcp` 不带 `--dport` 匹配所有 TCP；NAT 仅首包生效。

- 颜色定义：每色以 `/Name{c m y k setcmykcolor}DC` 注册，全部使用 CMYK，例：`/Red{0 1 1 0 setcmykcolor}DC`。
- `DC` 过程避免重复定义：
  ```postscript
  /DC{exch dup userdict exch known{pop pop}{X}ifelse}B
  ```
  已存在于 `userdict` 则忽略，防止覆盖。
- 单位换算：基于 `Resolution` 转换 DVI/PDF/PS 点制：
  ```postscript
  /DvipsToPDF{72.27 mul Resolution div}def
  /PDFToDvips{72.27 div Resolution mul}def
  ```
- 超链接边框：`HyperBorder`=1（pt）；`H.S`、`H.L`、`H.A`、`H.R` 分别计算 `pdfmark` 的 `Rect`，利用 `currentpoint` 和 `vsize`。
- pdfmark 兼容：`systemdict /pdfmark known` 判断，不支持时用 `cleartomark` 代替。
- 字体：`%%BeginFont: CMSY10` 开始嵌入 TeX 数学符号字体 CMSY10。

- Netfilter 项目支持资源：
  - 官网/下载/Git：`netfilter.org`、`pub/`、`git.netfilter.org`
  - 交互：邮件列表、Bugzilla、Workshop
  - 开发：Patchwork（补丁管理）、Wiki（nftables 文档）

- netfilter 是志愿者驱动的自由开源项目，依赖用户贡献代码、文档、邮件答疑等。
- 贡献方式：
  - 在邮件列表帮助其他用户
  - 补充/更新文档（man page 补丁或 wiki）
  - 开发：扩展代码以 GNU GPLv2+ 发布，补丁发至 netfilter 开发者邮件列表
  - 无明确方向可联系 coreteam 获取任务建议
- 开发要求：严格遵循内核 Coding Style，并阅读 Submitting Patches 指南。
- 捐赠：接受资金或硬件捐赠，联系 `coreteam@netfilter.org`；历史捐赠者见 Thanks 部分。

- **xtables-addons** 是 `patch-o-matic(-ng)` 的后继项目，包含未被主内核/iptables 接受或尚未接受的扩展。
- 独立主页：`http://xtables-addons.sourceforge.net/`
- 维护者：Jan Engelhardt
- 定位：为 iptables 提供额外匹配/目标扩展模块，可单独编译加载。

- 双重NAT：网段重叠时单NAT因直连路由优先失败；用中间网+两层DNAT/SNAT解耦。
- 拓扑：盒1 eth0=192.168.180.180，eth1=10.15.15.1；盒2 eth0=10.15.15.2，eth1=192.168.150.252。
- 准备：开启IP转发；保存 `iptables-save > /etc/sysconfig/iptables`。
- 别名：盒1 eth0:0-2=192.168.180.181-.183；盒2 eth0:0-2=10.15.15.181-.183（`ifconfig eth0:N IP netmask 255.255.255.0`）。

- 盒1：
```bash
iptables -t nat -A PREROUTING -d 192.168.180.181 -i eth0 -j DNAT --to-destination 10.15.15.181
iptables -A POSTROUTING -s 192.168.150.0/255.255.255.0 -d 10.15.15.0/255.255.255.0 -j SNAT -o eth1 --to-source 10.15.15.1
```
  .182/.183 同理映射到 10.15.15.182/.183。

- 盒2：
```bash
iptables -t nat -A PREROUTING -d 10.15.15.181 -i eth0 -j DNAT --to-destination 192.168.150.10
iptables -A POSTROUTING -s 10.15.15.0/24 -d 192.168.150.0/24 -j SNAT -o eth1 --to-source 192.168.150.252
```
  .182/.183 同理映射到 150.11/.12。

- 验证：`ssh 192.168.180.181` 应先登录盒2；最终用 .181-.183 访问 .10-.12。
- 易错：忘开IP转发；DNAT/SNAT须成对；`-i/-o`接口方向不能错。

- **ipset** 是 Linux 2.4.x+ 内核中的 IP 集合框架，通过 `ipset` 工具管理。
- 可存储：IP 地址、(TCP/UDP) 端口号、IP+MAC 地址；匹配集合条目速度极快。
- 典型用途：
  - 一次匹配大量 IP/端口（配合 iptables 一条规则）
  - 动态更新 IP/端口规则而不损失性能
  - 用单条 iptables 规则表达复杂地址/端口规则集
- 官方主页：`ipset.netfilter.org`
- 开发版 Git：`http://git.netfilter.org/ipset/`
- 主要作者：Jozsef Kadlecsik

```bash
# 创建集合（示例）
ipset create myset hash:ip
# 添加条目
ipset add myset 192.168.1.1
# 与 iptables 配合（示例）
iptables -A INPUT -m set --match-set myset src -j DROP
```

## iptables 项目

- **定位**：用户态命令行工具，配置 Linux 2.4.x 及以后内核的包过滤规则集，面向系统管理员。
- **NAT**：网络地址转换同样通过包过滤规则集配置，故也由 `iptables` 管理。
- **IPv6**：软件包内含 `ip6tables`，用于配置 IPv6 包过滤。
- **内核依赖**：要求内核具备 `ip_tables` 包过滤支持（所有 2.4.x 及以后版本）。

**三大核心功能**：
- 列出包过滤规则集内容
- 添加/删除/修改规则
- 查看/清零每条规则计数器

**开发版源码**：`https://git.netfilter.org/iptables/`

**作者**：netfilter 核心团队及众多社区贡献者。

## libmnl 项目

- 定位：面向 Netlink 开发者的极简用户态 C 库
- 解决的问题：Netlink 报文头与 TLV 的解析、校验、构造等重复且易错
- 提供可复用辅助函数，避免重复造轮子
- 许可证：LGPLv2.1+
- 文档：Doxygen 格式

### 核心特性

- **小**：x86 下共享库约 30KB
- **简单**：不隐藏 Netlink 细节，避免复杂抽象
- **易用**：封装 socket 处理、消息构建、校验、解析、序号跟踪
- **易复用**：可在其上构建自有抽象层
- **解耦**：各组件依赖小，提供辅助函数但不强制使用

### 关键信息

- Git 仓库：`https://git.netfilter.org/libmnl/`
- 主要作者：Pablo Neira Ayuso（Jozsef Kadlecsik、Jan Engelhardt 贡献）

## libnetfilter_acct 项目

- **定位**：用户空间库，提供对内核扩展计费基础设施（extended accounting）的接口。
- **使用者**：`nfacct` 工具依赖此库。
- **依赖**：
  - `libmnl`
  - 内核需包含 `nfnetlink_acct` 子系统（**kernel ≥ 3.3**）

### 核心功能

| 功能 | 说明 |
| --- | --- |
| 创建计费对象 | 新增 accounting object |
| 获取计费对象 | 读取计数并**原子置零** |
| 删除计费对象 | 移除 accounting object |

### 关键信息

- **API 文档**：Doxygen 格式
  <https://www.netfilter.org/projects/libnetfilter_acct/doxygen/>
- **开发版 Git**：

```bash
git clone https://git.netfilter.org/libnetfilter_acct/
```

### 易错点

- **内核版本**：低于 3.3 的内核无 `nfnetlink_acct` 支持，库无法工作。
- **链接依赖**：编译时需同时链接 `-lmnl`。

### 作者

Pablo Neira Ayuso

## libnetfilter_conntrack 项目

**定位**：用户空间库，提供访问内核连接跟踪状态表的编程接口（API）。旧称 `libnfnetlink_conntrack`、`libctnetlink`。被 conntrack-tools 等应用使用。

**依赖**
- `libnfnetlink`
- 内核含 `nfnetlink_conntrack` 子系统（初始支持 ≥ 2.6.14，推荐 ≥ 2.6.18）

**核心功能**
- 列出/读取内核 conntrack 表条目
- 插入/修改/删除 conntrack 表条目
- 列出/读取内核 expect 表条目
- 插入/修改/删除 expect 表条目

**License**：0.9.1 起为 GPLv2+，之前为 GPLv2

**Git 仓库**：`https://git.netfilter.org/libnetfilter_conntrack/`

**作者**：Pablo Neira、Harald Welte

**Python 绑定**：`pynetfilter_conntrack`（作者 Victor Stinner）

**文档**：Doxygen 格式

- **`libnetfilter_cthelper`** 是用户空间库，为 Linux 内核 3.6+ 的**用户空间 helper 基础设施**提供编程接口。
- 用途：注册、配置、启用、禁用用户空间 helper；被 `conntrack-tools` 使用。
- 依赖：`libmnl` + 内核包含 `nfnetlink_cthelper` 子系统（3.6+）。
- 主要功能：
  - 注册用户空间 helper
  - 检索现有 helper
- 服务对象：`nfnetlink_cthelper` 子系统。
- 文档：Doxygen 格式。
- Git 仓库：`https://git.netfilter.org/libnetfilter_cthelper/`
- 作者：Pablo Neira Ayuso。

- **libnetfilter_cttimeout** 是 netfilter 用户空间库，为**细粒度连接跟踪（conntrack）超时基础设施**提供编程接口。
- 功能：创建、更新、删除**超时策略（timeout policy）**，并可附加到流量流上。
- 被 `conntrack-tools` 使用。
- **依赖**：
  - `libmnl`
  - 内核需包含 `nfnetlink_cttimeout` 子系统（**kernel ≥ 3.4**）
- **核心功能**（面向 `nfnetlink_cttimeout` 子系统）：
  - 创建超时策略对象
  - 获取超时策略对象
  - 删除超时策略对象
- 开发版本 Git 仓库：`https://git.netfilter.org/libnetfilter_cttimeout/`
- 作者：Pablo Neira Ayuso

## libnetfilter_log 项目

- 用户态库：从内核包过滤器接收被记录的包，取代基于 `syslog`/`dmesg` 的旧式包日志机制
- 曾用名：`libnfnetlink_log`
- 被 `ulogd2` 使用

### 依赖
- `libnfnetlink`
- 内核含 `nfnetlink_log` 子系统（≥ 2.6.14）

### 核心功能
- 从内核 `nfnetlink_log` 子系统接收待记录的数据包

### 其他
- Doxygen 格式文档
- Git 仓库：`https://git.netfilter.org/libnetfilter_log/`
- 作者：Harald Welte

## libnetfilter_queue 核心知识点

- **定位**：用户态库，提供 API 访问由内核包过滤器排队的报文
- **背景**：用于取代旧机制 `ip_queue` / `libipq`
- **曾用名**：`libnfnetlink_queue`
- **依赖**：`libnfnetlink`；内核需含 `nfnetlink_queue` 子系统（2.6.14+）

**核心功能**：
- 从内核 `nfnetlink_queue` 子系统接收排队报文
- 向内核下发裁决（verdict）及/或重新注入修改后的报文

**其他**：
- 作者：Harald Welte
- 开发版 Git：`https://git.netfilter.org/libnetfilter_queue/`
- 文档：doxygen 格式

## libnfnetlink 项目

### 核心定位
- netfilter 内核态与用户态通信的**底层库**，提供通用消息传递基础设施
- 服务对象：内核 netfilter 子系统（`nfnetlink_log`、`nfnetlink_queue`、`nfnetlink_conntrack`）及其用户态管理工具
- **非公共 API**：仅供其他 netfilter.org 项目使用，如 `libnetfilter_log`、`libnetfilter_queue`、`libnetfilter_conntrack`

### 依赖
- 需要内核支持 nfnetlink 子系统：**kernel >= 2.6.14**

### 主要功能
- 底层 nfnetlink 消息处理函数

### Git 仓库
- 开发版本：`https://git.netfilter.org/libnfnetlink/`

### 作者
- 主要由 netfilter core team 编写，Pablo Neira Ayuso 参与贡献

## libnftnl 项目

- **定位**：用户态库，为内核 `nf_tables` 子系统提供底层 netlink 编程接口（API），当前被 **nftables** 使用。
- **依赖**：`libmnl`；内核需包含 `nf_tables` 子系统（初始支持 >= 3.14）。
- **核心功能**：
  - 规则（rule）：列出/获取、插入/修改/删除
  - 集合（set）：列出/获取、插入/修改/删除
- **许可证**：GPLv2+
- **开发版 Git**：<https://git.netfilter.org/libnftnl/>
- **作者**：Pablo Neira Ayuso 等

## nfacct 项目

netfilter 的**网络计费/账户对象管理命令行工具**，用于创建、检索、删除内核中的 accounting 对象。

**依赖**
- `libnetfilter_acct`、`libmnl`
- 内核需支持 `nfnetlink_acct` 子系统（官方发布内核 ≥ 3.3）

**核心功能**
- 以纯文本/XML 格式列出 nfacct 表对象
- **原子**获取并重置对象计数（get + reset）
- 向 nfacct 表新增对象
- 从表中删除对象

**开发仓库**
```bash
git clone https://git.netfilter.org/nfacct/
```

**维护者**：Pablo Neira Ayuso

- nftables 为 netfilter 新一代包过滤框架。
- 官方资源：download、git、lists、bugzilla、workshop、patchwork、wiki。

# nftables 核心要点

- **定位**：nftables 取代 `{ip,ip6,arp,eb}tables`，是基于内核专用 VM 的包分类框架，提供用户态工具 `nft`。
- **复用**：沿用 Netfilter 既有 hook、conntrack、NAT、用户态排队与日志子系统。
- **库**：提供 `libnftables` 高层用户态库，支持 JSON（见 `man 3 libnftables`）。

## 运行依赖
- Linux 内核 ≥ 3.13（推荐更新）
- `libmnl`：最小化 Netlink 库
- `libnftnl`：低层 Netlink 用户态库
- `nft`：命令行工具

## 关键特性
- **VM 编译/反编译**：`nft` 将规则集编译为 netlink 格式的 VM 字节码，经 nftables Netlink API 推入内核；读取时反编译为原始规则集。`nft` 既是编译器也是反编译器。
- **高性能**：通过 maps 和 concatenations 将规则检查次数降至最少，避免线性扫描。
- **内核代码更小**：逻辑集中于用户态 `nft`；升级用户态工具即可交付新功能，无需内核升级。
- **统一语法**：所有协议族语法一致，消除 xtables 的不一致问题。

## 兼容性
- `nft` 语法与传统 `{ip,ip6,eb,arp}tables` 不同。
- 提供向后兼容层，可用原 iptables/ip6tables 语法运行于 nftables 基础设施之上。

- 建议使用较新版本，内核为 nf-next 开发树
- 用户态库：`libmnl`、`libnftnl`
- 用户工具：`nftables`；向后兼容：`iptables`/`ip6tables`
- 文档：nftables HOWTO、manpage

ulogd：Netfilter 子项目（日志守护进程）。官网资源：下载、Git、邮件列表、Bugzilla、Workshop、Patchwork、Wiki。

- **ulogd** 是 netfilter/iptables 的用户态日志守护进程，支持逐包安全日志、记账、逐流日志及用户自定义记账。
- **版本**：`ulogd-1.x` 自 2012 年进入 EOL，生产环境应迁移至 `ulogd-2.x`；开发仅针对 2.x。

**依赖库（ulogd-2.x）**
- `libnfnetlink` / `libmnl`：Netlink 基础通信（`libmnl` 将取代 `libnfnetlink`，过渡期需同时依赖）
- `libnetfilter_log`：基于 `nfnetlink_queue` 的无状态包日志
- `libnetfilter_conntrack`：基于 `nf_conntrack_netlink` 的有状态流日志
- `libnetfilter_acct`：基于 `nfnetlink_acct` + iptables `nfacct` match 的灵活流量记账（需内核 ≥ 3.3.x）

**内核要求**：≥ 2.6.14，强烈建议 ≥ 2.6.18；SQL 输出需对应数据库头文件。

**主要特性**
- 包级与流级流量记账
- 通过 `nfacct` 基础设施实现灵活的用户自定义记账
- SQL 后端：SQLite3、MySQL、PostgreSQL
- 文本输出格式：CSV、XML、Netfilter LOG、Netfilter conntrack

**仓库**
- 2.x 稳定版：`https://git.netfilter.org/ulogd2/`
- 1.x 旧版（EOL）：`https://git.netfilter.org/ulogd/`

**维护**：`Eric Leblond`（维护者）；`Harald Welte`（主要作者）。

- netfilter.org：Linux 内核网络过滤（iptables/nftables）官方项目站。
- 资源入口：下载、Git、邮件列表、Bugzilla、Workshop、Patchwork、Wiki。
- 主页：`https://www.netfilter.org/`

## netfilter.org 核心知识

**项目定位**
- 社区驱动的 FOSS 项目，为 Linux 2.4.x+ 提供包过滤软件
- 关联工具：iptables 及其继任者 nftables

**核心功能**
- 包过滤、NAT/NAPT、包日志、用户态包队列、包改写（mangling）

**netfilter hooks**
- Linux 内核框架，允许内核模块在网络协议栈不同位置注册回调函数
- 经过对应 hook 的每个包都会触发回调

**iptables**
- 通用防火墙软件，定义规则集
- 规则 = 分类器（matches）+ 动作（target）

**nftables**
- iptables 继任者，更灵活、可扩展、高性能的包分类
- 新特性开发主阵地

**主要特性**
- 无状态/有状态包过滤（IPv4/IPv6）
- 各类 NAT/NAPT（IPv4/IPv6）
- 灵活可扩展基础设施，多层 API 供第三方扩展

**应用场景**
- 构建基于无状态/有状态过滤的互联网防火墙及高可用集群
- 用 NAT/masquerading 共享上网、实现透明代理
- 配合 tc/iproute2 构建 QoS 和策略路由
- 修改 IP 头 TOS/DSCP/ECN 位

**nftables 核心价值**
- 单一工具统一语法，替代碎片化的 `{ip,ip6,eb,arp}tables` 和 `ipset`
- 内核侧事务性规则集更新更快，无需用户态锁
- set 比 ipset 更灵活强大，map 进一步扩展
- 规则集完全灵活，无预定义表

- **nftables 核心特性**
  - 任意数量的用户自定义表，隔离规则集为“命名空间”
  - 基础链（base chain）的 hook 与 priority 可配置
  - 规则更灵活：无强制字段（如计数器），支持多动作（如 log 与 drop）
  - ingress hook：链绑定接口，TC 之后早期过滤
  - egress hook：链绑定接口，TC 之前发送路径过滤
  - flowtables 提供软件快速路径与硬件加速
  - 语法内嵌有限脚本能力：定义变量、include 其他文件；通过 JSON 输入/输出支持扩展脚本

- **许可条款**
  - netfilter.org 开发 Linux 内核软件，按 GPL-2.0 及兼容许可发布
  - 用户态库与工具亦为 GPL-2.0，具体以各库/工具条款为准

---
来源：consolidated/security/netfilter 与 iptables.md