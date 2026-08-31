---
source: kubernetes-docs
category: services
url: consolidated/services/容器编排（Kubernetes）.md
title: 容器编排（Kubernetes）
---

- 核心对象：Pod、Deployment、Service、Namespace、Label/Selector、Annotation、Finalizer  
- 关键命令：`kubeadm init --pod-network-cidr`、`kubeadm join`、`kubectl apply/delete/get`  
- 高可用：多控制面+etcd；PKI 证书有效期；kubelet 配置与 kubeadm 一致  
- 安全：Pod Security Standards、命名空间隔离、多区域推荐标签

- **Annotations** 用于为 Kubernetes 对象附加任意非标识性元数据；**不用于**选择/识别对象（选择用 Labels）。
- 与 Labels 相同，Annotations 是 key/value 映射；**键和值必须为字符串**（不可用数值、布尔、列表等类型）。

```json
"metadata": {
  "annotations": {
    "key1" : "value1",
    "key2" : "value2"
  }
}
```

- **典型用途**：声明式配置层字段、构建/发布/镜像信息（时间戳、分支、PR号、哈希、仓库地址）、日志/监控/审计仓库指针、客户端库调试信息、来源信息、回滚工具元数据、负责人联系方式、用户指令等。
- **key 语法**：`[前缀/]名称`。
  - 名称段必填：≤63 字符，首尾为字母数字 `[a-z0-9A-Z]`，中间可用 `-`、`_`、`.`。
  - 前缀可选：若指定，必须是 DNS 子域（点分隔标签，总长≤253 字符），后跟 `/`。
  - 省略前缀视为用户私有；自动化组件（如 `kube-scheduler`、`kubectl`）必须指定前缀。
  - `kubernetes.io/` 和 `k8s.io/` 前缀保留给 Kubernetes 核心组件。
- **value 无字符限制**：可含特殊字符、空白、JSON/YAML 等结构化数据；二进制数据建议 base64 编码。
- **容量限制**：单个对象上**所有**注解（键+值合计）不得超过 **256 KiB**。

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: annotations-demo
  annotations:
    imageregistry: "https://hub.docker.com/"
spec:
  containers:
  - name: nginx
    image: nginx:1.14.2
    ports:
    - containerPort: 80
```

- 文档覆盖：当前版 + 前 4 个旧版（共 5 版）
- 文档可用 ≠ 官方支持；支持周期见 `/releases/patch-releases/#support-period`
- 最新版本：v1.37
- 旧版本：v1.36、v1.35、v1.34、v1.33（均含 release 信息链接）

- 大型集群：`considerations for large clusters`
- 多可用区运行：`running in multiple zones`
- 节点配置校验：`validate node setup`
- 强制 Pod 安全标准：`enforcing Pod Security Standards`
- PKI 证书与要求：`PKI certificates and requirements`

对应文档章节：
```
/setup/best-practices/cluster-large/
/setup/best-practices/multiple-zones/
/setup/best-practices/node-conformance/
/setup/best-practices/enforcing-pod-security-standards/
/setup/best-practices/certificates/
```

## 4. kubeadm 引导集群

- kubeadm 是生产环境引导集群的工具，负责初始化控制平面与加入节点。
- 核心操作：`kubeadm init` 初始化控制平面；`kubeadm join` 加入工作节点。
- 主要子主题：
  - 安装：`install-kubeadm`
  - 创建集群：`create-cluster-kubeadm`
  - 故障排查：`troubleshooting-kubeadm`
  - 定制组件：通过 kubeadm API 调整控制平面组件参数，见 `control-plane-flags`
  - 高可用拓扑：`ha-topology`（堆叠 etcd / 外部 etcd）
  - 创建高可用集群：`high-availability`
  - 搭建高可用 etcd：`setup-ha-etcd-with-kubeadm`
  - 逐节点配置 kubelet：`kubelet-integration`
  - 双栈（IPv4/IPv6）支持：`dual-stack-support`

- 易错点：kubeadm 版本需与 Kubernetes 版本匹配；高可用部署需提前规划 etcd 拓扑。

- Kubernetes：可移植、可扩展的开源平台，用于管理容器化工作负载与服务，支持声明式配置和自动化。
- 概念章节按主题组织，各模块要点：

| 模块 | 核心内容 |
|---|---|
| Overview | 平台定位与生态 |
| Cluster Architecture | 集群架构设计 |
| Containers | 应用及其运行时依赖的打包技术 |
| Workloads | Pod 为最小可部署计算对象；上层抽象用于运行 Pod |
| Services, Load Balancing, and Networking | 网络相关概念与资源 |
| Storage | 为 Pod 提供长期与临时存储 |
| Configuration | 配置 Pod 的各类资源 |
| Security | 云原生工作负载安全 |
| Policies | 用策略管理安全与最佳实践 |
| Scheduling, Preemption and Eviction | 调度、抢占与驱逐 |
| Resource Management | 工作负载资源的表示、请求、分配与约束 |
| Cluster Administration | 创建或管理集群的底层细节 |
| Windows in Kubernetes | 支持 Microsoft Windows 节点 |
| Extending Kubernetes | 改变集群行为的扩展方式 |

- 资源层级：Cluster → Node → Pod → Container；Pod 是运行容器化应用的基本调度单位。

## kubeadm 配置 kubelet

- kubeadm CLI 与 kubelet 守护进程生命周期解耦；kubelet 由 systemd 托管（DEB/RPM 安装时）。
- 集群级配置用 `KubeletConfiguration` API 统一管理；实例级配置建议用 patches。

关键参数：
- `kubeadm init --service-cidr 10.96.0.0/12`：设置 Service 子网
- `--cluster-dns`：kubelet DNS 地址，集群内所有节点须一致
- `--resolv-conf`：DNS 解析文件路径，因系统而异（systemd-resolved），错误导致 DNS 解析失败
- `--hostname-override`：覆盖 Node 名称（默认主机名）
- `--cgroup-driver`：须与容器运行时 cgroup 驱动一致
- `--container-runtime-endpoint=<path>`：指定容器运行时端点

KubeletConfiguration 示例：
```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
clusterDNS:
- 10.96.0.10
```

查看默认值：`kubeadm config print init-defaults --component-configs KubeletConfiguration`

**kubeadm init 流程**：
- 配置写入 `/var/lib/kubelet/config.yaml`，并上传至 `kube-system` 的 `kubelet-config` ConfigMap
- 检测 CRI socket → `/var/lib/kubelet/instance-config.yaml`
- 集群级配置+客户端证书 → `/etc/kubernetes/kubelet.conf`
- 动态参数写入 `/var/lib/kubelet/kubeadm-flags.env`：
  ```
  KUBELET_KUBEADM_ARGS="--flag1=value1 --flag2=value2 ..."
  ```
- 执行：`systemctl daemon-reload && systemctl restart kubelet`

**kubeadm join 流程**：
- 用 Bootstrap Token TLS bootstrap，下载 `kubelet-config` ConfigMap → `/var/lib/kubelet/config.yaml`
- 同样检测 CRI socket、生成环境文件
- 重启 kubelet 后写 `/etc/kubernetes/bootstrap-kubelet.conf`（CA 证书+Bootstrap Token）
- 唯一凭证存于 `/etc/kubernetes/kubelet.conf`

- TLS Bootstrap 完成：`/etc/kubernetes/kubelet.conf` 写入后，`kubeadm` 删除 `/etc/kubernetes/bootstrap-kubelet.conf`。
- kubeadm 安装的 drop-in：`/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf`（kubeadm 不修改）。自定义覆盖放 `/etc/systemd/system/kubelet.service.d/local-overrides.conf`。
- 默认 drop-in 关键参数：`--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf --config=/var/lib/kubelet/config.yaml`，最终执行 `/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS`。
- 关键文件：`--bootstrap-kubeconfig` 仅当 `kubelet.conf` 不存在时用；`--kubeconfig` 唯一身份；`--config` ComponentConfig。
- `KUBELET_KUBEADM_ARGS` 来自 `/var/lib/kubelet/kubeadm-flags.env`；`KUBELET_EXTRA_ARGS` 用户覆盖：DEB `/etc/default/kubelet`，RPM `/etc/sysconfig/kubelet`；参数链末尾，冲突时优先级最高（推荐 `.NodeRegistration.KubeletExtraArgs`）。

## 大规模集群考量

**支持上限（K8s v1.37）**
- 节点 ≤ 5,000
- 每节点 Pod ≤ 110
- 总 Pod ≤ 150,000
- 总容器 ≤ 300,000

**云厂商配额**
- 提前申请增加配额：计算实例/CPU/存储卷/IP/负载均衡器/网络子网/日志流等
- 分批创建节点，批次间暂停，避免限流

**控制平面**
- 每个故障域至少 1-2 个实例；先垂直扩容，再水平扩容
- 节点不会自动将流量导向同故障域控制平面端点，需借助云厂商机制（如负载均衡器按可用区分发）

**etcd**
- 大型集群可将 Event 对象存到独立 etcd 实例，配置 API server 使用

**插件（addon）资源**
- 默认 limit 基于中小集群经验，大集群需上调，否则可能被 OOM 杀死或 CPU 受限
- 垂直扩展型：随集群扩容提高 requests/limits
- 水平扩展型/DaemonSet 型：大集群也需略提高限制；可用 Vertical Pod Autoscaler（recommender 模式）获取建议值

示例：
```yaml
resources:
  limits:
    cpu: 100m
    memory: 200Mi
```

**关键组件优先级**
- CoreDNS、metrics-server 等使用 `system-cluster-critical` 或 `system-node-critical` PriorityClass，确保优先调度且不被抢占

**工具**
- VerticalPodAutoscaler：管理资源 requests/limits
- addon resizer：随集群规模自动调整插件资源

- K8s 1.24 移除 dockershim，须用 CRI 运行时：containerd、CRI-O、Docker Engine、Mirantis；须支持 CRI v1 API，否则 kubelet 不注册节点（v1.26+ 仅 v1）。

- IPv4 转发：
```bash
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.ipv4.ip_forward = 1
EOF
sudo sysctl --system
```

- cgroup 驱动：`cgroupfs` 或 `systemd`；kubelet 与运行时必须一致。systemd init 或 cgroup v2 时用 `systemd`。  
kubelet 配置：
```yaml
cgroupDriver: systemd
```
containerd/CRI-O 同步设 `systemd`。

- K8s 1.37 起，若 `KubeletCgroupDriverFromCRI` 启用且运行时支持 `RuntimeConfig`，kubelet 自动检测并忽略 `cgroupDriver`；旧版 containerd 不支持则回退 `--cgroup-driver`，1.38 删除回退后旧版失败。

- 易错：已入集群节点改 cgroup 驱动可能致 pod sandbox 重建失败；建议自动替换或重装节点。

## containerd（CRI 运行时）
- 配置 `/etc/containerd/config.toml`，socket `/run/containerd/containerd.sock`
- cgroup v2 用 systemd：runc options 设 `SystemdCgroup = true`；前缀 1.x/2.x 为 `io.containerd.grpc.v1.cri`/`io.containerd.cri.v1.runtime`
- 包安装可能禁用 CRI：`disabled_plugins` 不含 `cri`，改后 `sudo systemctl restart containerd`；崩溃循环重置 `containerd config default > /etc/containerd/config.toml`
- pause 镜像：`[plugins."io.containerd.grpc.v1.cri"]` 下 `sandbox_image = "registry.k8s.io/pause:3.10"`

## CRI-O
- 默认 systemd；切 cgroupfs：`[crio.runtime]` 设 `cgroup_manager = "cgroupfs"`、`conmon_cgroup = "pod"`（配置或 drop-in）
- cgroupfs 时 `conmon_cgroup` 必须 `pod`；kubelet 需一致
- socket `/var/run/crio/crio.sock`；pause 镜像：`[crio.image]` 下 `pause_image`

## kubeadm
- 最小可用集群，支持 bootstrap tokens 与升级
- 前置：deb/rpm Linux；≥2 GiB RAM/机；控制平面 ≥2 CPU；网络互通
- 步骤：装运行时 + kubeadm → 初始化 → 装 Pod 网络
- 升级时 kubelet crashloop 正常；从默认网关选 IP 通告

## IP 地址配置
- 查默认网关：`ip route show` 找 `default via`。
- 多网关时 K8s 选用首个全局单播 IP，顺序随 OS 变化；无网关且未传自定义 IP 可能报错退出。
- 组件不支持自定义接口，须用 flag 向所有实例传 IP。
- API Server 通告：`--apiserver-advertise-address`；kubeadm 用 Init/Join 的 `localAPIEndpoint`。
- kubelet 节点 IP：`--node-ip`（置于 `.nodeRegistration.kubeletExtraArgs`）。
- 上述 IP 进证书 SAN，改后需重签并重启组件。
- 建议主机网络，使默认网关 IP 即自动探测 IP；网关为公网 IP 时需包过滤。

## 预拉取镜像（可选）
- 离线可预拉取 `registry.k8s.io` 默认镜像，或使用自定义镜像仓库。

## 初始化控制平面
- 控制平面运行 etcd 与 API Server；要 HA 须加 `--control-plane-endpoint`（DNS/LB IP）。
- Pod 网络：`--pod-network-cidr`；多运行时/非默认端点：`--cri-socket`。
- 执行 `kubeadm init <args>`。
- 区别：`--apiserver-advertise-address` 为当前节点通告地址；`--control-plane-endpoint` 为所有控制平面共享端点，支持 DNS，如 `192.168.0.102 cluster-endpoint`，再传 `--control-plane-endpoint=cluster-endpoint`。
- 未用 `--control-plane-endpoint` 创建的集群不能转 HA。
- 初始化前 prechecks；成功后按输出配 kubeconfig、部署 Pod 网络。
- 重跑必须先 tear down；跨架构节点 DaemonSet 镜像需支持对应架构。

## kubeadm 高可用集群（核心）

- **拓扑选择**：
  - 堆叠式：etcd 与控制平面同节点，基础设施少。
  - 外部 etcd：etcd 与控制平面分离，基础设施多。
  - 云环境注意：两种方式均不适用于 `LoadBalancer` Service 和动态 PV。

- **前置要求**：
  - 控制平面节点 ≥3（奇数，利于选主），工作节点 ≥3；均已装 kubeadm、kubelet、容器运行时。
  - 全网络互通、sudo 权限、单台设备 SSH 可所有节点。
  - 外部 etcd 拓扑需额外 ≥3 台 etcd 节点（奇数，满足 quorum）。

- **镜像与工具**：
  - 各主机需能拉取 `registry.k8s.io` 镜像，或预先放置。
  - 需装 kubectl（建议控制平面节点也装）。

- **创建 apiserver 负载均衡器**：
  - 使用 TCP 转发 LB，监听 `:6443`，健康检查 TCP。
  - LB 地址必须匹配 kubeadm `ControlPlaneEndpoint`。
  - 测试：
    ```bash
    nc -zv -w 2 <LOAD_BALANCER_IP> <PORT>
    ```
  - **易错**：连接拒绝=预期（apiserver 未启动）；超时=LB 无法通信，需调整。

- **初始化首个控制平面节点**（堆叠拓扑）：
  ```bash
  sudo kubeadm init --control-plane-endpoint "LOAD_BALANCER_DNS:LOAD_BALANCER_PORT" --upload-certs
  ```

```
## kubeadm 多控制平面集群要点

- init 参数：`--control-plane-endpoint`（LB 地址:端口）、`--upload-certs`
- `--config` 与 `--certificate-key` 不兼容
- CNI 须提前部署
- 证书密钥 2h 过期；重新上传：`sudo kubeadm init phase upload-certs --upload-certs`
- 控制面 join：
```bash
sudo kubeadm join <endpoint> --token <token> --discovery-token-ca-cert-hash sha256:<hash> --control-plane --certificate-key <key>
```
- 工作节点去掉 `--control-plane --certificate-key`
- CoreDNS 重平衡：`kubectl -n kube-system rollout restart deployment coredns`
- 定制：控制面 `ClusterConfiguration.extraArgs`；kubelet/kube-proxy `KubeletConfiguration`/`KubeProxyConfiguration`；节点差异/重复 flags 用 patches
```

- **extraArgs**：`ClusterConfiguration` 的 `controllerManager`/`scheduler`/`etcd.local` 下用 name/value 传参。
- **Patches**（v1.22+）：在 Init/Join/UpgradeConfiguration 设 `patches.directory`。文件名 `target[suffix][+patchtype].extension`，patchtype 默认 `strategic`。升级须重传同目录。
- **kubelet**：`KubeletConfiguration` 与集群配置同文件（`---` 分隔）传 `kubeadm init`；节点级用 `kubeletconfiguration` patch。
- **kube-proxy**：`KubeProxyConfiguration` 用 `---` 分隔传入 `kubeadm init`。
- **CoreDNS**：仅支持 `corednsdeployment` patch；其他对象手动 `kubectl patch` 并重建 Pod；`dns.disabled: true` 禁用。
- **双栈**（v1.23+）：Pod/Service 同时分配 IPv4/IPv6；节点启用 IPv6 forwarding。

```bash
sysctl net.ipv6.conf.all.forwarding
```
输出 `=1` 已启用，否则未启用。

- 无需重启应用 sysctl：`sudo sysctl --system`
- 双栈集群需 IPv4 与 IPv6 地址段；IPv4 常用私网段，IPv6 从 `2000::/3` 选用运营商分配的全局单播块
- 地址段无需公网路由，大小应匹配 Pod/Service 规模
- 注意：`kubeadm upgrade` 不支持修改 Pod CIDR 或 Service CIDR
- 创建双栈集群：`kubeadm init` 命令行参数指定双栈 CIDR 范围

## kubeadm 双栈集群

- 主节点初始化：
```bash
kubeadm init --pod-network-cidr=10.244.0.0/16,2001:db8:42:0::/56 --service-cidr=10.96.0.0/16,2001:db8:42:1::/112
```
- 配置文件关键字段（`kubeadm-config.yaml`）：
```yaml
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
networking:
  podSubnet: 10.244.0.0/16,2001:db8:42:0::/56
  serviceSubnet: 10.96.0.0/16,2001:db8:42:1::/112
---
apiVersion: kubeadm.k8s.io/v1beta4
kind: InitConfiguration
localAPIEndpoint:
  advertiseAddress: "10.100.0.1"
  bindPort: 6443
nodeRegistration:
  kubeletExtraArgs:
  - name: "node-ip"
    value: "10.100.0.2,fd00:1:2:3::2"
```
- `advertiseAddress` 等同 `--apiserver-advertise-address`，**不支持双栈**。
- 执行 `kubeadm init --config=kubeadm-config.yaml`。
- 控制器管理器 `--node-cidr-mask-size-ipv4|--node-cidr-mask-size-ipv6` 有默认值。
- 加入节点：`JoinConfiguration` 中 `discovery.bootstrapToken.apiServerEndpoint` 指定 API 端点，`nodeRegistration.kubeletExtraArgs` 设置双栈 `node-ip`。
- 加入控制面：在 `JoinConfiguration.controlPlane.localAPIEndpoint.advertiseAddress` 指定地址，执行 `kubeadm join --config=...`。
- 双栈特性不强制使用双栈寻址，可部署单栈集群。

## Pod 安全标准

- 内置 Pod Security Admission Controller（v1.25 起稳定），取代废弃的 PodSecurityPolicies。
- 所有命名空间都应配置安全级别标签；未配置的命名空间是安全模型缺口。
- 最小权限原则：尽量满足 `restricted`；允许 `privileged` 的命名空间需加访问控制并文档化特例。
- 多模式策略：对所有命名空间启用 `audit` 和 `warn` 模式，并设为期望的 `enforce` 级别；`warn` 提示负载作者修改，`audit` 记录审计日志以驱动后续收敛。即使完成 `enforce`，这两种模式仍可提供安全洞察。

## Pod 安全准入（warn/audit/enforce）

- `warn` 与 `enforce` 同级：客户端创建不合规 Pod（或含 Pod 模板资源）时收到警告，促其更新合规
- 命名空间将 `enforce` 固定为非 latest 版本时，`audit`/`warn` 指向 `latest`，可发现旧版本放行但当前最佳实践禁止的配置
- 第三方替代：Kubewarden、Kyverno、OPA Gatekeeper
- 内置 PodSecurity 与第三方工具的选择取决于自身情况，供应链信任是评估关键

## 字段选择器

按资源字段值过滤对象。默认无过滤，`kubectl get pods` 等价于 `kubectl get pods --field-selector ""`。

```bash
kubectl get pods --field-selector status.phase=Running
```

- 通用字段：所有资源类型支持 `metadata.name`、`metadata.namespace`；使用未知字段会报错
- 常用可用字段：
  - Pod：`spec.nodeName` `spec.restartPolicy` `spec.schedulerName` `spec.serviceAccountName` `spec.hostNetwork` `status.phase` `status.podIP` `status.nominatedNodeName`
  - Service：`spec.clusterIP` `spec.type`
  - Secret：`type`；Namespace：`status.phase`；Node：`spec.unschedulable`
  - 其他：Event、ReplicaSet、ReplicationController、Job、CertificateSigningRequest 各有专属字段
- 自定义资源：CRD 的 `spec.versions[*].selectableFields` 声明可作选择器的字段
- 操作符：`=`、`==`、`!=`（`=` 与 `==` 等价）；**不支持** `in`、`notin`、`exists`
- 链式与多类型：

```bash
kubectl get pods --field-selector=status.phase!=Running,spec.restartPolicy=Always
kubectl get statefulsets,services --all-namespaces --field-selector metadata.namespace!=default
```

- **定义**：Finalizers 是 namespace 级键，告知 Kubernetes 等待特定条件满足后才彻底删除标记为删除的资源；用于控制垃圾回收，提醒控制器清理被删除对象拥有的资源。
- **机制**：删除带 finalizer 的对象时，API server 填充 `.metadata.deletionTimestamp` 并返回 `202`（HTTP "Accepted"）；对象保持 `Terminating` 状态，直到控制器完成动作并清空 `metadata.finalizers` 字段，字段为空后对象被自动删除。
- **使用**：在 manifest 的 `metadata.finalizers` 字段指定；finalizer 只是键列表，不指定执行代码（类似 annotations）。

**删除流程**

```yaml
metadata:
  finalizers:
  - example.com/finalizer-name
```

1. API server 添加 `metadata.deletionTimestamp`
2. 阻止对象移除，直到 `finalizers` 字段清空
3. 返回 `202`
4. 控制器满足条件后逐个移除 key，字段清空后自动删除

**典型示例**：`kubernetes.io/pv-protection` 防止误删 PersistentVolume；PV 被 Pod 使用时挂上该 finalizer，删除时进入 `Terminating`，Pod 停止使用后 Kubernetes 清除 finalizer 并删除卷。

**易错点**
- DELETE 后只能移除已有 finalizers，不能新增；`deletionTimestamp` 不可修改
- 删除请求发出后对象不可恢复，只能删除重建
- 自定义 finalizer 必须用限定名格式 `example.com/finalizer-name`，API server 拒绝非限定名
- Owner references（非 labels）决定依赖对象清理（如 Job 删除 Pods）；finalizer 可能阻塞依赖对象删除，排查卡删时检查目标 owner 和依赖对象的 finalizers 与 owner references
- 避免手动强删 finalizer；仅在明确其目的且已用其它方式达成时操作

## 入门与 kubeadm 安装

### 集群安装方式
- 依据维护难度、安全、控制、资源、运维经验选择安装类型。
- 可部署到本地机器、云或自有数据中心。
- 核心组件（如 `kube-apiserver`、`kube-proxy`）**推荐**以容器镜像运行并由 Kubernetes 管理；例外：`kubelet` 等运行容器的组件不能。
- 不想自管集群可选托管服务（certified platforms）。

### 学习 vs 生产
- 学习环境：使用社区工具在本地搭建集群。
- 生产环境：官方支持的自管理工具为 `kubeadm`；需明确自管哪些抽象。

### 安装 kubeadm
- 安装指南针对 Kubernetes v1.37；其他版本见对应文档。

**前置要求**
- 兼容 Linux 主机（Debian/Red Hat 系或无包管理器发行版）。
- 每台机器 ≥2GB RAM；控制平面机器 ≥2 CPU。
- 所有机器间网络完全连通（公网/私网均可）。
- 每节点唯一 `hostname`、MAC 地址、`product_uuid`；开放所需端口。
- kubeadm 二进制动态链接依赖 `glibc`；Alpine 等无 glibc 发行版需兼容层。

**检查 OS 版本**
```bash
uname -r   # Linux，需 LTS 内核
systeminfo # Windows
```

### 后续步骤
- 下载 Kubernetes，安装 `kubectl`，选择容器运行时，参考集群搭建最佳实践。
- 控制平面运行于 Linux；集群内可运行 Linux 或 Windows 应用。

### kubeadm 集群前置检查与安装要点

#### 前置检查
- 内核版本：kubeadm 预检 SystemVerification；确认支持可 `--ignore-preflight-errors=SystemVerification` 跳过。
- 节点唯一性：MAC 和 product_uuid 必须唯一：
  ```bash
  ip link
  sudo cat /sys/class/dmi/id/product_uuid
  ```
- 多网卡：默认路由不达集群地址时需加路由。
- 端口：netcat 检查，如 `nc 127.0.0.1 6443 -zv -w 2`；Pod 网络插件可能额外要求。
- Swap：kubelet 检测 swap 即失败。禁用：`sudo swapoff -a`，并改 /etc/fstab、systemd.swap；或 kubelet 设 `failSwapOn: false`（默认工作负载仍不可用 swap，需 `swapBehavior`）。

#### 容器运行时
- Kubernetes 经 CRI 通信；kubeadm 自动扫描端点，零/多个需指定。
- Docker Engine 需额外装 cri-dockerd。
- 常见端点：
  - containerd: `unix:///var/run/containerd/containerd.sock`
  - CRI-O: `unix:///var/run/crio/crio.sock`
  - Docker Engine (cri-dockerd): `unix:///var/run/cri-dockerd.sock`

#### 安装
- kubeadm 引导集群；kubelet 节点代理；kubectl 交互；kubeadm 不安装/管理后两者。
- 版本：kubelet 可低于 API server 一个次要版本，不可高于；升级需特殊处理，包排除自动升级。
- 旧仓库已冻结弃用，必须用新仓库 `pkgs.k8s.io`（v1.24.0 起）。本指南针对 v1.37。
- 安装示例（Debian/Ubuntu）：
  ```bash
  sudo apt-get update
  sudo apt-get install -y apt-transport-https ca-certificates curl gpg
  ```

### apt 仓库配置（kubeadm）

- 所有仓库共用同一签名公钥，URL 中版本号可忽略：
```bash
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.37/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
```
- 易错点：Debian 12 / Ubuntu 22.04 之前，`/etc/apt/keyrings` 默认不存在，需先创建：
```bash
sudo mkdir -p -m 755 /etc/apt/keyrings
```
- 随后添加对应的 Kubernetes `apt` 仓库（需指定 `signed-by` 指向该 keyring）。

### 部署工具

- **kubeadm**：官方集群部署工具。
- **Cluster API**：Kubernetes 子项目，声明式 API 简化多集群配置、升级、运维。
- **kops**：自动化集群配置工具。
- **kubespray**：基于 Ansible playbook 的通用 OS/K8s 集群配置管理。

### Kubernetes 核心概念

- 开源系统，用于容器化应用的自动化部署、扩缩容与管理。
- 将应用容器分组为逻辑单元，便于管理与发现。
- 融合 Google 15 年生产经验与社区最佳实践。

### 社区

- 参与方式：GitHub、Slack、论坛、Meetup 等。
- 社区价值观：尊重与包容，所有互动遵循行为准则。

## Kubernetes 核心特性

- **可扩展性**：基于 Google 每周运行数十亿容器的调度原理，规模增长无需扩大运维团队。
- **灵活部署**：开源，支持本地、混合云、公有云，工作负载可无缝迁移。
- **自动发布/回滚**：渐进式更新并持续监控应用健康，异常时自动回滚。
- **服务发现与负载均衡**：每个 Pod 有独立 IP；一组 Pod 提供统一 DNS 名，自动负载均衡。
- **存储编排**：自动挂载本地存储、云存储或网络存储（iSCSI/NFS 等）。
- **密钥与配置管理**：无需重建镜像即可更新 Secret 和应用配置，且不暴露于配置清单。
- **自动装箱**：按资源需求和约束自动放置容器，混合关键任务与尽力而为工作负载，提高资源利用率。
- **批处理与 CI**：管理批处理和 CI 任务，容器失败时自动替换。
- **自愈**：自动重启崩溃容器、替换故障 Pod、重新挂载存储，并可联动节点自动缩放器。
- **水平缩放**：通过命令行、UI 或基于 CPU 使用率自动扩展/缩减 Pod 副本。
- **垂直缩放**：根据实际使用情况自动调整资源请求与限制。
- **双栈网络**：Pod 和 Service 支持 IPv4/IPv6 双栈地址。
- **可扩展性**：无需修改上游源码即可为集群增加自定义功能。

## 近期版本要点

- **Kubernetes v1.37**：`metrics.k8s.io/v1` 正式 GA，支持 `kubectl top` 及基于资源指标的 HPA。
- **Gateway API v1.6**：`TCPRoute`、`UDPRoute` 升级为标准 API。
- **KYAML**：用于规范化 Kubernetes YAML 格式，提升可读性。

## Kubernetes 组件
- 集群由**控制平面（Control Plane）** 与**工作节点（Worker Nodes）** 组成。
- 控制平面组件：
  - `kube-apiserver`：暴露 Kubernetes HTTP API 的核心组件。
  - `etcd`：一致且高可用的键值存储，保存所有 API 数据。
  - `kube-scheduler`：为未绑定节点的 Pod 分配合适节点。
  - `kube-controller-manager`：运行控制器，实现 API 行为。
  - `cloud-controller-manager`（可选）：集成云厂商。
- 节点组件：
  - `kubelet`：确保 Pod 及其容器运行。
  - `kube-proxy`（可选）：维护网络规则，实现 Service。
  - 容器运行时（Container runtime）：负责运行容器。
- 插件（Addons）：DNS、Web UI（Dashboard）、容器资源监控、集群级日志。

## Kubernetes 对象管理
- `kubectl` 支持三种管理方式：**命令式命令**、**命令式对象配置**、**声明式对象配置**。
- **警告**：同一对象只能使用一种方式管理，混用会导致未定义行为。

| 方式 | 操作对象 | 推荐环境 | 写者数 | 学习曲线 |
| --- | --- | --- | --- | --- |
| 命令式命令 | 活动对象 | 开发项目 | 1+ | 最低 |
| 命令式对象配置 | 单个文件 | 生产项目 | 1 | 中等 |
| 声明式对象配置 | 文件目录 | 生产项目 | 1+ | 最高 |

## Kubernetes 对象管理

**命令式命令**：直接操作集群实时对象，无历史。适合入门/一次性任务。
```bash
kubectl create deployment nginx --image nginx
```
优点：单一动作词、单步完成。缺点：无变更审查、无审计追踪、无记录、无模板。

**命令式对象配置**：指定操作 + YAML/JSON 文件（须含完整对象定义）：
```bash
kubectl create -f nginx.yaml
kubectl delete -f nginx.yaml -f redis.yaml
kubectl replace -f nginx.yaml
```
⚠️ `replace` 覆盖现有 spec，丢弃文件中缺失的变更；勿用于 `LoadBalancer` 等 spec 被独立更新的资源（如 `externalIPs`）。
优点：可存 Git、集成审查/审计、可作模板。缺点：需理解对象 schema；变更未同步回文件会在下次 replace 丢失；仅适合文件，不适合目录。

**声明式对象配置**：kubectl 自动检测每对象的 create/patch/delete：
```bash
kubectl diff -f configs/    # 先预览
kubectl apply -f configs/
kubectl apply -R -f configs/  # 递归
```
用 `patch` 只写差异，保留其他写入者的变更。优点：保留实时对象变更、支持目录操作。缺点：难调试、diff 合并复杂。

## 标签与选择器

- Labels 是附加于对象（如 Pod）的 key/value 对，用于组织与选择对象子集；key 在同一对象内唯一；可随时增改。
- 非标识信息用 annotations，不用 labels。
```yaml
metadata:
  labels:
    release: stable
    environment: production
    tier: frontend
```
- 动机：将组织结构松耦合映射到系统对象；部署/流水线是多维实体（分区、发布轨、层级、微服务），管理需跨维度操作。
- 常见约定：`release`（stable/canary）、`environment`（dev/qa/production）、`tier`（frontend/backend/cache）、`partition`、`track`。

- 标签键值对：键`[前缀/]名称`。名称≤63字符，首尾`[a-z0-9A-Z]`，中间`-_.`；前缀为DNS子域≤253字符，可省略；系统组件强制带前缀；`kubernetes.io/`、`k8s.io/`保留。值≤63字符，可为空，非空时同名称规则。
- 选择器逗号=AND，无OR。

- 等值选择器：`=`、`==`、`!=`。
  - `environment=production,tier!=frontend`
  - 用于nodeSelector：
```yaml
spec:
  nodeSelector:
    accelerator: nvidia-tesla-p100
```

- 集合选择器：`in`、`notin`、`exists`（键名）、`!`（键不存在）。
  - `environment in (production, qa)`
  - `tier notin (frontend, backend)`
  - `partition` / `!partition`
  - `environment=production` ≡ `environment in (production)`
  - 可混合：`partition in (customerA,customerB),environment!=qa`

- API过滤：
  - `?labelSelector=environment%3Dproduction,tier%3Dfrontend`
  - `?labelSelector=environment+in+%28production%2Cqa%29`
  - kubectl：
```bash
kubectl get pods -l environment=production,tier=frontend
kubectl get pods -l 'environment in (production),tier in (frontend)'
kubectl get pods -l 'environment in (production, qa)'
kubectl get pods -l 'environment,environment notin (frontend)'
```

- Service、ReplicationController等用等值选择器（map形式，不支持集合运算符）：
```yaml
selector:
  component: redis
```
- ReplicaSet等支持集合选择器。同一命名空间内两个实例的标签选择器不能重叠，否则控制器无法确定副本数。

- Job/Deployment/ReplicaSet/DaemonSet 支持**集合式选择器**（set-based）。
- 选择器由 `matchLabels` 与 `matchExpressions` 组成，两者条件**AND**，需全部满足。

```yaml
selector:
  matchLabels:
    component: redis
  matchExpressions:
    - { key: tier, operator: In, values: [cache] }
    - { key: environment, operator: NotIn, values: [dev] }
```

- `matchLabels`：`{key,value}` 映射；一个键值对等价于 `matchExpressions` 中 `operator: In`、`values: [value]`。
- `matchExpressions`：选择器需求列表，操作符含 `In`, `NotIn`, `Exists`, `DoesNotExist`；`In`/`NotIn` 时 `values` 必须非空。
- 典型用途：通过标签约束 Pod 可调度节点集合（node selection）。
- 标签使用建议：单标签不足以区分资源集合，应多用标签。例如前端可带：

```yaml
labels:
  app: guestbook
  app.kubernetes.io/name: guestbook-frontend
```

- 使用 `app` 便于手工查询/CLI；`app.kubernetes.io/name` 遵循推荐约定，适合工具自动化。

## 学习环境

- 前置条件：先安装 `kubectl`（与 Kubernetes 集群通信的 CLI）。
- 本地学习环境：
  - `kind`（Kubernetes IN Docker）：用 Docker 容器充当节点，轻量，专为测试 Kubernetes 设计，也适合学习。
  - `minikube`：本地单节点集群，支持多容器运行时，支持 Linux/macOS/Windows。
  - 第三方工具（Kubernetes 官方不提供支持）：Docker Desktop、Podman Desktop、Rancher Desktop、MicroK8s、Red Hat CodeReady Containers (CRC)。
- 在线练习场：Killercoda，浏览器运行，无需本地安装，适合快速实验和跟随教程。
- 生产环境练习：`kubeadm` 可搭建类生产集群，但属高级操作，需多台机器（物理或虚拟）并仔细配置。
- 易错点：不要一上来就用 `kubeadm`；先用 `kind` / `minikube` / 在线 playground。
- 后续：运行 Hello Minikube 教程部署首个应用；了解 Kubernetes 组件；熟悉 `kubectl` 命令。

## 26. Kubernetes 命名空间

**核心概念**
- 命名空间隔离单集群资源组；资源名仅同命名空间内唯一
- 只作用于命名空间级对象（Deployments、Services 等）；集群级对象（Nodes、PV、StorageClass）不受限
- 不可嵌套；多团队/项目才需要，少量用户无需使用
- 区分版本用 label，勿建多命名空间；生产避免 `default`，**禁止 `kube-` 前缀**

**内置命名空间**
- `default`：默认放置资源
- `kube-system`：系统对象
- `kube-public`：所有客户端（含未认证）可读
- `kube-node-lease`：节点 Lease，kubelet 心跳供控制面检测故障

**关键命令**
- 查看：`kubectl get namespace`
- 临时指定：`kubectl run nginx --image=nginx --namespace=<ns>`；`kubectl get pods --namespace=<ns>`
- 永久设置：`kubectl config set-context --current --namespace=<ns>`
- 资源归属：`kubectl api-resources --namespaced=true`（属于）/ `--namespaced=false`（不属于）

**DNS 行为**
- Service DNS：`<service-name>.<namespace-name>.svc.cluster.local`
- 同命名空间直接用 `<service-name>`；跨命名空间用 FQDN
- 命名空间名须合法 RFC 1123 DNS label
- **易错点**：命名空间名与公共顶级域（`.com`）重名时短 DNS 解析被劫持到该命名空间 Service；创建权限限可信用户

**自动标签**
- v1.22+ 控制面自动添加不可变标签 `kubernetes.io/metadata.name`，值为命名空间名

- Name 同类型内唯一；同一命名空间下 Pod 名唯一，但 Pod 与 Deployment 可同名，删除后可重建同名；UID 全集群唯一。
- 唯一标识四要素：API group + resource type + namespace + name；API version 不参与唯一标识，不能靠不同 API 版本创建同名对象。
- 非唯一属性用 labels / annotations。
- 易错：Node 代表物理主机，同名重建（未先删除）会被视为旧 Node，可能不一致。
- `generateName` 作前缀，服务端追加后缀；冲突最多尝试 8 次（v1.31+），失败返回 HTTP 409。
- 命名约束：
  - DNS 子域名（RFC 1123）：≤253，仅小写字母数字 `-` `.`，首尾须字母数字。
  - Label（RFC 1123/1035）：≤63，仅小写字母数字 `-`，字母开头（当前实现），尾字母数字；启用 `RelaxedServiceNameValidation` 时 Service 可数字开头。
  - 路径段：不能为 `.` 或 `..`，不能含 `/` 或 `%`。
- UID 系统生成，全集群生命周期唯一，用于区分历史实例；实现为 UUID。

## Kubernetes 对象

- **对象**：持久实体，描述集群状态：容器化应用、资源、行为策略（重启、升级、容错）；是“意图记录”，声明**期望状态**
- 通过 **Kubernetes API** 操作对象；`kubectl` 封装 API；manifest 常用 YAML

### spec 与 status
- `spec`：期望状态，创建时由用户设置
- `status`：当前状态，由系统持续更新；控制平面协调 status 匹配 spec

### 必需字段
- `apiVersion`（如 `apps/v1`）、`kind`（如 `Deployment`）、`metadata`（`name`、`UID`、可选 `namespace`）、`spec`（期望状态，格式因对象而异）

### Deployment 示例
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
spec:
  selector:
    matchLabels:
      app: nginx
  replicas: 2
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx:1.14.2
        ports:
        - containerPort: 80
```
```bash
kubectl apply -f deployment.yaml
```

### 服务端字段校验（v1.25+）
- API server 检测未知/重复字段
- `kubectl --validate`：`ignore`/`warn`/`strict`；默认 `true`(=strict)

- `kubectl` 无法连接支持字段校验的 API server 时，回退到客户端校验。
- Kubernetes ≥ v1.27 的 API server 始终支持字段校验；更旧版本可能不支持，需查阅对应版本文档。

## 高可用拓扑选项

Kubernetes HA 集群两种拓扑：

### 1. 堆叠 etcd 拓扑（Stacked etcd）
- 特点：etcd 成员与控制面节点同置
- 每个控制面节点运行 `kube-apiserver`、`kube-scheduler`、`kube-controller-manager`，`kube-apiserver` 经负载均衡器暴露给工作节点
- 每个控制面节点创建本地 etcd 成员，仅与本节点的 `kube-apiserver` 通信
- 优点：配置简单，复制管理简单；缺点：故障耦合，单节点宕机则 etcd 成员与控制面实例同时丢失，冗余受损；可通过增加控制面节点缓解
- 最小规模：3 个控制面节点
- kubeadm 默认拓扑；`kubeadm init` 与 `kubeadm join --control-plane` 自动创建本地 etcd 成员

### 2. 外部 etcd 拓扑（External etcd）
- 特点：etcd 与控制面节点分离，运行于独立主机
- 控制面组件同上，`kube-apiserver` 经负载均衡器暴露；每个 etcd 主机与每个控制面节点的 `kube-apiserver` 通信
- 优点：控制面与 etcd 解耦，丢失单个实例影响更小
- 缺点：主机数量翻倍
- 最小规模：3 个控制面主机 + 3 个 etcd 主机

### 易错点
- 堆叠拓扑是 kubeadm 默认，无需手动额外配置
- 外部 etcd 需两倍主机数，容量规划时务必预留

## 30. 概述

**定义**：Kubernetes（K8s，"K"+8字母+"s"）是可移植、可扩展的开源容器化工作负载管理平台，支持声明式配置与自动化。2014 年 Google 开源，融合 15+ 年大规模生产经验。

**核心能力**：
- **服务发现与负载均衡**：容器经 DNS 名或自身 IP 暴露，高流量时自动负载均衡
- **存储编排**：自动挂载本地存储、公有云存储等
- **自动发布/回滚**：以受控速率将实际状态驱动至期望状态，支持金丝雀发布
- **自动装箱**：依据容器 CPU/内存请求，将任务最优化调度至节点
- **自愈**：重启失败容器；对未通过健康检查的容器不向客户端分发流量
- **密钥与配置管理**：存储密码、OAuth token、SSH key，不重建镜像即可更新
- **批处理**：管理 batch/CI 负载，失败自动替换
- **水平扩缩容**：命令/UI/基于 CPU 自动伸缩
- **IPv4/IPv6 双栈**：Pod 与 Service 可分配双栈地址
- **可扩展**：不修改上游源码即可添加特性

**不是 PaaS**：
- 不部署源码、不构建应用（CI/CD 由组织自定）
- 不内置中间件、数据库、缓存、集群存储（可在其上运行，经 Open Service Broker 等可移植机制访问）
- 不规定日志/监控/告警方案
- 不强制配置语言，只提供声明式 API
- 非编排系统：编排是"先 A 后 B 后 C"的固定流程；K8s 由独立可组合的控制进程持续驱动当前状态趋向期望状态，不要求集中控制

**演进背景**：
- 传统物理机部署：无资源边界，一个应用耗尽资源导致其他应用受损；每应用独占服务器则成本高、利用率低
- 虚拟化（VM）部署：单物理机多 VM，实现隔离与安全，提升利用率；但每 VM 含完整 OS，开销大
- 容器部署：在 OS 层隔离，轻量、可移植，适合生产环境大规模管理

- 容器与 VM 类似，但**隔离性更弱，共享宿主机 OS**，因此更轻量。
- 每个容器拥有独立文件系统、CPU/内存份额、进程空间等；与底层基础设施解耦，可跨云和 OS 发行版移植。

**核心优势**

- **敏捷应用创建与部署**：容器镜像比 VM 镜像更易创建、效率更高。
- **持续开发/集成/部署**：镜像不可变，支持可靠频繁构建部署，回滚快速高效。
- **开发与运维关注点分离**：在构建/发布阶段生成应用镜像，而非部署阶段，使应用与基础设施解耦。
- **可观测性**：不仅暴露 OS 层信息，还提供应用健康状态等信号。
- **环境一致性**：开发、测试、生产环境行为一致（笔记本与云端相同）。
- **云与 OS 可移植性**：支持 Ubuntu、RHEL、CoreOS、主流公有云及本地环境。
- **以应用为中心的管理**：抽象层级从“在虚拟硬件上运行 OS”提升为“在 OS 上运行应用”，使用逻辑资源。
- **松耦合微服务**：应用拆分为独立小部件，可动态部署管理，避免单体巨石架构。
- **资源隔离**：可预测的应用性能。
- **资源利用**：高效率和密度。

> 相关后续：Kubernetes Components、Kubernetes API、kubectl、Cluster Architecture、Get Started 文档。

## 属主与依赖

- 某些对象是其他对象的属主，被拥有的对象称依赖。所有权不同于 labels/selectors。
- 依赖通过 `metadata.ownerReferences` 引用属主：有效引用 = 对象名 + UID，且必须与依赖在同一命名空间。
- 以下控制器的依赖对象自动设置该字段：ReplicaSet、DaemonSet、Deployment、Job、CronJob、ReplicationController；也可手动配置。
- `ownerReferences.blockOwnerDeletion`（布尔值）：控制依赖能否阻止垃圾回收删除属主；控制器自动设为 `true`，可手动调整；准入控制器根据属主的删除权限控制此字段的修改，防止未授权用户延迟属主删除。

跨命名空间限制：
- 设计禁止跨命名空间 ownerReference。命名空间级依赖可指定集群级属主或同命名空间属主；若属主不在同命名空间，引用视为不存在，依赖在属主验证消失后会被删除。
- 集群级依赖只能指定集群级属主；v1.20+ 若指定命名空间类型，视为不可解析引用，无法被垃圾回收。
- v1.20+ 发现非法跨命名空间引用时，产生警告事件，reason=`OwnerRefInvalidNamespace`。

检查命令：
```bash
kubectl get events -A --field-selector=reason=OwnerRefInvalidNamespace
```

所有权与 finalizers：
- 删除资源时，API 服务器让控制器处理 finalizer 规则。如 PV 带 `kubernetes.io/pv-protection` finalizer，删除时保持 `Terminating`，直到不再绑定 Pod。
- 前台级联删除：给属主添加 `foreground` finalizer，控制器必须先删除所有 `blockOwnerDeletion=true` 的依赖，再删除属主。
- 孤儿级联删除：添加 `orphan` finalizer，控制器删除属主后忽略依赖。

- **三类官方合作伙伴**
  - **KCSP**：认证服务提供商，帮助企业采用 K8s
  - **软件一致性认证**：认证发行版、托管平台、安装器，确保支持所需 API
  - **培训伙伴**：云原生技术培训认证

- **入认证路径**
  - KCSP：`https://www.cncf.io/certification/kcsp/`
  - 软件一致性：`https://www.cncf.io/certification/software-conformance/`
  - 培训：`https://www.cncf.io/certification/training/`

## kubeadm 证书与控制平面命令（核心要点）

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
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379   --cacert=/etc/kubernetes/pki/etcd/ca.crt   --cert=/etc/kubernetes/pki/etcd/server.crt   --key=/etc/kubernetes/pki/etcd/server.key   snapshot save /backup/etcd.db
# 恢复: etcdctl snapshot restore + 重启 kube-apiserver/etcd 静态 pod
```

**易错点**：①renew 后必须重启静态 pod（`crictl ps | grep apiserver` → 删 pod 自动重建）或 kubelet；②多控制面证书要逐台 renew；③升级集群（kubeadm upgrade）会自动续证书——1 年期不是问题。

## 推荐标签

- 应用可安装多次；`name` 标识应用，`instance` 标识实例（全局唯一），标签供选择器匹配。
- 标准键（前缀 `app.kubernetes.io/`）：`name`=应用名，`instance`=实例名（唯一），`version`=版本，`component`=组件角色，`part-of`=所属整体，`managed-by`=管理工具。
- 简单无状态服务（Deployment/Service）只需 `name` 与 `instance`；复杂应用子组件同时携带自身与所属应用信息。

WordPress 子组件示例：

```yaml
labels:
  app.kubernetes.io/name: wordpress
  app.kubernetes.io/instance: wordpress-abcxyz
  app.kubernetes.io/version: "4.9.4"
  app.kubernetes.io/managed-by: Helm
  app.kubernetes.io/component: server
  app.kubernetes.io/part-of: wordpress
```

MySQL 子组件：`name` 改为 `mysql`，`component` 为 `database`，`part-of` 仍为 `wordpress`。

## 版本发布

- 维护最近三个 minor：1.37、1.36、1.35。
- 支持周期：1.19+ 约 1 年；1.18 及更早约 9 个月。
- 版本格式 `x.y.z`（主.次.补丁）。
- 当前版本：
  - 1.37.0（2026-08-26 发布，2027-10-28 EOL）
  - 1.36.2（2026-06-09 发布，2027-06-28 EOL）
  - 1.35.6（2026-06-09 发布，2027-02-28 EOL）

## 37. 多区域运行

**核心概念**
- 单集群可跨多个故障域（zone），zone 归入 region；同 region 内各 zone 提供一致 API 与服务
- 架构目标：最小化单 zone 故障影响其他 zone 的概率

**控制平面**
- 控制面组件按组件复制，作为可互换资源池运行
- 高可用：至少选 3 个 zone，将 API server、scheduler、etcd、controller manager 各复制到至少 3 个 zone；cloud controller manager 也须覆盖所选全部 zone
- ⚠️ API server 端点无跨 zone 韧性；可用 DNS round-robin、SRV 记录或带健康检查的第三方负载均衡提升可用性

**节点与 Pod 调度**
- kubelet 启动时自动为 Node 打标签，含 zone 信息：`topology.kubernetes.io/zone`
- 工作负载 Pod 默认自动跨节点分散；可用节点标签 + Pod topology spread constraints 控制跨 region/zone/node 分布，降低关联故障风险
- 声明式定义约束即可，无需显式指定 zone；如令 StatefulSet 3 副本分处不同 zone：

```yaml
topologySpreadConstraints:
- topologyKey: topology.kubernetes.io/zone
  maxSkew: 1
  whenUnsatisfiable: DoNotSchedule
```

**版本状态**
- 1.33 已完结，最终补丁：1.33.13；下一版本：1.38
- EOL 版本不再受支持、无安全更新，须升级至受支持版本；个别版本曾因严重 CVE 在 EOL 后补发补丁

##### 节点跨可用区分布

- **节点管理**：K8s 不自动创建节点；可用 Cluster API 定义跨故障域的 worker 节点集，并自动修复整区故障。
- **Pod 指定 zone**：通过 `nodeSelector` 约束应用于 Pod 或工作负载资源模板（Deployment/StatefulSet/Job）。
- **存储 zone 感知**：PV 创建时自动打 zone 标签；调度器用 `NoVolumeZoneConflict` 保证申领 PV 的 Pod 与卷同 zone；标签方式取决于云厂商/存储供应商。可用 `StorageClass` 的 `allowed topologies` 限制故障域。
- **网络**：K8s 本身不感知 zone；依赖网络插件或 LB。`type=LoadBalancer` 可能只把流量转发到同 zone Pod；Service/Ingress 行为因集群而异。
- **容灾**：关键修复工作不能依赖至少一个健康节点；全节点故障时需用带特殊 `toleration` 的修复 Job 恢复。

##### kubeadm 搭建高可用外部 etcd

- 默认 kubeadm 在控制平面节点跑本地 etcd；也可用独立主机组成外部 etcd。
- **前置条件**：3 台主机互通（TCP 2379/2380，默认端口可配置），装有 systemd/bash、容器运行时/kubelet/kubeadm，能访问 `registry.k8s.io` 或使用 `kubeadm config images list/pull` 获取 etcd 镜像；etcd 以 static pod 运行；需 ssh/scp 复制文件。
- **流程**：在一节点生成全部证书，只分发必要文件到其他节点；kubeadm 自带完整证书生成能力，无需额外工具。
- 支持 IPv4/IPv6（etcd 不支持双栈）。
- 每台 etcd 主机需将 kubelet 配置为 etcd 的服务管理器。

- 覆盖 kubelet 服务优先级：创建 `/etc/systemd/system/kubelet.service.d/kubelet.conf`，关键参数：`cgroupDriver: systemd`（与容器运行时一致）、`containerRuntimeEndpoint: unix:///var/run/containerd/containerd.sock`、`staticPodPath: /etc/kubernetes/manifests`。
- 创建 `/etc/systemd/system/kubelet.service.d/20-etcd-service-manager.conf`，`ExecStart=` 置空。
- 执行 `systemctl daemon-reload && systemctl restart kubelet`。
- 生成 kubeadm 配置：导出 `HOST0/1/2` 为实际 IP，运行生成脚本（如 `export HOST0=10.0.0.6`）。

**1. 生成 kubeadmcfg.yaml**
- 目录：`mkdir -p /tmp/${HOST0}/ /tmp/${HOST1}/ /tmp/${HOST2}/`
- 每节点写 `/tmp/${HOST}/kubeadmcfg.yaml`：API `v1beta4`；`InitConfiguration` 填 `name`、`advertiseAddress`；`etcd.local` 填 SANs 及 `extraArgs`：`initial-cluster=NAME0=https://HOST0:2380,NAME1=https://HOST1:2380,NAME2=https://HOST2:2380`、`initial-cluster-state=new`、`name` 和 listen/advertise 的 peer/client URL。

**2. CA**
- 已有 CA：复制 `ca.crt`/`ca.key` 到 `/etc/kubernetes/pki/etcd/`；否则 `kubeadm init phase certs etcd-ca`

**3. 签发**（顺序 HOST2→HOST1→HOST0）
- 每个节点依次执行 phase：`etcd-server`、`etcd-peer`、`etcd-healthcheck-client`、`apiserver-etcd-client`，均带 `--config=/tmp/${HOST}/kubeadmcfg.yaml`

**4. 清理**（HOST0 除外）
- `cp -R /etc/kubernetes/pki /tmp/${HOST}/`
- `find /etc/kubernetes/pki -not -name ca.crt -not -name ca.key -type f -delete`

## kubeadm 高可用 etcd 集群

- 删除 `ca.key`（勿复制出本机）。
- 分发证书：scp 至各主机，`chown -R root:root pki && mv pki /etc/kubernetes/`。
- 必需文件：各主机 `$HOME/kubeadmcfg.yaml` 及 `/etc/kubernetes/pki/`（含 `etcd/` 证书）；仅 HOST0 有 `etcd/ca.key`。
- 生成静态 Pod 清单（各主机执行）：
```bash
kubeadm init phase etcd local --config=/tmp/${HOST0}/kubeadmcfg.yaml
# HOST1/HOST2: --config=$HOME/kubeadmcfg.yaml
```
- 健康检查：`etcdctl --cert ... --endpoints https://${HOST0}:2379 endpoint health`。

## 存储版本

- 存储版本是对象在 etcd 中的实际编码；API Server 自动转换。
- 每资源同时仅一个活动存储版本；API 版本与存储版本独立。
- 读取时动态转换，写入/更新时转为当前存储版本；旧版本在对象更新前可存在。
- CRD 必须显式指定存储版本，其 schema 用作存储层编码。

## Kubernetes API

- **用途**：查询和操作集群中 API 对象（Pod、Namespace、ConfigMap、Event 等）的状态。
- **核心**：API Server（kube-apiserver）暴露 HTTP API；用户、集群组件、外部组件均通过它相互通信。
- **调用方式**：通常用 `kubectl`、`kubeadm` 等 CLI 工具（内部调用 API）；也可直接 REST 调用，或使用官方 client libraries 编写应用。
- **API 规格发布机制**（供自动互操作，`kubectl` 会拉取并缓存以支持补全等功能）：
  - **Discovery API**：提供 API 摘要——名称、资源、版本、支持的操作；不含资源 schema；与 OpenAPI 相互独立。
  - **Kubernetes OpenAPI Document**：提供全部 API 端点的完整 OpenAPI v2.0/3.0 schema；推荐使用 OpenAPI v3，更全面准确；包含所有 API 路径、每个端点的输入/输出资源、集群支持的可扩展组件；数据量远大于 Discovery API。

## API 发现
- 资源含名称、范围、端点URL及动词、别名、组/版本/种类。
- 聚合发现（1.30+ stable）：`/api`、`/apis` 发布全部资源，需 `Accept: application/json;v=v2;g=apidiscovery.k8s.io;as=APIGroupDiscoveryList`；支持ETag、protobuf。
- 非聚合发现：先 `/api`、`/apis` 得APIGroupList，再请求 `/apis/<group>/<version>` 获取资源（kubectl依赖）。

## OpenAPI 接口定义
- 提供v2/v3；推荐v3（v2丢失`default`、`nullable`、`oneOf`）。
- V2：端点 `/openapi/v2`；Accept支持protobuf或json（默认）。⚠️ 精确校验用 `kubectl apply --dry-run=server`。
- V3（1.27+ stable）：`/openapi/v3` 返回所有group/version及 `serverRelativeURL`（含hash，不可变，过期重定向）。
  - 单组：`/openapi/v3/apis/<group>/<version>?hash=<hash>`；请求头同v2（protobuf为v3）。
  - Go客户端：`k8s.io/client-go/openapi3`。

## 其他
- Protobuf序列化用于集群内部通信，IDL在Go包。
- 持久化：对象序列化状态存入etcd。
- API组与版本：版本化在API层，路径如 `/api/v1`、`/apis/rbac.authorization.k8s.io/v1alpha1`；API组可启用/禁用。

# API 资源标识与版本转换
- 资源由 **API group、资源类型、namespace（仅命名空间资源）、name** 唯一区分。
- API server 透明处理版本转换；同一对象可经多个 API 版本访问/修改，不同版本只是同一持久化数据的不同表示。

# Kubernetes 培训与认证
- 免费课程：Introduction to Kubernetes / Cloud Infrastructure Technologies / Linux（edX）。
- Linux Foundation 提供应用开发与运维全生命周期课程。
- 认证：
  - **KCNA**：Kubernetes 与云原生基础。
  - **KCSA**：云原生安全基础，集群安全基线。
  - **CKAD**：设计、构建、配置、暴露云原生应用。
  - **CKA**：Kubernetes 管理员，安装/配置/管理生产集群。
  - **CKS**：容器与 Kubernetes 安全最佳实践；**须先有有效 CKA**。
- **Kubestronaut**：取得全部五项 CNCF 认证（CKA、CKAD、CKS、KCNA、KCSA）。

# kubeadm 故障排查
- 先搜 kubeadm GitHub issues；无果提 issue，或到 Slack `#kubeadm`、StackOverflow 提问（标签 `#kubernetes`、`#kubeadm`）。

## v1.18 Node 无法加入 v1.17 集群
- 原因：v1.18 kubeadm 新增同名 Node 预防检查，需为 bootstrap-token 用户添加 GET Node 的 RBAC，但 v1.17 缺失。
- 解决：在 v1.18 控制平面执行：
```bash
kubeadm init phase bootstrap-token
```
- 注意：该命令会同时启用其余 bootstrap-token 权限。

- **手动 RBAC**：`kubectl apply -f` 创建 ClusterRole `kubeadm:get-nodes`（`get` nodes）和 ClusterRoleBinding，绑定组 `system:bootstrappers:kubeadm:default-node-token`。
- **缺 `ebtables`/`ethtool`**（`kubeadm init` 警告）：`apt install ebtables ethtool`（Ubuntu/Debian）；`yum install ebtables ethtool`（CentOS/Fedora）。
- **init 卡在 "waiting for control plane"**：检查网络连通性；用 `docker ps`/`docker logs` 或 `crictl` 查控制面容器。
- **`kubeadm reset` 卡在移除容器**：重启容器运行时，再重跑 `kubeadm reset`。
- **Pod 状态异常**（`RunContainerError`/`CrashLoopBackOff`/`Error`）：init 后不应出现；安装网络插件后出现则插件损坏。
- **`coredns` 卡 `Pending`**：正常，先装 Pod 网络插件。
- **`HostPort` 不生效**：依赖 CNI；Calico/Canal/Flannel 支持；否则用 `NodePort` 或 `HostNetwork=true`。
- **Service IP 访问失败**：多因 hairpin 未启用；VirtualBox 下 `hostname -i` 需返回可路由 IP（改 `/etc/hosts`）。
- **TLS 证书错误**：可能证书不匹配。

## x509 未知权威
- 覆盖 admin kubeconfig：`sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config && sudo chown $(id -u):$(id -g) $HOME/.kube/config`

## Kubelet 证书轮换
- 删除故障节点 `/etc/kubernetes/kubelet.conf`、`/var/lib/kubelet/pki/kubelet-client*`
- 控制平面生成 `kubeadm kubeconfig user --org system:nodes --client-name system:node:$NODE > kubelet.conf`（`$NODE` 节点名）
- 复制回节点并重启 kubelet
- 修改 kubelet.conf 的 `client-certificate`/`client-key` 为 `/var/lib/kubelet/pki/kubelet-client-current.pem`
- 再次重启，确认 Ready

## Flannel 默认网卡
- flannel 加 `--iface eth1`

## 容器非公网 IP
- kubeadm `kubeletExtraArgs` 加 `--node-ip`（eth0/eth1）
- 重启 `systemctl daemon-reload && systemctl restart kubelet`

## 43. 交钥匙云解决方案（Turnkey Cloud Solutions）

- 本页为 Kubernetes 认证方案提供商目录
- 各提供商页面提供安装与搭建生产就绪（production ready）集群的指南
- 可直接选用认证提供商快速部署生产环境
- 反馈渠道：Stack Overflow 提问、GitHub 仓库提交 issue

**节点一致性测试（Node Conformance Test）**

容器化测试框架，验证节点是否满足 Kubernetes 最低要求；通过测试的节点具备加入集群资格。

**前置条件**
- 安装 CRI 兼容运行时（Docker、containerd、CRI-O）
- 安装 kubelet

**运行测试**
1. 确定 kubelet 的 `--kubeconfig` 值，如 `--kubeconfig=/var/lib/kubelet/config.yaml`；测试框架启动本地控制面，API server URL 用 `http://localhost:8080`
2. 若使用 `--cloud-provider=gce` 需移除该 flag

```bash
# $CONFIG_DIR 为 kubelet 的 pod manifest 路径；$LOG_DIR 为测试输出路径
sudo docker run -it --rm --privileged --net=host \
  -v /:/rootfs -v $CONFIG_DIR:$CONFIG_DIR -v $LOG_DIR:/var/result \
  registry.k8s.io/node-test:0.2
```

**其他架构镜像**

| Arch | Image |
|---|---|
| amd64 | node-test-amd64 |
| arm | node-test-arm |
| arm64 | node-test-arm64 |

**筛选测试**
- 仅运行指定测试（正则）：`-e FOCUS=MirrorPod`
- 跳过指定测试（正则）：`-e SKIP=MirrorPod`

**注意事项**
- 是 node e2e test 的容器化版本，默认运行全部一致性测试
- 理论上可配置运行任意 node e2e 测试，但强烈建议仅运行一致性测试（非一致性测试配置极复杂）
- 测试会在节点上遗留 docker 镜像和死容器

---
来源：consolidated/services/容器编排（Kubernetes）.md