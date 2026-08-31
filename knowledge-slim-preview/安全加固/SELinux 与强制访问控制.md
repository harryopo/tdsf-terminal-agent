---
source: selinux-docs
category: security
url: consolidated/security/SELinux 与强制访问控制.md
title: SELinux 与强制访问控制
---

- SELinux=LSM MAC；TE/RBAC；enforcing/permissive/disabled
- 配置：`USE=selinux`，`emerge -DN @world`
- 易错：`semanage port`，`selinux=0`

**/etc/portage/make.conf**（旧路径 `/etc/make.conf`）是 Portage 全局主配置，设置对所有 emerge 包生效（全局 USE、L10N、镜像等）。该文件可为目录，内容合并解析。

**优先级**：`/etc/portage/package.use/` 可逐包覆盖全局设置；环境变量亦可。新旧文件并存时 `/etc/portage/make.conf` 优先。

**变量规则**：大多可选、可跨行，但同一变量不可出现多次。

- **CHOST**：profile 已设好，改动需深厚构建链经验；profile 23.0+ 建议勿在 make.conf 列出。
- **CFLAGS/CXXFLAGS**：分别用于 C/C++ 编译，通常一致：

```bash
CFLAGS="-march=native -O2 -pipe"
CXXFLAGS="${CFLAGS}"
```

- **CONFIG_PROTECT**：空格分隔的受保护文件/目录列表，变更需手动合并（dispatch-conf）；`CONFIG_PROTECT_MASK` 排除子路径。查看当前值：

```bash
portageq envvar CONFIG_PROTECT
# 或
emerge --verbose --info | grep -E '^CONFIG_PROTECT='
```

```bash
CONFIG_PROTECT="/var/bind"
```

- **FEATURES**：启用 Portage 功能列表，影响行为；增量变量，默认值在 `/usr/share/portage/config/make.globals`，可在 make.conf 追加。

完整变量列表见 `man make.conf`。

### FEATURES
在 `/etc/portage/make.conf` 中添加 `FEATURES="keepwork"`，可保留编译临时文件（便于调试）。

### MAKEOPTS
- 指定构建源码时传递给 `make` 的参数，默认 `-j$(nproc) -l$(nproc)`。
- 推荐值取 `min(线程数, 内存/2GB)`。

```make.conf
# 双核超线程 + 8GB 内存：min(4, 8) = 4
MAKEOPTS="-j4 -l4"
```

### EMERGE_DEFAULT_OPTS
- 定义追加到 `emerge` 命令行的参数，实现并行构建。
- 常用 `--jobs N` 与 `--load-average X.Y` 控制系统负载和同时构建包数。

```make.conf
EMERGE_DEFAULT_OPTS="--jobs 3"
```

注意：该变量也会影响构建行为。

### PORTAGE_TMPDIR
- 定义 Portage 临时文件目录，默认 `/var/tmp`，构建位置为 `/var/tmp/portage`，ccache 为 `/var/tmp/ccache`。

```make.conf
PORTAGE_TMPDIR="/var/tmp"
```

- 易错点：若 `/var/tmp` 以 `noexec`（或 `user`/`users`）挂载，emerge 报错：
```
Can not execute files in /var/tmp/portage
```
- 解决：移除 `/etc/fstab` 中的对应挂载选项，或改设 `PORTAGE_TMPDIR` 到可执行目录。

**dispatch-conf**：Portage 附带的配置文件管理工具，在包更新后安全地合并/回滚配置变更。

- 自动更新从未修改过或仅注释/空白差异的配置文件
- 检查 `CONFIG_PROTECT` 目录下的变更；`CONFIG_PROTECT_MASK` 中的文件不保护，**自动覆盖**
- 所有变更存入存档目录，支持回滚

### 首次配置
编辑 `/etc/dispatch-conf.conf`，设置 `archive-dir` 并创建目录（默认 `/etc/config-archive`）：

```bash
root # mkdir -p /etc/config-archive
```

### RCS 集成
安装 RCS 并启用：

```bash
root # emerge --ask dev-vcs/rcs
```

`/etc/dispatch-conf.conf`:

```ini
use-rcs=yes
```

启用后所有更改存入 `/etc/config-archive`。

- 查看历史：`rlog /etc/config-archive/etc/conf.d/udev,v`
- 回滚到旧版：`co -p -r版本号 文件,v > 目标文件`
- 提交新版本：`co -p -l 文件,v` → 编辑 → `ci -l 文件,v`

### 易错点
- 首次运行前必须编辑配置并创建存档目录
- RCS 归档文件权限继承自首次 check-in，若工作文件权限已变可能产生安全风险，需控制父目录访问权限
- dispatch-conf 只记录包更新时建议的改动；之后的手工修改不会被自动注册
- `co` 检出会写文件系统，务必先备份现有文件，或使用 `-p` 输出到标准输出
- `ci` 前必须先锁定文件；不要删除工作文件

## 颜色显示
- 使用 `diffutils` 的 `--color` 或安装 `app-misc/colordiff`。
- 修改 `/etc/dispatch-conf.conf` 中的 `diff` 行：
```bash
diff="diff --color=always -Nu '%s' '%s'"
# 或安装后：
diff="colordiff -Nu '%s' '%s'"
```

## 使用 (g)vimdiff 合并
- 修改 `merge` 行。**左窗格是原始文件（合并输出）**，在左窗格修改并保存；右窗格为新配置，不可修改只读。
```bash
merge="vimdiff -c'saveas %s' -c next -c'setlocal noma readonly' -c prev %s %s"
# gvimdiff 需加 -f；neovim：
merge="nvim -d -c'saveas %s' -c next -c'setlocal noma readonly' -c prev %s %s"
```
- 常用命令：
```text
]c / [c          跳转下一个/上一个变更
CTRL-W <右/左>   切换窗口
do / dp          获取/放入高亮块
zo / zc / zr     开关折叠
:wqa             保存并退出
```

## 使用 imediff 合并
- 安装 `dev-util/imediff`，修改 `merge` 行：
```bash
# imediff-1.X
merge="imediff2 -c -N --output='%s' '%s' '%s'"
# imediff-3.X
merge="imediff --output='%s' '%s' '%s'"
```
- 按键：`a`/`b` 切换选项，`e` 用 `$EDITOR` 手动合并。

## 运行与备份
- 以 root 运行：`dispatch-conf`
- 手册：`man 1 dispatch-conf`
- 安装 `etckeeper` 可自动将每次配置变更保存到 git 仓库。

- **ebuild 文件**：描述软件包元数据（名称、版本、许可证、主页）、依赖（构建期/运行期）及构建安装指令的文本文件，通常存放在 ebuild 仓库中。
- 格式本质上是 **bash 脚本子集**，遵循指定 **EAPI** 版本，由 Package Manager Specification 标准化。
- 默认位置：`/var/db/repos/gentoo/`（Gentoo ebuild 仓库）。

```bash
# 查看 ebuild 示例
grep -r "EAPI" /var/db/repos/gentoo/app-shells/bash/
```

- **Live ebuild**：
  - 源码从 VCS（如 git）获取，版本号常为 `9999` 以便区分。
  - 正式判定：变量 `PROPERTIES` 含值 `"live"`；继承 VCS eclass（如 `git-r3`）时自动带 `PROPERTIES+=" live"`。

- **关键相关文档/命令**：
  - 编写指南：Basic guide to write Gentoo Ebuilds
  - 提交指南：Submitting ebuilds
  - 规范：Package Manager Specification
  - 帮助命令：`ebuild --help`、`man ebuild`

- **ebuild 仓库**：为 Gentoo 提供包的文件结构，含 ebuild、eclass、元数据、news items、profile 等。
- **Gentoo ebuild 仓库**（又称 ::gentoo、Portage tree、the tree）：官方主仓库，默认包来源，位于 `/var/db/repos/gentoo`，通过 git 同步。
- ebuild 文件包含：构建/安装/测试指令、依赖信息（随 USE flag 变化）、元数据（名称、版本、源码地址、USE flag、许可证、网站）。
- profile 定义默认 USE flag、make.conf 默认值、系统包集合。
- news items 在同步后提示。
- 其他仓库（如 GURU）可通过 Portage 配置，按优先级选择版本，故称 **overlay**。

## 关键路径与配置
- 仓库位置：`/var/db/repos/`
- Portage 仓库配置：`/etc/portage/repos.conf`
- 仓库可放在任意可访问文件系统（如 NFS、SSHFS），不限于本地。

## 仓库同步
- 额外仓库通常由第三方提供，配置后由 Portage 同步（镜像远程文件到本地）。

## 易错点
- 勿手动复制仓库文件，应通过 Portage 同步机制管理。
- 仓库优先级决定多仓库提供同一包版本时的选择顺序。

- ebuild 仓库本质是文件结构，可用多种方式同步；默认 rsync，也常用 git。
- 同步方式及获取信息在 `/etc/portage/repos.conf` 中配置。

### 仓库管理
- 使用 `eselect repository` 添加、禁用、删除仓库，也可列出 repos.gentoo.org 注册的仓库。
- 手动配置：编辑 `/etc/portage/repos.conf`。

**警告**：非 Gentoo/GURU 官方仓库可能含脆弱、损坏甚至恶意软件。

- 列出活动仓库：
```bash
emerge --info
portageq repos_config /
```

### 从其他仓库安装包
- 安装命令与普通 emerge 相同，输出中 `::仓库名` 显示来源。
- 示例（GURU 仓库安装 x11-misc/xbanish）：
```bash
emerge --ask x11-misc/xbanish
```
输出片段：
```
[ebuild   R   #] x11-misc/xbanish-1.7::guru  0 KiB
```
原因：该包不在 Gentoo 主仓库。

- 多仓库同包不同版本：Portage 默认装最新版。
- **易错点**：系统更新时，新加仓库若提供已装包的更新版本，会被覆盖。可用 masking 避免；GURU 刻意不覆盖 Gentoo 主仓库包。
- 同版本多仓库时：优先级高的仓库生效，优先级在 `/etc/portage/repos.conf` 设置。

# emerge

emerge 是 Gentoo 包管理器 Portage 的 CLI，用于下载/安装/更新/维护软件包，支持源码构建、二进制包、搜索、系统信息。

调用：
```
emerge [ options ] [ action ] [ ebuild | tbz2 | file | @set | atom ] [ ... ]
```
- 无参数打印帮助；安装需 root，查询可用普通用户；**直接跟包名即执行安装，不确认**。

关键选项：
- `-a`/`--ask`：显示变更计划并询问
- `-p`/`--pretend`：仅预览，无需 root
- `--verbose`：显示 USE、下载大小、overlay 等
- `-t`/`--tree`：显示依赖树
- 其他：`--sync` `--info` `--resume` `--search` `--deep` `--depclean`

**易错**：`--ask` 中意外按回车会跳过确认提示。

输出示例 `emerge -atv package`：
```
[ebuild  **U** ] category/package-3.0-r2::gentoo [2.0::gentoo] ...
[ebuild  **UD** ] category/package-2.0::gentoo [3.0::gentoo] ...
[ebuild  **R** ] category/package-1.0::gentoo ...
[ebuild **N** ] category/package-0.5::some-overlay-name ...
```
- `U` 升级、`D` 降级、`R` 重装、`N` 新装；方括号内为已装旧版本；粗体包名表示在 world（用户明确安装），其余为依赖/系统包。

安装：`emerge <package>` 后可加版本/slot/仓库说明符；USE flag 配置在 `/etc/portage/package.use`。

### emerge 常用选项

- `--ask`（`-a`）：操作前确认，默认不提供则直接执行。
- `--verbose`（`-v`）：显示更详细执行信息。
- 可在 `/etc/portage/make.conf` 中通过 `EMERGE_DEFAULT_OPTS` 设置默认选项，命令行可覆盖，如 `--ask=n`。
- `--pretend`：模拟执行，不实际变更。

示例安装包：

```bash
root # emerge --ask --verbose net-proxy/tinyproxy
```

### 搜索包

- 内置搜索受 `ACCEPT_KEYWORDS`、profile、`make.conf`、`package.accept_keywords` 限制；不区分 slot，可能比 `eix`/`eshowkw` 结果少。
- 按名称搜索：

```bash
user $ emerge --search proxy
```

- 按名称或描述搜索：

```bash
user $ emerge --searchdesc proxy
```

- 正则搜索：

```bash
user $ emerge -s '%^python$'
```

- 列出某分类全部包：

```bash
user $ emerge -s '@^net-ftp/'
```

### 卸载/清理包（depclean）

- 卸载即 `--depclean`（`-c`），会移除指定包及其多余依赖、孤立包、虚拟包默认依赖。
- **不会**移除当前是其他包依赖、或属于 `@system`/`@profile` 集合的包。
- 重要：执行前必须用 `--ask` 或 `--pretend` 审查要移除的包列表。
- 若某包仅因虚拟包依赖而存在但已被系统期望，可用 `--noreplace` 将其加入 `@world` 避免被清理。
- 系统更新可能误伤重要包（如编译器、内核），操作前务必核对。

## Portage 核心知识点

- Portage 是 Gentoo 官方包管理器，核心命令为 `emerge`；日常常用命令还包括 `emaint`、`dispatch-conf`。
- 系统自带，无需安装；损坏/缺失时需修复。

### 关键 USE flags（sys-apps/portage）

- `+ipc`：启用 portage 与 ebuild 间进程通信。
- `+native-extensions`：编译原生 C 扩展加速；不支持交叉编译。
- `+rsync-verify`：使用 gemato 对仓库进行加密校验。
- `xattr`：安装文件时保留扩展属性，通常硬化系统需要。
- `selinux`：**内部使用**，必须由 selinux profile 设置，手动设置会导致破坏。
- `build`：**内部使用**，禁止手动设置。
- `test`：启用测试依赖，通常由 `FEATURES=test` 控制。

### 更新 Portage

- 常规系统更新一般会自动更新 Portage；若同步后提示需先更新，执行：

```bash
emerge --ask --oneshot sys-apps/portage
```

- 易错点：必须加 `--oneshot`，避免将 Portage 加入 world 集合。

### 配置

- 主配置文件：`/etc/portage/make.conf`。
- 默认值位于 `/usr/share/portage/config/make.globals`，可在 make.conf 中覆盖同名变量。
- 查看当前 Portage 配置和环境变量：

```bash
emerge --info --verbose
```

- 其他配置位于 `/etc/portage/` 目录；完整变量说明见 `man make.conf`。

- 环境变量可按包设置：`/etc/portage/package.env`
- ebuild 仓库：官方 Gentoo 仓库外，另有 `repos.gentoo.org`（社区）、`GURU`（官方用户协作维护）、`gpo.zugaina.org`（第三方）
- 仓库配置方法见 Ebuild repository 文章；搜索包：`emerge --search` 或 `eix`
- 警告：第三方 ebuild 仓库可能含漏洞、损坏甚至恶意软件；仅官方仓库和 GURU 有审查
- 二进制包主机：配置于 `/etc/portage/binrepos.conf`，需匹配 USE flags；官方二进制 host 支持 amd64/arm64（见 Gentoo Binary Host Quickstart）
- 日常主要命令：`emerge`、`emaint`、`dispatch-conf`
- `archive-conf`：将配置文件存入 dispatch-conf 归档目录，基本无需运行：
```bash
archive-conf /CONFIG/FILE [/CONFIG/FILE...]
```
- `dispatch-conf`：管理配置文件更新
- `ebuild`：仅用于包开发，**不要用 `ebuild` 安装包**；需先放入 ebuild 仓库，再用 `emerge` 安装

- **Profiles** 是 Portage 核心功能，为 Gentoo 元发行版提供基础配置：定义架构底层参数、包可用性、USE flag 默认值、`/etc/portage/make.conf` 变量默认值、系统包集合、默认工具链与核心库。
- 安装时选择，之后可切换；当前版本 23.0（上一版 17.1 相距约 6 年）。
- 切换前**必须阅读并遵循对应 news item**；切换到不同 ABI（如 pure LLVM、musl）的 profile 需要重装系统。
- 自定义 profiles 按 ebuild 仓库定义；主仓库位于 `/var/db/repos/gentoo/profiles`。

## 稳定性等级
- **stable**：完整测试，CI 检查依赖图，标 `(stable)`。
- **dev**：开发中，CI 仅警告，标 `(dev)`；仅特定需求使用。
- **exp**：实验性，可能不成为永久 profile，标 `(exp)`；常见于非主流架构。可能需要全局 `~ARCH` 或通过 `/etc/portage/package.accept_keywords` 拉取测试包，并自行上报 stable 请求；使用中会偶发问题。

## 常用 profile
- 基础：`default/linux/<架构>/23.0` 和 `default/linux/<架构>/23.0/systemd`
- OpenRC 变体无 init 限定符；systemd 变体含 `systemd` 限定符。
- 完整列表见仓库 `profiles/profiles.desc`。

## Gentoo Profile 核心要点

- **desktop profile**：含 `desktop` 限定符，用于图形安装（DE/WM/Xorg/Wayland）；提供 GNOME、Plasma 变体；仅提供图形系统最小基础，仍具灵活性。**易错**：图形系统未用 desktop profile 会造成沉重维护负担及潜在问题。
- **hardened profiles**：用于 Hardened Gentoo，技术要求高、使用受限，不常用。
- **amd64 multilib / no-multilib**：amd64 支持 x86 及 x86_64。no-multilib 仅限明确特定场景（纯 x86_64），不推荐常规使用，否则遇到仍常见的非 x86_64 软件时会产生复杂问题。**关键**：no-multilib 与标准 profile 间切换几乎不可能，通常需全系统重装，非必需勿用。
- **split-usr profiles**：支持 `/bin`、`/sbin`、`/lib`、`/lib64` 合并进 `/usr` 之前的系统。
- **实验/开发中 profiles**：LLVM、musl、Prefix、x32（amd64）。仅供测试者或明确需要时使用；常规选 stable。
- **切换 profiles**：系统用途改变或找到更合适 profile 时进行；新 profile 发布后需升级。
- **升级 profiles**：⚠️ 不可轻率。ebuild 仓库同步后经 news item 通知，含详细指令须严格遵循；属非平凡操作，操作前务必备份。
- 全局 profiles 目录：`/var/db/repos/gentoo/profiles`

### selected-packages 集合（Portage）

- 即 `/var/lib/portage/world` 文件，记录用户显式选择的“world”包，与 World set 不同。
- **重要**：world 文件应尽量少包含依赖包，避免更新时依赖解析问题。

**列出集合**：
```bash
eix -c --selected-file
```

**安装依赖但不加入 world**（用 `--oneshot`/`-1`）：
```bash
emerge --ask --oneshot <category/atom>
```

**检查/修复 world 文件**：
```bash
/usr/sbin/emaint --check world
/usr/sbin/emaint --fix world
```

**添加包到 world 但不重新编译**（`--noreplace`/`-n`）：
```bash
emerge --ask --noreplace <category/atom>
```

**易错点**：
- 虽然 man 页声称可手工编辑 world 文件，但 Portage 会重写该文件：注释、包顺序会丢失，且无拼写检查。
- 用 `emerge --deselect`（`-W`）或 `--noreplace`（`-n`）增删 world 条目，而不实际安装/卸载包。

## SELinux 核心知识点

### 核心概念
- SELinux 是内核强制执行的强制访问控制（MAC）系统，基于安全策略；区别于传统自主访问控制（DAC）。
- MAC 不可绕过，所有访问由内核 SELinux 子系统裁决。

### 关键机制
- 类型强制：基于源/目标域类型的许可规则。
- RBAC：角色限制用户，最小权限。
- 基于用户访问控制：同域内不同 SELinux 用户隔离。
- 信息流控制：按安全级别限制信息流动。
- 无约束域：可放行不需保护场景。

### 关键配置与命令
- 标签：SELinux 基于标签管理资源，需正确设置。
- 策略：定义可接受行为；可模块化加载/卸载、追加规则、重建。
- 布尔值：开关附加策略控制，无需改策略文件。
- 状态：`enforcing`（强制）、`permissive`（宽松）、`disabled`（禁用）。
- 日志：拒绝事件记录于审计日志；未启用审计时落入系统日志。

### 开发与集成
- 内核通过 LSM 集成。
- 发行版策略基于上游 Reference Policy。
- 用户空间工具由 SELinux userspace project 提供。
- Gentoo 由 Gentoo Hardened 维护。

### 版本状态
- 用户空间：上游 3.10；Gentoo 稳定 3.9 / 测试 3.10。
- 策略：上游 2.20260312；Gentoo 稳定 2.20250618\_p1-r1 / 测试 2.20260312\_p1。

### 易错点
- 混淆 DAC 与 MAC：属主无权决定他人访问，一切由策略决定。
- 标签不匹配是常见拒绝原因，用 `restorecon` 排障。
- 调布尔值前先确认当前状态，避免意外放宽或收紧。

- 支持渠道：[gentoo-hardened](http://news.gmane.org/gmane.linux.gentoo.hardened) 邮件列表；Libera.Chat `#gentoo-hardened` IRC（[webchat](https://web.libera.chat/#gentoo-hardened)）。
- 外部资源：
  - *The Inevitability of Failure*：论证强制访问控制（MAC）的必要性。
  - *The Flask Security Architecture*：阐述 SELinux 所用的 Flask 安全架构。

SELinux 布尔值是可配置开关（类似 sysctl，但仅 on/off），用于控制附加策略规则，实现策略灵活管理。

策略中布尔值称为 tunable，通过 `tunable_policy` 宏控制规则集。示例：

```bash
tunable_policy(`use_nfs_home_dirs',`
        fs_manage_nfs_dirs(ssh_t)
        fs_manage_nfs_files(ssh_t)
')
```

- 设置布尔值即启用/禁用对应规则集；启用 NFS 主目录需将 `use_nfs_home_dirs` 设为 on。

管理命令：

- 列出所有布尔值：
  ```bash
  getsebool -a
  semanage boolean -l    # 显示状态/默认值/描述
  ```
- 查看单个布尔值：
  ```bash
  getsebool <布尔名>
  semanage boolean -l | grep <布尔名>
  ```
- 设置布尔值：
  ```bash
  setsebool <布尔名> on|off          # 仅当前会话有效
  setsebool -P <布尔名> on           # 持久化
  semanage boolean -m --on <布尔名>  # 持久化修改
  ```
- 查看受影响的策略规则：
  ```bash
  sesearch -b <布尔名> -A
  ```
  结果中 `E` 表示当前启用（Enable），`T` 表示布尔值为真时激活；`F` 表示布尔值为假时激活。如 `cron_can_relabel` 未启用时，相关规则显示 `EF`。

易错点：

- 不加 `-P` 或 `semanage boolean` 的修改只对当前启动会话生效，重启后恢复原策略。
- 临时调整可用于测试，但可能使系统不可用，重启即可恢复。
- 布尔值由策略提供，需先加载对应 SELinux 策略。

- SELinux 为强制访问控制系统；资源限制用 cgroups/PAM，非 SELinux；可与 PIE-SSP 硬化编译器并用。
- 依赖 xattr 存安全上下文。支持：ext2/3/4、jfs、xfs、btrfs、tmpfs；不支持：vfat、iso9660；NFS xattr 未完善。
- profile：amd64 no-multilib 用 `hardened/linux/amd64/no-multilib/selinux`；systemd 用 `systemd/selinux`。
- UBAC：源/目标均为 `ubac_constrained_type` 时，仅 SELinux 用户相同规则生效；例外：源域 `sysadm_t` 或任一方 `system_u`。  
  示例：`allow foo_t bar_t:file read;` staff_u 读 staff_u 允许，user_u 读 staff_u 禁止。
- `semanage` 报 `NameError: global name 'audit' is not defined`：给 `sys-process/audit` 加 `python` USE。
- 模式切换：`setenforce 0|1` 或内核参数 `enforcing=0/1`；配置在 `/etc/selinux/config`。
- 禁用：设 `SELINUX=disabled` 重启；**禁用后必须先进 permissive 并 relabel 整个文件系统**，否则新文件缺少 context。
- 文件上下文规则：`matchpathcon` 显示应有 context。优先级：无正则 > 正则；正则前字符多者优先；总字符多者优先；映射到特定类型者优先。来源优先级：`file_contexts.local` > `file_contexts.homedirs` > 策略 `file_contexts`；无正则规则优先。
- 本地规则用 `semanage fcontext` 维护。

### SELinux 策略模块自定义

- 策略只可增加权限，不宜删除；自定义规则写入独立模块（如 `fixlocal.te`）。
- 模块骨架：
```
policy_module(fixlocal)
require {
  # 类型、类别、权限声明
}
# 策略规则
```
- 规则示例：
```
allow mozilla_t self:process { execmem };
corenet_tcp_connect_all_ports(ssh_t)
logging_send_syslog_msg(user_t)
```
- 裸 `allow` 时，`require` 中必须列出类型、类别、权限；用接口时列出涉及类型。

### 编译与加载

```
make -f /usr/share/selinux/mcs/include/Makefile fixlocal.pp
semodule -i fixlocal.pp
```

### 加载整个策略集

- 2.4 起可简化：`semodule -i *.pp`
- 旧方式：`semodule -b base.pp -i $(ls *.pp | grep -v base.pp)`

### 易错点：模块优先级

- 2.4 起旧工具加载的模块优先级为 100，新模块为 400。
- 直接 `semodule -i *.pp` 加载新集但缺少旧模块时报错：
```
Re-declaration of typeattribute fixed_disk_raw_read
Failed to build ast
```
- 删除旧优先级模块又因依赖失败：
```
semodule -X 100 -r storage
Failed to resolve typeattributeset statement
```
- 新旧优先级不统一会造成“死锁”：需保留完整模块集，或明确用 `-X` 指定优先级操作。

## SELinux/Gentoo 策略包

- Gentoo 将 SELinux 策略模块打包为独立策略包，按需加载所需模块，而非全部策略
- 策略模块类似内核模块，可动态加载/卸载；每个模块包含某应用的全部 SELinux 规则
- 策略基于 hardened-refpolicy 仓库，同步上游并含 Gentoo 侧更新

### ebuild 结构

```
EAPI=8
MODS=( screen )
inherit selinux-policy-2
DESCRIPTION="SELinux policy for screen"
KEYWORDS="~amd64 ~x86"
```

实际构建由 `selinux-policy-2` eclass 完成。

### 关键变量

- `MODS`：要构建的模块名，可为数组。如 `MODS="screen"` 查找 `screen.if`/`screen.te`/`screen.fc`
- `BASEPOL`：基础策略版本。策略间接口调用可能跨版本不兼容，同一快照的所有模块必须使用相同 `BASEPOL`；未设置时取包版本
- `SELINUX_GIT_REPO`：改用其他 refpolicy 风格仓库
- `SELINUX_GIT_BRANCH`：指定 Git 分支（默认 `master`），用于合并前测试

### IUSE 支持

支持按 USE 标志优化策略，如 `USE="alsa"` 启停模块中的 ALSA 支持。

- SELinux profiles 通过 `features/selinux` 部件实现，无 parent，可独立叠加。在 profile parent 中引用：`../../../../features/selinux`。
- 已启用 profile（stable/exp）：`default/linux/amd64/23.0/hardened/selinux` 等。
- 默认 USE：`selinux`、`unconfined`（不用可移除）。
- 默认 FEATURES：`selinux`、`sesandbox`、`sfperms`。
- 默认变量：`POLICY_TYPES="strict targeted mcs mls"`、`PORTAGE_T="portage_t"`、`PORTAGE_FETCH_T="portage_fetch_t"`、`PORTAGE_SANDBOX_T="portage_sandbox_t"`。
- 无额外 package mask。
- 基础包入 @system：libsepol、libselinux、libsemanage、checkpolicy、policycoreutils、selinux-base-policy。
- 强制 USE：libselinux/libsemanage/setools 强制 `python`；dev-lang/python 强制 `xml`；系统级强制 `selinux`；`audit` 强制开启。
- 环境覆盖：`SANDBOX_WRITE` 允许写 `/selinux`、`/sys/fs/selinux`、`/proc/self/`（支持 `setfscreatecon`）。

- **信息流控制**：防数据泄漏，基于 Bell-LaPadula 模型，通过主体许可等级 vs 客体敏感性比较决定访问。
- **两条强制规则**：
  - 主体不能读更高安全级别的客体（**no read up，不上读**）
  - 主体不能写更低安全级别的客体（**no write down，不下写**）
- **核心概念**：
  - **安全级别**：层级化级别，如 public / internal / confidential 等。
  - **分类（Categorization）**：支持访问矩阵，用于部门级隔离；如仅允许本部门角色访问本部门保密数据。
  - **敏感性（Sensitivity）**：客体属性 = 安全级别 + 分类集合。
  - **许可（Clearance）**：主体属性 = 当前敏感性 + 最大安全级别与最大分类集合。
- **SELinux 实现**：通过 MLS（Multi-Level Security）支持该模型。
- **敏感性语法**：整数表示级别，整数表示分类，最低级别且包含分类 1、5、7 写作：

```text
s0:c1,c5,c7
```

- **许可语法**：包含当前敏感性和最大敏感性（用 `-` 连接）。当前级别 s1、可访问至 s3、分类 1、5、7 写作：

```text
s1-s3:c1,c5,c7
```

- **易错点**：
  - `s0-s3` 中 `s0` 为当前级别，`s3` 为最大级别，顺序不可颠倒。
  - 分类用逗号分隔，级别范围用连字符。
  - 不上读/不下写是强制规则，普通 DAC 权限之外还需检查 MLS 上下文。

- 先读 SELinux/Quick_introduction，避免损坏系统。
- 新装推荐 hardened stage3 SELinux tarball（解包→重打标签→添加管理员→重启）；以下针对现有系统转换。

### 策略类型
- `targeted`：含 unconfined 域，默认放行多数活动；`strict`：无 unconfined，默认拒绝，更安全但难管理。
- `mcs`：多类别隔离，适合多租户；应用需支持或脚本设类别；一般推荐，profile 默认。
- `mls`：实验性，不推荐。
- unconfined USE：mcs/mls 用其开关 unconfined；strict 不支持；targeted 必须设。

### 配置
`/etc/portage/make.conf`：
```
SELINUX_POLICY_TYPES="mcs"    # 默认
# 多 store 例：strict targeted，strict 为默认活动
SELINUX_POLICY_TYPES="strict targeted"
```
可定义多个 store，同时仅一个活动。

### /etc/fstab
tmpfs 默认上下文 `tmpfs_t`，需改 `tmp_t`；mcs/mls 加 `:s0`。
```
tmpfs  /tmp  tmpfs  defaults,noexec,nosuid,rootcontext=system_u:object_r:tmp_t  0 0
tmpfs  /run  tmpfs  mode=0755,nosuid,nodev,rootcontext=system_u:object_r:var_run_t  0 0
```
systemd 会自动重打 `/tmp`、`/dev`、`/run` 标签，可省略上述条目。

### 切换 profile
- 先读 Profile (Portage) 切换文档。
- 切至 hardened/selinux profile：`default/linux/amd64/23.0/hardened/selinux`。

- 切换 SELinux profile：

```bash
eselect profile list
eselect profile set default/linux/amd64/23.0/hardened/selinux
```

- 切换后**不要立即重建或更新系统**，须等待文档后续指示；否则 SELinux 策略可能导致重启后不可达。
- 此后 Portage 每次安装会警告 `Unable to set SELinux security labels`，属正常，SELinux 安装完成后消失。
- 为 `sec-policy/selinux-base` 配置 USE（`/etc/portage/make.conf` 或 `package.use`）：

| USE | 作用 |
| --- | --- |
| `+ubac` | 启用基于用户的访问控制（UBAC） |
| `+unconfined` | 启用 unconfined SELinux 模块 |
| `+unknown-perms` | 内核比策略新时，默认允许未知类别 |
| `doc` | 附加文档，建议按包启用而非全局 |
| `systemd` | 启用 systemd 特定库与功能 |

- USE 更新位置：`/etc/portage/make.conf` 中的 `USE` 变量，或 `/etc/portage/package.use`。

- 标签即 SELinux 上下文，策略基于标签决策；常只提 type（如 `user_home_t`）。多数文件系统存于 xattr `security.selinux`；不支持时由挂载选项统一分配。

**查看标签**：
```bash
ls -lZ /etc/resolv.conf
semanage fcontext --list | grep repos
```

**重打标签**（按定义库重置）：
```bash
restorecon -Rv /etc/
rlpkg -a -r        # 整个文件系统
```

**临时改标签**：
```bash
chcon -t net_conf_t /etc/puppet-resolv.conf
```
易错：`chcon` 不更新定义库，之后 `restorecon` 会还原。

**永久改标签**：先更新定义库（PCRE 正则），再 restorecon：
```bash
semanage fcontext --add --type net_conf_t "/etc/puppet-resolv\.conf"
restorecon -R /etc/puppet-resolv.conf
```

**端口标签**：
```bash
seinfo --portcon=80
semanage port -l | grep http
```
仅当端口当前类型为 `reserved_port_t`/`unreserved_port_t`/`hi_reserved_port_t` 时可改：
```bash
semanage port -a -t http_port_t -p tcp 9980
```

**进程标签**：进程标签即 domain，由策略决定。

- 进程无法重贴标签；换域可试 `runcon` 启动，但多数被策略拒绝；域由策略决定（SELinux-aware 应用可少量配置）。
- 查看进程标签：`ps -eZ`，例：`ps -eZ | grep init` → `system_u:system_r:init_t`。
- 标签管理是 SELinux 管理员核心能力：决策基于标签，确保资源上下文正确是首要任务。

- SELinux 提供丰富的策略语言，用于定义和控制策略及强制行为。
- 关键资源：
  - 官方 wiki：`selinuxproject.org`（策略语句详解）
  - SELinux Notebook：`github.com/SELinuxProject/selinux-notebook`（策略语言权威参考，Richard Haines 原作，社区维护）

- **记录机制**：SELinux 拒绝且未设 `dontaudit` 时，经 audit 子系统记录 AVC 事件。
- **AVC 格式**：关键字段为 `{}` 内权限、`tclass=` 类别、`scontext=` 源、`tcontext=` 目标，如：`avc: denied { read } ... scontext=... tcontext=... tclass=file`。
- **拒绝原因**：多数缺访问向量规则；但 UBAC 等约束即使 `sesearch` 查到规则也可能拒绝。
- **auditd**：安装 `sys-process/audit` 并启用，日志在 `/var/log/audit/audit.log`。注意 2024-03-08 起 hardened/selinux profile 下 auditd 不可用，可 `audit2allow --why <<< "审计字符串"`。
- **查看拒绝**：`ausearch -m avc -ts recent`（10 分钟内），`-ts boot`（本次启动）。
- **清空日志**（不推荐）：`> /var/log/audit/audit.log`。
- **dontaudit**：`semodule -DB` 禁用，`semodule -B` 恢复。
- **临时允许**：Gentoo 可用 `selocal -a "..." -Lb`；或 `ausearch -m avc -ts recent | audit2allow -M myupdates` 后 `semodule -i myupdates.pp`。警告：多数拒绝应通过正确标记资源或使用合规角色解决，勿直接加规则。

- SELinux 依托 **LSM (Linux Security Modules)** 实现内核级强制访问控制。
- 系统调用等所有内核操作均经 LSM；SELinux 注册 LSM 钩子参与放行/拒绝决策。
- LSM 为安全模块框架，SELinux 是具体实例。

- SELinux 策略模块组成：策略规则 + 上下文声明 + 通过布尔值提供灵活性
- Gentoo 中部分模块提供 `*_selinux` 手册页及 wiki 文档
- 已文档化模块：apache、chromium、cron、bind、ldap、munin、portage

- SELinux 网络控制：**端口/套接字标记**、**SECMARK 包标记**、**Labeled IPSec/NetLabel**。
- 端口权限：连接检查 `name_connect`，绑定检查 `name_bind`。
- SECMARK：通过 iptables/nftables 给包打本地标签，启用 `packet` 类 `send`/`recv`；标签不跨主机。
```c
allow mozilla_t http_client_packet_t : packet { send recv };
```
- 端口标签：查看 `semanage port -l | grep 9001`；修改 `semanage port -a -t http_port_t -p tcp 9224`，删除 `semanage port -d -t http_port_t -p tcp 9224`（仅限未分配端口）。
- 查询域访问端口：`sesearch -t http_port_t -c tcp_socket -p name_bind --allow`。
- SECMARK iptables：列表 `iptables -t mangle --list`；添加示例：
```bash
iptables -t mangle -A INPUT -p tcp --src 192.168.1.2 --dport 443 \
  -j SECMARK --selctx system_u:object_r:myauth_packet_t
```
**易错点**：加载任意 SECMARK 规则即启用过滤；域未获准处理 unlabeled 包时，未打标签包可能被拒。

# SELinux 策略要点

- 策略包含所有强制访问控制规则，控制与定义分离，可分发到多系统。
- 完全封闭、模块化：基础策略 + 可加载模块；编译为二进制节省内存，版本随内核演进（v23 per-domain permissive、v31 InfiniBand、v33 优化 filename transition）。
- 类型由 `/etc/selinux/config` 的 `SELINUXTYPE` 定义：
  - `strict`：无 unconfined，默认拒绝，管理难
  - `targeted`：含 unconfined，默认允许
  - `mcs`：支持 category，适合多租户
  - `mls`：多级安全，实验性

## 策略操作（semodule）

```bash
# 重建策略
semodule -B

# 重新编译规则（重建 Gentoo 策略包）
emerge -1 $(qlist -IC sec-policy)

# 卸载/加载模块
semodule -r screen
semodule -i /usr/share/selinux/mcs/screen.pp

# 禁用 dontaudit，记录全部拒绝；-B 恢复
semodule -DB
semodule -B
```

## Gentoo 集成

- 自定义规则：`selocal -a "接口(域, 域)" -c "说明" -Lb`；`selocal -l` 查看。
- 例：`selocal -a "zabbix_admin(staff_t, staff_r)" -c "Enabling Zabbix administration" -Lb`
- 策略包：`sec-policy/selinux-*` 为各应用模块；`selinux-base` 为基础策略；`selinux-base-policy` 加载交叉依赖的附加模块。

- `selinux-base-policy` 包管理策略模块：`application`、`authlogin`、`staff` 等。
- 安装策略包后，策略编译为二进制模块（如 `screen.pp`）并加载到活动策略。
- **易错点**：加载操作在 `post-install`，而非 ebuild 安装阶段。原因是后续其他 SELinux 模块可能加载失败；若在 install 阶段加载，会导致更改回滚，应避免。

策略存储（Policy Store）

- 概念：策略存储 = 策略包 + 管理员修改，单一逻辑实体；可多存储并切换。
- 位置：`/etc/selinux/<存储名>`；预定义：`strict`、`targeted`、`mcs`、`mls`。
- 活动存储：由 `/etc/selinux/config` 的 `SELINUXTYPE` 指定。
- Gentoo 维护：`/etc/portage/make.conf` 的 `POLICY_TYPES` 决定所维护存储，默认：

```
POLICY_TYPES="strict targeted mcs mls"
```

切换 mcs → strict：

1. 确保 `POLICY_TYPES` 含新旧存储，重建全部策略包：`emerge -1 $(qlist -IC sec-policy)`
2. 切 permissive：`setenforce 0`
3. 改配置：`/etc/selinux/config` 中 `SELINUXTYPE=strict`；`/etc/selinux/sepolgen.conf` 中 `SELINUX_DEVEL_PATH` 指向新存储
4. 加载新存储模块：`cd /usr/share/selinux/strict && semodule -b base.pp -i $(ls *.pp | grep -v base.pp)`
5. 两阶段 relabel：先 `rlpkg -a -r`；再绑定挂载处理隐藏文件：`mount -o bind / /mnt/gentoo && setfiles -r /mnt/gentoo /etc/selinux/strict/contexts/files/file_contexts /mnt/gentoo/{dev,lib64} && umount /mnt/gentoo`
6. 调整 `/etc/fstab` 中 SELinux 挂载参数（如 mcs→strict 去掉末尾 `:s0`）
7. 重启，新存储以 enforcing 运行。

### SELinux 核心要点

- **DAC局限**：属主可自定权限，用户可共享/拷贝资源绕过管理员意图。
- **MAC**：SELinux 基于 LSM 钩子拦截调用，由管理员策略强制，用户无法绕过。检查顺序：先 DAC 后 SELinux；DAC 拒绝则 SELinux 不参与。
- **上下文**：格式 `用户:角色:类型[:敏感度]`，如 `user_u:user_r:user_t`（进程）、`system_u:object_r:lib_t`（文件）。SELinux 用户≠Linux 用户；多数规则只看类型。
- **策略**：默认拒绝，仅显式 `allow` 放行，如 `allow user_t bin_t:file { execute };`。策略与内核解耦，编译为二进制策略包，可动态加载，无需重编内核。
- **模型**：类型强制（TE）为主，另有 RBAC、User-based ACL、MLS。
- **访问向量**：四要素：源上下文、目标上下文、目标类别、操作，全部匹配才放行，如 `allow user_t lib_t : file { execute };`。
- **易错点**：策略用细分类型限制权限，如将 `bin_t` 细分为 `shell_exec_t`，使脚本仅能执行 shell 解释器，而非所有二进制。

### Labeling（标记）
- Labeling 为资源设置 context（文件 context 常称文件 label）；Relabeling 将文件 label 重置为正确值。

### Class（资源类别）
- SELinux 在 type 外支持大量 class，按资源类别区分权限；同一 type 的不同 class 权限隔离，与 Linux 传统 DAC 不同。
- 普通文件与 TCP socket 权限集不同：file 有 read/write/append/create/unlink 等；tcp_socket 有 connect/listen/accept/bind 等。
- 查看 class/perms：
```bash
ls /sys/fs/selinux/class
ls /sys/fs/selinux/class/file/perms/
ls /sys/fs/selinux/class/tcp_socket/perms/
```

### 策略开发
- class 与权限集庞大，策略开发工作量大；发行版默认集成 reference policy 项目维护的基础策略。

### RBAC（基于角色的访问控制）
- Role 是用户可佩戴的“帽子”：用户必被分配角色，在允许前提下可切换。
- 普通用户通常仅 user_r；管理员可拥有 staff_r（日常操作）与 sysadm_r（系统管理任务）。

## 参考策略

- **参考策略**：SELinux 社区维护的策略项目，提供 Linux 及应用的 SELinux 策略；严格审查新增 allow 规则，避免策略臃肿和过于宽松。
- **Gentoo 基础**：Gentoo 策略基于参考策略，`hardened-refpolicy` 仓库紧跟上游。Gentoo 补丁定期送上游审查并合并，减少本地维护、获得独立质量保证，也惠及其他基于参考策略的发行版。
- **增强策略规则**：
  - 为策略模块增加 Gentoo 特有部分时，仅在模块末尾追加，使上游补丁可通过 `git am` 直接应用。
  - 仅当 Gentoo 补丁超出简单追加（如处理用户内容，支持 XDG 内容类型）时，才修改模块主体。
- **资源**：参考策略项目：<https://github.com/SELinuxProject/refpolicy>

## RBAC 核心要点

**RBAC 模型**
- 权限只能通过角色授予，禁止直接赋给用户
- 用户必须显式获得角色；无角色即无权限
- 用于实现最小权限与职责分离

**SELinux 实现机制**
- Linux 用户 → 映射为 SELinux user（定义安全级别上限）
- SELinux user → 允许一个或多个角色（职责分离）
- 角色 → 允许特定 domain（应用运行时权限）

**关键点**
- SELinux user 不可变：角色需求不同的用户不能映射到同一 SELinux user，否则会获得不应有的角色
- 授权 domain 需更新策略，例如：

```
zabbix_admin(oper_t, oper_r)
```

允许 `oper_r` 的默认域 `oper_t` 管理 Zabbix（启停服务、编辑资源）。
- 两种授权方式：增强用户域权限，或允许角色转换到应用域（常用于应用授权）

**默认角色**

| 角色 | 用途 |
|---|---|
| user_r | 普通交互登录用户 |
| staff_r | 可转换其他角色（本身权限≈user_r） |
| sysadm_r | 通用系统管理 |
| system_r | 守护进程/系统服务 |
| object_r | 资源对象，不可分配 |

其他角色可通过策略创建。

## SELinux 状态
- 状态：`disabled`（禁用）、`permissive`（记录不强制）、`enforcing`（强制）；可指定特定域为 permissive。
- 启动：内核支持时默认 permissive（除非 `selinux=0`）；init 读 `/etc/selinux/config`：
  - `SELINUX=disabled` → 不加载策略。
  - `SELINUX=enforcing`/`permissive` → 加载策略；enforcing 且找不到策略则系统冻结。
  - 可用 `enforcing=0` 启动为 permissive。
- permissive：记录“将拒绝”事件，但不强制；SELinux-aware 应用可能自行拒绝。
- enforcing：强制策略。permissive domain：仅该域不受强制，系统其余 enforce。

配置修改后重启：
```ini
SELINUX=disabled|permissive|enforcing
```
临时切换：
```bash
setenforce 0   # permissive
setenforce 1   # enforcing
```
单次禁用：内核参数 `selinux=0`；查询：`sestatus | grep mode`。

permissive 域管理：
```bash
semanage permissive -l            # 列出
semanage permissive -a portage_t  # 添加
semanage permissive -d portage_t  # 移除
```

易错点：
- 禁用后文件标签不再维护，新建文件无标签；重新启用需 relabel。
- 不要靠禁用 SELinux 绕过权限问题；应查清策略拒绝原因。

# SELinux 类型强制（Type Enforcement）

## 核心概念
- 基于**主体-访问-客体**规则：明确允许即允许，未允许即拒绝（deny by default）。
- 主体=进程；访问=权限（read/open等）；客体=资源。规则单向，无逻辑条件。

## 机制
- 基于**标签**实施，如“标签为 user_t 的进程可执行 bin_t 的常规文件”，而非指定具体路径。
- **域**：进程标签，如 `named_t`（完整 `system_u:system_r:named_t`，通常简化）。SELinux 只看标签。
- **类型**：客体标签，即安全上下文第三字段。客体=标签+**类别（class）**，同类标签不同类别规则不通用：
  ```
  allow user_t bin_t:file read;
  allow user_t bin_t:lnk_file read;
  allow user_t bin_t:dir read;
  ```
- **属性**：分组域/类型，规则可定义在属性上，如 `allow userdomain bin_t:file execute;`
- 查看属性包含的类型：`seinfo -auserdomain -x`
- 查看 file 类权限：`ls /sys/fs/selinux/class/file/perms`（输出含 append/create/execute/read/write/ioctl/lock 等；未知权限策略可允许/拒绝，Gentoo 默认拒绝）

## 易错点
- 域=进程标签，类型=客体标签，但安全上下文第三字段统称 type。
- 决策只看标签与类别，忽略进程身份、路径等。
- 类别不同则规则不通用，file/lnk_file/dir 需分别定义。

- SELinux 默认策略为 **deny by default**，要求所有客体都被策略建模。`unconfined domains` 是一种仍被 SELinux 管理、但被授予几乎全部权限的常规域，用于简化部署。
- 非受限用户：映射到 SELinux 用户 `unconfined_u`，角色 `unconfined_r`，默认类型 `unconfined_t`，所有动作在该类型中执行，拥有全量权限。
- 非受限用户配置示例：

```bash
# semanage login -a -s unconfined_u john
```

- 查看映射到 `unconfined_u` 的所有 Linux 用户：

```bash
# seinfo -u unconfined_u -x
```

- 非受限应用/守护进程域：通过 `unconfined_domain` 接口扩展，并被标记属性 `unconfined_domain_type`。
- 查询所有具有该属性的域（即广泛特权但仍受 SELinux 管理的服务）：

```bash
# seinfo -a unconfined_domain_type -x
```

- 易错点：非受限并非完全脱离 SELinux，只是权限极大；安全性低于受限域，但免去为每个应用编写策略的负担。

### SELinux 用户访问控制（UBAC）

- UBAC 是 SELinux 在类型强制（TE）和基于角色的访问控制（RBAC）之上增加的约束，用于强制用户间隔离，弥补 DAC 权限（如 `chmod 777`）被放宽的风险。
- 问题：SELinux 按域/类型授权，不区分不同 Linux 用户。所有普通用户进程都在 `user_t` 域，如下规则会允许所有用户读取所有 `user_home_t` 文件（只要 DAC 允许）：
  ```text
  allow user_t user_home_t:file read_file_perms;
  ```
- 为每个用户单独创建角色/类型不现实。

- 解法：启用可选的 UBAC 约束，基于 SELinux 用户身份（而非域类型）限制交互。
  - 核心约束：域与资源交互仅当满足以下任一条件：
    1. 双方 SELinux 用户相同；
    2. 任一方为 `system_u`；
    3. 任一方没有 `ubac_constrained_type` 属性。
  - 因此：只有将不同 Linux 用户映射为不同 SELinux 用户，才能阻止互访；相同 SELinux 用户（如 `user_u`）之间仍可按策略互读（受 DAC 限制）。

- 管理要点：
  - 为每个 Linux 用户创建独立 SELinux 用户是管理操作，可行。
  - UBAC 不能按用户单独豁免；豁免按域级别，例如 `sysadm_t` 域对文件、文件描述符和进程有 UBAC 豁免。

SELinux 用户是安全上下文的第一部分，固定不可由用户自行更改；其作用是审计与限制权限。Linux 账号通过“登录映射”绑定到唯一 SELinux 用户；但一个 SELinux 用户可对应多个 Linux 账号，并可关联多个角色，角色再决定可执行的域。

常见 SELinux 用户：

- `unconfined_u`：无限制（targeted 策略下默认映射给所有用户）
- `root`：仅用于 root 账号
- `sysadm_u`：纯管理账号
- `staff_u`：可同时运行普通与管理命令（在 `staff_r`/`sysadm_r` 间切换）
- `user_u`：非特权账号
- `system_u`：系统服务专用，不直接对应登录

## 登录映射管理（`semanage login`）

- 列出：`semanage login -l`
  - `__default__` 为回退映射，未匹配的登录名使用它
  - 登录名以 `%` 开头则匹配组，如 `%users` 匹配主组为 `users` 的用户
- 新增：`semanage login -a -s staff_u darcia`
- 修改：`semanage login -m -s sysadm_u darcia`
- 删除：`semanage login -d darcia`（回退到 `__default__`）
- MLS 系统可用 `-r` 指定安全级/范围，如 `-r s0-s0:c0.c100`

## SELinux 用户管理

- 查看：`semanage user -l`（列出用户及绑定角色；MLS 下含 sensitivity/clearance）
- 用户不能获得高于其 SELinux 用户所设的 clearance，但映射可单独设更低值

## 易错点

- Linux 用户只能映射到一个 SELinux 用户，修改映射后若 SELinux 用户变化，必须重贴文件标签，且先让该用户退出登录：

```bash
restorecon -RF /home/darcia
```

**SELinux 用户管理**

`semanage user -l` 查看用户列表。关键字段：Labeling Prefix（标签前缀）、MLS/MCS Level/Range、SELinux Roles。

默认用户：`root`(sysadm)、`staff_u`、`sysadm_u`、`system_u`、`unconfined_u`、`user_u`。其中 `user_u` 仅 MLS 级别 `s0`，无 Range，受限最严。

**创建自定义用户**

```bash
semanage user -a -R "staff_r dbadm_r" swift_u
```

- `-R` 指定角色集，多个角色用空格分隔
- `_u` 后缀非强制，但属最佳实践
- MLS 系统可加 `-r` 指定许可范围：

```bash
semanage user -a -R "staff_r dbadm_r" -r s0-s0:c0.c100,c201 swift_u
```

**修改用户**

```bash
semanage user -m -R "staff_r dbadm_r webadm_r" swift_u   # 改角色集
semanage user -m -r s0-s0:c0.c50 swift_u                  # 改 MLS 范围
```

**删除用户**

```bash
semanage user -d swift_u
```

易错点：删除前必须更新所有指向该 SELinux 用户的登录映射，并重新标记（relabel）其拥有的资源，否则资源归属失效。

**总结**：通过 SELinux 用户与登录映射，可对用户权限施加额外约束。

- Gentoo 为**滚动发布**，无版本升级概念，靠频繁增量更新保持系统最新。
- **更新频率**：建议每日至每周一次；多次同步勿超每日一次，避免服务器压力。
- 核心更新流程：先同步仓库，再更新系统包。

```bash
# 同步 Gentoo 仓库（emaint 短选项 -a）
root #emaint --auto sync
```

- 同步后**必须阅读并遵循** news items 及 Portage 输出信息。
- 更新全部已装包（含依赖）：
```bash
root #emerge --ask --verbose --update --deep --newuse @world
# 短选项
root #emerge -avuDN @world
```

**关键参数/易错点：**
- `--newuse`：根据当前 USE 变化重编译；若不用二进制包，可换 `--changed-use`（不会因禁用 USE 变化而重装）。
- `--with-bdeps=y`：同时更新构建时依赖。
- 依赖冲突时用 `--backtrack=30`（或更高）提高解析深度。
- 大量未解析依赖时，可试 `--emptytree`；但正常输出时**勿用**——过度且极慢，应拒绝并重跑无此选项的命令。
- 更新结束后**留意 Portage 提示**（部分见 Portage 日志），可能有需手动干预的变更。
- 配置更新用：
```bash
root #dispatch-conf
```

#### 更新后清理
- Portage 建议更新后运行 `emerge --depclean`，但务必谨慎：可能删除内核源码、虚拟包可选依赖等重要包。
- 孤立包的安全清理方法参见官方文档。

#### Profile 更新
- 新 profile 可用时，Portage 通过 news item 通知；旧 profile 仍可用，但若被弃用，建议更新（开发者不再支持）。
- 切换前必须：
  - 阅读 Profile 变更文档；
  - 切到 systemd profile 前阅读 systemd 文档；
  - 同步主 Gentoo 仓库（Portage tree）。
- 更新为手动操作，差异很大：
  - 简单：用 `eselect` 修改 `/etc/portage/make.profile` 符号链接；
  - 复杂：重新编译整个系统并重新配置。
- 具体迁移步骤以对应 news item 为准。
- 系统过旧时可能难以升级，必要时重装。

#### 子 profile
- 多数架构提供 `desktop` 子 profile，比默认最小 profile 更合适。
- `developer` 子 profile 仅用于 Gentoo 开发任务，非通用开发环境。

#### 切换命令
- 使用 `app-admin/eselect` 自动切换 profile。

- **USE flags** 是 Gentoo 核心特性：表示对某概念的支持与依赖信息，决定包安装/更新时的编译选项、链接库、包含文件等。
- 每个包有各自可用 USE flags；默认值由 profile 和 ebuild 提供，最终按 `USE_ORDER` 优先级覆盖。
- 状态：**set / unset / default**。全局在 `/etc/portage/make.conf` 的 `USE` 变量；对单个包在 `/etc/portage/package.use`。
  - 写入 flag → set
  - 写入 `-flag` → unset
  - 不写 → 用默认值
- 建议**按包设置**（`package.use`），避免全局设置；默认值通常合理。
- ⚠️ 不要用命令行环境变量临时设置（如 `USE="..." emerge -av <package>`），升级或重装后会丢失。

常用命令：

```bash
# 查看当前启用的 USE flags
portageq envvar USE | xargs -n 1

# 查看默认启用的 USE flags
USE_ORDER="defaults:pkginternal:repo" emerge --info | grep USE

# 检查某个 flag 是否启用、被哪些包使用
euse -I <use_flag>        # app-portage/gentoolkit
quse <use_flag>           # app-portage/portage-utils
eix --installed-with-use <use_flag>   # app-portage/eix
```

- 查看完整依赖与 USE 标志：`root # emerge --ask --verbose chromium`
  显示依赖解析、各包 USE/L10N 等，确认后合并。
- 仅查单包 USE，不递归依赖：`user $ emerge --nodeps --pretend chromium`
- USE 标志在括号 `()` 中表示强制、屏蔽或移除，来源为 profile 或架构。需分析 profile 文件（如 `profiles/base/package.use.stable.mask`）。
- 若认为屏蔽有误：在 `package.accept_keywords` 中加入该包（不带标志）尝试取消屏蔽；但若屏蔽正确，可能导致构建损坏或无效果。
- emerge USE 相关选项：
  - `--changed-use` (`-U`)
  - `--complete-graph-if-new-use < y | n >`
  - `--newuse` (`-N`)
  详见 `man 1 emerge`。
- 本地 vs 全局 USE 标志：技术区别仅在于描述在 ebuild 仓库中的存储位置（全局在 `use.desc`，本地在 `use.local.desc`）。

---
来源：consolidated/security/SELinux 与强制访问控制.md