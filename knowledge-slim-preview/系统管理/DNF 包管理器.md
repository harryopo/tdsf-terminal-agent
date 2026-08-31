---
source: dnf-docs
category: sys-admin
url: consolidated/sys-admin/DNF 包管理器.md
title: DNF 包管理器
---

- `dnf install/remove/upgrade`；`-y`
- 配置：`/etc/dnf/dnf.conf`、`/etc/yum.repos.d/*.repo`
- 易错：`--enablerepo`配`--disablerepo`

`dnf.Base`：DNF 核心类，有状态，用后 `close()`（或 `with`）释放；成功事务后 `close()` 删除已下载包。

关键属性：
- `conf`：`dnf.conf.Conf`，全部配置项
- `repos`：`RepoDict`，可用仓库，含 `add_new_repo()`
- `sack`：包数据源，需 `fill_sack()` 初始化
- `goal`：`dnf.goal.Goal`

关键方法：
- `__init__()`：无参
- `fill_sack()`：加载 RPMDB/仓库；耗时；之前须设置 `conf.cachedir` 与 `conf.substitutions`
- `add_remote_rpms()`：向 sack 加 RPM；须在操作 `goal` 前调用；strict=True 时 IO 错误抛 `IOError`
- `add_security_filters()`：安全过滤；`cmp_type` 仅 `eq`/`gte`
- `close()`：关闭句柄；上下文管理器自动调用

示例：
```python
import dnf
base = dnf.Base()
conf = base.conf
conf.cachedir = '/tmp/my_cache_dir'
conf.substitutions['releasever'] = '30'
conf.substitutions['basearch'] = 'x86_64'
base.repos.add_new_repo('my-repo', conf,
    baseurl=["http://.../$releasever/Everything/$basearch/os/"])
base.fill_sack()
for repo in base.repos.iter_enabled():
    print(repo.id, repo.baseurl)
```

易错点：
- `add_remote_rpms` 须在操作 `goal` 前调用
- 仓库配置变更后重新 `fill_sack()`
- `close()` 后不可再用

- `fill_sack_from_repos_in_cache(load_system_repo=True)`：从缓存加载所有启用仓库，不下载、不检查过期；`load_system_repo`控制是否加载系统仓库。需`repomd.xml`+元数据(xml/yaml)或`repomd.xml`+solv/solvx缓存，不足时按`skip_if_unavailable`跳过或抛`dnf.exceptions.RepoError`。额外元数据可选；`updateinfo.xml`生成solvx（xml/solvx任一即可）；`modules.yaml`不处理（声明则须存在）。易错：缓存按源识别，手动创建`dnf.repo.Repo`时`metalink/mirrorlist/baseurl`须与创建缓存时一致，否则找不到缓存。

- `do_transaction(display)`：执行已解析事务；`display`为`dnf.callback.TransactionProgress`实例或其序列；可能抛`Error`或`TransactionCheckError`。

- `download_packages(pkglist, progress=None, callback_total=None)`：仅下载远程仓库的包（本地仓库或命令行包不下载）；`progress`为`DownloadProgress`；`callback_total`接收`(总字节数, 开始时间epoch秒)`；部分失败抛`DownloadError`。

- `group_install(group_id, pkg_types, exclude=None, strict=True)`：标记组及其包为安装，返回标记安装的包数；`pkg_types`为字符串序列（如mandatory/default/optional）；`exclude`排除包，`strict`控制严格模式。

- `--skip-broken`：install 时相当于 `--setopt=strict=0`；upgrade 默认跳过。
- `dnf update` 与 `upgrade` 相同，推荐 `upgrade`。
- `clean_requirements_on_remove` 默认开：remove 常移除更多包。
- `resolvedep` 改用 `dnf provides`。
- `deplist` 改用 `dnf repoquery --deplist`（`yum deplist` 仍兼容）。
- 排除规则作用于所有操作，如：`dnf -x '*flask*' list installed 'python-f*'`。
- 配置文件不再支持 `include`。
- `dnf provides /bin/<file>` 不适用，需用实际路径如 `/usr/bin/<file>`。
- `skip_if_unavailable` 可能默认启用，避免第三方仓库中断。
- `overwrite_groups` 已移除，同组 ID 自动合并。
- `mirrorlist_expire` 移除，由 `metadata_expire` 控制。
- `mirrorlist` 不再自动识别 “metalink”。
- `alwaysprompt`、`upgrade_requirements_on_install` 已移除；升级直接 `dnf upgrade`。
- `history rollback` 不再失败，无需 `force`。
- 替换包：`dnf --allowerasing install B`（等价于 `yum swap`；DNF 用 `dnf swap A B`）。
- depsolving 细节不再输出到 CLI。

- DNF 不显示依赖解析细节：depsolver 始终考虑所有依赖，输出冗长；YUM 在大事务中同样混乱。
- `dnf provides` 不模仿 YUM 的 PATH 启发式。应显式指定路径或通配符：
  ```bash
  dnf provides /usr/bin/sandbox
  dnf provides '*/sandbox'
  ```
- 带宽限制：支持 `throttle`、`bandwidth`；多下载并发时总速度受限（YUM 因多进程无法实现）。
- `installonlypkgs`：DNF 将配置值追加到默认值；YUM 用配置覆盖默认值。
- Delta RPM：布尔选项 `deltarpm` 控制；不支持 `deltarpm_percentage`，自动选择最优 DRPM/RPM 比例。
- 安装本地 `.srpm` 或不存在包时，DNF 直接报错终止，不继续执行其他安装；YUM 仅警告。
  ```bash
  $ dnf install fdn-0.4.17-1.fc20.src.rpm tour-4-6.noarch.rpm
  Error: Will not install a source rpm package (fdn-0.4.17-1.fc20.src).
  ```
- 不会将安装 X 自动替换为 obsoletes X 的 Y（YUM 在 `obsoletes` 启用时可能替换，该行为未文档化且有风险）。
- `--installroot`：路径处理更可预测。`--config` 路径始终相对宿主系统（YUM 会与 installroot 组合）；若 reposdir 某路径在 installroot 内存在，则仓库严格从 installroot 读取。
- 事务表显示后仅询问是否继续，不提供下载功能；YUM 可继续下载。

## DNF-2 与 DNF-1 差异核心知识点

### CLI 变更
- 配置选项 `include`/`exclude` 被 `includepkgs`/`excludepkgs` 取代（与 YUM 兼容）
- 组安装可选包：由子命令 `with-optional` 改为选项 `--with-optional`

### Python API 变更
- 文档化模块的非 API 方法与属性全部变为私有
- 以下 API 方法参数发生变化：
  - `dnf.Base.add_remote_rpms()`
  - `dnf.Base.group_install()`
  - `dnf.cli.Command.configure()`
  - `dnf.cli.Command.run()`
  - `dnf.Plugin.read_config()`

## DNF hook API 变化

- 与 YUM 不一一对应；部分合并/重命名，部分无替代。
- 关键映射：
```text
config/postconfig/init → init
postreposetup → sack
exclude → resolved
postresolve → resolved but no re-resolve
pretrans → pre_transaction
postrans/close → transaction
```
- YUM 的 `predownload`、`postdownload`、`prereposetup`、`preresolve`、`clean` 在 DNF 中无对应。
- 缺失功能需提交 RFE。

- DNF 基于 Python 标准 `logging` 模块，提供三个标准 logger：
  - `dnf`：核心与 CLI 使用；消息可输出至 stdout；`INFO` 及以上级别需本地化
  - `dnf.plugin`：插件调试用；不写 stdout，仅写入 DNF 日志文件
  - `dnf.rpm`：RPM 事务回调用；插件/扩展不得改动
- 扩展/插件可自行增删这些 logger 的 handler

### Comps（发行版元数据）
- `dnf.comps.Comps`：合并所有仓库的 comps 信息，通常由 `dnf.Base` 实例化。
- 属性：
  - `categories`：全部 `Category` 对象列表
  - `environments`：全部 `Environment` 对象列表，按 `display_order` 排序
  - `groups`：全部 `Group` 对象列表，按 `display_order` 排序
- 匹配：`*_by_pattern(pattern, case_sensitive=False)`，匹配名称/ID，支持通配符；`case_sensitive=True` 区分大小写。
  - 单数（如 `group_by_pattern`）：返回对象或 `None`
  - 复数（如 `groups_by_pattern`）：返回可迭代对象，按 `display_order` 排序
- 迭代：`categories_iter()` / `environments_iter()` / `groups_iter()`，按 comps.xml 出现顺序返回。

### Package 类
- `dnf.comps.Package`（comps 包数据）≠ `dnf.package.Package`（Sack 实际包）；comps 包可能在 sack 中无对应、有一个或多个同名包。
- 属性：`name`（包名）、`option_type`（组内包含类型）。

### Category / Environment / Group
- 共同属性：`id`、`name`、`ui_name`（当前 locale 翻译）、`ui_description`。
- `Group` 额外方法：`packages_iter()`。

### 包含类型常量
```python
dnf.comps.CONDITIONAL
dnf.comps.DEFAULT
dnf.comps.MANDATORY
dnf.comps.OPTIONAL
```

- `dnf.Base` 配置存于 `dnf.conf.Conf`，对应 `[main]`。
- 代理：
  ```python
  import dnf
  base = dnf.Base()
  conf = base.conf
  conf.proxy = "http://the.proxy.url:3128"
  conf.proxy_username = "username"
  conf.proxy_password = "secret"
  base.read_all_repos()
  base.fill_sack()
  ```
- 方法：
  - `get_reposdir()`、`exclude_pkgs()`、`prepend_installroot()`
  - `read()`：读 `main` 节，默认写回 `config_file_path`
  - `dump()`、`set_or_append_opt_value()`（按优先级设/追加）、`write_raw_configfile()`
- `substitutions`：
  - 键：`arch`、`basearch`（自动）、`releasever`（默认 `None`）
  - 覆盖后需 `fill_sack()`；`update_from_etc()` 读 `/etc/yum/vars/`、`/etc/dnf/vars/`
- 易错：`read()` 仅读 `main`；`releasever` 默认未设；低优先级不能覆盖高优先级。

# dnf-automatic

DNF 自动升级工具，用法：`dnf-automatic [配置]`，默认 `/etc/dnf/automatic.conf`。流程：同步元数据→检查更新→退出/下载/安装，结果经 stdio/email/motd 报告。

## systemd timer
- 对应专用单元：`dnf-automatic-notifyonly.timer`（仅通知）、`dnf-automatic-download.timer`（仅下载）、`dnf-automatic-install.timer`（下载并安装）。
- 启用：`systemctl enable --now dnf-automatic-install.timer`

## [commands] 关键项
- `apply_updates`（默认 False）：安装更新，隐含 `download_updates`。
- `upgrade_type`：`default`（全部）/ `security`（仅安全）。
- `reboot`：`never` / `when-changed` / `when-needed`。
- `random_sleep`：下载前随机延迟上限（秒）；注意 timer 默认另有最长 1h 随机延迟。
- `network_online_timeout`（默认 60s，0 跳过）。
- `systemd_inhibit`（默认 True）：阻止关机，容器内无效。

## [emitters]
- `emit_via`：默认 `email, stdio, motd`。

`dnf [options] <command> [<args>...]` — RPM 系包管理器，兼容 YUM CLI，支持插件。

返回码：0 成功；1 错误已处理；3 未处理错误；100 有可用更新（check-update）；200 锁获取/释放失败。

插件虚拟提供：`dnf-command(<alias>)`，如 `install 'dnf-command(versionlock)'`。

常用命令：install, remove, upgrade, downgrade, autoremove, reinstall, distro-sync, check-update, clean, history, info, list, makecache, group, module, provides, repolist, repoquery, search, updateinfo, upgrade-minimal

关键选项：
- `-4`/`-6`：仅 IPv4/IPv6
- `--allowerasing`：允许删除已装包解决依赖
- `--assumeno`：所有问题自动答 no
- `--best`：升级时只考虑最新版本，依赖问题则报错
- `-C`：仅用系统缓存，不更新元数据
- `--disablerepo=<repoid>`：临时禁用仓库，支持逗号/glob，与 `--repo` 互斥
- `--downloadonly`：只下载 rpm，不执行事务
- `--downloaddir=<path>`：配合 `--downloadonly` 指定下载目录
- `--advisory/--bugfix/--bz/--cve`：按公告/Bugzilla/CVE 过滤
- `--disableplugin=<names|globs>`：禁用插件

易错点：
- `--best` 只保证直接请求的包用最新版，依赖可能用旧版
- 普通用户可用 `-C` 只读访问 root 系统缓存，通常更新鲜
- 插件命令需先安装对应的 `dnf-command(<alias>)` 包

- 包在事务成功后移除；与 `--destdir` 同用时目录视为缓存，不保留包；需保留用 `download`。
- `-e <level>, --errorlevel=<level>`：错误输出级别，默认3；已弃用，用 `-v`。
- `--enable, --set-enabled`：启用仓库（自动保存），须配合 `config-manager`。
- `--enableplugin=<plugins>`：按名称/glob 启用插件。
- `--enablerepo=<repoid>`：临时启用仓库，支持 id、逗号列表或 glob，可多次。
- `--enhancement`：包含增强包；适用于 `install`、`repoquery` 等。
- `-x, --exclude=<pkg-spec>`：排除包；`--excludepkgs` 已弃用。
- `--forcearch=<arch>`：强制架构，非原生架构需模拟。
- `-h, --help`：显示帮助。
- `--installroot=<path>`：指定替代安装根（类似 chroot）。配置文件/`reposdir` 先搜 installroot，否则取宿主；命令行 `--config`/`--setopt=reposdir=` 相对宿主；vars 来源依据 `reposdir`；pluginpath 相对宿主。
- 易错点：创建 installroot 时需加 `--releasever=<release>`，否则 `$releasever` 从空 rpmdb 取，事务失败；`--releasever=/` 可从宿主检测。模块系统建议加 `--setopt=module_platform_id=<模块:流>`。

```bash
dnf --installroot=<path> --releasever=<release> install <pkg>
# 模块系统追加：--setopt=module_platform_id=<module_name:stream>
```

## DNF 配置参考

### 配置文件与格式
- 全局：`/etc/dnf/dnf.conf`；仓库：`/etc/yum.repos.d/*.repo`（仓库优先）
- INI 格式；`[main]` 唯一，仓库节 repo ID 须唯一（字母数字 `-_.:`）
- 最小仓库：repo ID + `baseurl`/`metalink`/`mirrorlist` 之一

### 常用易错点
- `best=True` 只用最高版本，否则失败；默认 `False`
- `skip_if_unavailable` 可被发行版覆盖
- `allow_vendor_change` 默认 `True`；不支持 downgrade/distro-sync
- `assumeyes` 全自动 Yes；`defaultyes` 默认 Yes 仍提示；`assumeno` 全 No
- `clean_requirements_on_remove` 默认 `True`；`installonlypkgs` 不自动删
- `exclude_from_weak` 阻止弱依赖安装；`exclude_from_weak_autodetect` 默认 `True`
- `cacheonly` 仅用缓存；必须在创建仓库对象前设置（插件 `pre_config` hook）
- `check_config_file_age` 默认 `True`，配置新于元数据则过期
- `arch`/`basearch` 覆盖架构检测，常与 `ignorearch` 搭配
- `debuglevel` 0–10 默认 2；`errorlevel` 0–10 默认 3（弃用）
- `gpgkey_dns_verification` 需 `python3-unbound`，默认 `False`
- `group_package_types` 控制组包类型

- `group_package_types`：`groupinstall` 安装组内包类型，取值 `optional/default/mandatory`，默认 `default, mandatory`
- `ignorearch`：布尔，默认 `False`；`True` 允许安装与 CPU 架构不兼容的包，常与 `arch` 联用
- `installonlypkgs`：列表，仅安装不升级的包（如内核）；即使作为依赖装入，`dnf autoremove` 也不移除；追加到 DNF 默认列表
- `installonly_limit`：整数，允许并发安装的 installonly 包数量；默认 `3`，最小 `2`，`0` 不限；**禁止设为 `1`**（妨碍内核升级保护）
- `installroot`：字符串，所有打包操作的文件系统根目录，必须是绝对路径
- `install_weak_deps`：布尔，默认 `True`；安装新包时拉取弱依赖（Recommends/Supplements）关联的包
- `keepcache`：布尔，默认 `False`；`True` 保留下载的包缓存；即使 `False`，未安装的包也保留到下次成功事务
- 日志：`logdir` 默认 `/var/log`；`logfilelevel` 默认 `9`，设 `10` 才影响 `dnf.librepo.log`/`hawkey.log`；`log_compress` 默认 `False`；`log_rotate` 默认 `4`，`0` 不轮转；`log_size` 默认 `1M`，单位 `k/M/G`，`0` 不轮转
- `metadata_timer_sync`：秒，两次 `makecache timer` 最小间隔；默认约 3 小时；`0` 禁用自动同步；不影响手动 `makecache`
- `module_obsoletes`：布尔，默认 `False`；是否应用模块化 obsoletes
- `module_platform_id`：字符串，`$name:$stream` 格式，覆盖 `/etc/os-release` 的 `PLATFORM_ID`

## DNF 发布说明核心要点

**兼容性与弃用**
- 4.25.0 识别 Elbrus2000 架构（`e2k`、`e2kv4-v6`），映射为 `e2k` 基架
- 4.24.0 起最低要求 libdnf 0.75.0；modularity 支持（含 `module` 命令）已弃用；不再支持 RHEL ≤ 7 构建

**Bootc/OSTree 系统**
- 4.24.0 起事务的 persistent/transient 标志存入历史库，`dnf history info` 可见
- 临时事务前检测可能冲突的变更文件，路径由 `usr_drift_protected_paths` 配置，默认：
  ```
  glob:/etc/dnf/usr-drift-protected-paths.d/*.conf
  ```
  注意：设置该选项后 filelists 总是被下载
- 4.23.0 新增 `--transient`；4.22.0 允许只读 bootc 系统使用 `--installroot`、`--downloadonly`

**新命令行选项（4.23.0）**
- `--releasever-major`、`--releasever-minor`：显式覆盖 releasever 变量

**关键修复**
- 4.20.0 修复 `dnf repoquery -f` 未加载 filelists（RhBug:2276012）
- 多版本共存包（如 kernel）取最新 changelog 日期
- `dnf-automatic` 修正 `releasever_minor` 变量检测
- 4.22.0 向用户打印 rpm 包解包错误

**其他**
- 4.21.0 检测 ostree 系统并警告变更会丢失
- 4.19.1 支持 `RPMTRANS_FLAG_DEPLOOPS`；libdnf 要求提升至 0.73.1
- 日志轮转时保留 ACL（4.25.0）

# DNF 4.17–4.19 核心变更

## 4.19.0
- 默认不加载 filelists；`optional_metadata_types=filelists` 按需加载。
- Fedora 40+ 默认 `deltarpm=False`。
- 自动为需要 filelists 的命令加载元数据，CLI 提示事务文件依赖失败。
- 修复：`add_security_filters` 替代 `_update_security_filters`。

## 4.18.2
- automatic 支持出错时 emitter。
- 修复 `gpgkey_dns_verification=yes` 误报“密钥已撤销”。

## 4.18.1
- 修复 repoquery 时间格式被翻译导致 `fedora-update-feedback` 异常。
- 修复 automatic 的 `color` 选项无效。

## 4.18.0
- 支持 `$releasever_major`/`$releasever_minor`。
- 默认不打印 “Verifying”。
- obsoletes 仅考虑最新包，避免 systemd-udev 误解析。
- 修复 `dnf group remove` 误删、`distro-sync` 误报。
- 允许 DNF5 移除 DNF（`dnf5` 不再受保护）。

## 4.17.0
- 密码学改用 libdnf crypto API（不再依赖 GnuPG/GpgME）。
- automatic 支持 STARTTLS/TLS，可用 `email_port` 指定端口。
- 恢复保护 `dnf`，取消保护 `python3-dnf`。

## 易错点
- Fedora 40+ 显式 `deltarpm=False`（4.19 已默认）。
- 依赖 filelists 的命令（如 `repoquery --file`）需 `optional_metadata_types=filelists`。

- 核心：按特性装包。特性可指定：精确包、RPM、配置文件/解释器/扩展/可执行文件、包组。例：`hawkey-0.5.3-1.fc21.i686`、`/etc/yum.repos.d/fedora.repo`、`ruby(runtime_executable)`、`python3-dnf`、`*/binaryname`、`@kde-desktop`。仅缺失时安装最新且不冲突的包；任一失败则整体失败。

- CLI：`dnf install "hawkey-0.5.3-1.fc21.i686" "@kde-desktop"`

- 插件 API：
  - 继承 `dnf.cli.Command`，注册 `aliases`；`configure()` 中声明需求：
    ```python
    self.cli.demands.available_repos = True
    self.cli.demands.sack_activation = True
    self.cli.demands.resolving = True
    self.cli.demands.root_user = True
    ```
  - 安装：`base.install(spec)`（缺失抛 `MarkingError`，需捕获）；远端 RPM：`base.add_remote_rpms(filenames, strict=False)` + `base.package_install(pkg, strict=False)`
  - 组：先 `base.read_comps(arch_filter=True)`，再 `base.group_install(group.id, ['mandatory','default'])`

- 扩展 API：直接构造 `FTR_SPECS`、`RPM_SPECS`、`GRP_SPECS`、`MODULE_SPEC` 后调用 dnf 接口。

- 易错点：捕获标记异常；组必须先读 comps；需仓库可访问且 root。

## dnf.Base 程序化安装流程

- 核心顺序：`detect_releasever` → 设置 `substitutions` → `read_all_repos()` → `fill_sack()` → `install()` / `package_install()` → `resolve()` → `download_packages()` → `do_transaction()`
- 分组安装：`read_comps(arch_filter=True)` + `group_install(group.id, ['mandatory','default'])`
- 需捕获：`MarkingError`、`DepsolveError`、`DownloadError`

## dnf list 包过滤

- 关系过滤：`installed`、`available`、`extras`、`obsoletes`、`recent`、`upgrades`
- 示例：`dnf list installed *debuginfo`、`dnf list available gtk*devel`
- 插件：`@dnf.plugin.register_command`；`configure()` 设 `demands.available_repos=True`、`sack_activation=True`；查询 `base.sack.query().installed()` / `q.filter(obsoletes=inst)`

## FAQ 要点

- DNF = Dandified YUM；与 YUM 事务数据不共享，`autoremove` 保守
- 迁移：`dnf install python-dnf-plugins-extras-migrate && dnf-2 migrate`
- 兼容：`dnf-yum` 提供 `/usr/bin/yum`，但与 `yum` 包冲突
- 脚本卸载失败：`rpm -e <pkg> --noscripts`（打包错误，报维护者）

## DNF 常见问题与异常

- `dnf check-update` 不做依赖解析；`dnf upgrade` 才解析。查原因：`dnf upgrade --best`。强制移除冲突包：`dnf upgrade --best --allowerasing`。
- DNF 与 YUM 结果不同：多为元数据时间不同或 depsolver 差异；相同元数据下 DNF 拒绝才为真问题。
- 强制刷新：`dnf clean metadata && dnf upgrade` / `dnf upgrade --refresh`。设 `/etc/dnf/dnf.conf` 中 `metadata_expire=0`。
- 禁用自动同步：dnf.conf 加 `metadata_timer_sync=0`。
- 非 root 可运行 DNF（取决于配置）。
- 稳定版装 rawhide：`dnf install fedora-repos-rawhide`，`dnf --enablerepo=rawhide upgrade rpm`；不推荐。
- Fedora 40+ 不下载 filelists：包不得依赖 filepath 依赖；提供路径参数时自动下载所需 filelists。恢复用 `optional_metadata_types`。
- 异常：`Error` 基类；`CompsError` 组；`DepsolveError` 依赖；`DownloadError` 下载；`MarkingError` 无匹配；`MarkingErrors` 分类错误（`no_match_pkg_specs`、`error_pkg_specs`、`no_match_group_specs`、`error_group_specs`、`module_depsolv_errors`）；`RepoError` 仓库加载。

## 模块化

- 已弃用，DNF5 将移除
- 仓库可含 `modulemd`（`Name`、`Stream`、包列表）；模块包带 `%{modularitylabel}` 头；流以 `Name:Stream` 标识，同模块仅一个流 `active`
- 过滤：无模块时选最高版本；非模块包名/`provide` 匹配启用/默认/依赖流模块包名即被过滤
- 热修复：`.repo` 设 `module_hotfixes=true` 避免过滤；不覆盖模块包，按 `Epoch`/`Version`/`Release` 定版本
- Fail-safe：元数据不可用时保留活动流最新 `modulemd` 副本维持过滤；孤儿模块包（无 `modulemd`）禁装/禁升级

## 软件包 API

`dnf.package.Package` 对应 RPM 包。属性：

- `arch`、`baseurl`、`description`、`epoch`、`evr`、`files`
- `chksum`：仅仓库包返回 `(校验和, 类型)`（`@pkgid`）；已安装/命令行仓库不返回
- `conflicts`、`enhances`：依赖关系列表
- `debug_name`：debug-info 包名
- `from_repo`：已安装包来源仓库 id，无则空串

## dnf.package.Package 核心属性

- 基础：`name`/`version`/`release`、`installed`、`reponame`（已装=`@System`）
- 依赖（`Hawkey.Reldep`）：`requires`含`requires_pre`；`requires_pre`已装含`%pre/%post/%preun/%postun`，未装仅`%pre/%post`；`prereq_ignoreinst`可安全移除
- 下载：`remote_location(*schemes=('http','ftp','file','https'))`，否则`None`

易错：`requires`已含`requires_pre`。

## 插件接口

要求：继承`dnf.Plugin`、位于`Conf.pluginpath`、定义`name`并重写`__init__`

钩子：`pre_config()`→`config()`→`sack()`→`resolved()`→`pre_transaction()`（RPMDB已锁）→`transaction()`

命令注册：`@dnf.plugin.register_command`，子类继承`dnf.cli.Command`，设`aliases`/`summary`、重写`run()`

## 回调进度报告（`dnf.callback`）

- `Payload`：单文件；`download_size` 为传输总大小。
- `DownloadProgress`：`start`、`progress(payload,done)`、`end(payload,status,msg)`；status 含 `STATUS_OK`/`STATUS_FAILED` 等。
- `TransactionProgress`：`error`、`progress`、`scriptout`。易错：action 为 `TRANS_POST` 时其余参数 `None`；`PKG_SCRIPTLET` 可任意时刻。

## 查询与主题

- `Query`：基于 Sack 查询，**惰性求值**（`run()` 或迭代时执行）；过滤方法返回新 `Query`，不修改原对象。`available()` 保留可用包；`difference(other)` 返回不在 `other` 中的包。

```python
import dnf

base = dnf.Base()
base.fill_sack()

q = base.sack.query()
installed = q.installed().filter(name='dnf')

for pkg in installed:  # 此处才实际求值
    print(pkg, pkg.reponame)
```

- `downgrades()`：可降级候选（同名、更低EVR、架构适合），不验证可安装。
- `duplicated(exclude=[])`：已安装的同名不同版本包；`exclude` 排除包名。
- `extras()`：已安装但不在任何 repo 中。
- `filter(**kwargs)`：按条件过滤；多键为 AND，同键列表/query 为 OR。
  - 常用键：`arch`、`name`、`version`、`release`、`epoch`、`reponame`、`file`、`sourcerpm`、`pkg`、`provides`，及依赖键 `requires/conflicts/obsoletes/enhances/recommends/suggests/supplements`。
  - 操作符后缀 `__`：`eq`（默认）、`glob`、`gt/gte/lt/lte`、`neq`、`substr`、`eqg`、`upgrade`。
  - 易错：依赖过滤传 package/query 比字符串/reldep 更精确。
- `filterm(**kwargs)`：同 `filter()`，但就地修改。
- `installed()`：仅已安装包。
- `intersection(other)`：与 `other` 交集。
- `latest(limit=1)`：按名称/架构保留最高版本；负数排除最新 N 个。
- `run()`：执行查询，返回 `dnf.package.Package` 列表。
- `union(other)`：并集。
- `upgrades()`：可升级候选（同名、更高EVR、架构适合），不验证可安装。

### Subject 类
- 解析 CLI 包规格字符串（支持通配/省略），生成 `Query` 或 `Selector`。
- `__init__(pkg_spec, ignore_case=False)`：`ignore_case=True` 忽略大小写。

### dnf.subject.Subject 核心方法

- **`get_best_query(sack, with_nevra=True, with_provides=True, with_filenames=True, forms=None)`**  
  返回 `Query`，查找匹配给定输入的包；无匹配则为空集。
  - `sack`：搜索所用的 `Sack`
  - `with_nevra`：按 NEVRA 搜索
  - `with_provides`：除包名外也搜索 provides
  - `with_filenames`：同时搜索文件 provides
  - `forms`：hawkey 模式列表；`None` 使用合理默认值

- **`get_best_selector(sack, forms=None, obsoletes=True, reponame=None)`**  
  返回 `Selector`，在事务操作中选择单个最佳匹配包。
  - `sack`、`forms` 含义同上
  - `obsoletes=True`：包含淘汰请求包的包
  - `reponame`：仅从指定仓库选择（默认 `None` 不限制）

- **`get_nevra_possibilities(forms=None)`**  
  生成器，产出每个可能的 NEVRA；NEVRA 类属性：`name`、`epoch`、`version`、`release`、`arch`。

示例（输入可能为完整 NEVRA 或 NEVR）：

```python
import dnf, hawkey
s = dnf.subject.Subject("dnf-0:4.2.2-2.fc30.noarch")
for n in s.get_nevra_possibilities(forms=[hawkey.FORM_NEVRA, hawkey.FORM_NEVR]):
    print(n.name, n.epoch, n.version, n.release, n.arch)
```

### RepoDict
- 继承 `dict`，映射 `repoid`→`Repo`。
- `add(repo)` 添加；`add_new_repo(repoid, conf, baseurl=(), **kwargs)` 创建并添加，自动替换 `$releasever` 等变量。
- `get_matching(key)` 通配符匹配，返回列表可批量操作：
```python
repos = base.repos.get_matching('*-debuginfo')
repos.disable()
```
- `iter_enabled()` 迭代启用仓库；`all()` 返回全部。

### Repo
- 必配 `metalink`/`mirrorlist`/`baseurl` 之一；属性对应 `[repo]`/`[main]` 配置项。
- `id` 只读，合法字符：ASCII 字母、数字、`-_.:`。
- `load()` 加载元数据，返回 `True`（新下载）/`False`（缓存）；失败抛 `RepoError`；成功后可用 `metadata`。
- `dump()` 打印配置；`enable()`/`disable()` 启停。
- `pkgdir` 设包下载目录；`repofile` 配置文件路径。

### Metadata
- `fresh`：`True` 源加载，`False` 缓存。

### 易错点
- `excludepkgs`/`includepkgs` 为 SWIG `VectorString`，鸭子类型可用，但 `isinstance()`/`type()` 不符预期。
- `repo_id_invalid(repo_id)` 校验 ID，返回首个无效字符索引或 `None`。

- `set_or_append_opt_value(name, value_string, priority=PRIO_RUNTIME)`：
  - 标准选项：若 `priority ≥ 当前优先级`，则设置值。
  - append 选项：将解析值追加到列表；若首元素为空且 `priority ≥ 当前优先级`，则用新值替换列表。
  - 若 `priority` 更高，则提升当前优先级。
  - 选项不存在或值无效/不允许时，抛出 `dnf.exceptions.ConfigError`。
- `set_progress_bar(progress)`：
  - 设置 `load()` 时下载进度对象，`progress` 必须为 `dnf.callback.DownloadProgress` 实例。

- `dnf.sack.Sack`：包仓库对象，保存所有已知包（已安装+可用）的元数据。
- `query(flags=hawkey.APPLY_EXCLUDES)`：返回 `Query` 查询 sack 中的包。创建查询时应用包过滤，可用 flags：
  - `hawkey.APPLY_EXCLUDES`：应用全部包过滤
  - `hawkey.IGNORE_EXCLUDES`：忽略全部包过滤
  - `hawkey.IGNORE_REGULAR_EXCLUDES`：忽略配置文件/命令行定义的常规排除
  - `hawkey.IGNORE_MODULAR_EXCLUDES`：忽略模块化过滤
- `dnf.sack.rpmdb_sack(base)`：返回仅含已安装包（`@System` 仓库）的新 sack；适用于事务后获取已安装 RPM 列表。

- `dnf.selector.Selector`：指定事务操作目标。
- `set()`：设置内容，同 `dnf.query.Query.filter()`。
- `matches()`：返回表示内容的包。

```python
class dnf.selector.Selector:
    set()
    matches()
```

# DNF 事务 JSON 格式

- 格式不稳定；建议用同版本 dnf 存储与回放。
- 顶层：`version` 为 `MAJOR.MINOR`，MAJOR 递增不兼容，MINOR 递增兼容；`rpms`、`groups`、`environments` 数组。
- rpm：`action` 枚举 `Downgrade, Downgraded, Install, Obsoleted, Reason Change, Reinstall, Reinstalled, Removed, Upgrade, Upgraded`；`nevra` 格式 `name-epoch:version-release.arch`；`reason` 枚举 `dependency, clean, group, unknown, user, weak-dependency`；`repo_id` 来自本地配置，系统间可能不同。
- group/environment：`action` 为 `Install, Upgrade, Removed`；含 `id`；`package_types` 枚举 `conditional, default, mandatory, optional`，仅 `Install` 有效；group 含 `packages`，environment 含 `group`。
- group-package：`installed` 布尔值，`name` 包名，`package_type` 同上枚举。
- environment-group：`group_type` 为 `mandatory, optional`，含 `id`、`installed` 布尔值。
- 易错点：枚举值大小写敏感；`repo_id` 非跨系统稳定标识；`package_types` 仅 `Install` 时有效；跨 MAJOR 版本重放事务可能失败。

- `dnf.db.group.RPMTransaction`：描述已解析的事务集，可迭代获取 `items`。
- 事务内打包请求原样传给 RPM，不再做依赖解析；若集合不适合实际事务（冲突/依赖不一致），RPM 默认拒绝执行。
- 只读属性：
  - `install_set`：待安装的 `Packages` 集合
  - `remove_set`：待移除的 `Packages` 集合

---
来源：consolidated/sys-admin/DNF 包管理器.md