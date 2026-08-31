---
source: archwiki
category: basic-ops
url: consolidated/basic-ops/网络基础（Arch Wiki）.md
title: 1. 域名解析
---

- DNS 经 NSS（`getaddrinfo`）解析；`/etc/nsswitch.conf` 的 `hosts` 控制顺序：`files`→`/etc/hosts`，`dns`→`/etc/resolv.conf`。
- 查询：`getent ahosts domain`

## resolver 与 resolv.conf
- 每次解析重读；最多 3 个 nameserver，按序尝试；无缓存/DNSSEC。
- 常用配置：`options timeout:1`（加速切换备用服务器）、`options single-request`（修复 IPv6 5 秒延迟）、`search example.org`（短主机名）。
- 防覆盖：`chattr +i /etc/resolv.conf`
- NetworkManager 持久设置：`nmcli con mod Wired +ipv4.dns-options 'rotate,single-request,timeout:1'`
- 易错点：`drill` 等查询工具需完整 FQDN，不识别 search。

## 查询工具
- `drill domain @nameserver TXT`：指定记录；默认用 resolv.conf 的 nameserver。

## 查询工具
- 独立工具：`doggo`、`q`（GitHub/AUR 获取）
- DNS 服务器自带：
  - `knot` → `khost(1)`、`kdig(1)`
  - `unbound` → `unbound-host(1)`
  - `bind` → `dig(1)`、`host(1)`、`nslookup(1)`
  - `powerdns` → `sdig(1)`
- systemd-resolved 提供 `resolvectl query` 子命令（仅限其自身）

## 解析器性能
- Glibc 解析器**不缓存**查询
- 本地缓存方案：
  - 使用 systemd-resolved，或自建本地缓存 DNS 服务器
  - 在 `/etc/resolv.conf` 中设置 `nameserver 127.0.0.1` 和 `::1`
  - 若用 openresolv，则配置 `/etc/resolvconf.conf`
- 提示：`drill`、`dig`、`kdig` 会报告查询时间；路由器通常自带缓存解析器；若切换 DNS 超时过长，可减小 timeout

## 隐私与安全
- Do53（传统 DNS）**不加密**，存在窃听、响应篡改、DNS 劫持风险
- 对策：
  - 信任可靠的 DNS 服务器，或自建递归解析器
  - 在不受信任的 DHCP 网络中，设置静态 nameserver，或使用 VPN
- 加密协议示例：DNS over TLS（DoT）——需上游服务器与本地解析器均支持

## netctl 核心知识点

- CLI+profile 网络管理器（Arch）。安装 `pacman -S netctl`。
- ⚠️ 勿同时启用冲突服务；查 `systemctl --type=service`。

### 配置
- 配置目录 `/etc/netctl/`，复制后设 `Interface`；无线可用 `wifi-menu`。

### 使用
```bash
netctl start profile
netctl status profile
netctl enable profile
netctl reenable profile
```
- `profile` 为名称非路径；`journalctl -xn` 排查；频繁切换用 special units，不要 enable。

### Special units
- 有线：`netctl-ifplugd@interface`；无线：`netctl-auto@interface`（需 ifplugd）；无线 profile 须 `Security=wpa-configsection|wpa`。
- ⚠️ `Key=` 空/引号错则 unit 挂；曾 enable 需 disable；手动 `netctl-auto`。

### 示例
- 有线：`IP=dhcp` 或 `IP=static`；静态需 `Address=('10.1.10.2/24')`（带 `/24`）。
- 无线 WPA-PSK：
```ini
Interface=wlp2s2
Connection=wireless
Security=wpa
IP=dhcp
ESSID=your_essid
Key=<PSK>
```

- **netctl `Key` 特殊引用**：遵循 `netctl.profile(5)`；若 passphrase 失败，去掉 `Key` 中的 `\"`。注意：仅隐藏明文，有读权限者仍可连接。
- **混淆无线密码**：用 `wpa_passphrase` 生成 256 位 PSK，替换 `Key` 明文。
  ```bash
  $ wpa_passphrase your_essid
  # 取 psk=... 填入 Key
  ```
- **Bonding**：聚合多接口为逻辑接口，支持热备/负载均衡。示例 `/etc/netctl/bond0`：
  ```
  Description='Bond Interface'
  Interface='bond0'
  Connection=bond
  BindsToInterfaces=('eth0' 'eth1')
  IP=dhcp
  IP6=stateless
  ```
  默认 round-robin；设置 `MODE` 可能无效，必要时加载模块时传参。检查状态：`cat /proc/net/bonding/bond0`
- **有线→无线故障转移**：用 `wpa_supplicant`，AP 设桥接模式；bond0 包含有线+无线接口。

**网络连通性检查**：
1. 接口已列出并启用
2. 已连接网络（网线/WLAN）
3. 接口有 IP
4. 路由表正确
5. ping 本地 IP（如默认网关）
6. ping 公共 IP（如 `9.9.9.9`）
7. 解析域名（如 `archlinux.org`）

- 若安装后 ping 不通但网络服务正常，可能主机名变更致设备认证失败（如校园网），等约 2 小时重试。
- ping 示例：`$ ping www.example.com`；注意主机可能不响应 ICMP。

- 确认网络接口已列出并启用；连接有线或无线网络
- 多数网络使用 DHCP 自动获取 IP；若无 DHCP，需手动配置静态 IP、路由表和 DNS
- 安装镜像默认使用：
  - `systemd-networkd`：作为 DHCP 客户端，支持 Ethernet/WLAN/WWAN
  - `systemd-resolved`：提供系统级 DNS

### iproute2
- `iproute2` 是 `base` 依赖，提供 `ip` 命令，用于管理网络接口、IP 地址和路由表
- 注意：`ip` 命令配置**重启后丢失**；持久化需通过脚本 + systemd units 自动化
- Arch 已弃用 `net-tools`，统一使用 `iproute2`

常用命令：
```bash
# 列出 IP 地址
ip address show

# 添加 IP 地址到接口
ip address add <IP>/<前缀> dev <接口>
```

### 静态 IP 配置
- 可用网络管理器或 `dhcpcd` 配置
- 手动配置需完成：
  1. 添加 IP 地址（`ip address add`）
  2. 设置路由表（`ip route`）
  3. 配置 DNS 服务器（如 `/etc/resolv.conf`）

- `ip address add <address>/<prefix_len> broadcast + dev <interface>`
- 地址用CIDR，`+`自动推导广播地址
- 手动IP勿与DHCP冲突
- 删除：`ip address del`（参数同add）

**关键命令**
```bash
ip address flush dev <interface>
ip route show
ip -6 route show
```

**核心要点**
- 清空接口 IP：`ip address flush dev <interface>`
- 路由表决定直连或经网关，无匹配时走默认网关
- `PREFIX` 为 CIDR 或 `default`
- 路由管理用 `ip-route`
- IPv4 地址计算可用 `ipcalc`

### 自动网络配置与网络管理器

- 自动配置用 DHCP 获取 IP、网关、DNS；可用 `dhcping` 检测 DHCPv4 服务器。
- **每个网络接口只能由一个 DHCP 客户端或网络管理器管理**，避免冲突。
- 常用客户端：`dhclient`（Ethernet/PPPoE）、`dhcpcd`（Ethernet，可启动 `wpa_supplicant`，写 `/etc/resolv.conf` 或调用 resolvconf）。

### NTP 守护进程

- NTP 同步系统时钟，公网精度数十毫秒，局域网 1 毫秒。
- 安装 `ntp` 包，默认客户端模式。
- 配置 `/etc/ntp.conf`；服务器按 stratum 分层（stratum 0 独立时间源，通常用 stratum 2）。选择就近服务器池，如：
  ```
  server 0.fr.pool.ntp.org iburst
  server 1.fr.pool.ntp.org iburst
  ```
- `iburst` 推荐：首次失败才发突发包；`burst` 首试也突发，需授权，否则可能被拉黑。
- 闰秒文件：`leapfile /usr/share/zoneinfo/leap-seconds.list`
- 服务器模式：启用 orphan 模式，断网继续服务：`tos orphan 15`
- `restrict` 控制访问，典型：
  ```
  restrict default nomodify nopeer noquery
  restrict 127.0.0.1
  ```
  `nomodify` 禁止重配置；`noquery` 防止状态被 dump；可加 `kod limited notrap`。
- **易错点**：`noserve` 完全停止时间同步；`restrict` 默认允许查询，除非加 `noserve`。
- 强制地址族：`-4` IPv4，`-6` IPv6，如 `restrict -6 ::1`。

**NTP 要点**
- `driftfile /var/lib/ntp/ntp.drift` 记偏差；`logfile` 可选
- `server 0.arch.pool.ntp.org iburst`；`tos orphan 15`
- `restrict default kod limited nomodify notrap nopeer noquery`（`-6` 同）
- 另 `restrict 127.0.0.1`、`-6 ::1`
- 默认客户端模式并降权，控制台加 `-u`

- `ntpd -u ntp:ntp`：两个 systemd 服务使用 `-u` 指定用户/组，并加 `-g` 禁用 panic-gate 阈值，即使服务器时间偏差过大也会同步。
- ⚠️ 首次同步前若无历史时钟，建议先停止易受时间跳变影响的后台任务。
- 服务依赖网络解析器，检测到活动连接后开始同步。

- 开机启动：启用 `ntpd.service`；但 `timedatectl set-ntp 1` 会意外停止 `ntpd.service`（其只控制系统 timesyncd）。
- 检查同步：`ntpq -p`；`delay/offset/jitter` 应为非零，前缀 `*` 表示已同步服务器，最长需 1024 秒。

- 一次性同步：启用 `ntpdate.service`（`-q` 非驻留，`-n` 非 fork）；不适合长期运行的服务器。若需写入硬件时钟，添加覆盖：
```ini
/etc/systemd/system/ntpdate.service.d/hwclock.conf
[Service]
ExecStart=/usr/bin/hwclock -w
```

- 网络触发：netctl profile 加 `ExecUpPost="systemctl start ntpd.service"`、`ExecDownPre="systemctl stop ntpd.service"`；NetworkManager 可用 `networkmanager-dispatcher-ntpd` AUR；KDE 需先禁用 ntpd 再用时钟设置。

- GPS：ntpd ≥4.2.8 直接连接 `gpsd`（需安装），在 `/etc/ntp.conf` 添加相应配置，优于传统 SHM 方式。

## NTP GPSD 驱动（driver46）

- 配置：
```
server 127.127.46.0
fudge 127.127.46.0 time1 0.0 time2 0.0 refid GPS
```
- 验证：`cgps -s`；`ntpq -p`。
- 易错：`reach=0` 未连通 gpsd；GPS 须支持 PPS（`ppscheck /dev/gps0`）；USB 设备 `ln -s /dev/ttyUSB0 /dev/gps0`。

## NetworkManager

- 安装：
```
pacman -S networkmanager
systemctl enable --now NetworkManager.service
```
  附带 `nmcli`、`nmtui`。
- 易错：
  - WiFi 密码默认 root/GUI 可读。
  - 每接口仅一个 DHCP 客户端/网络管理器，查 `systemctl --type=service`。
  - 未启用 systemd-resolved 会刷 `dbus-org.freedesktop.resolve1.service not found`。
- 常用：
```
nmcli device wifi list
nmcli device wifi connect SSID_or_BSSID password password
nmcli device wifi connect SSID_or_BSSID password password hidden yes
```

## NetworkManager nmcli

- 连接 Wi-Fi：`nmcli device wifi connect <SSID> password <密码> ifname wlan1 <配置名>`
- 断开接口：`nmcli device disconnect ifname eth0`
- 查看连接：`nmcli connection show`
- 激活连接：`nmcli connection up <名称或UUID>`
- 自动连接：`nmcli connection modify <名称> connection.autoconnect yes`
- 删除连接：`nmcli connection delete <名称或UUID>`
- 查看设备状态：`nmcli device`
- 关闭 Wi-Fi：`nmcli radio wifi off`

**编辑连接**
- 交互式：`nmcli connection edit '连接名'`
- 修改属性：`nmcli connection modify '连接名' setting.property value`（例：`ipv4.route-metric 200`；移除设值为 `""`）
- 配置文件：`/etc/NetworkManager/system-connections/`，编辑后执行 `nmcli connection reload`
- TUI：`nmtui`

## Samba 服务器

- 安装 `samba`
- 手动创建 `/etc/samba/smb.conf`，启动 `smb.service` 前必须就绪
- 易错点：
  - 默认 `log file` 不可写：改为 `log file = /var/log/samba/%m.log` 或 `logging = systemd`
  - `workgroup` 需匹配 Windows 工作组（默认 `WORKGROUP`）
  - 示例 `[homes]` 暴露主目录且可写，应注释
- 配置检查：`testparm`
- 启动并启用服务：`smb.service`

- 通过 NetBIOS 主机名访问：在 `smb.conf` 设置 `netbios name`，并启用/启动 `nmb.service`。注意：`nmb.service` 非必需，但某些主机需按主机名访问；若网络仅含 Win10+，可另装 WSD 守护进程以显示在“网络”视图。
- 使服务器可被发现：安装 `avahi`，启用/启动 `avahi-daemon.service`（Zeroconf）。适用于 macOS Finder、Linux/BSD GUI 文件管理器等。不运行 avahi 时仍可经 IP/域名直连，仅不自动发现。
- 替代方案：`systemd-resolved` 提供类似 Zeroconf 功能，确保其 mDNS 已启用：

```ini
/etc/systemd/resolved.conf
[Resolve]
```

#### 启用 systemd-resolved 的 DNS-SD
- 在 `/etc/systemd/resolved.conf` 设置：`MulticastDNS=yes`
- 创建服务定义 `/etc/systemd/dnssd/smb.dnssd`：
```ini
[Service]
Name=%H
Type=_smb._tcp
Port=445
TxtText=
```
- 重载 `systemd-resolved` 生效；规避 Avahi 主机名不稳定 bug。

#### 防火墙放行 Samba
需开放端口：`137-139` + `445`。

**UFW**：默认含 `CIFS` profile，直接：
```bash
ufw allow CIFS
```
若 profile 缺失，创建 `/etc/ufw/applications.d/samba` 并加入：
```
ports=137,138/udp|139,445/tcp
```
然后：
```bash
ufw app update Samba
ufw allow Samba
```

**firewalld**：在 home 区域放行 Samba 服务。

- **防火墙**：`firewall-cmd --permanent --add-service={samba,samba-client,samba-dc} --zone=home`
  - `samba`：文件共享；`samba-client`：浏览网络共享；`samba-dc`：AD 域控制器。
  - `--permanent`：重启 firewalld 后仍生效。

- **用户管理**：
  - Samba 使用本地 `tdbsam` 数据库；也可绑定 AD 域、作 DC 或配 LDAP。
  - 添加 Samba 用户需先有 Linux 用户账户（现有或新建）。
  - 系统 `nobody` 用户/组默认作为 `guest account`，用于 `guest ok = yes` 共享，免登录。
  - Samba 密码独立于 Linux 密码；将 `samba_user` 替换为所选 Samba 账户。

- 创建 Samba 用户：`smbpasswd -a samba_user`
- 依服务器角色，可能需调整文件权限/属性
- 仅允许 Samba 访问：
  - 禁用 shell：`usermod --shell /usr/bin/nologin --lock samba_user`
  - 禁用 SSH：编辑 `/etc/ssh/sshd_config`，设置 `AllowUsers`
- 列出用户：`pdbedit`

### 匿名 guest 共享
- 创建禁止登录的 Linux 用户（任意有效用户名，无需是 Samba 用户）：
```bash
useradd guest -s /usr/bin/nologin
```
- `smb.conf` 核心配置：
```ini
[global]
security = user
map to guest = bad user
guest account = guest

[guest_share]
    path = /tmp/
    public = yes
    only guest = yes
    writable = yes
    printable = no
```
- 匿名用户映射为 `guest`，可访问 `path` 指定目录；共享名可任意。
- 确保 `guest` 对共享路径有权限，并正确按共享定义配置。

### 进阶配置
- **启用符号链接**（有安全风险）：
```ini
[global]
follow symlinks = yes
wide links = yes
unix extensions = no
```
  重启 `smb.service`；若用 AppArmor 且链接指向家目录外，需改 AppArmor 权限。
- **macOS 服务端复制**（避免数据在服务器与客户端间传输，默认开启但对 macOS 无效）：
```ini
[global]
fruit:copyfile = yes
```
  重启 `smb.service`。

### Usershares（可选，非 root 用户可管共享）
```bash
mkdir /var/lib/samba/usershares
groupadd -r sambashare
chown root:sambashare /var/lib/samba/usershares
chmod 1770 /var/lib/samba/usershares  # 含 sticky bit，防止删除他人共享
```

- SSH：加密网络协议，用于在不安全网络上安全运行网络服务；典型应用为远程登录与命令行执行。
- 可承载服务：Git、rsync、X11 forwarding；始终使用 SSH 的服务：SCP、SFTP。
- 服务端默认监听 TCP 端口 22；客户端用于连接 `sshd` 守护进程。现代操作系统普遍内置。

## 常用软件

- **OpenSSH** — 最主流的 SSH 实现（服务端 + 客户端）
- **Dropbear** — 轻量级 SSH 服务端；命令行客户端为 `dbclient(1)`
- **TinySSH** — 极简 SSH 服务端，仅实现 SSHv2 子集，依赖仅 glibc
- **PuTTY** — 终端集成 SSH/Telnet 客户端

## 安全要点

- 加固策略参见 Security#SSH 章节。
- 常与终端复用器（tmux/screen）配合使用。
- 注意检查 SSH 密钥指纹格式，防止中间人攻击。

- TLS 前身 SSL 已弃用；Arch 默认 OpenSSL，GnuTLS 多作依赖。
- 主要实现：OpenSSL（通用密码库）、GnuTLS（TLS/DTLS+X.509）、NSS（Mozilla，智能卡）、mbed TLS（嵌入式）、LibreSSL（OpenBSD fork）。
- CA 机制：客户端用 CA 自签公钥验证服务器证书。Arch 默认 Mozilla CA 库（`ca-certificates`）。集中接口：`/usr/lib/pkcs11/p11-kit-trust.so`（p11-kit）；证书在 `/usr/share/ca-certificates/trust-source/`、`/etc/ca-certificates/trust-source/`。命令 `trust`；非 PKCS#11 库用 `update-ca-trust`（ca-certificates-utils），复制至 `/etc/ca-certificates/extracted/`、`/etc/ssl/certs/`。
- 加载方式：OpenSSL 硬编码 `/etc/ssl/cert.pem`、`/etc/ssl/certs/`；GnuTLS 经 PKCS#11 `trust-policy: yes`；NSS 自动从动态 PKCS#11 模块加载；mbed TLS 需手动加载；LibreSSL 硬编码 `/etc/libressl/cert.pem`、`/etc/libressl/certs/`。
- 易错：LibreSSL 用自己的 CA 证书集，非系统默认。

- 信任管理用 `trust(1)`，基于 PKCS #11（`trust-policy: yes`，按 `priority:` 排序）；改库后运行 `update-ca-trust(8)` 使非 PKCS #11 库生效。
- 列出：`trust list`。
- 添加：`trust anchor certificate.crt`（支持 persistence/DER/PEM/OpenSSL trusted，存入首个可写 token）。
- 移除：`trust anchor --remove 'pkcs11:id=%00%11%22%33%44%55%66%77%88%99%AA%BB%CC%DD%EE%FF%00%11%22%33;type=cert'`（按 PKCS #11 ID）。
- 默认库 `p11-kit-trust.so` 含 blocklist `/etc/ca-certificates/trust-source/blocklist/`，其中证书全局不信任；禁用默认 CA：`trust extract --format=pem-bundle --filter='pkcs11:id=...;type=cert' /etc/ca-certificates/trust-source/blocklist/untrusted_authority.pem`。
- 生成私钥前设 `umask 077`（Arch 的 openssl 未保护 `/etc/ssl/private`）。密钥算法：椭圆曲线（如 Curve25519）现代、性能好，256 位可到 2030 年；RSA 兼容性高但依赖因数分解，安全性可能减弱。

---
来源：consolidated/basic-ops/网络基础（Arch Wiki）.md