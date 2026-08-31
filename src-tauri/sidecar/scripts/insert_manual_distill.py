"""insert_manual_distill.py — 主 agent 手工提炼的章节写入 slim 库（复用 distill 管线）

用法：MANUAL 字典 {fid: 中文提炼正文}；脚本按 fid 反查全量库章节元数据，
走与 distill_knowledge.py 相同的 id/title/url/tags/嵌入管线入库。幂等可重跑。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

SIDECAR = Path(__file__).resolve().parent.parent
os.environ["TDSF_DATA_DIR"] = str(SIDECAR.parent.parent / ".tdsf-data")
sys.path.insert(0, str(SIDECAR))
sys.stdout.reconfigure(encoding="utf-8")

from knowledge.rag import get_slim_rag  # noqa: E402
from knowledge.fts5 import KnowledgeEntry  # noqa: E402

# ---------------------------------------------------------------------------
# 主 agent 手工提炼的中文核心知识点（每章 ≤~600 字，命令原样保留）
# ---------------------------------------------------------------------------
MANUAL: dict[str, str] = {}

MANUAL["slim-c3557f41-7"] = """## Netfilter 双重 NAT HOWTO（核心要点）

**场景**：两个子网使用**重叠地址段**（均为 192.168.150.0/24，公司网 + 不可信网）需要互访。

**单 NAT 失败原因**：Linux 本机路由策略按「直连接口 > 静态路由 > 默认路由」排序——NAT 盒子直连了 192.168.150.0 的"分身"，永远无法路由到真正的 Network 1。

**双重 NAT 方案**：中间引入 192.168.180.0 过渡网，两台 NAT 盒子串联，把重叠地址解耦到独立地址空间：

```
Corp 192.168.150.0 ─ NAT BOX1 (eth1 10.15.15.1) ─ NAT BOX2 (eth1 192.168.150.252) ─ Untrusted 192.168.150.0
```

**实施三步**（示例：访问 Network 3 的 192.168.150.10-12）：

1. **别名 IP**：两台盒子 eth0 各建 3 个别名
   - BOX1: `ifconfig eth0:0 192.168.180.181 netmask 255.255.255.0`（.181-.183）
   - BOX2: `ifconfig eth0:0 10.15.15.181 netmask 255.255.255.0`
2. **BOX1 静态映射**：DNAT 进 + SNAT 出
   ```bash
   iptables -t nat -A PREROUTING -d 192.168.180.181 -i eth0 -j DNAT --to-destination 10.15.15.181
   iptables -A POSTROUTING -s 192.168.150.0/24 -d 10.15.15.0/24 -j SNAT -o eth1 --to-source 10.15.15.1
   ```
3. **BOX2 静态映射**：DNAT 到真实目标 + SNAT 回源
   ```bash
   iptables -t nat -A PREROUTING -d 10.15.15.181 -i eth0 -j DNAT --to-destination 192.168.150.10
   iptables -A POSTROUTING -s 10.15.15.0/24 -d 192.168.150.0/24 -j SNAT -o eth1 --to-source 192.168.150.252
   ```

**易错点**：①忘记开 IP 转发（`net.ipv4.ip_forward=1`）整个链路不通；②基础包过滤先行（RELATED,ESTABLISHED 放行 + NEW 限入），`iptables-save > /etc/sysconfig/iptables` 持久化；③用 ssh 别名地址验证每一跳。"""

MANUAL["slim-c3557f41-8"] = """## conntrack-tools 项目（核心要点）

**定位**：conntrack-tools 是 netfilter 的**连接跟踪用户态工具集**，包含守护进程 `conntrackd` 与命令行 `conntrack`——实现**有状态防火墙集群**（状态同步/冗余）。

**核心命令**：

```bash
conntrack -L                  # 列出连接跟踪表
conntrack -L -p tcp --dport 22 # 过滤查看
conntrack -E                  # 实时监听连接事件
conntrack -F                  # 清空跟踪表
conntrack -D -s 192.168.1.5   # 删除指定源的跟踪项
conntrack -U -s 192.168.1.5 --mark 1 --label web  # 更新标记
```

**conntrackd 三种模式**：
- **FTFW（firewall）**：主备防火墙间同步连接状态，故障切换不丢会话（keeplived 常配合）
- **statistics**：汇总多节点流量统计
- **alarm**：按阈值告警同步

**配置要点**：`/etc/conntrackd/conntrackd.conf` 定义 Sync（组播地址 224.0.0.50、专网接口）与 NFCT（跟踪表 hook）；集群节点需 `Netlink` 事件可靠传输。

**易错点**：①内核需加载 `nf_conntrack_netlink`；②只同步 TCP established 等稳定状态，不做 SYNFlood 场景同步；③`conntrack -S` 查看各 CPU 桶占用，表满（nf_conntrack_max）会丢包——调大需同时看内存。"""

MANUAL["slim-c3557f41-10"] = """## iptables 项目（核心要点）

**定位**：iptables 是 Linux 2.4/2.6 内核包过滤框架 netfilter 的用户态配置工具（取代 ipchains；nftables 为其后继）。

**四表五链**（优先级 raw > mangle > nat > filter）：
- 表：raw（连接跟踪豁免）/ mangle（改包）/ nat（地址转换）/ filter（过滤）
- 链：PREROUTING → INPUT →（转发）FORWARD → POSTROUTING；本机出：OUTPUT → POSTROUTING

**核心语法**：

```bash
iptables -t filter -A INPUT -p tcp --dport 22 -j ACCEPT   # 追加规则
iptables -I INPUT 1 -s 10.0.0.0/8 -j DROP                 # 插入首位
iptables -D INPUT 1                                       # 按序号删
iptables -L -n -v --line-numbers                          # 查看含计数
iptables -F INPUT                                         # 清空链
iptables -P FORWARD DROP                                  # 默认策略
```

**常用匹配模块**：`-m state --state NEW,ESTABLISHED`（ conntrack 状态）、`-m multiport --dports 80,443`、`-m iprange`、`-m limit --limit 5/s`（限速防爆破）、`-m mac --mac-source`。

**NAT**：SNAT（`-t nat -A POSTROUTING -o eth0 -j SNAT --to-source x.x.x.x`，出口固定）与 MASQUERADE（动态 IP）；DNAT（PREROUTING，端口映射）。

**易错点**：①规则自上而下首条命中即止，插入顺序错=规则不生效；②只改 filter 表不影响 nat；③持久化用 `iptables-save/restore` 或 netfilter-persistent；④nftables 迁移：`iptables-translate` 逐条转换。"""

MANUAL["slim-c3557f41-18"] = """## 包过滤 HOWTO（核心要点）

**防火墙设计三原则**：①默认拒绝（policy DROP），逐条放行；②先放行 RELATED,ESTABLISHED（回应流量）；③最小暴露——只开业务端口。

**标准三链骨架**：

```bash
iptables -P INPUT DROP && iptables -P FORWARD DROP
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT                       # 环回必放
iptables -A INPUT -p icmp --icmp-type echo-request -m limit --limit 1/s -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -j ACCEPT           # SSH
iptables -A INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
```

**FORWARD 网关场景**（内网出网）：

```bash
iptables -A FORWARD -i eth-lan -o eth-wan -j ACCEPT
iptables -A FORWARD -i eth-wan -o eth-lan -m state --state RELATED,ESTABLISHED -j ACCEPT
# NAT 上网
iptables -t nat -A POSTROUTING -o eth-wan -j MASQUERADE
```

**SYN 防护与日志**：

```bash
iptables -A INPUT -p tcp --syn -m limit --limit 1/s --limit-burst 4 -j ACCEPT
iptables -A INPUT -m limit --limit 5/m -j LOG --log-prefix "IPT DROP: "
```

**易错点**：①INPUT 影响本机、FORWARD 影响转发，网关机器两条链都要管；②`-m limit` 是令牌桶，`--limit-burst` 决定容忍突发；③规则持久化（重启丢失）；④调试用 `iptables -L -v` 看 pkts 计数定位规则是否命中。"""

MANUAL["slim-f6cac906-20"] = """## kubeadm 证书与控制平面命令（核心要点）

**证书体系**：kubeadm init 生成 PKI 于 `/etc/kubernetes/pki/`（ca.crt/ca.key、apiserver 各组件证书、etcd、front-proxy）。证书默认 **1 年**有效（CA 10 年）。

**证书检查与续期**：

```bash
kubeadm certs check-expiration            # 查看过期时间
kubeadm certs renew all                   # 全部续期（重启控制面 pod）
kubeadm certs renew apiserver kubelet-client  # 指定组件
```

**控制平面常用命令**：

```bash
kubeadm init --pod-network-cidr=10.244.0.0/16 --control-plane-endpoint "LB:6443"
kubeadm token create --print-join-command   # 生成 worker 加入命令
kubeadm token create --print-join-command --certificate-key $(kubeadm init phase upload-certs --upload-certs | tail -1)  # 控制面加入
kubeadm reset                                # 清理节点（含 /etc/cni、iptables 需手动清）
```

**etcd 备份恢复**：

```bash
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /backup/etcd.db
# 恢复: etcdctl snapshot restore + 重启 kube-apiserver/etcd 静态 pod
```

**易错点**：①renew 后必须重启静态 pod（`crictl ps | grep apiserver` → 删 pod 自动重建）或 kubelet；②多控制面证书要逐台 renew；③升级集群（kubeadm upgrade）会自动续证书——1 年期不是问题。"""

MANUAL["slim-a20b1c94-3"] = """## Nginx 缓存指南（核心要点）

**代理缓存三件套**：`proxy_cache_path`（共享内存+目录）→ `proxy_cache`（location 启用）→ 响应头控制。

```nginx
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=mycache:10m
                 max_size=1g inactive=60m use_temp_path=off;

server {
    location / {
        proxy_cache mycache;
        proxy_cache_key "$scheme$request_method$host$request_uri";
        proxy_cache_valid 200 302 10m;      # 按状态码设 TTL
        proxy_cache_valid 404      1m;
        proxy_cache_use_stale error timeout updating;  # 后端挂了用旧缓存
        proxy_cache_background_update on;   # 后台刷新
        add_header X-Cache-Status $upstream_cache_status;  # 调试: HIT/MISS/EXPIRED
    }
}
```

**缓存键与绕过**：默认 key 含 $request_uri；带 Cookie/Authorization 的响应默认不缓存。绕过：`proxy_cache_bypass $cookie_nocache $arg_nocache;`；客户端刷新头 `Cache-Control: no-cache` 用 `proxy_cache_revalidate on` 配合 304。

**清理**：官方无主动 purge（Plus 版有）——开源方案：缓存 key 定向删除模块或 `inactive=60m` 自然淘汰 + `rm -rf` 全量清。

**易错点**：①`proxy_buffering off` 时缓存不生效；②上游响应含 `Set-Cookie` 默认不缓存（可用 `proxy_ignore_headers` 覆盖，慎用）；③磁盘满：max_size+inactive 双控，worker 进程淘汰；④microcaching（短 TTL 如 5s）是高并发站性价比最高的方案。"""

MANUAL["slim-bb781115-17"] = """## fstab（核心要点）

**作用**：`/etc/fstab` 定义文件系统静态挂载（设备/挂载点/类型/选项/dump/fsck 六列）。systemd 时代由 fstab 生成 mount unit，仍以 fstab 为配置源头。

**列结构**：`UUID=xxx  /mnt/data  ext4  defaults,nofail  0  2`

**设备名**：必须用**持久命名**——`UUID=`（`lsblk -f` 或 `blkid` 查）/ `PARTUUID=`/ `LABEL=`；禁用 `/dev/sda1`（重启可能漂移）。

**关键选项**：
- `defaults` = rw,suid,dev,exec,auto,nouser,async
- `noauto`：不随开机挂（配合 systemd automount 手动触发）
- `nofail`：设备缺失不阻塞启动（外置盘/网络盘必加）
- `x-systemd.automount`：首次访问才挂载（大分区/网络盘体验佳）
- `x-systemd.device-timeout=5s`：设备等待超时
- 网络盘加 `_netdev`（等网络就绪）

**fsck 列**：根分区 `1`，其他 `2`（btrfs/XFS 一律 `0`——自身日志校验，无需 fsck）。

**易错点**：①改完先 `mount -a` 或 `findmnt --verify` 验证再重启，写错=启动失败；②swap 行 fsck 列为 0；③临时挂载测试：`mount -o ro /dev/disk/by-uuid/xxx /mnt`。"""

MANUAL["slim-79afa7ad-0"] = """## init 与 systemd（核心要点）

**演进**：SysVinit（串行脚本，/etc/rc?.d）→ Upstart → **systemd**（并行、按需、cgroup 资源管理，PID 1）。

**Unit 类型**：service / socket / timer / mount / target（运行时分组，取代 runlevel）。

**核心命令**：

```bash
systemctl start|stop|restart|status nginx
systemctl enable --now nginx        # 开机自启+立即启动
systemctl disable nginx
systemctl list-units --type=service --state=running
systemctl list-unit-files | grep enabled
systemctl daemon-reload             # 改 unit 文件后必执行
systemctl cat nginx                 # 查看完整 unit（含 drop-in）
systemctl edit nginx                # override.conf 覆写（不改编译版文件）
systemctl isolate multi-user.target # 切换运行级别（等价 init 3）
systemctl get-default / set-default graphical.target
```

**unit 文件三段**：[Unit] 描述与依赖（After=/Requires=/Wants=）、[Service] 执行（Type=simple/forking/oneshot、ExecStart=、Restart=on-failure）、[Install] enable 目标（WantedBy=multi-user.target）。文件位置：/etc/systemd/system（管理员）> /usr/lib/systemd/system（包管理）。

**排错三板斧**：`journalctl -u nginx -b`（本次启动日志）/ `-f`（跟随）/ `-p err`；失败后 `systemctl reset-failed`；进入救援模式 `systemctl rescue`。

**易错点**：①Type=forking 服务必须留 PIDFile，否则 systemd 追踪不到主进程；②timer 取代 cron（`systemctl list-timers`）；③改了 unit 不 daemon-reload = 改了白改。"""

MANUAL["slim-79afa7ad-7"] = """## udisks（核心要点）

**定位**：udisks2 是桌面环境的**磁盘管理守护进程**（D-Bus 服务 org.freedesktop.UDisks2），让文件管理器（Nautilus/Dolphin）免 root 挂载/卸载/格式化 U 盘与移动硬盘。

**命令行工具 `udisksctl`**：

```bash
udisksctl status                     # 块设备概览
udisksctl info -b /dev/sdb1          # 设备详情（文件系统/挂载点/UUID）
udisksctl mount -b /dev/sdb1         # 挂载（polkit 授权，桌面会话免密）
udisksctl unmount -b /dev/sdb1       # 卸载
udisksctl lock/unlock -b /dev/sdb1   # LUKS 加密卷
udisksctl loop-setup -f image.iso    # 挂载 ISO 镜像
```

**与传统工具关系**：底层仍是 mount/umount；udisks 加了 polkit 权限层与桌面通知。服务器/脚本场景直接用 mount（无需 udisks 依赖）。

**屏蔽桌面自动挂载**：udev 规则 `ENV{UDISKS_IGNORE}="1"`（隐藏分区/恢复分区常用）或 `ENV{UDISKS_AUTOOPEN}="0"`。

**易错点**：①SSH 会话里 udisksctl 报 "Not authorized"——polkit 规则限制活动会话才免密（`loginctl` 看 session active）；②卸载报 busy 用 `lsof +f -- /dev/sdb1` 找占用进程；③NTFS 读写需 ntfs-3g。"""


def main() -> int:
    slim = get_slim_rag()
    rag_con = sqlite3.connect(
        str(SIDECAR.parent.parent / ".tdsf-data" / "rag.db")
    )
    rag_con.row_factory = sqlite3.Row

    # 反查每 fid 的章节元数据（同 distill 聚合规则）
    rows = rag_con.execute(
        "SELECT url, title, id, source, category, tags, created_at FROM entries "
        "WHERE category != 'linux-philosophy' ORDER BY url, id"
    ).fetchall()
    ws = re.compile(r"\s+")
    order: dict[str, dict[str, int]] = {}
    meta: dict[tuple, dict] = {}
    for r in rows:
        url = r["url"]
        parts = ws.sub(" ", r["title"] or "").strip().split(" · ")
        sec = parts[1] if len(parts) > 1 else ""
        if url not in order:
            order[url] = {}
        if sec not in order[url]:
            order[url][sec] = len(order[url])
        meta.setdefault((url, sec), r)

    existing = {
        str(x["id"])
        for x in slim._conn.execute("SELECT id FROM entries").fetchall()
    }
    written = 0
    skipped = 0
    for fid, zh in MANUAL.items():
        if fid in existing:
            skipped += 1
            continue
        h = fid.split("-")[1]
        seq = int(fid.split("-")[2])
        match = [
            u for u in order if hashlib.md5(u.encode()).hexdigest()[:8] == h
        ]
        if not match:
            print(f"{fid}: url not found, skip")
            continue
        url = match[0]
        sec = next((k for k, v in order[url].items() if v == seq), "?")
        m = meta.get((url, sec))
        if m is None:
            print(f"{fid}: section meta missing, skip")
            continue
        entry = KnowledgeEntry(
            id=fid,
            source=m["source"],
            title=sec if sec else m["title"],
            content=zh,
            url=url,
            tags=json.loads(m["tags"]) + ["slim", "manual-distill"],
            created_at=m["created_at"] or datetime.now().isoformat(),
            category=m["category"] or "",
            content_zh="",
        )
        ok = slim.add(entry, dedupe=False)
        if ok:
            written += 1
            print(f"written: {fid} ({sec[:40]})")
        else:
            print(f"add failed: {fid}")

    print(f"\n写入 {written}, 已存在跳过 {skipped}, 总块数: {slim.count()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
