---
source: firewalld-docs
category: security
url: consolidated/security/firewalld 防火墙.md
title: firewalld 防火墙
---

- zone 关联连接/接口/源；默认 zone 兜底
- runtime/permanent 分离；永久生效

`firewall-cmd --zone=public --add-service=http --permanent`

- 两层设计：**核心层**（配置 + 后端：iptables/ip6tables/ebtables/ipset/模块加载）+ **D-Bus 层**（主要管理接口）。
- 工具分工：
  - `firewall-cmd`、`firewall-config`、`firewall-applet` 走 D-Bus。
  - `firewall-offline-cmd` 直接经核心层修改配置文件；firewalld 运行时也可用，但不推荐（永久配置约 5 秒后生效）。
- 与 NetworkManager：不依赖但推荐使用。不用 NM 时：
  - 无网络设备重命名通知。
  - firewalld 在网络启动后才运行，则已有接口不会自动绑定 zone。
- 手动绑定接口：
  ```bash
  firewall-cmd [--permanent] --zone=zone --add-interface=interface
  ```
- 易错点：若存在 `/etc/sysconfig/network-scripts/ifcfg-<interface>`，其中的 `ZONE=zone` 必须与命令指定的 zone 一致（或都为空/缺失），否则行为未定义。

- Firewalld：有状态、基于区域，用策略/区域组织规则，覆盖输入/转发/输出过滤及 NAT。
- 区域：流量仅进入/离开一个区域；区域定义信任级别；区域内默认允许，区域间默认拒绝（可配置）。

### 策略（有状态、单向）
- 策略关联 ingress/egress 区域，返回流量隐式放行。
- 创建并放行全部流量：
```bash
firewall-cmd --permanent --new-policy myPolicy
firewall-cmd --permanent --policy myPolicy --add-ingress-zone internal
firewall-cmd --permanent --policy myPolicy --add-egress-zone external
firewall-cmd --permanent --policy myPolicy --set-target ACCEPT
firewall-cmd --reload
```
- 放行服务用 `--add-service`。

### 区域到本机（HOST）
- 区域隐式提供本机输入策略，简单场景无需显式策略。

### 运行时与永久配置
- 永久配置加 `--permanent` 并 `--reload` 生效；reload 不中断连接。
- 省略 `--permanent` 只改运行时，reload 后丢失。

- 配置区域：firewall-config / firewall-cmd / D-BUS，或复制/创建区域文件。
- 目录：
  - 默认/回退：`/usr/lib/firewalld/zones`
  - 用户自定义：`/etc/firewalld/zones`

## 连接、接口与源

- 区域可绑定到**连接、网络接口、源地址**三类对象。

### 为连接设置区域
- 基于 ifcfg 的系统：在 ifcfg 文件中用 `ZONE=` 选项指定；缺失或为空则使用 firewalld 默认区域。
- NetworkManager 管理的连接：可用 `nm-connection-editor` 修改区域。

### NetworkManager 管理的连接
- 内核防火墙**只能识别网络接口，不能识别 NetworkManager 的连接名**，因此 NetworkManager 需将连接使用的接口告知 firewalld，并分配到该连接配置所定义的区域。
- 分配发生在**接口启用之前**。
- 配置中未指定区域 → 接口归入 firewalld 默认区域。
- 一个连接含多个接口时，所有接口都会交给 firewalld；接口改名也由 NetworkManager 同步给 firewalld。
- 连接断开时，NetworkManager 通知 firewalld 取消区域分配。
- firewalld 启动或重启时，NetworkManager 会收到通知并按上述规则重新分配。

### network scripts 管理的连接（局限）
- **无守护进程**通知 firewalld 添加连接，仅在 `ifcfg-post` 脚本中执行分配。
- 接口改名无法同步给 firewalld。
- 连接已激活时重启 firewalld 会**丢失区域关系**。
- 缓解方案：将所有未显式设置区域的连接推入默认区域。

**默认区域**：未显式绑定/分配到其他区域的连接、接口或源使用的区域。
- 未分配区域时，仅默认区域生效。
- 默认区域可能不显式列出（实际仍使用），取决于接口管理器。
- NetworkManager 管理的连接：以 NM 请求形式为接口添加区域绑定。
- network 服务管理的接口：同样列出（因服务请求）。

配置目录：
- `/usr/lib/firewalld`：默认/回退配置（icmptypes, services, zones）。勿修改，包更新即丢失；额外配置可由包提供或自建文件。
- `/etc/firewalld`：系统/用户配置，覆盖默认，由管理员或配置接口生成。

手动修改预定义项：从默认目录复制对应文件到 `/etc/firewalld` 相应目录，再修改。

若 `/etc/firewalld` 不存在或无配置，则使用默认配置及 `firewalld.conf` 默认设置。

## 7. 选项

- `<zone>` 一次，可选 `version`；`target="ACCEPT|%%REJECT%%|DROP"`（默认 REJECT）。含：`interface name`（fallback）、`source address|mac|ipset`（不支持主机名）、`service name`、`port port+protocol`、`protocol value`、`icmp-block name`、`icmp-block-inversion`（反转，每 zone 一次）、`masquerade`（仅IPv4）、`forward-port`（仅IPv4，本地 `to-port`，远程 `to-addr`）、`source-port`、`rule` 富规则：

```xml
<rule [family="ipv4|ipv6"]>
  [<source address="..." [invert="True"/>]
  [<destination address="..." [invert="True"/>]
  [<service name="..."/> | <port .../> | <protocol .../> | <icmp-block .../> | <masquerade/> | <forward-port .../> | <source-port .../>]
  [<log [prefix="..." level="..."] [<limit value="rate/duration"/>]/> | <nflog .../> | <audit>]
  [<accept/> | <reject [type="..."]/> | <drop/> | <mark set="..."/>]
</rule>
```

- 源黑白名单规则须含 `<source>` 与 `<accept|reject|drop>`。

- firewall-applet：firewalld 托盘小程序，显示默认 zone 及 zone 绑定（连接/接口/源）。
- 支持左右键菜单、悬停 tooltip。
- 已移植至 Qt5（Gtk3 StatusIcon 已弃用）。
- Gnome3 限制：通知后图标自动隐藏且无法检测；tooltip 不可见；菜单可能不可用/不可见。

- **firewall-cmd**：firewalld 主 CLI，查询/修改运行时（runtime）与永久（permanent）配置。
- 依赖 **polkit** 认证；仅 firewalld 运行时可使用；服务可用其替代 iptables 调用。
- 常用命令：

```bash
firewall-cmd --version                    # 版本
firewall-cmd --help                       # 帮助
firewall-cmd --state                      # 运行状态
firewall-cmd --get-active-zones           # 活动区域及绑定接口
firewall-cmd --get-zone-of-interface=em1  # 接口所属区域
```

- 完整用法见 `firewall-cmd` man page。

## firewall-config

firewalld 图形化配置工具。

- 左侧：活动绑定（zone+connection/interface/source）概览；仅可切换 zone，不能新增绑定
- 新增绑定：右侧 `Zones` 面板的 `Interface` / `Source` 标签页
- `Configuration` 下拉菜单：`Runtime` 与 `Permanent` 模式
- 仅 `Permanent` 模式出现额外图标行（服务参数不可在 runtime 模式下修改）
- 永久模式修改不立即生效：需 reload firewalld，或同时在 runtime 模式应用

`firewall-offline-cmd`：firewalld 未运行/未激活时配置的工具（系统安装、chroot 等场景）。

- 需 root；只能查看/修改**永久配置**（基于文件 IO）。
- firewalld 运行时也可用，但不推荐；改动约 5 秒后生效。

```bash
firewall-offline-cmd --version
firewall-offline-cmd --help
firewall-offline-cmd --get-zone-of-interface=em1   # 默认 no zone
```

易错：仅操作永久配置，不处理运行时配置。

`/etc/firewalld/firewalld.conf` 为 firewalld 基础配置；文件缺失时使用内置默认值。

- **DefaultZone=public** — 默认 zone，未绑定其他 zone 的流量由其处理
- **MinimalMark=100** — direct 接口可用的最小 mark 值；需更多空闲 mark 时调大
- **CleanupOnExit=yes** — 退出/停止时清理防火墙配置；设为 `no`/`false` 则不清理
- **Lockdown=no** — 启用后 D-Bus 接口变更仅限白名单应用（lockdown-whitelist.xml）
- **IPv6_rpfilter=yes** — IPv6 反向路径过滤：回复经同一接口发出则接受，否则丢弃；IPv4 由 sysctl 的 rp_filter 控制
- **IndividualCalls=no** — 不使用合并的 `-restore` 调用，改用单独调用；降低速度但便于调试
- **LogDenied=off** — 在 INPUT/FORWARD/OUTPUT 链的 reject/drop 规则前及 zone 内加日志；值：`all`/`unicast`/`broadcast`/`multicast`/`off`

列出配置格式：

```
DefaultZone=public
MinimalMark=100
CleanupOnExit=yes
Lockdown=no
IPv6_rpfilter=yes
IndividualCalls=no
LogDenied=off
```

- **firewalld**：动态管理防火墙，支持 zone 定义网络/接口信任级别；支持 IPv4、IPv6、以太网桥、IP set。
- **运行时与永久配置分离**：
  - 运行时配置立即生效，无需重启服务；仅在下次 reload/restart 或系统重启前有效。
  - 永久配置在 reload/restart/重启后重新加载。
  - 可在运行时评估测试，完成后保存为永久配置。
- **D-Bus 接口**：供服务、应用、用户直接修改防火墙；工具如 `firewall-cmd`、`firewall-config`、`firewall-applet` 均通过此接口工作。
- **核心特性**：
  - 完整 D-Bus API；IPv4/IPv6/桥/ipset；IPv4/IPv6 NAT。
  - 防火墙 zone；预定义 zone、服务、icmptypes。
  - zone 内支持：服务、端口、协议、源端口、伪装、端口转发、ICMP 过滤、富规则、接口、源地址处理。
  - 服务定义：端口、协议、源端口、模块（netfilter helper）、目标地址。
  - 富语言（Rich Language）用于灵活复杂规则；定时防火墙规则；被拒数据包简单日志。
  - Direct 接口；Lockdown（白名单限制可修改防火墙的应用）；自动加载内核模块。
  - Puppet 集成；命令行客户端（在线/离线配置）；gtk3 图形工具；Qt5 applet。
- **默认使用发行版**：RHEL 7+、CentOS 7+、Fedora 18+、SUSE 15+、OpenSUSE 15+。
- **支持 firewalld 的应用/库**：NetworkManager、libvirt、podman、docker（仅 iptables 后端）、fail2ban。

- ipset：将多个 IP/MAC 地址分组，减少防火墙规则数
- family 决定地址类型：`inet`（默认，IPv4）/ `inet6`（IPv6）
- 同一 ipset 内地址必须同为 IPv4 或 IPv6，不可混用
- 典型用法：大量地址的 allow/block 规则缩减为少量规则
- 选项、示例及更多配置见 `firewalld.ipset` 手册页

### 策略集（Policy Sets）
预定义策略集（如网关），默认禁用。
激活：`firewall-cmd --policy-set gateway --remove-disable`
转发示例：
```bash
firewall-cmd --permanent --policy gateway-world-to-HOST \
             --add-forward-port port=2222:proto=tcp:toport=22:toaddr=10.0.0.22
firewall-cmd --reload
```

### StrictForwardPorts 严格转发端口
控制容器发布端口是否默认放行，配置于`/etc/firewalld/firewalld.conf`：
```
StrictForwardPorts=no   # 默认no，隐式放行；yes仅放行显式转发端口
```
`yes`时容器发布端口全阻，需显式添加；容器IP动态，运行时获取：
```bash
CONTAINER_IP=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' <container_name>)
firewall-cmd --zone public --add-forward-port=port=8080:proto=tcp:toport=80:toaddr=${CONTAINER_IP}
```

### Docker 严格过滤（配合firewalld）
`daemon.json`设`"iptables": false`，重启主机（仅重启Docker不够）。Docker不自动创建规则，随后自定义zone：
```bash
firewall-cmd --permanent --zone docker --add-source 172.17.0.1/16
```

**firewalld 管理 Docker 网络**

Docker 弃用 iptables 后 `--publish` 失效，改用 firewalld。

容器外网访问：新建策略 `dockerToWorld`，ingress `docker`，egress `ANY`，target `ACCEPT`，加 masquerade。

端口转发：
```bash
firewall-cmd --permanent --new-policy dockerFwdPort
firewall-cmd --permanent --policy dockerFwdPort --add-ingress-zone ANY
firewall-cmd --permanent --policy dockerFwdPort --add-egress-zone HOST
firewall-cmd --permanent --policy dockerFwdPort --add-forward-port port=8080:proto=tcp:toport=80:toaddr=172.17.0.2
```
- 最后 `firewall-cmd --reload`；需提前知道容器 IP；容器内 `apt update` 验证。
- 旧版 v2.0.z 前 egress 用 ANY。

firewalld 预定义区域按信任级别从低到高：

- `drop`：丢弃所有入站包，无回复；仅允许出站连接。
- `block`：入站连接被拒，IPv4 返回 `icmp-host-prohibited`，IPv6 返回 `icmp6-adm-prohibited`；仅本系统发起的连接可通。
- `public`：公共场合，不信任其他主机，仅接受选定入站连接。
- `external`：外部网络，启用 IPv4 `masquerading`（常用于路由器），不信任其他主机，仅接受选定入站连接。
- `dmz`：非军事区主机，可公开访问，但对内网访问受限；仅接受选定入站连接。
- `work` / `home` / `internal`：工作/家庭/内部网络，基本信任其他主机，但仅接受选定入站连接。
- `trusted`：接受所有网络连接。

关键点：
- 区域按信任度排列，从 `drop` 到 `trusted`；除 `trusted` 外，默认均只放行选定流量。
- `drop` 静默丢弃；`block` 返回拒绝消息。
- `external` 适合路由器场景，启用 IPv4 掩蔽。
- 出站连接在多数区域默认允许。

## 运行时与永久配置

- **运行时配置**：当前实际生效、作用于内核。firewalld 启动时由永久配置载入；运行时修改**不自动保存**，服务停止则丢失；reload 会用永久配置替换运行时配置，并恢复已更改的 zone 绑定。
- **永久配置**：存于配置文件；机器开机或服务 reload/restart 时加载为新的运行时配置。
- **运行时 → 永久迁移**：调试完成后可迁移，支持 `firewall-config` 与 `firewall-cmd`：

```bash
firewall-cmd --runtime-to-permanent
```

- **易错点**：运行时配置若出错，执行 firewalld reload/restart 即可恢复到永久配置。

- firewalld service = 本地端口/目的地列表；可含 helper 模块，启用时自动加载
- 预定义服务简化启用/禁用访问
- 详细配置见 `firewalld.service` man page

- firewalld 是动态防火墙守护进程，以 zone 为网络/连接/接口/来源分配信任等级。
- 支持 IPv4、IPv6、以太网桥接、IPSet。
- 运行时配置与永久配置分离。
- 提供接口供服务/应用直接添加 iptables、ip6tables、ebtables 规则。

重载：

```bash
firewall-cmd --reload
killall -HUP firewalld   # 等价，发送 SIGHUP
```

- 选 zone：按网络信任度匹配。公共 Wi-Fi 宜用不可信 zone；有线家庭网络应较可信。
- 配置/添加 zone 的接口：`firewall-config`、`firewall-cmd`、D-BUS（`FIREWALLD.DBUS(5)`）、编辑 zone 文件（`FIREWALLD.ZONE(5)`）。
- zone 文件目录：
  - `/etc/firewalld/zones`：用户自定义/修改。
  - `/usr/lib/firewalld/zones`：默认/回退配置。

**Zone（防火墙区域）**
- 定义连接/接口/源地址绑定的**信任级别**
- 约束关系：一个连接/接口/源只能属于**一个** zone；一个 zone 可用于**多个**连接/接口/源
- 相关主题：预定义 Zone、连接/接口/源、Zone 配置、默认 Zone、Zone 使用、选项、示例
- 更多配置见 man 手册：`firewalld.zone`

---
来源：consolidated/security/firewalld 防火墙.md