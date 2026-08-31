---
source: archwiki
category: basic-ops
url: consolidated/basic-ops/存储与引导（Arch Wiki）.md
title: 1. GPT fdisk
---

- 工具：`gdisk`（交互）、`sgdisk`（命令行）、`cgdisk`、`fixparts`；仅 GPT。安装包 `gptfdisk`。
- 列出：`gdisk -l /dev/sda` 或 `sgdisk -p /dev/sda`
- 备份/恢复/克隆：
```bash
sgdisk -b=backup.bin /dev/sda
sgdisk -l=backup.bin /dev/sda
sgdisk -R=/dev/sdc /dev/sda
sgdisk -G /dev/sdc   # 同机克隆需随机化 GUID
```
- 创建：`gdisk /dev/sda`
  - `o` 新建 GPT 表（**清空数据**）；`n` 新建分区，依次输分区号/首扇区/末扇区/类型。
  - 支持 `K/M/G/T/P`，绝对 `40M`，相对 `+2G`/`-200M`，回车默认；自动 2048 扇区对齐；命名 `/dev/sda1`、`/dev/nvme0n1p1`、`/dev/mmcblk0p1`。
- 类型：默认 `Linux filesystem`，GUID `0FC63DAF-8483-4772-8E79-3D69D8477DE4`，代码 `8300`；`L` 列出。建议遵循 Discoverable Partitions Spec，便于 `systemd-gpt-auto-generator` 自动挂载。
- 易错：新建表前先备份；相对大小用 `+size{M,G,T,P}`，勿小于 1 MiB；留 1 MiB 空闲（首扇区 `+1M`）供 BIOS boot partition。

- GPT 分区类型（gdisk 代码）：
  - Linux filesystem：`8300`
  - EFI system partition：`ef00`
  - BIOS boot partition：`ef02`
  - XBOOTLDR：`ea00`
  - Linux x86-64 root `/`：`8304`
  - Linux swap：`8200`
  - Linux `/home`：`8302`
  - Linux `/srv`：`8306`
  - Linux `/var`：`8310`
  - Linux `/var/tmp`：`8311`
  - Linux LVM：`8e00`
  - Linux RAID：`fd00`
  - Linux LUKS：`8309`
  - Linux dm-crypt：`8308`

- `c` 命令可修改分区名（PARTLABEL）；`w` 写入分区表并退出。

- MBR/BSD disklabel 转 GPT（无损）：gdisk/sgdisk/cgdisk 支持，转换后每个分区获得正确类型 GUID 和唯一 GUID。

- 转换后必须重装引导器以支持 GPT 启动。

- 易错点：
  - GPT 备份表在磁盘末尾占用默认 33 个 512 字节扇区（16.5 KiB）。MBR 末尾无此结构，若最后一个 MBR 分区延伸到磁盘末端，转换会失败，需先缩小该分区。
  - Intel 芯片组笔记本在 RAID 模式下可能损坏备份 GPT，尽量改用 AHCI。

- sgdisk 转换命令：
```bash
# MBR → GPT
sgdisk -g /dev/sda
# GPT → MBR（注意：超过 4 个主分区无法转换）
sgdisk -m /dev/sda
```

- kexec 直接加载启动新内核，免 BIOS，适合快速重启/内核开发。
- 安装：`kexec-tools`
- 重启：
  ```
  kexec -l /boot/vmlinuz-linux --initrd=/boot/initramfs-linux.img --reuse-cmdline
  kexec -e
  ```
  `kexec -e` 不卸载文件系统/停服务；建议先 `kexec -l` 再 `systemctl kexec`。systemd-boot 多 initrd 会拒绝。
- 自定义 service（`/etc/systemd/system/kexec-load@.service`）：
  ```
  [Unit]
  DefaultDependencies=no
  Before=shutdown.target umount.target final.target

  [Service]
  Type=oneshot
  ExecStart=/usr/bin/kexec -l /boot/vmlinuz-%i --initrd=/boot/initramfs-%i.img --reuse-cmdline

  [Install]
  WantedBy=kexec.target
  ```
  启用如 `kexec-load@linux.service`。initramfs 含 shutdown hook 时需从 mkinitcpio.conf 的 HOOKS 移除。
- Nvidia：kexec 前先 `modprobe -r nvidia_drm`。

## Limine
- 支持文件系统仅 FAT12/16/32、ISO9660；启动文件须在 FAT 分区。

### 安装
```bash
pacman -S limine
```

### UEFI 部署
```bash
mkdir -p esp/EFI/arch-limine
cp /usr/share/limine/BOOTX64.EFI esp/EFI/arch-limine/
efibootmgr --create --disk /dev/sdX --part Y \
  --label "Arch Linux Limine Boot Loader" \
  --loader '\EFI\arch-limine\BOOTX64.EFI' --unicode
```
`/dev/sdX` 是磁盘，`Y`=ESP 分区号。若主板忽略，改用 `esp/EFI/BOOT/BOOTX64.EFI`。

### BIOS/MBR 部署
```bash
mkdir -p /boot/limine
cp /usr/share/limine/limine-bios.sys /boot/limine/
limine bios-install /dev/sdX
```

### 配置
- 文件名必须 `limine.conf`；`boot():/` = 配置所在分区。
```ini
timeout: 5
```

## Limine 核心配置

```limine.conf
/Arch Linux
    protocol: linux
    path: boot():/vmlinuz-linux
    cmdline: root=UUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx rw
    module_path: boot():/initramfs-linux.img
```

- 若 `/boot` 分区与 `limine.conf` 所在分区不同，将 `boot():/` 替换为 `uuid(<PARTUUID>):/`（PARTUUID 为 `/boot` FAT 分区）。
- 跨盘报错 `Failed to open image...`：禁用固件快速启动或强制初始化磁盘。
- Secure Boot：资源路径追加 `#<BLAKE2B 校验值>`（128 字符）；`limine enroll-config /path/to/limine.efi <校验值>` 嵌入配置，再签名。
- Windows/memtest 条目可仿照；Windows 若 `limine.conf` 不在 ESP，path 用 ESP 的 `uuid(<PARTUUID>):/`。
- pacman hook：`/etc/pacman.d/hooks/99-limine.hook`，Trigger=Install/Upgrade + Package=limine；32 位 UEFI 用 `BOOTIA32.EFI`。

## rEFInd 要点

- UEFI 引导管理器（rEFIt 分支），EFI boot stub 启动内核；`esp`=ESP 挂载点。
- 文件系统：继承 FAT；加载安装目录 `drivers`/`drivers_x64` 驱动，自带只读 ext4/Btrfs。
- 警告：内核/initramfs 须位于 rEFInd 可读文件系统；Btrfs 需对 `/boot` 禁用 CoW 避免误报 `Not Found`。
- 安装：`pacman -S refind`，运行 `refind-install`。

- `refind-install`：自动挂载 ESP，复制 rEFInd 至 `esp/EFI/refind/`，并用 `efibootmgr` 设为默认启动项。
- 备选回退路径：`esp/EFI/BOOT/bootx64.efi`，适合 USB 启动或 NVRAM 异常系统。

- 安装：`refind-install --usedefault /dev/sdXY`（`/dev/sdXY` 是 EFI 系统分区块设备，非挂载点）
- 驱动：默认仅装内核所在文件系统驱动；其他驱动手动复制 `/usr/share/refind/drivers_x64/` 至 `esp/EFI/refind/drivers_x64/`，或加 `--alldrivers`（适合 USB）
- 配置：`refind_linux.conf` 需与内核同目录；`--usedefault` 不生成，root 运行 `mkrlconf`
- 易错：chroot 安装时 `/boot/refind_linux.conf` 会带入 live 系统参数，须编辑，否则可能 kernel panic
- 默认 rEFInd 扫描所有有驱动的磁盘，自动添加 EFI 启动加载器条目（Arch 的 EFI stub 内核），通常可直接启动
- Secure Boot：可用 PreLoader，执行 `refind-install --preloader /path/to/preloader`（需先获取签名的 `PreLoader.efi`/`HashTool.efi`）

```bash
cp /usr/share/refind/drivers_x64/* esp/EFI/refind/drivers_x64/   # 手动装驱动
mkrlconf                                                         # 生成内核参数配置
```

- 安装：`refind-install --preloader /usr/share/preloader-signed/PreLoader.efi`
- Secure Boot 启动时，HashTool 需注册：`loader.efi`、驱动（如 `ext4_x64.efi`）、内核（如 `vmlinuz-linux`）哈希
- 注意：HashTool 仅能访问其所在分区；内核不在 ESP 时无法注册，改用 KeyTool（可写 MokList、不限分区），并先注册 KeyTool 哈希
- shim 方式：安装 `shim-signed`，参照 Secure Boot#shim，跳过文件复制；仅用哈希时执行 `refind-install --shim /path/to/shim`

- 安装：`refind-install --shim /usr/share/shim-signed/shimx64.efi`
- 首次启动进 MokManager，注册哈希：`grubx64.efi`、驱动 `ext4_x64.efi`、内核 `vmlinuz-linux`
- 装 `sbsigntools`；密钥放 `/etc/refind.d/keys`：`refind_local.key`、`.crt`、`.cer`
- 执行：`refind-install --shim /path/to/shim --localkeys`

- 遵循 Secure Boot#Using your own keys 创建密钥
- 建目录 `/etc/refind.d/keys`，放入 db 密钥/证书，命名：
  - `refind_local.key`(PEM 私钥)
  - `refind_local.crt`(PEM 证书)
  - `refind_local.cer`(DER 证书)
- 安装脚本加 `--localkeys`
- 签名内核：
```bash
sbsign --key /etc/refind.d/keys/refind_local.key --cert /etc/refind.d/keys/refind_local.crt --output /boot/vmlinuz-linux /boot/vmlinuz-linux
```
- 可配 mkinitcpio post hook 自动签名
- MokManager 添加 `refind_local.cer`（位于 `esp/EFI/refind/keys/refind_local.cer`）

- `refind-install --localkeys`：用提供的密钥和证书对 EFI 二进制签名。
- 脚本安装失败时，可手工安装：先将可执行文件复制到 ESP。

- 安装：`cp /usr/share/refind/refind_x64.efi esp/EFI/refind/`
- 回退：改用 `esp/EFI/BOOT/bootx64.efi`

用 `efibootmgr` 创建 UEFI NVRAM 启动条目；`/dev/sdX` 和 `Y` 为 EFI 系统分区设备与分区号。若已用默认回退路径，可跳过此步。

```bash
efibootmgr --create --disk /dev/sdX --part Y --loader /EFI/refind/refind_x64.efi --label "rEFInd Boot Manager" --unicode
```
- 内核不在 ESP：挂载分区；非 UEFI FS 需驱动。
- 驱动自动加载：安装目录下 `drivers`/`drivers_arch`（如 `drivers_x64`）。

复制驱动：
```bash
cp /usr/share/refind/drivers_x64/drivername_x64.efi esp/EFI/refind/drivers_x64/
```
rEFInd 自动生成启动项，需设置**内核参数**。若无法启动，编辑配置文件调优。

- `cp /usr/share/refind/refind.conf-sample esp/EFI/refind/refind.conf`
- 未设 `textonly` 时须复制图标，否则显示丑陋占位符。

- 复制字体目录：`cp -r /usr/share/refind/fonts esp/EFI/refind/`
- rEFInd 中按 `F10` 保存截图。

---
来源：consolidated/basic-ops/存储与引导（Arch Wiki）.md