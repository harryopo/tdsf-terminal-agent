---
source: archwiki
category: basic-ops
url: consolidated/basic-ops/安全与访问控制（Arch Wiki）.md
title: 1. 访问控制列表
---

### 访问控制列表 (ACL)

- 补充传统UNIX权限，可为任意用户/组设置权限；`acl`包默认已装（systemd依赖）。
- 启用前提：内核支持 `CONFIG_POSIX_ACL`，文件系统挂载启用；若 `/proc/mounts` 出现 `noacl` 则覆盖默认配置。Ext4 默认开启，Btrfs/XFS 硬编码。

**核心命令**
```bash
setfacl -m "u:用户:权限" 文件     # 设置用户权限；g: 为组
setfacl -m "other:权限" 文件      # 设置其他用户
setfacl -dm "条目" 目录           # 默认ACL，新建文件继承（移动来的不继承）
setfacl -x "条目" 文件            # 删除指定条目；-k 删默认；-b 删除所有ACL
getfacl 文件                      # 查看ACL
```
- 常用参数：`-R` 递归，`--test` 试运行，`-n` 不重算 mask。

**mask 机制**：mask 限制命名用户/组及 owning group 的最大有效权限。`setfacl` 默认重算 mask 为这些条目权限的并集；有效权限 = 条目权限 ∩ mask。如 `u:bob:rwx`、mask `r-x`，有效 `r-x`。

**识别**：`ls -l` 权限位有 `+` 即含 ACL。

**安全实践**（如 http 访问家目录）
```bash
setfacl -m "u:http:--x" /home/geoffrey   # 目录需执行权限
chmod o-rx /home/geoffrey
setfacl -dm "u:http:rwx" /home/geoffrey/project1/cache
```

- ACL 扩展 POSIX 权限；`getfacl` 查看，`setfacl` 设置。
- `setfacl -m u:user:rwx file`；递归 `-R`；删条目 `-x`；清除全部 `-b`；删默认 `-k`。
- 默认 ACL：`setfacl -m d:u:user:rwx dir`，新建文件继承。
- 易错：`chmod` 改 mask，限制命名用户/组权限。

## AppArmor
- 基于 LSM 的 MAC，补充非替代 DAC；不可超出原有权限。基于路径配置；SELinux 基于标签，较复杂。

### 安装
- `pacman -S apparmor`；`systemctl enable apparmor.service`
- 追加内核参数：`lsm=landlock,lockdown,yama,integrity,apparmor,bpf`
- 易错：`apparmor` 须首个 major 模块；`capability` 自动含；见 `cat /sys/kernel/security/lsm`

### 使用
- `aa-enabled`/`aa-status`；模式：complain 放行（deny 仍强制），enforce 阻止并记录
- `apparmor_parser`：`-a` 加载；`-C` complain；`-r` 覆盖；`-R` 移除
- 禁用：`aa-teardown`；`systemctl disable apparmor.service`；`apparmor=0`

### 生成策略
- 需 `auditd`；AVC 可能干扰 `ausearch`
- 流程：`aa-genprof` → `aa-logprof` → `aa-enforce`（初始 complain）
- deny 非必需（默认拒绝未显式允许项），但有特殊用途

## AppArmor
- deny 优先于 allow，用于 `/etc/apparmor.d/abstractions` 阻止访问关键文件，防 allow 过度放权。
- deny 抑制日志；complain 模式仍强制生效，异常先检查 deny。
- 额外 profile：`/usr/share/apparmor/extra-profiles/`（未必生产就绪）。

### Profile 结构
- 位置：`/etc/apparmor.d/`，文本描述执行策略。
- `@` 变量，`#include` 包含，路径后权限。
- 常用权限：`r` 读、`w` 写、`m` 映射执行、`x` 执行（需限定符）；受 DAC 约束。

### 桌面通知 DENIED 动作
- auditd：`groupadd -r audit`；`gpasswd -a 用户 audit`；`auditd.conf` 设置 `log_group = audit`。
- 易错：audit 4.1.2-1 的 tmpfiles.d 重置 `/var/log/audit` 权限，需在 `/etc/tmpfiles.d/` 创建覆盖文件。

## 核心转储
- 进程崩溃内存快照，可能含密码/密钥，仅与可信方共享；由内核交给 systemd-coredump。
- 禁用自动转储：创建 `/etc/sysctl.d/50-coredump.conf`：
```
kernel.core_pattern=|/bin/false
```
- 生效：`sysctl --system`

- 默认 systemd-coredump：`/usr/lib/sysctl.d/50-coredump.conf` 设 `kernel.core_pattern` 指向 `systemd-coredump`，dump 存 `/var/lib/systemd/coredump`。
- 自定义：在 `/etc/systemd/coredump.conf.d/` 建配置片段，必须带 `[Coredump]` 节，否则忽略；改后 `daemon-reload`。示例：
  ```ini
  [Coredump]
  Storage=none
  ProcessSizeMax=0
  ```
- 禁用：
  - PAM `limits.conf` 的 `core` 项；shell `ulimit -c 0`。
  - 易错：若 `kernel.core_pattern` 为管道，内核忽略 ulimit，取决于接收程序；systemd-coredump 仍遵守。
  - 个别进程可用 `prctl(2)` 的 `dumpable`。
- 手动生成：gdb attach 后 `(gdb) generate-core-file`。
- 存放由 `kernel.core_pattern` 决定。默认 `Storage=external`、`Compress=yes`（zstd）。设 `kernel.core_pattern=core` 可明文存当前工作目录。
- 查看/提取：`coredumpctl`。

- core dump 存于 `/var/lib/systemd/coredump/`，由 `systemd-tmpfiles --clean` 自动清理（每日 `systemd-tmpfiles-clean.timer` 触发），至少保留 2 周。
- 查看清理配置：`systemd-tmpfiles --cat-config`
- 删除 journal 条目：参考手动清理 journal 文件。

- 分析 dump 前需唯一标识，可按 PID、可执行文件名、路径或 journalctl 谓词指定。
- 查看 dump 列表：`coredumpctl list`
- 详见 `coredumpctl(1)`、`journalctl(1)`。

- `coredumpctl info <match>`：看 `Signal` 行定位崩溃原因
- 默认 `gdb` 分析 backtrace

## coredumpctl + gdb 调试
- `coredumpctl debug` 进入 gdb，执行 `thread apply all backtrace full` 打印完整回溯。
- 回溯中出现 `?` 表示缺少调试符号，需安装对应 debugging symbols。

## dm-crypt
- Linux 内核 device mapper 加密目标，透明磁盘加密；可加密整盘、分区、RAID、LVM、文件；支持文件系统、swap、LVM PV。
- 核心工具：`cryptsetup`（LUKS、plain）。
- 关键操作：
  - 安全擦除、分区后用 `cryptsetup` 加密；LUKS 密钥管理、备份/恢复。
  - 系统配置：`mkinitcpio`、内核参数、`crypttab`。
  - swap 必须加密；区分有无 suspend-to-disk 支持。
  - 特殊：保护未加密 boot、GPG/OpenSSL 加密 keyfiles、网络远程解锁、SSD TRIM、encrypt hook 多磁盘。
- 场景：加密非 root 文件系统；全盘加密（LUKS/plain/LVM）。
- 参考：cryptsetup 项目主页与 FAQ。

## Firejail
- setuid 沙箱，用 Linux namespaces、seccomp-bpf、capabilities 限制未信任应用。
- 警告：不能使运行未信任代码绝对安全。
- 安装：`firejail`；GUI：`firetools`。
- 配置：
  - 默认 profile：`/etc/firejail/application.profile`；自定义：`~/.config/firejail/`。
  - 无匹配 profile 时使用系统默认限制，可能导致应用异常。
- 易错点：多数自带 profile 依赖黑名单，未明确禁止的资源仍可访问（如 btrfs 快照绕过 `$HOME/.ssh` 限制）；需审计 profile。
- 参考：`firejail-profile(5)`。

- 默认保护运行程序：`firejail program_name`
- 临时附加选项（如 seccomp）：`firejail --seccomp okular`
- 自定义 profile：`firejail --profile=/绝对路径/profile program_name`

全局默认启用 Firejail：

```bash
sudo firecfg
```

- 在 `/usr/local/bin/` 为已有 profile 的程序创建指向 `/usr/bin/firejail` 的符号链接
- 仅处理 `/etc/firejail/firecfg.config` 列出的程序；`tar`、`curl`、`git` 等 CLI 程序不在其中，需手动链接
- 同时将当前用户加入 Firejail 用户访问数据库；检查 `/usr/share/applications/*.desktop`，移除可执行文件完整路径并复制到 `~/.local/share/applications/`，防止绕过
- 无 sudo 时以 root 执行：`# firecfg`

```bash
# firecfg                      # root
$ firecfg --fix                # 用户，修复 .desktop
```

- 手动显式调用：编辑 `~/.local/share/applications/` 下 .desktop 的 `Exec=` 行。
- pacman hook 自动运行：`/etc/pacman.d/hooks/firejail.hook`，关键参数 `Type=Path`、`Target=usr/bin/*`、`Target=usr/share/applications/*.desktop`、`Exec=firecfg >/dev/null 2>&1`。

- 创建符号链接封装：`ln -s /usr/bin/firejail /usr/local/bin/application`
  - 前提：`/usr/local/bin` 须在 `PATH` 中先于 `/usr/bin`（Arch 默认 `/etc/profile` 已满足）。
  - 以自定义 firejail 设置运行：命令前加 `firejail`。
  - 守护进程：需覆盖对应 systemd unit 文件。
  - 易错：勿为 `gzip`、`xz` 建符号链接，会破坏 `makepkg` 预加载 `libfakeroot.so`。

- 启用 hardened_malloc：
  - 部分程序不兼容（如 PyCharm、Firefox）。
  - 临时启动：
    ```bash
    $ firejail --env=LD_PRELOAD='/usr/lib/libhardened_malloc.so' /usr/bin/firefox
    ```
  - 永久生效：自定义 profile 中加入：
    ```
    env LD_PRELOAD=/usr/lib/libhardened_malloc.so
    ```
  - 若 profile 启用 `private-lib`，需追加：
    ```
    private-lib /lib/libhardened_malloc.so
    ```
  - 调参变量见 hardened_malloc GitHub 页。

- AppArmor 支持（0.9.60-1+）：
  - 安装生成 `/etc/apparmor.d/firejail-default`，需以 root 加载进内核。

## Firejail AppArmor 集成

- 启用：`apparmor_parser -r /etc/apparmor.d/firejail-default`
- 启用方式：`firejail --apparmor firefox`；profile 加 `apparmor`
- 专用 AppArmor profile 需 `ignore apparmor`，不推荐

## 自定义 profile

- `blacklist <路径>` 拒绝；`noblacklist` 须写在上方
- `whitelist <路径>` 放行并封锁顶级目录其余；`nowhitelist` 须写在上方
- 复制 `profile.template` 为 `ProfileName.profile`，改 `include ProfileName.local`，勿改模板顺序
- 构建：`firejail --build application`
- 易错点：白名单型不适于随机路径访问；原则：**尽可能限制，保持可用**

## polkit

- 应用级授权框架，非特权与特权进程通信，不授予整体 root
- 动作 + 用户 + 获准方式（如输密码）
- 安装 `polkit`；认证代理 `pkttyagent`；图形环境需图形代理

- 规则目录：第三方 `/usr/share/polkit-1/rules.d`，本地 `/etc/polkit-1/rules.d`（`root:polkitd`）
- `pkaction` 列出；权限：`no`拒/`yes`免/`auth_self`普通密码/`auth_admin`管理员密码/`*_keep`保持
- 改后 `systemctl reload polkit.service`；`polkit.addRule()` 按文件序，`00-` 提前
```javascript
polkit.addRule(function(action, subject) {
    if (action.id == "org.gnome.gparted" &&
        subject.isInGroup("admin")) {
        return polkit.Result.YES;
    }
});
```
- 默认 `50-default.rules` 复制到本地改；`addAdminRule()` 指定管理员，如 `["unix-group:wheel"]`；身份 `unix-user:名`/`unix-group:组`
- 易错：不改 actions 文件（升级覆盖），用 rules 覆盖；不用 polkit 限制半特权，用 sudoers

- Arch: `wheel` 组默认为管理员。
- polkit 可改为输 root 密码认证；规则文件 `/etc/polkit-1/rules.d/49-rootpw_global.rules`

### 安全核心理念

- **权衡**：安全性可无限提高，但以可用性为代价，需平衡。
- **最大威胁始终是用户自身**。
- **最小权限原则**：每个部件仅能访问严格必需资源。
- **纵深防御**：多层独立防护，一层失守时另一层拦截。
- **保持偏执与怀疑**；无法做到 100% 安全（除非断电封存）。
- **为失效做准备**：预先制定安全被突破时的应对计划。

### 密码安全

**选取原则**：强度取决于**长度与随机性**（熵）。弱哈希算法下，8 字符密码数小时内可被破解。

**不安全密码示例**：
- 含个人可识别信息（宠物名、生日、区号、游戏名）
- 简单字符替换（如 `k1araj0hns0n`），现代字典攻击可轻易破解
- 根词/常见词前后加数字符号（如 `DG091101%`）
- 多个字典词组合的短语（如 `photocopyhauntbranchexpose`），含替换（如 `Ph0t0c...`）
- 任何常见密码列表中的密码

**推荐做法**：
- 用随机工具生成：`pwgen`、`apg`（AUR）、`keepassxc`（GUI 支持字典式口令生成）。
- 记忆技巧：长随机密码可临时写下，逐次增加记忆字符直至形成肌肉记忆；或使用助记短语映射字符（如 `the girl...` → `t6!WdtR5`）。
- 随机密码可写下来放钱包/文件保险箱等物理安全处。
- 密码管理器：记住一个高强度主密码，其余随机密码密管存储；注意主密码是单点故障，须只用于此目的且绝不保存。
- 口令短语法：从数千词库中随机选 5~7 个词（如 Diceware），熵足够高；可能组合数 = 词库大小 ^ 选词数。

## 密码安全核心要点

**威胁防范**
- 警惕键盘记录器、屏幕记录器、社会工程、肩窥
- 避免密码复用，防止不安全服务器泄露过多信息

**密码管理器**
- 复制密码后每次清空剪贴板；勿粘贴到终端命令，避免写入 `.bash_history` 等日志
- 浏览器扩展实现的密码管理器易受侧信道攻击，改用独立应用

**密码选择**
- 不因难记而选弱密码；加密数据库+强主密码优于多个相似弱密码
- 手写记录同样有效，但需物理安全
- 密码/口令不得能从其他来源轻易恢复

**磁盘加密与登录密码混用**
- 若同一密码用于磁盘加密和登录，确保 `/etc/shadow` 位于加密分区，且哈希用强 KDF：yescrypt/argon2 或 sha512+PBKDF2；禁用 md5 或低迭代次数
- Arch 2023 起默认哈希算法为 yescrypt：执行 `passwd` 即可应用新默认

**密码库备份**
- 每份备份不能存放在"密码库内记录的密码"保护之下（如加密盘、远程存储），否则无法访问
- 技巧：用主密码的简单哈希保护备份位置；维护备份位置清单
- 怀疑泄露须立即更换所有备份及派生密钥位置的主密码
- 版本控制数据库需能更新所有版本的主密码；可定期更换以降低泄露风险

---
来源：consolidated/basic-ops/安全与访问控制（Arch Wiki）.md