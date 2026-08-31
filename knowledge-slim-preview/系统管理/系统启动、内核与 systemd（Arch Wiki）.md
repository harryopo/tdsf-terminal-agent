---
source: archwiki
category: sys-admin
url: consolidated/sys-admin/系统启动、内核与 systemd（Arch Wiki）.md
title: 系统启动、内核与 systemd（Arch Wiki）
---

- ESP 挂 /boot，fstab 用 UUID
- /etc/kernel/cmdline、/etc/modules-load.d
- mkinitcpio -P；bootctl install --esp-path=/boot
- systemctl、journalctl

## Arch 启动流程

### 固件类型
- **UEFI**：读取分区表和文件系统；不执行 MBR 引导代码；依赖 NVRAM 启动项；支持 FAT12/16/32；EFI 应用存放于 ESP，路径如 `/EFI/vendor_name`；支持 CSM 兼容 BIOS，Intel 正淘汰。
- **BIOS**：主板固件，已被 UEFI 取代。

### UEFI 启动
1. POST 后初始化硬件
2. 读取 NVRAM 启动项
3. 启动 EFI 应用（boot loader、内核 EFI stub、UEFI shell、boot manager）

- 启动项为磁盘时，固件查找 ESP 回退路径：

```text
\EFI\BOOT\BOOTx64.EFI
```

- 启用 Secure Boot 时验证 EFI 二进制签名
- 多启动：各 OS 独立维护 ESP 文件，无需 chain loading
- 易错：某些 UEFI 固件只能从回退路径启动；启用 CSM 时会尝试 MBR 引导

### BIOS 启动
1. POST 后初始化硬件
2. 执行首个磁盘 MBR 前 440 字节引导代码
3. 引导代码加载第二阶段（post-MBR gap、分区 VBR 或 GPT 的 BIOS boot partition）
4. 启动 boot loader → 内核

### Boot loader 与 boot manager
- **boot loader**：由固件启动，负责加载内核、内核参数、initramfs
- **boot manager**：提供菜单或控制方式，运行 EFI 可执行文件
- UEFI 下内核可直接启动（EFI boot stub），boot loader 便于启动前编辑内核参数

## 核心要点
- 32 位 IA32 UEFI 需要支持混合模式（mixed mode）引导的引导加载程序。
- 引导加载程序必须能访问 `/boot` 中的内核和 initramfs；即需支持从块设备、堆叠块设备（LVM/RAID/dm-crypt/LUKS）到文件系统的完整链路。
- 几乎无引导加载程序支持堆叠块设备，且新文件系统特性可能不被支持。可行方案：独立 `/boot` 分区，使用通用文件系统如 `FAT32`。
- GPT 属 UEFI 规范，所有 UEFI 引导器均支持 GPT；BIOS 上可用 Hybrid MBR 或 GPT-only 协议，但某些 BIOS 实现可能有问题。
- Secure Boot 同理，所有 UEFI 引导器均支持，但部分有限制。

## 引导器对比
- Clover：BIOS/UEFI 均支持；不支持 MBR；支持 GPT；可在 legacy BIOS 上模拟 UEFI。
- EFI boot stub：仅 UEFI；内核本身是 EFI 可执行文件，可由 UEFI 直接启动；文件系统支持继承自固件。
- GRUB：BIOS/UEFI 均支持；MBR/GPT 均支持；文件系统内建；支持 RAID、LUKS、LVM（但不支持 thin provisioned volumes）。
- Limine：BIOS/UEFI 均支持；MBR/GPT 均支持；文件系统支持有限。
- rEFInd：仅 UEFI；MBR/GPT 均支持；文件系统可扩展；能自动检测内核和参数，无需显式配置，支持 fastboot。
- Syslinux：BIOS 支持，UEFI 仅部分支持；MBR/GPT 均支持。

- **ESP**：独立于 OS 的 FAT 分区，UEFI 启动必需。
- **检查现有 ESP**：`fdisk -l /dev/sdx`；GPT 显示 `gpt`，MBR 显示 `dos`；类型为 `EFI System` 且挂载后含 `EFI` 目录。**双系统勿重格式化 ESP**。
- **创建分区**：必须物理分区，**不能**在 LVM/软 RAID 下。
- **大小**：推荐 **1 GiB**（保守 4 GiB）；早期固件 ≥512 MiB；单内核挂 /boot 400 MiB；Windows 双启动 4Kn 盘 ≥300 MiB，否则 ≥100 MiB；FAT32 最小：512B 扇区 ≥36 MiB，4Kn 扇区 ≥260 MiB。
- **GPT 盘**：类型 GUID `C12A7328-F81F-11D2-BA4B-00A0C93EC93B`；fdisk `t`→`uefi`；gdisk `EF00`；Parted `fat32`+`esp`。
- **MBR 盘**（不推荐）：类型 ID `EF`；fdisk `t`→`EFI (FAT-12/16/32)`；Parted `fat32`+`esp`；部分固件不支持，`bootctl` 不支持 MBR 安装。
- **格式化**（FAT32）：
  ```bash
  mkfs.fat -F 32 /dev/sdxY
  ```

### 格式化为 FAT
- FAT32 报 cluster 过少警告时：`mkfs.fat -s 2 -F 32 ...` 或 `-s 1` 减小簇；否则 UEFI 可能无法读取。
- 分区 <32 MiB 可用 FAT16/FAT12，例：`# mkfs.fat -F 12 /dev/sdxY`

### 挂载 ESP
- 内核/initramfs/微码需让引导器或 UEFI 可访问。
- 若 ESP 不在 `/boot`，升级内核前务必手动挂载，勿依赖 systemd 自动挂载；否则升级后可能无法挂载，锁死当前内核。
- 可预加载模块：`/etc/modules-load.d/vfat.conf`
```
vfat
nls_cp437
nls_ascii
```

### 典型挂载点
- **挂到 `/boot`**：便于维护，微码/mkinitcpio 默认路径，兼容多数引导器。但增加 ESP 容量要求；双启动时易被篡改；无法加密 `/boot`；根快照回滚后内核与 `/boot` 不一致。
- **挂到 `/efi` + XBOOTLDR 挂 `/boot`**：ESP 过小时使用，systemd-boot 支持。
- **仅挂 `/efi`**：目前仅 GRUB 与 rEFInd 支持。

`/etc/fstab` 定义分区/块设备/远程文件系统的挂载方式，systemd 启动时动态转换为 mount 单元，自动 fsck 并在依赖服务前挂载；NFS/Samba 等远程挂载会等待网络就绪。

### 字段格式
每行一个文件系统，六列：

```
# <device>  <dir>  <type>  <options>  <dump>  <fsck>
UUID=...    /      ext4    defaults   0       1
```

- `<device>`：设备标识（推荐 UUID/PARTUUID，禁用内核设备名）
- `<dir>`：挂载点，需预先创建
- `<type>`：文件系统类型；`auto` 可自动探测（光盘适用）
- `<options>`：挂载选项，如 `defaults,nodev,nosuid,noexec` 等
- `<dump>`：通常 `0` 禁用备份检查
- `<fsck>`：启动检查顺序；根分区 `1`，其他 `2` 或 `0`；**btrfs/XFS 根分区应设 `0`**

### 设备标识方式
`lsblk -f` 或 `blkid` 查看标识：

| 方式 | 示例 |
|---|---|
| 内核名 | `/dev/sda1` |
| 卷标 | `LABEL=ESP` |
| 文件系统 UUID | `UUID=CBB6-24F2` |
| GPT 分区 UUID | `PARTUUID=...` |

**易错点：**
- 内核设备名（`/dev/sd*`）不持久，每次启动可能变化，禁止用于 fstab
- 标识含空格需转义（如 `\040`）
- 挂载点目录必须事先存在
- 列出的设备不存在会导致启动错误，除非加 `nofail` 选项；`noauto` 可阻止开机自动挂载
- 指定单一设备或目录时，`mount` 会从 fstab 补全另一项及挂载选项

## /etc/fstab 标识方式
- 用 `blkid` 查看分区，使用 `PARTLABEL` 或 `PARTUUID`（去掉引号）。
- 字段含空格时用 `\040` 转义。

```fstab
PARTLABEL=GNU/Linux                  /     ext4 defaults                                           0      1
PARTLABEL=EFI\040system\040partition /boot vfat defaults,nodev,nosuid,noexec,fmask=0177,dmask=0077 0      2
PARTLABEL=Home                       /home ext4 defaults                                           0      2
PARTLABEL=Swap                       none  swap defaults                                           0      0
```

## systemd 自动挂载
- 大分区如 `/home`：加 `x-systemd.automount`，首次访问时才 fsck/挂载，避免开机阻塞；挂载类型变为 `autofs`，`locate` 默认忽略。
- 远程文件系统：加 `x-systemd.automount,_netdev,x-systemd.mount-timeout=30`，确保网络就绪后挂载并限制等待。
- 修改 fstab 后：`systemctl daemon-reload`，重启 `remote-fs.target`。
- 加密分区（带 keyfile）：`crypttab` 与 `fstab` 对应条目加 `nofail`，避免开机等待；默认 mount 服务仅等 90 秒，keyfile 延迟可能失败，改用 `x-systemd.mount-timeout=0` 无限等待。

### GRUB

**核心概念**
- GRUB = GRand Unified Bootloader，当前即 GRUB 2（原 GRUB Legacy 为 0.9x）
- 全文 `esp` 指 EFI 系统分区挂载点
- 自带多文件系统支持：FAT32、ext4、Btrfs、XFS
- ⚠️ 文件系统新特性可能不被 GRUB 支持，`/boot` 建议用独立分区并选 FAT32 等通用格式

**UEFI 要点**
- 安装介质必须以 UEFI 模式引导，否则 `efibootmgr` 无法写入 NVRAM 启动项
- 必须有 EFI 系统分区
- x64 UEFI 用 `x86_64-efi`；IA32（32 位 UEFI）用 `i386-efi`
- Secure Boot 开启时无法 `insmod` 额外模块；需用 `grub-mkstandalone` 重新生成 `grubx64.efi`，或重装时将模块编入

**安装步骤**
1. 安装 `grub` + `efibootmgr`（后者用于写 NVRAM 启动项）
2. 挂载 ESP，以下 `esp` 为其挂载点
3. 选启动标识符（如 `GRUB`），生成 `esp/EFI/GRUB/` 并显示在 UEFI 启动菜单
4. 执行：
```bash
# grub-install --target=x86_64-efi --efi-directory=esp --bootloader-id=GRUB
```

**易错点**
- 必须在 chroot 内运行 `grub-install`；否则追加 `--boot-directory=/mnt/boot`
- `--bootloader-id` 不能含空格（部分主板不支持）
- EFI 在 RAID 上：仅支持 mdadm 0.90/1.0 元数据；`grub-install` 需加 `--no-nvram`，再用 `efibootmgr` 手动添加启动项
- 安装后 GRUB 主目录为 `/boot/grub/`
- ⚠️ 配置完成后必须生成主配置文件，否则系统不会出现在 GRUB 菜单

## GRUB UEFI 安装与安全启动

- `--removable`：安装至 `esp/EFI/BOOT/BOOTX64.EFI`；EFI 变量重置或换机仍可引导；Mac 必须；部分主板（MSI）仅识别此位置。
- 双系统：Windows 同路径 EFI 程序仅重建其启动项；固件更新可能删启动项，`--removable` 可回退。
- UEFI 参数：`--efi-directory`（废弃 `--root-directory`）、`--bootloader-id`。
- `grub-install` 忽略 `device_path`（如 `/dev/sda`）：UEFI 不用 MBR/分区引导扇区。
- Secure Boot 配置错误可能无法引导；先禁用 Secure Boot 排查。

CA Keys 安装：
```bash
grub-install --target=x86_64-efi --efi-directory=esp --bootloader-id=GRUB --modules="tpm" --disable-shim-lock
```

Shim-lock（需先配置 shim，备好 sbsigntools）：
- GRUB ≥ `2.06.r261.g2f4430cc0` 后 Secure Boot 禁止 `insmod`，否则报错 `error: prohibited by secure boot policy`。
- 读取 vmlinuz/initramfs 所需文件系统模块必须全部嵌入 EFI 二进制。

## 启动性能优化

- 分析耗时：`systemd-analyze`、`blame`、`critical-chain`、`plot > plot.svg`。
- 用 systemd-boot/GRUB 时还能显示 EFI 固件与引导加载器耗时。
- 自定义内核：官方模块以 `ZSTD_CLEVEL=19` 压缩，SSD 用 `1` 可能更快；建议将根卷存储/文件系统模块编入内核，免 initramfs。
- Initramfs：mkinitcpio 可省略默认 `base` hook 提速（需替代 `fsck` hook 检查）。

### 缩小 initramfs
- 可用 mkinitcpio 的 `autodetect` 钩子精简
- 或改用 Booster：生成更小 initramfs，单二进制 init，比 mkinitcpio/dracut 更小

### 压缩选项
- 默认 zstd，可改用 lz4：解压更快，体积稍大，启动读取稍慢，总体可能更快

### 最小化 Intel 微码镜像
- 若不用 initramfs 或使用 Booster，可用 pacman hook 配合 `iucode-tool` 收缩 intel-ucode.img：

```ini
/etc/pacman.d/hooks/shrink-intel-ucode
[Trigger]
Type = Package
Operation = Install
Operation = Upgrade
Target = intel-ucode

[Action]
Description = Minimizing intel-ucode.img ...
When = PostTransaction
Depends = iucode-tool
Exec = /usr/bin/iucode_tool -S /usr/lib/firmware/intel-ucode --overwrite --write-earlyfw=/boot/intel-ucode.img
```

### 服务启动方式
- systemd 优先使用 D-Bus/socket 激活：按需启动，如桌面启用 `cups.socket` 而非 `cups.service`
- 若服务必然启动（如 `upower`），直接 enable `upower.service` 可尽早启动，避免 socket/D-Bus 激活竞态

### Staggered spin-up (SSS)
- 某些硬件串行探测 ATA 接口，逐盘启动，降低峰值功耗但拖慢启动；消费级硬件通常无益

## 启动优化

- SATA AHCI：检查 `dmesg | grep SSS`，无输出即未用；禁用：`libahci.ignore_sss=1`
- 挂载：
  - 用 mkinitcpio 的 `fsck` hook：内核行 `ro` 改 `rw`，加 `rootflags=rw,other_mount_options`；删除 fstab 根条目，或 mask `systemd-remount-fs.service`
  - Btrfs 根：移除 `fsck` hook、mask `systemd-fsck-root.service` 或加 `fsck.mode=skip`
  - API 文件系统自动挂载，可移出 fstab；查看：`pacman -Ql systemd | grep '\.mount$'`
  - `/home`、ESP 用 `noauto,x-systemd.automount`；若 `/` 为 btrfs 子卷且 `/home` 独立，mask `home.conf`：`ln -s /dev/null /etc/tmpfiles.d/home.conf`
- 减少启动输出可提速（SSD 上 TTY 是瓶颈）
- 换引导器（如 systemd-boot）可省数秒；EFI boot stub 更快
- 挂起到 RAM 是最佳优化

## 内核

- 内核装到 `/usr/lib/modules/`，vmlinuz 复制到 `/boot/`；切换内核需同步引导器配置
- 官方内核：
  - `linux`：稳定版+少量补丁
  - `linux-hardened`：安全强化
  - `linux-lts`：长期支持，适合外部模块
  - `linux-rt`/`linux-rt-lts`：实时，几乎全可抢占
  - `linux-zen`：日常优化
- 自定义编译用 ABS 或手动；警告：可能不稳定/数据丢失，需备份；官方仅支持上述内核

### 内核配置与自编译
- 按 CPU/架构调配置；去掉未用设备（蓝牙、video4linux、千兆网）可减小体积、加快编译。
- Arch 内核源码含 `config`；启用 `CONFIG_IKCONFIG_PROC`，则运行配置见 `/proc/config.gz`。

### 内核变体
- 官方：`linux-git`（Linus 仓库）、`linux-mainline`（主线）、`linux-next-git`（前瞻）、`linux-lts*`（LTS）。
- 非官方：`linux-cachyos`（新调度）、`linux-libre`（自由驱动）、`linux-lqx`（桌面/游戏）、`linux-pf`（多补丁）、`linux-prjc`（BMQ/PDS）、`linux-nitrous`（新CPU）、`linux-tachyon`（Clear Linux）、`linux-tkg`（多调度器）、`linux-vfio`（PCI直通）、`linux-xanmod`（BBRv3/高性能）。
- 非官方内核特性需手动启用，见补丁文档。

### 内核模块
- 模块可按需加载/卸载，免重启扩展功能。
- 模块项 `M` 表示可加载，否则内置。
- 新内核用 DKMS 自动重建第三方模块。

### 排障
- Kernel panic：不可恢复错误，多因驱动 bug，死锁需重启。

- 内核模块存放于 `/usr/lib/modules/$(uname -r)/`，用 `uname -r` 查看当前版本。
- 模块名中的 `_` 与 `-` 可互换（`modprobe` 及 `/etc/modprobe.d/` 中自动转换）。

**常用命令**
```bash
lsmod                    # 查看已加载模块
modinfo module_name      # 查看模块信息
systool -v -m module_name  # 查看已加载模块的选项（需 sysfsutils）
modprobe -c | less       # 显示全部模块配置
modprobe -c | grep module_name  # 查看特定模块配置
modprobe --show-depends module_name  # 查看模块依赖（含自身）
```

**自动加载**
- 常规模块由 udev 自动加载，无需配置。
- 需额外加载/黑名单时：
  - initramfs 早期加载：取决于生成器（Booster/Dracut/Mkinitcpio 的 `MODULES` 等）。
  - systemd：在 `/etc/modules-load.d/*.conf` 中每行一个模块名，空行及 `#`/`;` 开头行忽略。

**易错点**
- initramfs 镜像可能不包含 `/etc/modules-load.d/` 中指定的模块或对应文件。

- 开机加载 `virtio_net`：在 `/etc/modules-load.d/` 配置文件中写入 `virtio_net`（详见 modules-load.d(5)）。
- 手动模块管理：由 `kmod` 提供工具（内核包依赖），可手动加载模块。

- `modprobe module_name`：加载模块。
- 内核升级未重启时，`modprobe` 无错误消息，退出码 `1`，因 `/usr/lib/modules/kernel_release/` 路径不存在；需手动检查该路径。
- 按文件名加载非标准目录模块：需用其他方式（原文未给出具体命令）。

- 移除模块：`modprobe --remove module_name`
- 参数传递：手动 `modprobe module_name key=value`、配置文件、内核命令行；模块内建时仅内核命令行有效

- 临时加载：`modprobe 模块名 参数名=参数值`

- 配置文件 `/etc/modprobe.d/*.conf`（须以 `.conf` 结尾，文件名决定优先级）；查看生效：`systemd-analyze cat-config modprobe.d`。语法：
  ```
  options 模块名 参数1=值1 参数2=值2a,值2b
  ```
  同一模块选项**必单行**；新 `options` 行替换旧行；参数空格分隔，值列表逗号分隔。

- 内建模块：仅能内核命令行传参 `模块名.参数名=参数值`（如 `thinkpad_acpi.fan_control=1`），加至引导加载器。

- initramfs 模块：将 `.conf` 加入 `mkinitcpio.conf` 的 `FILES` 或启用 `modconf` hook，再重新生成 initramfs。

- Alias：`alias 别名 真实模块名`，支持通配符；查看内部别名：`modinfo --field=alias 模块名`。

- 阻止加载：
  - `alias 别名 off`：停用该别名自动加载（仍可通过其他别名/名称加载）。
  - `blacklist 模块名`：禁用所有内部别名（不阻止手动/依赖加载）。
  - `install 模块名 /bin/true`：模拟成功，阻止实际插入；`/bin/false` 强制失败并阻断依赖。
  - initramfs：`mkinitcpio -M` 查看自动检测模块，在 conf 中 blacklist，用 `modconf` hook 加入；无则加入 `FILES`，重新生成 initramfs。

## 内核参数

**三种传递方式**
1. 内核编译时（config 文件）
2. 启动时命令行（boot loader 或 UKI）
3. 运行时：`/proc/sys/`（sysctl）与 `/sys/`

格式：`parameter`、`parameter=value`、`module.parameter=value`；**区分大小写**。模块参数放 `/etc/modprobe.d/*.conf`。查看当前参数：`cat /proc/cmdline`

**GRUB**
- 临时：菜单按 `e`，`linux` 行追加参数，`Ctrl+x`
- 永久：编辑 `/etc/default/grub` 的 `GRUB_CMDLINE_LINUX_DEFAULT="..."`，然后：
```bash
grub-mkconfig -o /boot/grub/grub.cfg
```

**systemd-boot**
- 临时：菜单按 `e`，行尾追加，`Enter`
- 菜单不出现：开机按 `Space`；无法编辑：`/boot/loader/loader.conf` 加 `editor 1`
- 永久：编辑 `/boot/loader/entries/arch.conf` 的 `options`；UKI 编辑 `/etc/kernel/cmdline`

**Syslinux**：临时按 `Tab`；永久编辑 `/boot/syslinux/syslinux.cfg` 的 `APPEND`
**rEFInd**：临时按 `Insert`/`F2`/`Tab`/`+`；永久编辑 `/boot/refind_linux.conf`

**dracut**：参数可嵌入 initramfs，仅对 `root=`、`rd.*` 等有效，非真正内核参数。

**劫持 cmdline**：bind mount 覆盖 `/proc/cmdline`，仅影响用户态读取，无法启用内核级参数。

典型示例：
```
root=UUID=0a3407de... rw quiet splash initrd=\initramfs-linux.img
```

### 临时修改内核参数
创建参数文件并覆盖 `/proc/cmdline`（仅当前运行期有效）：
```bash
echo 'root=UUID=... ro console=tty1 debug' > /root/cmdline
mount --bind -o ro /root/cmdline /proc/cmdline
cat /proc/cmdline   # 验证
```

### 常用内核参数
- `init`：指定 init 进程；`initrd`：initramfs 路径（UEFI 用反斜杠）
- `cryptdevice`：指定 dm-crypt 加密分区及 mapper 名
- `debug`：内核调试日志；`nomodeset`：禁用 KMS
- `maxcpus`：SMP 最大 CPU 数；`lsm`：安全模块初始化顺序
- `panic`：panic 后重启等待秒数；`resume`：休眠恢复交换设备
- `root`：根设备（`root=UUID=`/`root=dissect`）
- `ro`：根只读挂载；`rootflags`：根挂载选项

> systemd、mkinitcpio、dracut 也会读取 `/proc/cmdline`。

### kernel-install
systemd 内核安装工具，由插件完成引导条目、UKI、Secure Boot 签名；本身不生成 initramfs。

#### 主配置
`/etc/kernel/install.conf`：
```
layout=bls|uki
initrd_generator=/uki_generator=
```

#### 内核参数
必须写入 `/etc/kernel/cmdline`，会嵌入 UKI 或加入引导配置。
**易错点**：文件不存在时回退到 `/usr/lib/kernel/cmdline` 或当前 `/proc/cmdline`。

#### 调试
```bash
kernel-install inspect --verbose
```

`kernel-install inspect` 查看内核安装插件链。  
可用插件位于 `/usr/lib/kernel/install.d/`：

```bash
ls /usr/lib/kernel/install.d/
```

同名文件放 `/etc/kernel/install.d/` 可覆盖默认插件；例如用同名空文件覆盖 `91-sbctl.install` 以禁用 Secure Boot 自动签名 UKI。

- 禁用：`ln -sf /dev/null /etc/kernel/install.d/91-sbctl.install`
- 插件目录：`/etc/kernel/install.d/`
- 手动安装：`kernel-install add`

## fstab（核心要点）

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

**易错点**：①改完先 `mount -a` 或 `findmnt --verify` 验证再重启，写错=启动失败；②swap 行 fsck 列为 0；③临时挂载测试：`mount -o ro /dev/disk/by-uuid/xxx /mnt`。

- 自动触发 `kernel-install` 及插件：安装 `pacman-hook-kernel-install` (AUR)  
- `mkinitcpio` 的 pacman hooks 已有类似功能，需手动屏蔽避免重复

### 禁用自动生成 initramfs（临时）
- 将 pacman hook 符号链接到 /dev/null：
```bash
ln -s /dev/null /etc/pacman.d/hooks/90-mkinitcpio-install.hook
```
- 恢复：删除上述符号链接。

## mkinitcpio
- Bash 脚本，用于创建 initramfs 镜像。

### 两种 initramfs 方式
- **systemd-based**：systemd 在 initramfs 阶段早期启动，由 systemd unit 决定任务。
  - 优点：与 systemd 生态集成，可并行启动任务，支持 `systemd-cryptsetup-generator`（`/etc/crypttab.initramfs`）、GPT 分区自动挂载。
  - 缺点：依赖多，initramfs 体积大，可能略增启动时间。
- **Busybox-based**：init 脚本扫描并执行 initramfs 中的运行时 hooks。
  - 优点：轻量、体积小、依赖少；顺序执行，易诊断启动问题。
- 由 `/etc/mkinitcpio.conf` 的 `HOOKS` 数组中是否存在 `systemd` 钩子决定。

### 安装
- `mkinitcpio` 是内核包的依赖，通常已安装。

### 镜像生成
- 自动：内核安装/升级时，pacman hook 自动生成 `/etc/mkinitcpio.d/` 下的 `.preset` 文件（如 `linux.preset`）。默认仅生成 default 镜像；fallback 镜像需显式启用：
  - default：按配置创建。
  - fallback：跳过 `autodetect` 钩子，包含全范围模块。
- 注意：`.preset` 文件用于内核更新后自动重新生成 initramfs，编辑需谨慎。
- 手动生成：
```bash
mkinitcpio -p linux   # 或 --preset linux
```

- **mkinitcpio 重新生成 initramfs**
  - 按所有预设重新生成：`mkinitcpio -P`（`--allpresets`）；指定预设如 linux：`mkinitcpio -p linux`。通常在修改全局配置后执行。
  - 可选清理 `/boot`、`/efi` 下残留的 `initramfs-*.img`。

- **kernel-install 生成 UKI**
  - 依赖 systemd 和 systemd-ukify，确保 kernel-install 已正确设置。
  - 配置 `/etc/kernel/install.conf`：
    ```ini
    layout=uki
    ```
  - ukify 的配置写入 `/etc/kernel/uki.conf`，例如：
    ```ini
    [UKI]
    Splash=/usr/share/systemd/bootctl/splash-arch.bmp
    ```
  - 易错：**不要**在 `uki.conf` 中设置内核命令行（会被忽略），应使用 kernel-install 的内核命令行机制。
  - 可让 mkinitcpio 直接生成 UKI：在 `install.conf` 中增加 `uki_generator=mkinitcpio`，此时无需 systemd-ukify；也可另行设置 `initrd_generator`。
  - 修改配置后必须重新安装所使用内核包才能生效。

- **dracut / ukify 单独使用**
  - dracut：生成 UKI 及内核升级时重新生成 initramfs 的细节见 dracut 文档。
  - ukify：安装 systemd-ukify 后，因 ukify 本身不能生成 initramfs，须先用 mkinitcpio/dracut/booster 生成 initramfs，再交给 ukify 组装。

- 可创建多个 initramfs 镜像，配置各异；须在引导加载器配置中指定所需镜像。
- 自定义生成：按 `/etc/mkinitcpio-custom.conf` 生成镜像，保存为 `/boot/initramfs-custom.img`。

mkinitcpio --config /etc/mkinitcpio-custom.conf --generate /boot/initramfs-custom.img
- 其他内核追加版本号，见 `/usr/lib/modules/`

## mkinitcpio
- 配置：`/etc/mkinitcpio.conf`；drop-in `/etc/mkinitcpio.conf.d/`（`-c`/`ALL_config` 时忽略）；preset `/etc/mkinitcpio.d/`。
- 变量：`MODULES`(钩子前加载)、`HOOKS`(按序脚本)、`COMPRESSION`(压缩)、`COMPRESSION_OPTIONS`(不建议)；`BINARIES`/`FILES` 见示例。
- 易错：`lvm2`、`encrypt` 默认未启用；`模块?` 不报错；out-of-tree FS（`zfs`）必须加；USB3 键盘加 `usbhid xhci_hcd`。
- 示例：`FILES=(/usr/lib/firmware/edid/vrr.bin) BINARIES=(kexec)`。
- `mkinitcpio -L` 列钩子，`-H` 帮助。

## pacman
- Arch 包管理器，同步/安装依赖。
- `pacman`→`makepkg`/`vercmp`；`pacman-contrib`→`pactree`/`checkupdates`。
- 查看：`pacman -Ql pacman pacman-contrib | grep -E 'bin/.+'`

- **pacman** 是 Arch 的包管理器；包为归档，包含编译文件、元数据（名称、版本、依赖）及安装脚本。
- 使用包管理器的优点：
  - 易更新：`pacman` 自动更新已有包；
  - 依赖检查：自动处理依赖，只需指定程序名；
  - 干净卸载：记录包内所有文件，卸载无残留。
- 安装注意：
  - 可选依赖仅增强功能，不强制；安装时列出，但不写入 `pacman.log`；
  - 若某包仅作为其他包的（可选）依赖，推荐加 `--asdeps` 安装。
- 易错点：避免只刷新源列表而不升级系统。不要运行 `pacman -Sy package_name`，应使用 `pacman -Syu package_name`，否则会导致部分升级，引发依赖问题。
- 安装单个或多个包（含依赖）：
  ```bash
  pacman -S package_name [package_name ...]
  ```

- `pacman -S package_name1 package_name2 ...` 安装多个包；同一命令可用于重装。
- 支持正则匹配批量安装（命令见下）。

- `pacman -S $(pacman -Ssq package_regex)` 用正则匹配包名并批量安装。

- **虚拟包**：自身不存在，由其他包 `provides` 提供；用于多候选依赖，不能按名安装，安装提供者后自动装入。例：`dbus-units`。
- **多候选排序**：先按 `pacman.conf` 仓库顺序，同仓库按字母序。
- **包组**：相关包的集合，可同时安装。示例：
```pacman -S plasma-{workspace{,-wallpapers},pa}
```

- 安装包组：`pacman -S gnome` → 交互选择组内包。
- 选择语法：`1-10 15`（选1~10及15）；`^5-8 ^2`（排除5~8及2）。
- 查看组内包：`pacman -Sg gnome`；可用组列表见 <https://archlinux.org/groups/>。
- 易错点：组内已安装的包也会被重装，用 `--needed` 跳过。
- 移除单个包：仅移除该包，依赖保留。

`pacman -Rs` 删除包及其依赖。删除组时忽略组内包的安装原因，依赖的安装原因仍被尊重。若组含必需包而失败，改用 `pacman -Rsu`（跳过依赖检查？实为递归删除不再需要的依赖）。

`pacman -Rsu` 用于组删除失败时的替代：递归删除目标包及其不再需要的依赖。注意：仍受依赖原因影响，操作需谨慎。

- `pacman -Rdd package_name`：移除一个被其他包依赖的包，但不移除依赖它的包。
- 警告：此操作可能破坏系统，应避免使用。
```bash
pacman -Rdd package_name
```

- `pacman -Rdd package_name` 强制删除（忽略依赖）。
- 删除应用时，重要配置备份为 `.pacsave`。
- 加 `-n` 选项可防止生成备份文件。

- `pacman -Rn package_name`：移除包及配置文件，但不删除应用自建配置（如家目录 dotfiles）。
- 升级：须遵循系统维护指南定期完整升级，勿盲目执行；Arch 仅支持全系统升级，不支持部分升级。
- 升级命令同步仓库数据库并更新系统包，排除不在已配置仓库中的本地包。

```markdown
- 查询本地库 `-Q`；同步库 `-S`；文件库 `-F`
- 子选项帮助：`pacman -Q --help`、`-S --help`、`-F --help`
- 易错：查 `-F` 前先同步（`pacman -Fy`）
```

- 刷新文件数据库：`pacman -Fy`；可启用 `pacman-filesdb-refresh.timer`（pacman-contrib 提供）每周自动刷新。
- 搜索远程包（名称+描述）：`pacman -Ss string1 string2 ...`；`-s` 用 ERE，易误匹配，用 `'^vim-'` 限定包名。
- 搜索已安装包：`pacman -Qs string1 string2 ...`
- 按文件名搜索远程包：`pacman -F string1 string2 ...`
- 显示远程包详细信息（含依赖）：`pacman -Si package_name`
- 显示本地包信息：`pacman -Qi package_name`
- 双 `-i` 显示备份文件及修改状态：`pacman -Qii package_name`
- 列出包安装的文件：`pacman -Ql package_name`

- 分区：将磁盘划分为独立区域，可单分区或多分区（双系统、swap、数据隔离）。分区表存入 MBR 或 GPT。
- 查看分区表：`parted /dev/sdX print` 或 `fdisk -l /dev/sdX`
  - 设备名示例：SATA `/dev/sda`、NVMe `/dev/nvme0n1`、eMMC `/dev/mmcblk0`

## MBR
- 位于设备第一扇区（物理偏移 0），不在任何分区内；分区内的引导扇区称 VBR。
- 前 440 字节为 bootstrap code，可用 `dd` 备份/恢复/擦除。
- 分区类型：
  - 主分区（Primary）：可引导，每盘最多 4 个
  - 扩展分区（Extended）：容器，每盘最多 1 个，也计入主分区数
  - 逻辑分区（Logical）：位于扩展分区内，数量不限
- 双启动 Windows 时，Windows 必须在主分区。
- 编号惯例：主分区 `sda1`-`sda3`，扩展分区 `sda4`，逻辑分区从 `sda5` 起。
- 易错点：MBR 盘末尾预留至少 33 个 512 字节扇区（16.5 KiB）未分区空间，便于日后转 GPT。

## GPT
- 基于 UEFI 规范，使用 GUID/UUID 定义分区和类型，取代 MBR。
- 磁盘起始有保护性 MBR（PMBR），含 bootstrap code area，可用于 BIOS/GPT 引导（需引导器支持）。
- 注意：BIOS 系统从 GPT 磁盘用 GRUB 或 Limine 引导时，需要 BIOS boot partition。

## 选择 GPT vs MBR
- GPT 更现代，无 MBR 的旧限制，格式化工具有同等可靠性/性能。
- 关键约束：BIOS+GPT 必须配 BIOS boot partition；BIOS+MBR 传统兼容；UEFI 通常用 GPT。

## GPT vs MBR 选择要点

- **双启动 Windows（Legacy BIOS，32/64 位）**：必须用 MBR。
- **双启动 Windows 64 位（UEFI 模式）**：必须用 GPT。
- **老旧硬件（旧笔记本）**：BIOS 可能不支持 GPT，选 MBR；但可有绕过方法（见 gdisk 相关技巧）。
- **磁盘 >2 TiB（≈2.2 TB）**：必须用 GPT。
- **UEFI 启动**：建议始终 GPT，因部分 UEFI 固件不支持 UEFI 模式下从 MBR 启动。
- **其他情况**：自由选择；GPT 更现代，推荐。

## GPT 相对 MBR 的优势

- 提供磁盘 GUID 和分区 GUID（`PARTUUID`），是文件系统无关的引用方式，也是 Discoverable Partitions Specification 的前提（可用于 systemd initramfs）。
- 提供分区名（`PARTLABEL`），同样与文件系统无关。
- 分区数量任意（默认 128 个，可扩展，仅 `gdisk` 支持扩展）。
- 使用 64 位 LBA，最大寻址 2 ZiB；MBR 单盘限制 2 TiB。
- GPT 在磁盘末尾存有备份头和分区表，便于恢复。
- 头和分区表有 CRC32 校验，可检测错误/损坏。

**转换**：MBR 与 GPT 可互转，见 `gdisk#Convert between MBR and GPT`。

## 无分区盘（Partitionless disk）

- 无分区表，单一文件系统占据整个设备。
- 引导扇区称卷引导记录（VBR）。
- 适用场景（如虚拟机）待补充，但 Btrfs 可整盘占用并替代分区方案，见 `Btrfs#Partitionless Btrfs disk`。

## 分区方案（Partition scheme）

- 无严格规则，取决于灵活性、速度、安全性、磁盘空间限制。
- 可结合 LVM、mdadm、dm-crypt、Btrfs 子卷等设计。

## systemd

- systemd：PID 1 的系统与服务管理器。核心：并行化启动、socket/D-Bus 激活、按需启动、cgroups 追踪、事务性依赖控制。
- 守护进程：后台运行、无终端界面的程序。

### systemctl 核心用法

默认操作 `--system` 单元；用户单元用 `systemctl --user`。

**Unit 命名**
- 省略后缀默认 `.service`
- 挂载点→`.mount`：`/home` ≡ `home.mount`
- 设备→`.device`：`/dev/sda2` ≡ `dev-sda2.device`
- `name@string.service` = 模板 `name@.service` 的实例，单元内以 `%i` 引用

**常用命令**（root）：

```bash
systemctl status [unit]
systemctl start|stop|restart|reload unit
systemctl enable --now unit
systemctl disable --now unit
systemctl mask|unmask unit
systemctl daemon-reload
systemctl list-units
systemctl --failed
systemctl list-unit-files
systemctl is-enabled unit
```

要点：
- `--now` 可与 enable/disable/mask 连用立即生效。
- 支持通配符：`systemctl list-units 'dbus*'`
- 优先 enable `.socket` 而非 `.service` 可实现按需启动。
- 模板单元省略实例标识符通常启动失败。

- Unit 文件加载路径（优先级从低到高）：`/usr/lib/systemd/system/`（包提供）、`/run/systemd/system/`（管理员临时，重启失效）、`/etc/systemd/system/`（管理员持久）。完整列表：`systemctl show --property=UnitPath`。用户模式路径不同。
- 屏蔽单元检查：`systemctl list-unit-files --state=masked`。masking 危险：手动和依赖都会被屏蔽。
- 电源管理需 polkit；本地 logind 会话且无其他活动会话时免 root，否则提示密码。

| 操作 | 命令 |
| --- | --- |
| 重启 | `systemctl reboot` |
| 关机 | `systemctl poweroff` |
| 挂起 | `systemctl suspend` |
| 休眠（RAM→磁盘） | `systemctl hibernate` |
| 混合睡眠（RAM→磁盘+挂起） | `systemctl hybrid-sleep` |
| 先挂起，定时唤醒转休眠 | `systemctl suspend-then-hibernate` |
| 仅用户空间重启 | `systemctl soft-reboot` |

- Soft reboot：不涉及内核，跳过固件/initramfs，保留已解锁 dm-crypt。若 `/run/nextroot/` 含有效根文件系统则切换根；该路径会自动成为挂载点。
- **易错点**：内核和 initramfs 更新后**勿**执行 `systemctl soft-reboot`。
- 编写 unit 文件：语法受 .desktop / .ini 启发，加载位置同上。

# systemd-boot

- 文本菜单式UEFI启动管理器，仅能启动位于ESP或同盘XBOOTLDR分区的EFI程序；文件系统继承固件（FAT12/16/32），随systemd提供。

### 安装

- 确认UEFI模式：`ls /sys/firmware/efi/efivars`（目录存在即UEFI）
- 安装：`bootctl install`（自动复制EFI文件并创建启动项"Linux Boot Manager"）
- ESP自动探测`/efi`、`/boot`、`/boot/efi`，其他路径用`--esp-path=esp`
- **易错点**：覆盖已有`BOOTX64.EFI`；arch-chroot非systemd模式不写UEFI变量，需用`arch-chroot -S`

### XBOOTLDR

- 独立`/boot`分区，须与ESP同盘；分区类型GUID `bc13c2ff-59e6-4262-a352-b275fd6f7172`（gdisk `ea00`、fdisk `xbootldr`）
- 关闭UEFI "fast boot"以免启动项丢失
- 挂载ESP至`/mnt/efi`、XBOOTLDR至`/mnt/boot`后：`bootctl --esp-path=/efi --boot-path=/boot install`

### 更新

- 手动：`bootctl update`
- systemd≥261.2-1自动更新经`systemd-boot-update.service`执行：`bootctl --variables=no --graceful update`
- Secure Boot启用时需签名后再更新

- `bootctl` 自动检测 ESP（`/efi`、`/boot`、`/boot/efi`）；不在则用 `bootctl --esp-path=esp update`。更新时优先 `.efi.signed`（配合 Secure Boot）。
- Secure Boot 可加 pacman hook 调用 `systemd-sbsign` 自动签名；输出的 `.signed` 会被 `bootctl install/update` 拾取。也可用 `sbctl`。
- 改配置后运行 `bootctl` 验证；可用 `kernel-install` 生成。`esp/loader/loader.conf`：
```ini
default  arch.conf
timeout  4
console-mode max
editor   no
```
- `default`/`timeout` 可在菜单改并存 UEFI 变量覆盖；清除：`bootctl set-default ""`、`bootctl set-timeout ""`。默认配置 `/usr/share/systemd/bootctl/loader.conf`。
- 菜单异常：`console-mode` 用 `auto`、`keep` 或 `2`。记住上次启动：
```ini
default @saved
```

- `systemd-creds`：安全存储/检索 systemd 服务凭据（密码、API key 等）。
- 加密方式：TPM2 芯片密钥、`/var/` 存储密钥，或两者组合；检查：`systemd-analyze has-tpm2`。
- 加密文件：
  ```bash
  systemd-creds --name=foobar encrypt plaintext.txt ciphertext.cred
  ```
  - 凭据内置目标名称防误用；省略 `--name` 用文件名；敏感明文放 tmpfs。
- 验证解密（systemd-run 注入）：
  ```bash
  shred -u plaintext.txt
  systemd-run --pipe --wait --property=LoadCredentialEncrypted=foobar:$(pwd)/ciphertext.cred systemd-creds cat foobar
  ```
- 免落盘加密：
  ```bash
  systemd-ask-password -n | systemd-creds encrypt --name=mysql-password -p - -
  ```
  输出 `SetCredentialEncrypted=mysql-password: ...` 直接粘贴进 service。
- 普通用户加 `--user`：
  ```bash
  echo -n hunter2 | systemd-creds --user encrypt - ciphertext.cred
  systemd-creds --user decrypt ciphertext.cred
  ```
- 用户凭据作用域为用户 scope + `/etc/machine-id`；root 不能解密其他用户凭据；不指定用户报错；需显式 `--uid user` 指定。

- 作用：将硬件令牌（PKCS#11/智能卡、FIDO2、TPM2）或口令登记到 LUKS2 卷，供启动时解锁。
- 依赖：systemd 自带；PKCS#11 需 libp11-kit/opensc；FIDO2 需 libfido2；TPM2 需 tpm2-tss。
- 列出槽位：`systemd-cryptenroll /dev/disk`（类似 luksDump）。
- 擦除槽位：`systemd-cryptenroll /dev/disk --wipe-slot=SLOT`；SLOT 可为索引、类型（empty/password/recovery/pkcs11/fido2/tpm2）或逗号组合；`all` 仅可与登记同用。
- 登记口令：`--password`（常规密码）；`--recovery-key`（恢复密钥）。
- 登记硬件：设备选项支持 `list`/`auto`；登记后需在 early/late userspace 按 dm-crypt 配置启用。
  - PKCS#11（需含 RSA 密钥对）：`systemd-cryptenroll /dev/disk --pkcs11-token-uri=device`
  - FIDO2（需 hmac-secret）：`systemd-cryptenroll /dev/disk --fido2-device=device --fido2-with-client-pin=no`；可配 `--fido2-with-user-presence`（默认 yes）、`--fido2-with-user-verification`（默认 no）；默认算法 es256，可用 `--fido2-credential-algorithm=eddsa`；用另一已登记令牌解锁需加 `--unlock-fido2-device=auto`，且两个令牌均插入。
  - TPM2：需 tpm2-tss + LUKS2；用于根分区时，mkinitcpio 需启用 `systemd` 和 `sd-encrypt` hooks。

- **hooks 顺序**：非标准顺序可致无法启动；需从 arch-chroot 重新生成 initramfs，dracut 用户启用 `tpm2-tss`。
- 列出 TPM：`systemd-cryptenroll --tpm2-device=list`；多 TPM 时指定 `--tpm2-device=/path/to/device`。建议用 PCR 策略而非裸 PCR 值。
- 绑定 PCR 7 生成密钥：

  ```bash
  # systemd-cryptenroll --tpm2-device=auto --tpm2-pcrs=7 /dev/sdX
  ```

  若用密钥文件解锁加 `--unlock-key-file=/path/to/keyfile`；多 PCR 用 `+` 分隔。
- **警告**：
  - PCR 7 需 Secure Boot 启用且用户模式，否则未授权启动设备可解锁。
  - 固件证书变化（如 fwupd 或轮换 Secure Boot 密钥）会改 PCR 7，可能锁死系统。
  - 仅绑 PCR 0-7 有漏洞：恶意复制真实根分区 UUID 冒充，解密失败回退密码，攻击者可获真实密钥。
  - 缓解：绑定空 PCR 15：

    ```bash
    --tpm2-pcrs=other_pcrs+15:sha256=0000000000000000000000000000000000000000000000000000000000000000
    ```

    用 `rd.luks` 或 `/etc/crypttab.initramfs` 时加 `tpm2-measure-pcr=yes`；根卷解锁后 PCR 15 改变，密钥失效。
  - 更优方案见 dm-crypt/System configuration#Pinning a LUKS volume。
- PCR 组合需权衡可用性与锁定强度。

## systemd-firstboot 核心要点

- 功能：首次启动前/时初始化时区、locale、主机名、root 密码、machine ID（systemd 216+）。
- 直接操作文件系统，不使用 `timedatectl`/`hostnamectl`/`localectl`；**禁止在已运行系统上执行**。
- 仅用于全新安装（chroot 内、卸载分区前）。无需单独安装，随 systemd 包提供。

**启用步骤**

1. 删除已有配置，否则对应项不提示：
```bash
rm /etc/{machine-id,localtime,hostname,shadow,locale.conf}
```
2. 编辑 `/etc/passwd` 删除 root 账户，否则不询问 root 密码。
3. 创建 drop-in 并启用服务：
```ini
# /etc/systemd/systemd-firstboot.service.d/install.conf
[Service]
ExecStart=
ExecStart=/usr/bin/systemd-firstboot --prompt

[Install]
WantedBy=sysinit.target
```
```bash
systemctl enable systemd-firstboot.service
```
4. 退出 chroot → 卸载 → 重启，下次启动进入交互配置。

**易错点**
- 所需 locale 必须已生成，否则不在选项中。
- 若系统无其他配置改动，删除上述文件并重启可再次触发 `systemd-firstboot`。
- 支持非交互模式（镜像）与早期启动交互模式。

- systemd-homed：便携用户账户，信息存于 `~/.identity`（签名），自动管理加密与挂起锁定。
- 启用：`systemctl enable --now systemd-homed.service`（pambase 已含 PAM）。
- 创建：`homectl create username`（默认 UID 60001–60513、同名组、bash，存储依次 luks→subvolume→directory）。
- 查看/修改：`homectl inspect username`、`homectl update username --属性=值`。
- 查询用户/组：`userdbctl`。
- `~/.identity` 有签名，勿直接编辑，用 `homectl update --identity=/path` 修改。
- 存储（`--storage=`）：`luks`（LUKS 加密卷；loopback 可加 `--luks-discard`；可移动介质需 GPT 类型）；`fscrypt`（ext4/F2FS）；`directory`/`subvolume`（无加密绑定挂载）；`cifs`（CIFS 挂载，本地密码登录）。
- 易错：shell 必须位于 `/etc/shells`；默认登录自动激活 home。

## homectl 操作
- 激活：`homectl activate user`；停用：`homectl deactivate user`（挂载持续至登出/卸载）
- 删除：`homectl remove user1 user2`（可多个）

## LUKS 默认挂载
- 默认 `compress=zstd:1,noacl`；可覆盖：`homectl update user --luks-extra-mount-options acl,compress=zstd,user_subvol_rm_allowed`

## SSH 远程解锁
- 仅公钥认证无法挂载家目录；需公钥+密码双认证。`/etc/ssh/sshd_config` 添加：
  ```
  PasswordAuthentication yes
  PubkeyAuthentication yes
  AuthenticationMethods publickey,password
  ```
- 更新密钥（需解锁）：`homectl update user --ssh-authorized-keys=@/path/to/mounted/home/.ssh/authorized_keys`

## 救援模式挂载
```bash
losetup -fP --show user.home
cryptsetup open /dev/loopXpY mappername
mount /dev/mapper/mappername /mnt/mountpoint
```
建议存救援盘。

systemd-networkd 自动检测/配置网络设备。
- 启用：`systemctl enable --now systemd-networkd.service`
- 易错点：每接口只能由一个 DHCP 客户端/网络管理器管理，用 `systemctl --type=service` 停用冲突；DNS 需启用 `systemd-resolved.service`。
- 优先级：`/etc/systemd/network` > `/run/systemd/network` > `/usr/lib/systemd/network`；类型：`.network`（设备）、`.netdev`（虚拟）、`.link`（链路）。
- wait-online 默认等待所有链路，多接口延迟 2 分钟。在 `/etc/systemd/system/systemd-networkd-wait-online.service.d/*.conf` 的 `[Service]` 段用 `ExecStart=` 清空后设置：
  - `ExecStart=/usr/lib/systemd/systemd-networkd-wait-online --any`（任一接口）
  - `ExecStart=/usr/lib/systemd/systemd-networkd-wait-online --dns`（DNS 可达）
- 等待可路由 IP：`.network` 的 `[Link]` 设 `RequiredForOnline=routable`。
- `networkctl` 查看/管理网络。

- `*.netdev`：创建虚拟网络设备；`*.link`：网络设备出现时由 udev 匹配应用。二者遵循相同规则。
- `[Match]` 条件全部满足才生效；空 `[Match]` 始终匹配（相当于 `*`）。
- 所有配置按字典序处理，同名文件互相覆盖；修改后重启 `systemd-networkd.service`。
- 易错点：
  - 选项区分大小写。
  - 可用通配符 `Name=en*`、`Name=wl*`，或按类型匹配 `Type=ether`、`Type=wlan`、`Type=wwan`。
  - `Type=ether` 也会匹配虚拟以太网，排除需加 `Kind=!*`。
- 覆盖与屏蔽：`/etc/systemd/network/` 覆盖 `/usr/lib/systemd/network/`；可用 symlink 指向 `/dev/null` 屏蔽系统文件。
- 布尔值：`1/true/yes/on` 为真，`0/false/no/off` 为假。
- 路由表：systemd-networkd 会改动其他软件的路由，如不需要可设 `ManageForeignRoutingPolicyRules=`（见 networkd.conf(5)）。
- 查看状态：`networkctl` 列出链接及状态。

### systemd-networkd

- 启用 mDNS：`networkctl edit @wlan0 --drop-in mdns`，写入：
```ini
[Network]
MulticastDNS=true
```
`wlan0` 替换为稳定接口名或完整路径。

- 有线 DHCP（`/etc/systemd/network/20-wired.network`）：
```ini
[Match]
Name=enp1s0

[Link]
RequiredForOnline=routable

[Network]
DHCP=yes
```

- 有线静态 IP：
```ini
[Match]
Name=enp1s0

[Network]
Address=10.1.10.9/24
Address=2001:db8:1234:5678::1/64
Gateway=10.1.10.1
Gateway=fe80::1
DNS=10.1.10.1
DNS=2001:db8:1122::3344:1
```
`Address=` 可重复用于多个 IPv4/IPv6 地址。

### systemd-nspawn

- 类 chroot 但更强：完全虚拟化文件系统层次、进程树、IPC 子系统、主机名/域名。
- 容器内限制：`/sys`、`/proc/sys`、`/sys/fs/selinux` 只读；不可修改网络接口/系统时钟；不可创建设备节点；不可重启主机或加载内核模块。
- 比 LXC/Libvirt 更易配置；随 systemd 提供。
- 创建最小 Arch 容器：
```bash
mkdir ~/MyContainer
pacstrap ~/MyContainer base   # pacstrap 来自 arch-install-scripts
```

- 创建容器：`pacstrap -K -c ~/MyContainer base [附加包]`
- `base` 不依赖 `linux` 内核，容器可直接使用
- 非 Arch 系统无 pacstrap 时：用 bootstrap tarball，容器内初始化 pacman keyring
- 完成后进入容器，设置 root 密码

```bash
# root密码可选；免登录进容器root shell
machinectl shell root@MyContainer
# 用Podman/Docker创建RHEL衍生环境（适用于dnf发行版）
```

- `systemd-nspawn -b -D ~/MyContainer`：`-b` 以 systemd 为 PID1 启动容器；`-D` 指定容器根目录。
- 容器内执行 `poweroff` 关机；主机侧用 `machinectl` 管理容器。
- 退出容器会话：按住 `Ctrl` 快速按 `]` 三次。
- Debian/Ubuntu 环境：安装 `debootstrap`，及 `debian-archive-keyring` 或 `ubuntu-keyring`，再调用 debootstrap。

# debootstrap 核心要点

命令格式：
```bash
debootstrap [OPTIONS...] SUITE TARGET [MIRROR]
```

- **SUITE**（必填）：发行版代号
  - Debian：`stable`/`testing`/`unstable` 或 `bookworm`/`sid`
  - Ubuntu：仅用代号（如 `jammy`、`noble`），不用版本号
  - 其他衍生版需特定 keyring，或加 `--no-check-sig` 禁用 OpenPGP 校验
- **TARGET**（必填）：目标目录，不存在则自动创建
- **MIRROR**（可选）：软件源 URL
  - Debian 默认 `https://deb.debian.org/debian`
  - Ubuntu 默认 `https://archive.ubuntu.com/ubuntu`
  - Debian 旧版（<10/Buster）用 `https://archive.debian.org/debian/`
  - Ubuntu 旧版用 `https://old-releases.ubuntu.com/ubuntu/`
  - 注意：旧版可能报 `unknown signing key`（如 Debian 9 及更早），需换 keyring 或禁用签名检查

- **易错点**：debootstrap 不解析虚拟包依赖，默认不装 `dbus` 和 `libpam-systemd`，导致部分 systemd 功能（如 `localectl`）及 `machinectl` 管理容器失效
  - 解决：加参数 `--include=dbus,libpam-systemd` 或在容器内手动安装

- `debootstrap --include=dbus,libpam-systemd,libnss-systemd stable /path/to/machine`
- 非 systemd init 容器 `-b/--boot` 启动可能异常；shell 不受影响。
- systemd 为 Debian 8+/Ubuntu 15.04+ 默认 init。
- 设置 root 密码：`systemd-nspawn` 不加 `-b`。

- `dnf --repo=baseos --releasever=9 --best --installroot=/machine install systemd-udev hostname yum dnf centos-gpg-keys centos-stream-release rootfiles shadow-utils util-linux`
- 易错：`--installroot` 指向挂载点；缺 `systemd-udev`/`shadow-utils` 启动失败；清 root 密码后退出即可启动。

- 启动：`systemd-nspawn --machine=my-machine --boot`
- 创建 Fedora 环境：装 `dnf`，编辑 `/etc/dnf/dnf.conf` 加 `[fedora]`/`[updates]` 仓库，关键参数 `metalink`（`https://mirrors.fedoraproject.org/metalink?repo=fedora-$releasever&arch=$basearch`）与 `gpgkey`（`https://fedoraproject.org/fedora.gpg`）。
- `fedora.gpg` 含 GPG 密钥；可建最小 Fedora 42 容器。

```bash
dnf5 --releasever=42 --best --use-host-config --setopt=install_weak_deps=False --repo=fedora --repo=updates --installroot=/var/lib/machines/container-name install dhcp-client dnf fedora-release glibc glibc-langpack-en iputils less ncurses passwd systemd systemd-networkd systemd-resolved util-linux vim-default-editor
```

- 不同 release 包要求不同
- btrfs 用子卷，勿用目录
- AlmaLinux 最小容器只需在 `/etc/dnf/dnf.conf` 配置 BaseOS 仓库（含 mirrorlist 与 gpgkey）

- 容器安装：`dnf --repo=baseos --installroot --releasever=9 install ...`
- 默认最新版；指定版改 gpgkey=`RPM-GPG-KEY-AlmaLinux-9`
- root 无密码：`systemd-nspawn` 不带 `-b`

## systemd-repart

- 作用：操作 GPT（GUID 分区表）的工具，参考 systemd-repart(8)
- 归属：systemd 组件，Arch 安装 ISO 自带
- 用途：Arch 安装过程中创建/格式化分区
- 需先编写 repart.d(5) 配置文件

创建配置目录：
```bash
mkdir -p /etc/repart.d
```

配置文件中定义分区，参数按需调整。

`mkdir /etc/repart.d`；每分区一个.conf 含[Partition]。

- ESP：Type=esp,Format=vfat
- root：Type=root,Format=btrfs,Encrypt=tpm2
- swap：Type=swap,Encrypt=tpm2
- home：Type=home,Format=btrfs

Encrypt=tpm2需TPM，无则省略。

```bash
systemd-repart --empty=allow /dev/disk
```
- `--empty=allow`：无分区表时自动创建 GPT。
- 预览结果满意后，执行该命令应用更改。

- `systemd-repart --dry-run=no --empty=allow /dev/disk`：按配置创建分区，自动加密/格式化。
- 会覆盖数据，务必先备份。
- 随后挂载所需分区，继续安装。

- **挂载与自动配置**
  - `mount -m /dev/disk/by-partlabel/esp /mnt/boot`
  - 启用 systemd GPT 分区自动挂载后，无需 fstab/crypttab 条目，swap 自动配置，勿再运行 `mkswap`。

## 22. systemd-resolved

- **定位**：systemd 提供的网络名称解析服务，通过 D-Bus、`resolve` NSS 服务（`nss-resolve`）、本地 DNS stub `127.0.0.53` 工作。
- **安装**：已含于 systemd 包，默认可用；启动并启用 `systemd-resolved.service`。
- **配置**：`/etc/systemd/resolved.conf` 及 drop-in `/etc/systemd/resolved.conf.d/`。
- **功能**：支持 DNS（DNSSEC、DNS over TLS）、mDNS、LLMNR。
- **兼容性**：
  - 基于 glibc `getaddrinfo` 的软件开箱即用（`/etc/nsswitch.conf` 默认启用 `nss-resolve`）。
  - 直接读 `/etc/resolv.conf` 的软件（浏览器、Go、GnuPG、QEMU 用户网络）推荐 **stub 模式**：
```bash
ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
```
  - stub 文件内容：DNS 服务器 `127.0.0.53` + 搜索域。
- **易错点**：resolv.conf 处理共有 stub/static/uplink/foreign 四种模式，仅推荐 stub；不要手动改动 `/run/systemd/resolve/` 下的文件。

## /etc/resolv.conf
- `ln -sf ../run/systemd/resolve/stub-resolv.conf /etc/resolv.conf`；`../` 相对链接位置。arch-chroot 内被 bind-mount，需退出后对 `/mnt/etc/resolv.conf` 执行。

## DNS 服务器
- NetworkManager 等自动识别；`resolvconf` 客户端需装 `systemd-resolvconf`。
- 手动 `/etc/systemd/resolved.conf.d/dns_servers.conf`：
```ini
[Resolve]
DNS=192.168.35.1 fd7b:d0bd:7a6e::1
Domains=~.
```
`Domains=~.` 防 per-link 覆盖。

## DNSSEC（实验性，默认禁用）
- `false` 默认；`allow-downgrade`：上游不支持时降级；`true`：强制验证，不支持会解析失败。配置 `DNSSEC=true`。

## DNS over TLS
- `/etc/systemd/resolved.conf.d/dns_over_tls.conf`：
```ini
[Resolve]
DNS=9.9.9.9#dns.quad9.net 149.112.112.112#dns.quad9.net 2620:fe::fe#dns.quad9.net 2620:fe::9#dns.quad9.net
DNSOverTLS=true
Domains=~.
```
- `DNS=ip#hostname` 校验证书，须支持 DoT；`DNSOverTLS=opportunistic` 回退明文。

## DNS over TLS
- systemd-networkd：在 `.network` 的 `[Network]` 段设 `DNSOverTLS=yes`，用 `DNS=` 指定服务器。
- NetworkManager：`.nmconnection` 的 `[connection]` 段设 `dns-over-tls=2`，或 `nmcli connection modify <接口> connection.dns-over-tls 2`。

## systemd-timesyncd
- 轻量 SNTP 客户端，随 systemd 默认安装，适合不提供 NTP 服务的场景。
- 配置：`/etc/systemd/timesyncd.conf` 及 `/etc/systemd/timesyncd.conf.d/*.conf`。
- 示例：

```ini
[Time]
NTP=0.arch.pool.ntp.org 1.arch.pool.ntp.org 2.arch.pool.ntp.org 3.arch.pool.ntp.org
FallbackNTP=0.pool.ntp.org 1.pool.ntp.org 0.fr.pool.ntp.org
```

- 验证：`timedatectl show-timesync --all`
- 优先级：networkd/DHCP 接口级 `NTP=` → timesyncd.conf `NTP=`（依序尝试）→ `FallbackNTP=`。
- 同步后及每 60 秒写 `/var/lib/systemd/timesync/clock`（路径硬编码）；只读根或减少写入可设 `PollIntervalMinSec=1d`、`SaveIntervalSec=infinity`。
- 启用：`systemctl enable --now systemd-timesyncd.service`

- 启用 NTP：`timedatectl set-ntp true`；状态：`timedatectl status`（确认 `System clock synchronized: yes`、`NTP service: active`）；详细：`timedatectl timesync-status`
- 控制台日志：内核参数加 `loglevel=3` 或 `quiet`
- getty：默认仅 1 个，socket 激活上限 6。改 `/etc/systemd/logind.conf` 的 `NAutoVTs`；全部 Fx 用 12，预留 tty12 给日志转发用 11。预激活：`enable`/`start` `getty@ttyX.service`；systemd 不用 `/etc/inittab`
- 启动无输出：删除 `quiet`，日志用 `journalctl`
- 内核要求：不支持 <3.0；自定义内核查 `/usr/share/doc/systemd/README`
- 依赖查询：`systemctl show -p "Wants" multi-user.target`；也可用 `WantedBy`、`Requires` 等
- 关机：用 `systemctl poweroff`，勿用 `halt`
- 开机脚本：创建 `/etc/systemd/system/myscript.service`：

```ini
[Unit]
Description=My script

[Service]
ExecStart=/usr/bin/my-script

[Install]
WantedBy=multi-user.target
```

确保可执行并 `enable`；脚本需含 `#!/bin/sh`，勿写 `ExecStart=/bin/sh /path/to/script.sh`
- `active (exited)`：oneshot 配合 `RemainAfterExit=yes` 的正常状态
- enable 报 symlink 冲突：先 `disable` 旧服务，或 `enable -f` 覆盖

## systemd/Journal

- systemd 自带日志系统 journal，无需独立日志守护进程。
- 用 `journalctl` 读取：`-e`/`--pager-end` 查看历史日志；`-f`/`--follow` 跟踪新条目；两者均隐含 `-n`/`--lines`。

### 过滤输出

```bash
journalctl --grep=PATTERN        # 比管道 grep 高效
journalctl --catalog             # 附日志说明（勿用于 bug 报告）
journalctl --since="2012-10-30 18:17:16"
journalctl --since "20 min ago"
journalctl --boot                # 本次启动
journalctl --identifier sudo     # 按标识符
journalctl --unit man-db.service # 按单元，.service 可省略；用户服务用 --user-unit
journalctl --priority err..alert # 或 -p 3..1；单值 -p 3 含 0~3
```

- 非选项参数按字段过滤，如 `_PID=1`。
- 日志量大时 `journalctl` 过滤变慢，用 `--file` 只查最新日志：
```bash
journalctl --file /var/log/journal/*/system.journal -f
```
- 排查死机系统：挂载磁盘至 `/mnt` 后，用 `-D`/`--directory` 指定日志路径。

### 无 journalctl 查看日志
- journal 为二进制格式，但消息内容未修改，可用 `strings` 提取：
```bash
$ strings /mnt/arch/var/log/journal/.../system.journal | grep -i message
```

### 优先级（Priority）
syslog 严重级别（RFC 5424），值 0-7，由应用开发者自定：

| 值 | 关键字 | 含义 |
|---|---|---|
| 0 | emerg | 系统不可用 |
| 1 | alert | 需立即纠正 |
| 2 | crit | 崩溃、coredump |
| 3 | err | 错误 |
| 4 | warning | 警告 |
| 5 | notice | 异常但非错误 |
| 6 | info | 正常消息 |
| 7 | debug | 调试 |

### 设备（Facility）
指定消息来源程序类型，常用关注：0(kern)、1(user)、3(daemon)、4(auth)、9(clock)、10(authpriv)、15(cron)。

### 日志存储
- 默认 `Storage=persistent`，写入 `/var/log/journal/`
- 改为 `Storage=auto` 时写入 `/run/log/journal/`，非持久
- 持久日志大小限制：文件系统容量的 10%，软上限 4 GiB

## journald 日志管理

- 限制大小：编辑 `/etc/systemd/journald.conf` 设 `SystemMaxUse=50M`，重启 `systemd-journald.service` 生效；drop-in 写法 `/etc/systemd/journald.conf.d/00-journal-size.conf`，置于 `[Journal]` 段
- 易错：`SystemMaxUse` 过大仍受默认 `SystemKeepFree`（15%）限制，取较小值
- 手动清理：先 `journalctl --rotate` 轮转，再 `journalctl --vacuum-size=100M`（按空间）或 `--vacuum-time=2weeks`（按时间）
- 按单元限制：服务加 `LogNamespace=ssh`，配置复制为 `journald@ssh.conf`，用 `journalctl --namespace ssh` 查看

## run0 提权工具

- systemd v256 引入，无 suid 二进制，比 sudo 更安全；用 polkit 认证，用户需加入 `wheel` 组
- 用法：`run0 cmd`（如 `run0 pacman -Syu`）；单独 `run0` 进入交互式 shell
- `run0 --empower`：以当前用户身份执行特权命令，文件归当前用户所有

## systemd 沙盒加固

- 仅系统服务单元可沙盒化；用户单元不可
- 沙盒指令不能全用（如 Web 服务器不应设 `PrivateNetwork=true`）
- 评估：`systemd-analyze security unit` 生成安全评分；评分有误导性，实际无法满分
- 配置错误信息含糊时，临时设日志级别 `debug` 获取有效信息

- `AmbientCapabilities=` 与 `CapabilityBoundingSet=` 必须同用；`CAP_NET_BIND_SERVICE` 可绑 <1024 端口。
- 布尔指令：`NoNewPrivileges`、`PrivateDevices`、`PrivateTmp`、`PrivateNetwork`、`PrivateUsers`、`RestrictSUIDSGID`（配 `NoNewPrivileges`）、`MemoryDenyWriteExecute`（不兼容 JIT）。
- `ProtectSystem=strict|full|true`（strict 配 `ReadWritePaths=`；full 破坏 ACME 续期）；`ProtectHome=true|tmpfs|read-only`。
- `RestrictAddressFamilies=` 限定协议族，如 `AF_UNIX AF_INET AF_INET6`。
- `DynamicUser=true` 配 `StateDirectory=`/`RuntimeDirectory=`。
- `RestrictFileSystems=`（如 `ext4 tmpfs`）；`SystemCallFilter=@system-service` 漏一个 syscall 即段错误。
- `SocketBindAllow/Deny=`（如 `ipv4:22`），配 `CAP_NET_BIND_SERVICE`。
- `TemporaryFileSystem=/:ro` 配 `BindReadOnlyPaths=`/`BindPaths=`；与 `ProtectSystem`/`ProtectHome` 不兼容，官方不支持。

### systemd 服务沙箱

- `TemporaryFileSystem=/:ro` 根只读；`BindReadOnlyPaths=` 只读绑定；`BindPaths=` 可写绑定。
- 常用白名单：`/etc/ssl`、`/etc/resolv.conf`、`/usr/share/zoneinfo`、socket 文件。
- 失败 `status=203/EXEC`：可执行文件或库不可访问，可先放开 `/usr` 再收紧。

### systemd 全局

- `SystemCallArchitectures=native` 禁用非本机架构 syscall（影响 32 位/Wine）。
- `Default*Accounting` 可开启资源统计。

### systemd 定时器

- timer 控制同名 `.service`。两种：
  - **实时**：`OnCalendar=`（类 cron）
  - **单调**：`On*Sec=`（如 `OnBootSec=15min`、`OnUnitActiveSec=1w`）
- 启用：`[Install] WantedBy=timers.target`，enable timer；service 无需 `[Install]`。
- 管理：`systemctl list-timers`；时间错乱时删 `/var/lib/systemd/timers/stamp-*`。
- `OnCalendar` 格式：`DayOfWeek Year-Month-Day Hour:Minute:Second`；支持 `*`、`,`、`..`。
- 例：`OnCalendar=Mon..Fri 22:30`；`OnCalendar=*-*-* 02:00:00`；加 `Persistent=true` 可补执行。

- `OnCalendar` 规格用 `systemd-analyze calendar` 验证并计算下次触发时间：`systemd-analyze calendar weekly`、`systemd-analyze calendar "Mon,Tue *-*-01..04 12:00:00"`；加 `--iterations=N` 显示多轮。
- `faketime` 可配合测试不同场景（libfaketime 包）。
- `daily`/`weekly` 等特殊表达式共享同一开始时间，同时触发易致资源竞争；在 `[Timer]` 段设 `RandomizedDelaySec` 随机错开。
- 默认 `AccuracySec=1m` 不精确，可在 `[Timer]` 段设 `AccuracySec=1us`。
- `WakeSystem` 选项可能需要系统能力，失败时报 `Failed to enter waiting state: Operation not supported` 或 `Failed with result 'resources'.`
- `systemd-run` 可创建瞬时 timer（无需 service 文件），例如 `systemd-run --on-active=30 /bin/touch /tmp/foo`。

- `systemd-run --on-active=<时间>` 免 .timer，时间默认秒；可对已有单元（如 `someunit.service`）设延迟（12.5h）。

- `systemd-run --on-active="12h 30m" --unit someunit.service`：延迟执行服务。
- 定时器替代 cron 优势：每个任务独立 service，可独立调试、自定义环境（systemd.exec）、cgroup 控制、依赖其他单元、日志统一。
- 缺点：需创建两个文件并执行 `systemctl`；无内置 `MAILTO`，可用 `OnFailure=` 实现邮件通知。
- 用户级 timer 默认仅活跃登录会话时运行；启用 lingering 可在无登录时启动。
- 可用 `systemd-cron` 解析传统 crontab 并处理 `MAILTO`。
- 手动模板示例 `/etc/systemd/system/monthly@.timer`：
```ini
[Unit]
Description=Monthly Timer for %i service
[Timer]
OnCalendar=*-*-1 02:00:00
AccuracySec=6h
RandomizedDelaySec=1h
Persistent=true
Unit=%i.service
[Install]
WantedBy=default.target
```
启用：`systemctl enable --now monthly@unit_name.timer`。
- 注意：用 `RandomizedDelaySec` 而非仅 `AccuracySec`，避免所有任务同时触发。
- 处理“距上次运行时间”：用 `OnUnitInactiveSec=1day1sec` 追踪任务结束后的间隔；可配合 `Restart=on-failure`、`RestartSec` 实现差异化重启策略。
- 桌面通知：`systemd-timer-notify`。

## systemd 用户

- 原理：`pam_systemd` 在首次登录时自动启动 `systemd --user` 实例；最后一个会话关闭时终止。启用 lingering 后开机启动且不随会话结束终止。
- 用户单元目录（优先级递增）：`/usr/lib/systemd/user/`、`~/.local/share/systemd/user/`、`/etc/systemd/user/`、`~/.config/systemd/user/`。
- 实例默认启动 `default.target`；用 `systemctl --user` 管理。
- 注意：`systemd --user` 是 per-user 进程而非 per-session；用户单元不能引用或依赖系统单元或其他用户单元。
- 基本设置：用户单元放 `~/.config/systemd/user/`，启用执行 `systemctl --user enable unit`；全局启用用 `systemctl --global enable unit`（root）。
- 环境变量：用户实例不继承 `.bashrc` 等设置，需另行配置。

- **当前用户**：`~/.config/environment.d/*.conf`（`NAME=VAL`）
- **全局 user unit**：`/etc/systemd/user.conf` 的 `DefaultEnvironment=`
- **指定 UID**：`/etc/systemd/system/user@UID.service.d/*.conf`
- **所有用户**：`/etc/systemd/system/user@.service.d/*.conf`
- **运行时**：`systemctl --user set-environment` / `import-environment`，仅影响之后启动的 unit
- **导入 D-Bus 会话**：`dbus-update-activation-environment --systemd --all`
- **动态生成**：systemd.environment-generator

验证/生效：

```bash
systemctl --user show-environment
systemctl --user daemon-reload
```

Drop-in 示例：

```ini
[Service]
Environment="PATH=/usr/lib/ccache/bin:/usr/local/sbin:/usr/local/bin:/usr/bin"
Environment="EDITOR=nano -c"
Environment="BROWSER=firefox"
Environment="NO_AT_BRIDGE=1"
Environment="XDG_STATE_HOME=%h/.local/var/state"
```

复用登录 shell 环境（`/etc/systemd/user-environment-generators/10-profile`）：

```sh
#!/bin/sh
env -i -- $SHELL --login -c env | grep -vE '^(_|SHLVL|PWD|OLDPWD)='
```

- 仅启动时执行一次，`daemon-reload` 可重载
- 含 `/etc/profile`、`/etc/profile.d`，不含 `~/.bashrc`、`~/.zshrc`

特殊变量：

- **DISPLAY/XAUTHORITY**：X 启动时由 `50-systemd-user.sh` 导入；非标准 X 启动需手动设置
- **PATH**：若在 `.bash_profile` 自定义，追加 `systemctl --user import-environment PATH`；不影响已启动服务；systemd 解析非绝对路径命令时不用它

易错点：

- systemd 用户实例**不解析 environment.d**；需要时用 drop-in 设置
- `pam_env.so` 方式已弃用
- 用 `%C`、`%E`、`%L`、`%S`、`%t` 等 specifier 检查展开值

lingering：

```bash
loginctl enable-linger             # 当前用户，需 polkit
loginctl enable-linger <用户>       # 非当前用户，root 可执行
```

- `loginctl enable-linger username`
- 勿作自动登录（非会话）
- `loginctl list-users`→LINGER
- `loginctl disable-linger username`

# udev 核心知识点

- udev 是用户空间守护进程，处理内核热插拔/外设事件，管理 `/dev` 设备节点（添加、符号链接、重命名），可调权限、加载内核模块。
- 设备名跨启动不固定（`/dev/sda` 可能变 `/dev/sdb`），应使用 `/dev/disk/by-id`、`by-path`、`by-uuid` 持久标识。

## 规则位置
- 管理员规则：`/etc/udev/rules.d/*.rules`
- 包自带：`/usr/lib/udev/rules.d/`；同名时 `/etc` 优先。

## 常用命令
- `udevadm info --attribute-walk --name=/dev/设备名`
- `udevadm monitor --property --udev`（监控事件/环境变量；插入未知设备可找到最深路径）

## 规则示例
匹配摄像头并创符号链接，可设权限：
```udev
KERNEL=="video[0-9]*", SUBSYSTEM=="video4linux", SUBSYSTEMS=="usb", ATTRS{idVendor}=="05a9", ATTRS{idProduct}=="4519", SYMLINK+="video-cam", OWNER="john", GROUP="video", MODE="0660"
```
移除设备时执行脚本（remove 时属性可能不可访问，用环境变量）：
```udev
ACTION=="remove", SUBSYSTEM=="usb", ENV{ID_VENDOR_ID}=="05a9", ENV{ID_MODEL_ID}=="4519", RUN+="/path/to/your/script"
```

## 易错点
- 匹配区分大小写：`"05A9"` 不能匹配 `idVendor="05a9"`。
- 规则文件必须以 `.rules` 结尾；同名时 `/etc` 覆盖 `/usr/lib`。

- 测试 udev 规则：`udevadm test $(udevadm info --query=path --name=device_name) 2>&1`
- 不执行新规则全部操作，仅处理现有设备 symlink 规则
- 适用：无法加载规则时
- 可直接提供设备路径测试

```bash
udevadm test /sys/class/backlight/acpi_video0/
```

- udev 规则变更自动生效，无需重启。
- 已有设备不重触发规则；热插拔设备需重连，或重载 `ohci-hcd`/`ehci-hcd` 模块。

# udev 规则：动作匹配

- `ACTION==` 匹配事件：`add/remove`、`bind/unbind`、`change`（驱动手动触发）、`online/offline`、`move`。
- `change` 关键子系统属性：
  - `block`：`DISK_MEDIA_CHANGE=1`（新碟）、`DISK_EJECT_REQUEST=1`（弹出）
  - `drm`：`HOTPLUG=1`（显示器热插拔）、`WEDGED=`（卡死）
  - `backlight`：`SOURCE=sysfs|hotkey|unknown`
  - `usb_role`：`USB_ROLE_SWITCH=none|host|device`
  - 合成事件：写入 `uevent`：`change $(uuidgen) FOO=BAR HELLO=WORLD`，产生 `SYNTH_UUID`、`SYNTH_ARG_*`

# 统一内核镜像（UKI）

- 将 UEFI stub、内核、initramfs 合并为单个 PE 文件，可由 UEFI 直接启动，便于 Secure Boot 签名。
- 生成（mkinitcpio）：已装 ukify 时自动调用；`--no-ukify` 禁用。
- 内核命令行：读取 `/etc/cmdline.d/*.conf` 拼接；`#` 注释；移除指向 microcode/initramfs 的条目。
- 示例：`root=UUID=0a3407de-014b-458b-b5c1-848e92a327a3 rw`
- 易错：Btrfs 非默认子卷作根需加 `rootflags=subvolid=256`；`rootflags` 仅启动时用，之后 systemd 按 `/etc/fstab` 重挂载。

- 启用 AppArmor：内核参数添加：
  ```
  lsm=landlock,lockdown,yama,integrity,apparmor,bpf audit=1 audit_backlog_limit=256
  ```
- 可通过 `/etc/kernel/cmdline` 配置；`root=` 可省略（systemd 自动挂载）；`bgrt_disable` 隐藏 OEM logo。
- 修改 `/etc/mkinitcpio.d/linux.preset`：
  - 取消 `PRESET_uki=` 注释；
  - 可选注释 `PRESET_image=` 避免冗余 initramfs；
  - 可选在 `PRESET_options=` 加 `--splash`。

- 预设文件 `/etc/mkinitcpio.d/linux.preset` 定义 UKI 生成规则。
- 关键参数：
  ```ini
  ALL_kver="/boot/vmlinuz-linux"
  PRESETS=('default' 'fallback')
  default_uki="esp/EFI/Linux/arch-linux.efi"
  default_options="--splash=/usr/share/systemd/bootctl/splash-arch.bmp"
  fallback_uki="esp/EFI/Linux/arch-linux-fallback.efi"
  fallback_options="-S autodetect"
  ```
- 旧名 `PRESET_efi_image` 已弃用（2022-11 起），现用 `PRESET_uki`，旧名暂可用。
- ⚠️ 内核 `ALL_kver` 若放在未加密分区（如 ESP 挂载于 `/boot`），双系统时可被其他 OS 篡改。
- 仅需启动 UKI 时，ESP 可挂载到 `/efi`，UKI 文件放 ESP 即可。
- 辅助选项：
  - `fallback_options` 追加 `--cmdline /etc/kernel/fallback_cmdline` 可用不同内核命令行；
  - 加 `--no-cmdline` 则不嵌入命令行，由引导器传参。
- systemd-stub、intel/amd-ucode、linux 内核更新会经 pacman hook 自动重建 UKI；可检查 `/etc/pacman.d/hooks/`。
- 构建：先建 UKI 目录，再重新生成 initramfs：
  ```bash
  mkdir -p esp/EFI/Linux
  mkinitcpio -P
  ```

### ukify 构建 UKI

```bash
ukify build --linux=/boot/vmlinuz-linux \
            --initrd=/boot/initramfs-linux.img \
            --cmdline="quiet rw"
```

- 微码 initramfs 须置首位：`--initrd=/boot/intel-ucode.img --initrd=/boot/initramfs-linux.img`
- `--output=esp/EFI/Linux/filename.efi` 直接输出 ESP；`--cmdline=@/etc/kernel/cmdline` 从文件读参数
- 配合 kernel-install/mkinitcpio，内核/微码/initramfs 变更时自动更新

### 手动构建（objcopy）

合并微码与 initramfs：

```bash
cat esp/cpu_manufacturer-ucode.img esp/initramfs-linux.img > /tmp/combined_initramfs.img
```

- 合并文件作 initramfs，完成后可删除
- IA32 用 `linuxia32.efi.stub` 替换 `linuxx64.efi.stub`
- 用 `objdump -p/-h` 获取 stub 的 SectionAlignment 与 .osrel 偏移，计算对齐与偏移

---
来源：consolidated/sys-admin/系统启动、内核与 systemd（Arch Wiki）.md