---
name: network-troubleshoot
description: Linux 网络配置与故障定位 Skill，分层诊断网卡、地址、路由、网关、DNS、HTTP 和虚拟机网络模式
version: 1.0.0
author: TDSF
tags: [linux, network, dns, routing, networkmanager, virtualization]
---

# Linux 网络配置与故障定位

## When to use

- `dnf` / `yum` / `apt` / `curl` / `wget` 下载失败、卡住或域名解析失败
- 网卡没有地址、默认路由缺失、网关不可达、DNS 异常
- 用户需要配置静态 IP、DHCP、NetworkManager 连接
- Linux 运行在 VMware、VirtualBox、Hyper-V、KVM 等虚拟机中，疑似 NAT、桥接或 Host-only 配置错误

## Workflow

1. **先识别环境，不先改配置**
   - `systemd-detect-virt || true`
   - `cat /sys/class/dmi/id/product_name 2>/dev/null`
   - `ip -br link && ip -br addr`
   - `nmcli -t -f NAME,DEVICE,TYPE,STATE connection show --active 2>/dev/null`
2. **从近到远分层诊断**
   - 链路：目标网卡是否 `UP`，是否有预期 IPv4/IPv6 地址
   - 路由：`ip route` 是否有默认路由，出口接口和源地址是否合理
   - 邻居/网关：`ip neigh show`；先测试默认网关，`INCOMPLETE`/`FAILED` 表示二层不可达
   - DNS：读取 `/etc/resolv.conf`，用 `getent ahosts <domain>` 验证系统解析链
   - TCP/HTTP：`curl --connect-timeout 5 --max-time 15 -I <url>`，区分 DNS、连接、TLS、HTTP 错误
3. **定位责任边界**
   - 网卡 down 或无地址：处理虚拟机内 NetworkManager/网卡配置
   - 默认网关邻居为 `INCOMPLETE`，但同网段其他地址可达：优先判断宿主机虚拟交换机、NAT、桥接或 Host-only 设置
   - IP 可达但域名失败：处理 DNS，不要把 DNS 问题误判为公网不通
   - 网关可达但 TCP 失败：继续检查上游路由、防火墙、代理和仓库源
4. **需要虚拟机外部设置时暂停询问**
   - 用 `ask_user` 提问卡确认虚拟化平台和期望网络模式（NAT/桥接/Host-only）
   - 明确告诉用户应在宿主机哪一层检查；Agent 不得假装已修改宿主机设置
5. **修改前保留回滚信息，修改后逐层复验**
   - 记录活动连接、原地址、路由、DNS
   - 网络写操作按当前 Agent 审批模式执行
   - 复验顺序：链路 → 地址 → 网关 → DNS → TCP/HTTP → 原始业务命令

## Safety rules

- 不以单次 `ping` 作为网络正常或异常的唯一证据；ICMP 可能被禁用。
- 不盲目覆盖 `/etc/resolv.conf`；先确认它是否由 NetworkManager、systemd-resolved 或其他服务管理。
- 不直接停用承载当前 SSH 会话的连接；变更活动网卡前必须说明断联风险并获得确认。
- 包管理器失败后先诊断网络，不连续重试相同安装命令。
- 动态安装命令保持前台执行并使用足够的工具超时，依赖 SSH 原生实时输出观察进度。

## Verification

- `ip -br addr`：目标接口状态和地址正确。
- `ip route get <target>`：出口接口、网关、源地址正确。
- `getent ahosts <domain>`：系统 DNS 解析成功。
- `curl --connect-timeout 5 --max-time 15 -I <url>`：目标 TCP/HTTP 可达。
- 重新执行最初失败的 `dnf` / `apt` / `curl` 命令，并以退出码和完整输出确认恢复。
