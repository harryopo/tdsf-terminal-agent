# 第三方资产与许可证

ShellLab 在浏览器内运行以下开源组件。许可证原文随资产保留在仓库中。

| 组件 | 用途 | 许可证 | 本地许可证文件 |
|---|---|---|---|
| xterm.js 6.0.0 | 终端界面 | MIT | `site/assets/vendor/xterm/LICENSE` |
| @xterm/addon-fit | 终端尺寸自适应 | MIT | `site/assets/vendor/xterm/addon-fit-LICENSE` |
| v86 | x86 模拟器与 Linux 运行时 | MIT | `site/assets/vendor/v86/LICENSE` |
| JetBrains Mono | 界面与终端字体 | SIL Open Font License 1.1 | `site/assets/fonts/OFL.txt` |
| SeaBIOS / VGA BIOS | 客户机固件 | 各上游项目许可证 | 随 v86 发行资产提供 |
| Buildroot 2013.08.1 Linux 镜像 | 隔离练习客户机 | 镜像内各组件分别适用其上游许可证 | 见下方来源说明 |

## Linux 镜像来源

镜像来自 v86 项目的磁盘镜像资产，运行时版本标识为 Buildroot 2013.08.1、32 位 i686。镜像包含 Linux 内核、BusyBox 等开源组件；这些组件的权利归各自作者和项目所有。

对应上游来源：

- v86：https://github.com/copy/v86
- Buildroot 2013.08.1：https://buildroot.uclibc.org/downloads/buildroot-2013.08.1.tar.bz2
- Linux 内核：https://kernel.org/
- BusyBox：https://busybox.net/

ShellLab 不声称拥有上述组件，也不提供任何上游项目的背书。部署镜像仅用于浏览器内隔离教学，不用于生产系统。
