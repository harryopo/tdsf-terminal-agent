---
source: git-docs
category: cmd-tools
url: consolidated/cmd-tools/Git 版本控制.md
title: Git 版本控制
---

- 配置：git config --global user.name/user.email
- 易错：pull前commit/stash；公共分支勿rebase

```bash
git add . && git commit -m "msg" && git pull --rebase && git push
```

- 设计目标：为 Linux 内核开发而生，单仓库可承载数千万行代码，速度与性能优先。
- 存储效率：Linux 内核源码 1.7 GB，完整历史（140 万提交）仅占 5.5 GB。
- 普及度：2022 Stack Overflow 调查，96% 专业开发者使用 Git。
- 生态：核心为命令行工具，但托管服务（GitHub/GitLab）、GUI、编辑器集成、命令行工具丰富。
- 开源：以 GPLv2 发布，保证用户自由修改/共享；但 “Git” 名称与 logo 受商标政策限制，须遵守。

## 命令行工具

### TUI 界面
- `lazygit`：简洁终端 UI
- `tig`：基于 ncurses 的文本界面
- `forgit`：基于 `fzf` 的交互式 Git
- `gitui`：Rust 编写的高性能终端 UI

### 历史管理
- `git-absorb`：自动生成 `git commit --fixup`
- `git-filter-repo`：快速重写仓库历史（替代 `filter-branch`）
- `git-imerge`：增量合并
- `mergiraf`：语法感知的 Git merge 驱动
- `git-branchless`：无分支工作流

### Shell 提示符
- `Starship`：极简、快速、可无限定制的提示符
- `git-prompt.sh`：Git 自带的 Bash 提示符脚本

### 大文件
- `git-lfs`：Git 大文件存储
- `git-annex`：文件管理，不将内容存入 Git

### Diff 工具
- `delta`：语法高亮 diff 分页器
- `difftastic`：结构化 diff，理解语法
- `diff-so-fancy`：提升 diff 可读性

### Hooks 管理
- `pre-commit`：多语言 pre-commit 钩子框架
- `lefthook`：Go 编写的高性能 hooks 管理器

### 工具集
- `git-extras`：仓库摘要、changelog、作者提交占比等
- `git-toolbelt`：脚本化/日常使用的 Git 命令套件

### 其他
- `mob.sh`：远程结对/集体编程的快速交接
- `git-secrets`：阻止提交密钥和凭据
- `Commitizen`：提交规范、自动版本号与 changelog
- `git-town`：自动化分支创建、同步、发布与清理

## 3. Git 文档

### 核心概念
- Git：快速、可扩展的分布式版本控制系统，兼具高层操作与底层内部访问。
- 入门：`gittutorial`；最小常用命令集：`giteveryday`；深入：Git User's Manual。
- 单命令帮助：`git help <command>`；在线文档：https://git-scm.com/docs

### 语法
```bash
git [-v | --version] [-h | --help] [-C <path>] [-c <name>=<value>]
    [-p | --paginate | -P | --no-pager] [--git-dir=<path>]
    [--work-tree=<path>] [--namespace=<name>] [--config-env=<name>=<envvar>]
    <command> [<args>]
```

### 关键参数
- `-v | --version`：打印版本（内部转为 `git version ...`）；与 `--help` 同给时，`--help` 优先。
- `-h | --help`：打印概要及常用命令；加 `-a | --all` 打印全部命令；后跟命令名则打开该命令手册（内部转为 `git help ...`）。
- `-C <path>`：相当于在 `<path>` 下运行 git。多个 `-C` 时，后续相对路径基于前一个 `-C` 解析；`-C ""` 保持当前目录不变。影响 `--git-dir`、`--work-tree` 的相对路径基准。

### 易错点
`-C` 改变相对路径基准，以下等价：
```bash
git --git-dir=a.git --work-tree=b -C c status
git --git-dir=c/a.git --work-tree=c/b status
```

- `-c <name>=<value>`：传配置参数，覆盖配置文件值；`<name>` 格式同 `git config`（点分键）。
- 省略 `=`（`-c foo.bar`）→ 设布尔 true。
- 含 `=` 但空值（`-c foo.bar=`）→ 设空字符串，`git config --type=bool` 转为 false。
- `--config-env=<name>=<envvar>`：类似 `-c`，但值取自环境变量 `<envvar>`。
- 无快捷方式设空串，须环境变量本身为空；环境变量未设置则报错。

## git-add 核心

- 功能：将文件改动加入索引（暂存区），供下次 `commit` 使用。只有暂存内容会被提交。
```bash
git add file.c
git commit
```
- 可多次 `add`；每次只记录执行时状态，后续改动需重新 `add`。`git status` 查看暂存摘要。

### 关键参数
- `<pathspec>`: 支持通配符 `*.c`；目录 `dir` 会记录目录下新增/修改/删除；旧版忽略删除，用 `--no-all` 只添加新增/修改。
- `-n|--dry-run`: 试运行。
- `-u|--update`: 更新已跟踪条目（含删除），不新增文件。
- `-A|--all`: 暂存全部（含新增、删除）。
- `-p|--patch`: 交互式选择 hunk 暂存。
- `-i|--interactive`: 交互模式。
- `-e|--edit`: 编辑 diff 后应用（易产生不匹配补丁）。
- `-f|--force`: 添加被忽略文件；子模块 `submodule.<name>.ignore=all` 时也用它，且需显式指定路径。
- `--sparse`: 允许更新 sparse-checkout 范围外条目（默认拒绝）。
- `--[no-]ignore-removal`: 控制是否处理已删除文件。

### 易错点
- 默认忽略 `.gitignore`；显式指定被忽略文件会报错，否则静默忽略。
- `-U` 无参数等价于 `-p`（历史原因）。
- 用目录作 pathspec 会记录删除，不想删除用 `--no-all`。

- `-u`：仅更新已跟踪文件；无 `<pathspec>` 时更新整个工作树（旧 Git 仅限当前目录及子目录）。
- `-A` / `--all` / `--no-ignore-removal`：使索引与工作树完全一致，含新增、修改、删除；无 `<pathspec>` 时处理全工作树。
- `--no-all` / `--ignore-removal`：只添加新增和修改，忽略已删除文件；无 `<pathspec>` 时无效。用于兼容旧版 `git add <pathspec>` 行为（忽略删除）。
- `-N` / `--intent-to-add`：仅登记路径“稍后添加”，索引中存空条目。

```bash
git add -u
git add -A
git add --no-all .
git add -N file
```

## git-branch 核心知识点

- **用途**：列出、创建、删除分支。
- **列出**：`git branch`（本地，当前带`*`）、`-r`（远程跟踪）、`-a`（全部）、`--list <pattern>`（通配符过滤）。注意：带`<pattern>`必须用`--list`，否则视为创建分支。
- **筛选**：`--merged [<commit>]`（已合并）、`--no-merged [<commit>]`（未合并）。
- **创建**：`git branch <branch-name> [<start-point>]`，仅创建不切换；切换用`git switch <new-branch>`。
- **跟踪**：基于远程跟踪分支创建时自动设上游，使`git pull`正常；事后用`-u/--set-upstream-to`修改，`--track/--no-track`可覆盖默认。
- **重命名**：`-m <old> <new>`，`-M`强制覆盖。
- **删除**：`-d <branch>`（需已完全合并），`-D`强制删除（`--delete --force`）。

- `--create-reflog`：创建分支 reflog，记录分支引用所有变更，支持日期表达式 `<branch>@{yesterday}`。非裸仓库默认由 `core.logAllRefUpdates` 开启；`--no-create-reflog` 仅覆盖之前的 `--create-reflog`，不关闭该配置。
- `-f` / `--force`：强制将分支重置到 `<start-point>`，分支已存在时无 `-f` 会拒绝修改。与 `-d` 配合可忽略合并状态删除；与 `-m` / `-c` 配合允许重命名/复制到已存在的新名称。

## git-bugreport

收集用户机器、Git 客户端与仓库状态信息，生成单个文本文件用于提交 bug 报告。

### 命令格式
```bash
git bugreport [(-o | --output-directory) <path>]
              [(-s | --suffix) <format> | --no-suffix]
              [--diagnose[=<mode>]]
```

### 收集内容
- 用户填写：复现步骤（Reproduction steps）、期望行为（Expected behavior）、实际行为（Actual behavior）
- 自动捕获：
  - `git version --build-options`
  - uname 系统信息（sysname/release/version/machine）
  - 编译器信息字符串
  - 已启用的 hooks 列表
  - `$SHELL`

### 选项
- `-o <path>` / `--output-directory <path>`：指定输出目录，默认当前目录
- `-s <format>` / `--suffix <format>`：自定义文件名后缀，格式为 strftime(3) 时间字符串，生成 `git-bugreport-<formatted-suffix>`
- `--no-suffix`：不带任何后缀，文件名为 `git-bugreport`
- `--diagnose[=<mode>]`：额外生成 zip 诊断归档 `git-diagnostics-<formatted-suffix>`；`mode` 控制归档内容范围，有效值见 git-diagnose
- `--no-diagnose`：禁用诊断归档

### 易错点
- 如果相关配置文件不可读，该工具可能无法启动，此时需手动收集上述信息。

## Git 速查

- **建仓**：`git init`；`git clone <url>`
- **提交**：`git add <file>`或`.`；`git reset <file>`取消暂存；`git commit -m 'msg'`（`-a`免暂存）
- **分支**：`git switch <name>`（`-c`新建）；`git branch -d/-D <name>`
- **差异**：`git diff`/`--staged`/`HEAD`=未/已/全部；引用：`HEAD`、`HEAD~3`、分支/标签/ID
- **撤销**：`git restore <file>`；`git reset --hard`
- **历史**：`git reset HEAD^`撤上次提交；`git commit --amend`改提交；`git rebase -i HEAD~n`合并提交
- **查看/合并**：`git log --oneline`；`git merge <branch>`；`git cherry-pick <commit>`
- **远程/配置**：`git push -u origin main`；`git pull --rebase`；安全强推`--force-with-lease`；`git config --global`；`.gitignore`

**核心功能**：`git checkout` 两种模式——切换分支、恢复工作区文件。

**分支切换**
- `git checkout <branch>`：切换到目标分支并更新工作区。若当前有未提交更改且与目标分支冲突则失败；否则保留这些更改。
- 若 `<branch>` 不存在，但唯一远程存在同名跟踪分支，且未用 `--no-guess`，等效：
```bash
git checkout -b <branch> --track <remote>/<branch>
```
- 不带参数：仅打印当前分支的跟踪信息。
- `-b <new-branch> [<start-point>]`：创建新分支并切换；默认起点为当前提交；可用 `--track`/`--no-track` 设置上游。
- `-B`：若分支已存在则重置到起点，而不是失败。
- `--detach [<branch>]` 或 `checkout <commit>`：使 `HEAD` 直接指向提交/分支顶点，进入分离头状态。

**恢复文件**
- `git checkout <tree-ish> -- <pathspec>`：用指定提交/树版本替换文件，并加入索引（暂存区）。
- `git checkout -- <pathspec>`：用索引版本覆盖工作区文件，丢弃未暂存修改。若文件有未解决的合并冲突会失败，需先 `git add` 标记已解决。
- 冲突时可选：
  - `-f`：强制忽略未合并文件
  - `--ours` / `--theirs`：取合并某一方
  - `-m`：恢复原始冲突结果
- `-p|--patch`：交互式选择 diff 数据块应用。

**常用选项**
- `-q`/`--quiet`：静默。
- `--progress`/`--no-progress`：默认在终端时向 stderr 输出进度；`--quiet` 可用显式 `--progress` 覆盖。
- `-f`：强制操作，覆盖未提交更改或忽略未合并文件。

- `--force`：切分支时丢弃本地改动及阻挡的未跟踪文件/目录；检出路径时忽略未合并条目。
- `--ours`/`--theirs`：从索引检出未合并路径的阶段 #2/#3。
- 注意：`git rebase`/`pull --rebase` 时二者互换，`--ours` 指 rebase 目标分支版本。

- 功能：克隆仓库到新目录，创建远程跟踪分支（`git branch --remotes` 可见），检出初始分支。
- 默认行为：无参 `git fetch` 更新所有远程跟踪分支；无参 `git pull` 合并远程 master（`--single-branch` 时除外）。
- 默认配置：远程分支引用置于 `refs/remotes/origin`，初始化 `remote.origin.url` 与 `remote.origin.fetch`。
- `-l`/`--local`：本地克隆，直接复制 `HEAD`、`objects`、`refs`；对象默认硬链接节省空间。本地路径默认启用，URL 时忽略；`--no-local` 强制常规传输。易错：源 `$GIT_DIR/objects` 为符号链接会失败（安全机制）；不能克隆他人拥有的仓库（需 `--no-local`）。
- `--no-hardlinks`：本地克隆时强制复制对象而非硬链接，适合备份。
- `-s`/`--shared`：通过 `.git/objects/info/alternates` 共享源对象，新仓库初始无自有对象。危险：源仓库删除分支等导致对象悬空，可能被 `git maintenance run --auto` 清理，损坏克隆仓库。注意：`git repack`（不带 `--local`）会复制对象，破坏节省；`git gc` 默认 `--local` 安全；`git repack -a` 可解除依赖。

- `--reference-if-able=<repo>`：若参考仓库在本地，自动配置 `.git/objects/info/alternates` 从中获取对象，减少网络与存储成本；目录不存在时仅警告，不中止克隆。
- `--dissociate`：借参考仓库对象减少网络传输，克隆后复制所需对象并解除借用；需配合 `--reference` 使用。
- 注意：两者与 `--shared` 选项相关，见其说明。

创建新提交：暂存区内容 + 日志消息，挂于 `HEAD` 并更新分支指针；detached 无分支关联。提交后错误可用 `git reset` 恢复。

提交来源：
- `git add` 暂存（已修改文件也要 add）；`git rm` 删除工作区与暂存区文件
- `<pathspec>`：忽略暂存内容，提交所列已跟踪文件当前内容
- `-a`：自动暂存已跟踪文件的修改/删除，并删除工作区已移除的跟踪文件（不影响未跟踪）
- `--interactive` / `--patch`：逐文件/逐 hunk 交互选择

关键选项：
- `-m <msg>` 指定消息；`-F <file>` 从文件读取
- `--amend` 修改上次提交；`--reset-author` 重置作者
- `-C <commit>` 复用消息+作者；`-c <commit>` 同 `-C` 但打开编辑器
- `--fixup=[amend:|reword:]<commit>` 配合 `rebase --autosquash`
- `--no-verify` 跳过 pre-commit 钩子

易错点：
- `-U` 不带 `<n>` 等同 `-p`；上下文默认由 `diff.context` 决定，未设置时 3
- 普通 `--fixup` 只改内容不改消息；`amend:` 替换消息；`reword:` 只改消息不动内容
- `--fixup` 的 `-m` 附加说明在 `rebase --autosquash` 时被丢弃

- `--fixup=amend:<commit>`：提交信息前缀 `amend!`，将原提交消息复制到编辑器中修改；`rebase --autosquash` 时用修改后的信息替换原提交信息。
- 空消息报错，除非指定 `--allow-empty-message`。
- `--fixup=reword:<commit>` = `--fixup=amend:<commit> --only`，仅修改消息，忽略暂存改动；squash 后替换原提交消息。

- **用途**：读取/设置 Git 配置。
- **配置文件层级**（低→高）：系统 `/etc/gitconfig` → 用户 `~/.gitconfig` → 仓库 `.git/config` → 命令行 `-c`。
- **常用命令**：
  - 读：`git config --list`、`git config --get <key>`
  - 写：`git config [--global] <key> <value>`（默认当前仓库）
  - 删：`git config --unset <key>`
  - 编辑：`git config --edit`
- **重要配置**：
  - 身份：`user.name`、`user.email`（提交必需）
  - `core.autocrlf`：Windows 用 `true`，macOS/Linux 用 `input`
  - `core.ignorecase false`（大小写敏感）
  - `core.filemode false`（忽略权限变化）
  - 别名：`alias.co checkout`
  - `init.defaultBranch main`
  - `http.proxy`：设置代理
- **易错点**：
  - 默认只操作当前仓库，忘 `--global` 导致配置仅对当前仓库生效。
  - 同一 key 可多值，`--get` 返回最后一个；多值场景用 `--get-all`。
  - 配置值含空格/特殊字符时需加引号。
  - 修改立即生效，但已打开终端的部分环境变量不刷新。

- 子命令：`list`、`get`、`set`、`unset`、`rename-section`、`remove-section`、`edit`；另含 `--get-colorbool`。
- 关键选项：`--includes`、`--all`、`--regexp`、`--value=<pattern>`、`--fixed-value`、`--default=<default>`、`--url=<url>`、`--type=<type>`；文件选项如 `--global`/`--system`/`--local`。
- 名称格式：`section.key`，值自动转义；支持多行值。

## Git 凭据助手

**Git 自带**
- `git-credential-store`：明文保存凭据（注意安全风险）
- `git-credential-cache`：内存临时保存；缓存过期或系统重启后凭据丢失，不适合长期 Personal Access Token

**平台专用**
- `git-credential-osxkeychain`：macOS 钥匙串，macOS Git 自带
- `git-credential-libsecret`：Linux secret service（GNOME Keyring / KDE Wallet），多数 Linux 发行版打包
- `git-credential-wincred`：Windows 凭据管理器，Git for Windows 自带

**OAuth（跨平台）**
- `Git Credential Manager`：Git for Windows 自带，支持多凭据存储；首次认证弹浏览器，后续后台完成
- `git-credential-oauth`：多数 Linux 发行版包含

**密码管理器存储**
- `git-credential-gopass` → gopass
- `git-credential-lastpass` → LastPass
- `git-credential-1password` → 1Password
- `git-credential-keepassxc` → KeePassXC

**主机专用**
- `git-credential-netlify`：Netlify 认证
- `git-credential-azure`：Azure Repos 认证

**易错点**：`cache` 凭据易失，不适合长期 token；`store` 明文存储，需谨慎使用。

**git-diff**：查看工作区、暂存区、提交、blob 及文件系统路径间的差异。

### 常用形式
```bash
# 工作区 vs 暂存区（未暂存改动）
git diff [--] [<path>…]

# 暂存区 vs 某提交（默认 HEAD）
git diff --cached [<commit>]   # --staged 同义

# 工作区 vs 某提交
git diff <commit>

# 两提交间差异
git diff <commit> <commit>

# 两 blob 对象差异
git diff <blob> <blob>

# 文件系统两路径差异；仓库外可省略 --no-index
git diff --no-index <path> <path>
```

### 关键参数
- `--merge-base`：用 merge base 代替比较基准，等价 `git diff $(git merge-base A HEAD)`
- `A...B`：显示从 A、B 的合并基到 B 的差异
- `--`：分隔提交与路径，避免路径歧义
- `--exit-code`：`--no-index` 隐含；有差异退出码 1，无差异 0，可用于脚本

### 易错点
- 不带 `--cached` 时不包含已 `git add` 的暂存改动
- `--cached` 未给 `<commit>` 默认对比 HEAD；HEAD 不存在（unborn 分支）时显示全部暂存改动

- 合并提交对比：首提交须为合并提交，其余为父提交。`git diff A A^@`、`git diff A^!`、`git show A` 三者等价。
- 两点对比（`..`）：`git diff A..B` 等价于 `git diff A B`；省略任一侧提交，默认 `HEAD`。
- 三点对比（`...`）：显示从共同祖先到第二提交的变更；等价于 `git diff $(git merge-base A B) B`；可省略任一提交，默认 `HEAD`。

`git difftool` 是 `git diff` 前端，用外部工具查看差异。  
语法：`git difftool [<options>] [<commit>…] [--] [<path>…]`

**核心选项**
- `-d`/`--dir-diff`：目录对比，不提示；默认 `--symlinks`，Windows 为 `--no-symlinks`
- `-y`/`--no-prompt`：不提示（默认提示）
- `-t <tool>`：指定工具；`--tool-help` 列出
- `-g`/`--gui`：用 `diff.guitool`，回退 `merge.guitool`→`diff.tool`→`merge.tool`
- `-x <command>`：执行 `<command> $LOCAL $REMOTE`

**配置**
`diff.tool`、`diff.guitool`、`difftool.<tool>.path/.cmd`；变量 `$LOCAL/$REMOTE/$MERGED/$BASE`；缺失回退 `mergetool`。

**常用工具**：`vimdiff`, `nvimdiff`, `meld`, `kdiff3`, `p4merge`, `diffuse`, `tkdiff`, `winmerge`, `vscode` 等。

**易错点**
- 默认每次提示；`-d` 或 `-y` 禁用
- 非内置工具需定义 `difftool.<tool>.cmd`
- Windows 下 `--dir-diff` 默认 `--no-symlinks`

- `difftool.<tool>.path`：覆盖工具路径，用于工具不在 `PATH` 时。
- `difftool.trustExitCode`：diff 工具返回非零退出码则退出 difftool（同 `--trust-exit-code`）。
- `difftool.prompt`：每次调用 diff 工具前提示确认。
- `difftool.guiDefault`：`true` 默认用 `diff.guitool`（等同 `--gui`）；`auto` 根据 `DISPLAY` 变量自动选择 `diff.guitool` 或 `diff.tool`；默认 `false`，须显式加 `--gui` 才使用 `diff.guitool`。

## git-fetch 核心知识点

**作用**：从远程仓库下载对象与引用，更新远程跟踪分支；不合并。

**语法**：`git fetch [<options>] [<repository> [<refspec>…]]`，支持 `--all`、`--multiple`。

**要点**：
- 默认获取指向所取历史的标签；用 `--tags`/`--no-tags` 或 `remote.<name>.tagOpt` 调整。
- 未指定远程时默认 `origin`；若当前分支有 upstream 则用其远程。
- 写入 `.git/FETCH_HEAD`，供脚本或 `git pull` 使用。

**常用选项**：
- `--all`：获取所有远程（跳过 `remote.<name>.skipFetchAll`）。
- `-a/--append`：追加到 FETCH_HEAD 而非覆盖。
- `--atomic`：本地 refs 原子更新。
- `--depth=<depth>`：浅获取，限制从远程 tip 起的提交数。
- `--deepen=<depth>`：基于当前浅边界加深指定提交数。
- `--shallow-since=<date>` / `--shallow-exclude=<ref>`：按日期/排除 ref 控制浅历史。
- `--unshallow`：浅仓库转完整仓库。
- `--update-shallow`：允许更新 `.git/shallow`。
- `--negotiation-tip=<commit|glob>`：只向服务器报告指定 tip 的可达提交，减小 packfile。

**易错点**：`--depth` 从分支 tip 起算，`--deepen` 从当前浅边界起算；浅获取默认不取加深提交的标签。

- 选项可多次指定，报告从任一给定提交可达的提交。
- 参数：ref 通配符、ref 或（可缩写）提交 SHA-1；通配符等价于按每个匹配 ref 多次指定。
- 相关配置：`fetch.negotiationAlgorithm`、`push.negotiate`；另见 `--negotiate-only`。
- `--negotiation-include=<commit|glob>`：强制在 fetch 协商中始终将给定 tips 作为 "have" 行发送，不受协商算法选择影响。

- 作用：显示 Git 帮助（手册页、指南、配置变量等）。
- 语法：
```bash
git help [-a|--all] [-c|--config] [-g|--guides] [--[no-]verbose] [--[no-]external-commands] [--[no-]aliases]
git help [[-i|--info] [-m|--man] [-w|--web]] [<command>|<doc>]
```
- 核心行为：
  - 无参数：打印命令概要及常用命令。
  - `git help <command>` 显示手册页（默认 man）；`git <command> --help` 等价。
  - 传别名时显示别名定义；查别名对应命令用 `git <command> --help`。
  - `git help git` 显示 git 手册；`git help help` 显示本页。
- 常用选项：
  - `-a|--all` 列出所有命令；默认含外部 `git-*` 与别名，用 `--no-external-commands`、`--no-aliases` 排除。
  - `--verbose` 显示描述（与 `--all` 同用，默认开）。
  - `-c|--config` 列出配置变量；`-g|--guides` 列出概念指南。
  - `-i|-m|-w` 指定手册格式：info/man/web。
- 配置变量：
  - `help.format`：默认格式，`man`/`info`/`web`；仅在无命令行选项时生效。
  - `man.viewer`：选择 man 查看器（`man`/`woman`/`konqueror`），可多值按序尝试。
  - `web.browser`/`help.browser`：指定 web 浏览器。
- 易错点：
  - `git --help` 与 `git help` 相同；但 `git help <alias>` 只显示别名定义。
  - `--all` 默认含外部命令和别名，需显式排除。
  - `help.format` 在命令行指定格式时被忽略。

- `man.viewer` 不支持时，查找 `man.<tool>.cmd`，存在则视为自定义命令，用 shell eval 执行，man 页作为参数传递。
- konqueror：指定 `man.viewer=konqueror` 时，用 `kfmclient` 在已打开的 konqueror 新标签打开；若设置 `man.konqueror.path=.../konqueror`，则尝试启动 `.../kfmclient`。
- 强制用 konqueror：
```ini
[man]
viewer = konq
[man "konq"]
cmd = A_PATH_TO/konqueror
```
- 推荐全局设置：
```bash
git config --global help.format web
git config --global web.browser firefox
```

## git init 要点
- 本质：创建 `.git`（含 `objects/`、`refs/heads/`、`refs/tags/` 等）。重复运行安全，不覆盖已有数据。
- 格式：
```bash
git init [-q] [--bare] [--template=<dir>] [--separate-git-dir=<dir>]
         [--object-format=<format>] [--ref-format=<format>]
         [-b <branch>] [--shared[=<perm>]] [<directory>]
```
- `-q`：只输出错误/警告。
- `--bare`：裸仓库，当前目录为仓库根。
- `--object-format`：`sha1`（默认）或 `sha256`，两种不互通。
- `--ref-format`：`files`（默认）或 `reftable`。
- `-b/--initial-branch`：初始分支名，默认 `master`；可用 `init.defaultBranch` 配置。
- `--separate-git-dir`：在 `.git` 位置写文本指向实际仓库路径；重初始化可移动仓库。
- `--template`：模板目录内容复制到 `$GIT_DIR`。
- `--shared[=perm]`：多用户共享，默认 `group`，设置 `core.sharedRepository`；共享仓库默认禁止非快进推送。perm 可为 `umask/false`、`group/true`、`all`、`0xxx`（如 `0640`）。`0xxx` 不受 umask 影响；`group/all` 只放宽权限。
- `<directory>`：指定目录，不存在则创建。
- 环境变量：`GIT_DIR` 覆盖仓库路径；`GIT_OBJECT_DIRECTORY` 指定对象目录。
- 易错：`sha256` 与 `sha1` 不可互操作；重复 `init` 仅补充模板/移动仓库。

## git init 模板目录

模板来源优先级（高→低）：

1. `--template` 选项参数
2. `$GIT_TEMPLATE_DIR` 环境变量
3. `init.templateDir` 配置变量
4. 默认目录：`/usr/share/git-core/templates`

默认模板包含目录结构、建议的 exclude 模式（gitignore）、示例 hook 文件。

**易错点**：示例 hooks 默认全部禁用，启用需移除 `.sample` 后缀。

已有代码库初始化：

```bash
$ cd /path/to/my/codebase
$ git init      # 创建 .git 目录
$ git add .     # 添加所有现有文件到暂存区
$ git commit    # 将初始状态记录为第一次提交
```

## git log 提交日志

```bash
git log [<options>] [<revision-range>] [[--] <path>…]
```

- 沿 `parent` 链接列出可达提交，默认反向时间顺序；`^` 前缀表示排除该提交可达的所有提交。
- 集合运算：`git log foo bar ^baz` = 从 foo 或 bar 可达、但从 baz 不可达的所有提交。
- `A..B` 等价 `^A B`：

```bash
$ git log origin..HEAD
$ git log HEAD ^origin
```

- `A...B` = 对称差集，用于合并场景：

```bash
$ git log A B --not $(git merge-base --all A B)
$ git log A...B
```

关键选项：

- `--follow`：跨重命名追踪文件历史（仅适用于单个文件）
- `--decorate[=short|full|auto|no]`：显示提交的引用名
  - `short`：省略 `refs/heads/`、`refs/tags/`、`refs/remotes/` 前缀
  - `full`：显示含前缀的完整引用名

## git log 装饰选项
- `--decorate[=short|full|auto|no]`：`auto` 仅当输出到终端时显示 short 格式，否则不显示。
- `--decorate` 等价于 `--decorate=short`；默认取 `log.decorate` 配置，未配置则为 `auto`。
- `--decorate-refs=<pattern>` / `--decorate-refs-exclude=<pattern>`：控制引用装饰。同用时须匹配 include 且不匹配 exclude；显式 `--decorate-refs` 可覆盖 `log.excludeDecoration` 配置。
- 默认装饰引用：`HEAD`、`refs/heads/`、`refs/remotes/`、`refs/stash/`、`refs/tags/`。
- `--clear-decorations`：清除之前的装饰过滤，包含全部引用；配置 `log.initialDecorationSet=all` 时默认生效。
- `--source`：显示命令行中给定的引用名。
- `--mailmap` / `--use-mailmap`（及 `--no-` 变体）：用 mailmap 映射作者/提交者规范名字。

## git merge
- 将指定提交自当前分支分叉以来的更改合并入当前分支；`git pull` 内部使用。
- 合并前 `ORIG_HEAD` 设为当前分支 tip。
- 冲突或 `--no-commit` 时停止；`--continue` 继续，`--abort` 尝试恢复合并前状态。
- 警告：带非平凡未提交更改运行 merge 可能难以回退，不推荐。
- `--no-commit`：合并但不创建提交，便于检查/调整；`--commit` 可覆盖。
- 成功合并生成新提交，包含两个父提交及用户提交信息。

- `git merge` 关键选项：
  - `--ff`（默认）：能快进仅更新指针，不产生合并提交；`--no-ff` 强制创建合并提交；`--ff-only` 仅接受快进，否则失败。
  - 易错：快进时 `--no-commit` 无效，需配合 `--no-ff --no-commit`。
  - `-e/--edit` 合并成功后编辑提交信息；`--no-edit` 接受自动信息（不推荐）。
  - `-S[<key-id>]/--gpg-sign` 对合并提交签名；`--no-gpg-sign` 取消签名。
- `git mergetool [--tool=<tool>] [-y | --[no-]prompt] [<file>…]`：
  - 在 `git merge` 后运行，处理冲突；无文件参数时处理所有冲突文件，指定目录则处理该路径下全部未解决文件。
  - `--tool=<tool>` 指定合并工具（常用 `meld`、`vimdiff`、`kdiff3` 等），未指定时读 `merge.tool` 配置。
  - 自定义命令用 `mergetool.<tool>.cmd`，运行时注入环境变量：`BASE`（共同基础）、`LOCAL`（当前分支）、`REMOTE`（待合并分支）、`MERGED`（输出文件）。
  - 若工具退出码正确，设 `mergetool.<tool>.trustExitCode=true`；否则 git 会提示确认。
  - `-y`：每次调用工具前不提示确认。

### git-mergetool

- `--no-prompt`：不提示（有 `--tool`/`merge.tool` 时默认）；`--prompt` 提示可跳过
- `-g/--gui`：用 `merge.guitool`，否则 `merge.tool`；`--no-gui` 反向

配置：
- `mergetool.<tool>.cmd`：自定义命令，变量 `BASE`/`LOCAL`/`REMOTE`/`MERGED`
- `.trustExitCode`：`true` 看退出码，否则看时间戳

### git-mv

```shell
git mv [-v] [-f] [-n] [-k] <source> <destination>
git mv [-v] [-f] [-n] [-k] <source>... <destination-directory>
```

- 移动文件/目录/符号链接，更新索引后需 `git commit`；`-f` 强制覆盖；`-k` 跳过出错操作；`-n` 试运行；`-v` 显示文件名
- 移动子模块：更新 gitfile、`core.worktree`、`submodule.<name>.path` 并暂存 `.gitmodules`
- Bug：父项目更新后旧位残留、新位空，需 `git submodule update` 重填

`git-notes`：为对象附加/查看备注，不改动对象本身。

## 核心机制
- 默认存储于 `refs/notes/commits`，首次使用自动创建；`git log` 以 `Notes:` 缩进显示
- `git format-patch --notes` 将备注加入补丁注释（`---` 后）

## 子命令（默认对象 `HEAD`）
- `list [<object>]`：列出备注；无参数输出 `note-object annotated-object`
- `add [-f] [-m <msg>|-F <file>|-C <object>|-c <object>] [<object>]`：添加；已有备注则中止，`-f` 覆盖
- `append`：追加内容（自动空行）
- `edit`：编辑；`show`：显示
- `copy [-f] (--stdin | <from> [<to>])`：复制；`--stdin` 逐行读入，兼容 `post-rewrite`
- `merge [-s <strategy>] <notes-ref>`：合并；冲突在 `.git/NOTES_MERGE_WORKTREE` 手动解决，完成用 `merge --commit/--abort`
- `remove [--ignore-missing] [<object>…]`：删除备注

## 关键选项
- `-m <msg>`：多条自动分段；`-F <file>` 用 `-` 读 stdin；可混用
- `-C <object>` 直接复用 blob；`-c` 先打开编辑器
- 配置 `notes.rewrite.<command>`：重写提交时自动携带备注

## 易错点
- 对象已有备注 `add` 报错，需 `-f`
- `copy` 等价于 `add -f -C $(git notes list <from>) <to>`

- **git pull** = `git fetch` + 集成（merge/rebase）到当前分支。
- 默认拉取当前分支的 upstream；未配置则用 `origin`。

```bash
git pull [<options>] [<repository> [<refspec>…]]
```

- 集成方式（4 种）：
  - `--ff-only`：仅快进，本地与远程分叉则失败（默认）
  - `--rebase`：执行 `git rebase`
  - `--no-rebase`：执行 `git merge`
  - `--squash`：执行 `git merge --squash`
- 可用配置替代：`pull.rebase`、`pull.squash`、`pull.ff`
- 冲突后安全中止：`git merge --abort` 或 `git rebase --abort`

- 常用选项：
  - `-q` / `--quiet`、`-v` / `--verbose`：透传给 fetch 和 merge
  - `--[no-]recurse-submodules[=yes|on-demand|no]`：控制子模块获取与工作树更新；rebase 时重放本地子模块提交，merge 时解决子模块冲突

- 合并选项：
  - `--commit` / `--no-commit`：`--no-commit` 在创建合并提交前停止，便于检查
  - `--edit` / `-e`：编辑合并提交信息

- 易错点：快进更新不会产生 merge commit，因此 `--no-commit` 无法阻止；若须确保分支不被更新，需同时使用 `--no-ff --no-commit`。

- **作用**：将本地分支/标签/引用推送到远程，并传输远程缺失的对象。
- **基本用法**：
  ```bash
  git push <remote> <branch>   # 如 git push origin main
  ```
  默认推送目标：当前分支的 upstream；未配置 upstream 时默认 `origin`。

- **多远程推送（远程组）**：
  ```bash
  git config remotes.all "origin gitlab backup"
  git push all
  ```
  依次推送到组内每个远程，各自独立使用自己的 push 映射。

- **决定推送哪些 refs 的优先级**：
  1. `<refspec>` 参数或 `--all` / `--mirror` / `--tags`
  2. `remote.<name>.push` 配置
  3. `push.default`（默认 `simple`：推送到同名分支）

- **refspec 格式**：`[+]<src>[:<dst>]`
  - 示例：`main`、`main:other`、`HEAD^:refs/heads/main`
  - `<src>` 可为本地分支或任意 SHA-1 表达式；`<dst>` 必须是远程合法 ref 名
  - `+` 前缀等价于 `--force`

- **易错点**：
  - 未设置 upstream 时，`git push` 可能失败（取决于 `push.default`）
  - `+` / `--force` 会强制覆盖远程引用，慎用

## refspec 要点

- 语法 `<src>:<dst>`；省略 dst 更新同名 ref。
- 展开：`main` → `main:refs/heads/main`；dst 唯一对应远端 ref 可直接用（`HEAD:v1.0` → `HEAD:refs/tags/v1.0`）；src 以 `refs/heads/` 或 `refs/tags/` 开头则前缀加到 dst。
- `:` 或 `+:`（允许非快进）推送匹配分支：远端同名的本地分支。
- src 可含一个 `*`：`refs/heads/*:refs/heads/*` 推送所有分支。
- `^` 前缀 = 否定 refspec，只含 src，排除匹配 ref。

## git range-diff 要点

用途：比较两个提交区间，忽略合并提交；自动配对补丁差异小的提交，按第二区间顺序展示。

用法：
```
git range-diff [options] ( <range1> <range2> | <rev1>...<rev2> | <base> <rev1> <rev2> )
```

区间写法：
- `<base>..<rev>`、`<rev>^!`、`<rev>^-<n>`（即 `<range1> <range2>`）
- `<rev1>...<rev2>` ⟺ `<rev2>..<rev1>` + `<rev1>..<rev2>`
- `<base> <rev1> <rev2>` ⟺ `<base>..<rev1>` + `<base>..<rev2>`，base 无需精确分支点

关键选项：
- `--creation-factor=<percent>`：默认 60；大改动被误判为重写时调大
- `--left-only` / `--right-only`：抑制第一/二区间缺失的提交
- `--diff-merges=<format>`：对合并提交生成 diff；`remerge` 最自然；`--remerge-diff` 等价
- `--no-dual-color`：取消双色着色
- `--notes[=<ref>]` / `--no-notes`：传给 git log

## git range-diff

- 接受常规 diff 选项（`--color[=<when>]`、`--no-color`），用于比较新旧补丁的作者、提交信息与 diff
- 输出仅供人读：跨版本不稳定、不可机器解析；`--stat` 等选项可能产生无意义输出
- 配置：`diff.color.*`、`pager.range-diff`（默认开启）
- 示例：`git range-diff @{u} @{1} @`（rebase 解决冲突后对比）
- 标记：`-:` 新增/删除、`=` 完全匹配、`!` 有修改；着色：新增绿、删除红、匹配黄

## git remote

- 管理远程仓库；无参列出，`-v` 显示 URL（须在 `remote` 与子命令间）
- 子命令：`add` `rename` `remove` `set-head` `set-branches` `get-url` `set-url` `show` `prune` `update`
- `add` 语法：

  ```bash
  git remote add [-t <分支>] [-m <主分支>] [-f] [--tags|--no-tags] [--mirror=(fetch|push)] <name> <URL>
  ```

  - `-f` 立即 fetch；`--tags` 全部标签，默认仅 fetch 分支的标签
  - `-t` 只跟踪指定分支；`-m` 设 HEAD 指向远程主分支
  - `--mirror=fetch` 仅限裸仓库；`--mirror=push` 恒为镜像
- `rename` 更新跟踪分支与配置；`remove` 删除远程及跟踪分支

## git remote 子命令
- **set-head**：设置/删除远程默认分支（符号引用 `refs/remotes/<name>/HEAD`）。`-d` 删除；`-a` 自动设置（需先 fetch）；`<branch>` 显式设置。
- **set-branches**：修改远程跟踪的分支列表；`--add` 追加。
- **get-url**：获取远程 URL，展开 `insteadOf`；`--push` 查 push URL；`--all` 列全部。
- **set-url**：按正则匹配替换 URL；`--push`、`--add`、`--delete`。易错：push 与 fetch URL 须指向同一位置；分离用两个独立 remote。
- **show**：显示远程信息；`-n` 用缓存。
- **prune**：删除过期远程跟踪引用（等价于 `git fetch --prune <name>`）；`--dry-run`。

## git reset
用途：1) 改变 `HEAD` 指向；2) 更新暂存区。

语法：
```bash
git reset [--soft | --mixed [-N] | --hard | --merge | --keep] [-q] [<commit>]
git reset [-q] [<tree-ish>] [--] <pathspec>…
git reset (--patch | -p) [<tree-ish>] [--] [<pathspec>…]
```
操作前设 `ORIG_HEAD` 为当前分支 tip。

模式（默认 `--mixed`）：
- **--mixed**：工作区不变，index 更新，不暂存；`-N` 将已删除路径标记为 intent-to-add。
- **--soft**：工作区与 index 均不变；`git reset --soft HEAD~5; git commit` 可合并最近 5 个提交。
- **--hard**：工作区与 index 重置为 `<commit>` 内容；可能覆盖未跟踪文件，删除不在 `<commit>` 中的跟踪文件。

### git reset 核心知识点

- **路径模式**：`git reset [-q] [<tree-ish>] [--] <pathspec>...`  
  将指定路径的暂存区重置为给定提交（默认 `HEAD`），是 `git add` 的反操作，等价于 `git restore --staged`。仅更新索引，不改变 `HEAD` 和工作区文件。

- **`--merge`**：重置索引，并更新工作区中 `HEAD` 与 `<commit>` 不同的文件，但保留索引与工作区有未暂存更改的文件。用于清除未合并的索引条目（如 `git am -3`、`git switch -m` 遗留）。若文件在 `<commit>` 与索引间不同且含未暂存更改，则中止。

- **`--keep`**：重置索引并更新工作区中 `HEAD` 与 `<commit>` 不同的文件；若这些文件有本地更改，则中止。

#### 示例：撤销 add

```bash
$ edit
$ git add frotz.c filfre.c
$ git reset          # 取消暂存
$ git pull ...
```

`git restore`：从指定来源恢复索引/工作树。

```bash
git restore [<options>] [--source=<tree>] [--staged|--worktree] [--] <pathspec>…
```

- 默认源：无 `--staged` 从索引恢复；有 `--staged` 从 `HEAD`；`-s` 可指定提交/分支/标签；`A...B` 取 merge base。
- 恢复位置：默认工作树；`-S` 恢复索引，`-W` 恢复工作树，连用两者同时恢复。
- 关键参数：`-p` 交互选择；`-m/--conflict` 处理未合并冲突（`merge`/`diff3`/`zdiff3`）；`--ours/--theirs` 选 stage #2/#3；`--overlay` 不删除源中缺失文件；`--ignore-unmerged` 跳过未合并条目；`--recurse-submodules` 更新子模块。
- 易错：`--ours/--theirs` 与 `--source` 不能同用；`--merge/--conflict` 也不能；rebase 期间 `ours/theirs` 语义互换；默认 `--no-overlay` 会删除源中不存在的已跟踪文件；子模块默认不恢复。
- 示例：`git restore --source=master~2 Makefile` 用指定版本覆盖；`git restore hello.c` 从索引恢复误删。

- 功能：从索引或工作区+索引删除文件。不能仅从工作区删除（用 `/bin/rm`）。
- 默认安全限制：文件须与分支最新提交一致，且无暂存修改；`-f` 强制覆盖。
- `--cached`：仅从索引删除（取消暂存），保留工作树文件。

```bash
git rm [-f] [-n] [-r] [--cached] [--ignore-unmatch] [--quiet] [--] [<pathspec>…]
```

- `-r`：删除目录（给出目录名时必需）。
- `-n`：试运行，只显示将删除的文件。
- `--ignore-unmatch`：无匹配也返回 0。
- `--`：分隔选项与文件名。
- `--pathspec-from-file=<file>`：从文件读取 pathspec，`-` 表示 stdin；`--pathspec-file-nul` 用 NUL 分隔。

- 通配符跨目录边界：`git rm d*` 会删 `d2`，`git rm d/*` 不会。

删除已从文件系统消失的文件：
- 用 `git commit -a` 或 `git add -u` 自动记录删除。
- 批量替换场景：先删除工作树全部跟踪文件，再 `git add -A`：

```bash
git ls-files -z | xargs -0 rm -f
git add -A
```

- 仅从索引清理已消失文件（工作树脏时）：

```bash
git diff --name-only --diff-filter=D -z | xargs -0 git rm --cached
```

子模块：
- 使用 gitfile（Git ≥1.7.8）的子模块会从工作树移除；旧式 `.git` 目录会移入父项目 `.git` 保护历史。
- 会移除 `.gitmodules` 中的 `submodule.<name>` 段并暂存（除非 `--cached` 或 `-n`）。

### git rm 子模块
- 子模块最新：HEAD 与索引一致、无已跟踪修改、无未忽略未跟踪文件；忽略文件不影响。
- `git submodule deinit`：仅移除本地检出，不提交移除。
- `git rm Documentation/\*.txt`：`*` 加引号由 Git 展开，删除 `Documentation/` 下全部 `*.txt`。
- `git rm -f git-*.sh`：shell 展开 `*`，不匹配 `subdir/git-foo.sh`。
- 易错：超项目切换提交后，旧位置残留子模块检出；仅使用 gitfile 时删除旧目录安全，否则连带删除子模块历史。

### git shortlog
- 作用：汇总 `git log`，按作者/标题分组；适合发布公告，会去掉 `[PATCH]`。
- 用法：`git shortlog [<options>] [<revision-range>] [[--] <path>…]` 或 `git log --pretty=short | git shortlog [<options>]`。
- 常用参数：
  - `-n`：按提交数排序；`-s`：仅计数；`-e`：显示邮箱。
  - `--format=<format>`：自定义提交格式，如 `* [%h] %s`。
  - `--group=<type>`：按 author（默认）、committer（`-c`）、trailer、format 分组；`-c` 为 committer 别名。
- 注意：
  - `--group=trailer:<field>` 无该 trailer 不计；多 trailer 可能重复计数。
  - 未给范围且 stdin 非终端或无当前分支时，从 stdin 读日志。

### git show 核心知识点
- **作用**：显示一个或多个 Git 对象（commit/tag/tree/blob），默认 `HEAD`。
  - commit：日志消息 + 文本 diff；merge 提交用 `git diff-tree --cc` 特殊格式。
  - tag：标签消息 + 引用的对象；tree：等价 `git ls-tree --name-only`；blob：纯内容。
- **常用选项**：
  - `-w[<width>[,<indent1>[,<indent2>]]]`：输出换行。默认 `width=76`、`indent1=6`、`indent2=9`；`width=0` 只缩进不换行。
  - `--pretty[=<format>]` / `--format=<format>`：设置提交日志格式。可为 `oneline`、`short`、`medium`、`full`、`fuller`、`reference`、`email`、`raw`、`format:<string>`、`tformat:<string>`。含 `%<placeholder>` 时等价于 `--pretty=tformat:<format>`。
- **修订范围**：默认 `HEAD` 完整历史；`origin..HEAD` 显示当前可达但 `origin` 不可达的提交；`[--] <path>...` 只显示解释路径演变的提交，路径用 `--` 分隔。
- **提交限制**（多个选项叠加生效，在排序/格式化前应用）：
  - `-<number>` / `-n <number>` / `--max-count=<number>`：仅显示前 `<number>` 个提交。
  - `--skip=<number>`：跳过前 `<number>` 个提交后再显示。
  - `--since=<date>` / `--after=<date>`：晚于该日期的提交；`--until=<date>` / `--before=<date>`：早于该日期；`today` 指最近午夜。
  - `--author=<pattern>`：按作者模式过滤。

## Git 日志格式化

- `--abbrev-commit`：短哈希；`--abbrev=<n>` 指定长度。`--no-abbrev-commit`：完整 40 位，覆盖 `--abbrev-commit` 及 `--oneline`。
- `--oneline`：`--pretty=oneline --abbrev-commit` 简写。
- `--encoding=<编码>`：重编码提交信息，默认 UTF-8；失败则原样输出。
- `--expand-tabs[=<n>]`：制表符展开为空格（默认 8），`--no-expand-tabs` 禁用；`medium/full/fuller` 默认展开。
- `--notes[=<ref>]`：显示附注，默认 `core.notesRef`/`notes.displayRef`；可多次组合。

## Git Stash

- 暂存脏工作区并恢复 `HEAD`；`git stash` 等价 `git stash push`。
- 最新 stash 在 `refs/stash`，旧用 reflog：`stash@{n}`。

```bash
git stash push [-u|--include-untracked] [-a|--all] [-p|--patch] [-k|--keep-index] [-m <message>] [--] [<pathspec>...]
git stash list [<log-options>]
git stash show [-u] [<stash>]
git stash pop [--index] [<stash>]
git stash apply [--index] [<stash>]
git stash branch <branchname> [<stash>]
git stash drop [<stash>]
git stash clear
```

- `-u` 含未跟踪；`-a` 全部；`-p` 交互；`-k` 保留索引。
- `--index` 恢复索引；`-q` 静默。

## git stash

- `git stash push`：保存本地修改到新 stash 条目并回滚到 HEAD。省略 `push` 时，pathspec 仅允许在 `--` 之后。
- `git stash push -m <msg> -u` 等：常用选项 `-p/--patch`、`-S/--staged`、`-k/--keep-index`、`-u/--include-untracked`、`-a/--all`、`-q/--quiet`。
- `save`：已弃用，改用 `push`；不能接受 pathspec，所有非选项参数拼接为消息。
- `list`：列出条目，最新为 `stash@{0}`，可用 `git log` 选项控制显示。
- `show [<stash>]`：默认 diffstat，`-p` 显示补丁；受 `stash.showStat`、`stash.showPatch`、`stash.showIncludeUntracked` 配置控制。
- `pop`：应用并删除条目；若冲突则不删除，需手动 `git stash drop`。适用前工作目录需与索引一致。
- `apply`：同 `pop` 但保留条目；`<stash>` 可为任意 stash 创建的提交。
- `branch <branchname> [<stash>]`：从 stash 原始位置创建新分支并应用改动，成功则丢弃该 stash；适合 `apply` 冲突时使用。
- `clear`：删除所有条目；可能无法恢复。
- `drop`：删除单个条目。
- `create`：创建 stash 提交对象并返回对象名，不存入 ref 命名空间。

## git status

- 显示：索引与 HEAD 的差异（`git commit` 将提交的）、工作树与索引的差异（`git add` 后可提交的）、未跟踪且未被忽略的文件。
- 用法：`git status [<options>] [--] [<pathspec>…]`
- 常用选项：`-s/--short` 短格式；`-b/--branch` 短格式下也显示分支与跟踪信息。

- `--porcelain[=<v>]`：脚本稳定格式，默认 `v1`；`-z` 隐含 `--porcelain=v1`，NUL 分隔条目。
- `-u[<mode>]` / `--untracked-files[=<mode>]`：显示未跟踪文件，mode=`no|normal|all`，默认 `normal`；布尔值 true=normal，false=no，可用 `status.showUntrackedFiles` 改默认。必须连写：`-uno` 合法，`-u no` 不合法。
- `-v` / `--verbose`：额外显示已暂存变更（同 `git diff --cached`）；`-vv` 再加未暂存工作区变更（同 `git diff`）。
- `--ignore-submodules[=<when>]`：默认 `all`；`none` 任何更改即修改，`untracked` 纯未跟踪不算 dirty，`dirty` 忽略子模块工作区，`all` 全部隐藏。
- `--ignored[=<mode>]`：显示被忽略文件，默认 `traditional`，另有 `no`、`matching`。
- `--ahead-behind` / `--no-ahead-behind`：显示/隐藏与上游分支的领先落后计数。
- `--renames` / `--no-renames` / `--find-renames[=<n>]`：重命名检测开关及相似度阈值。
- `<pathspec>`：限定路径范围。

注意：默认长格式为 commit 模板注释，内容格式可能变化；路径相对于当前目录。

## git-submodule
- 用途：检查、更新、管理子模块；无参数显示状态。
- 核心命令：
```bash
git submodule add <repository> [<path>]
git submodule status [--cached] [--recursive] [<path>...]
git submodule init [<path>...]
git submodule deinit [-f|--force] (--all|[<path>...])
git submodule update [--init] [<path>...]
git submodule set-url <path> <newurl>
git submodule sync [--recursive]
```
- add 易错点：相对 URL 如 `../foo.git`，**不能**写 `./foo.git`；默认远程为当前分支 remote-tracking 分支的 remote，否则 `origin`；`<path>` 缺省为仓库规范名；`<path>` 已是 Git 仓库时直接暂存；URL 写入 `.gitmodules`。
- status 前缀：`-` 未初始化；`+` 检出与索引 SHA-1 不一致；`U` 冲突。`--cached` 显示索引 SHA-1；`--recursive` 递归。
- init：从 `.gitmodules` 复制 url 与 update 到 `.git/config`（自定义命令不复制），不覆盖已有；可用 `update --init` 替代。
- deinit：删除 `.git/config` 中 `submodule.$name` 段。

## git-switch
- 用途：切换分支。

### git switch 核心要点

切换分支并更新工作树/索引；新提交落在该分支顶端。不要求工作区干净，但可能丢失本地更改时中止（除非 `-f`/`-m`）。

**语法**
```bash
git switch [<options>] <branch>
git switch [<options>] -c <new-branch> [<start-point>]
git switch [<options>] --detach [<start-point>]
```

**关键选项**
- `-c`：创建并切换，等价 `git branch && git switch`；分支被其他 worktree 占用则失败。
- `-C`：同 `-c`，已存在时重置到 `<start-point>`。
- `-d`：分离 HEAD 检查/实验。
- `-f`：丢弃本地改动，索引和工作树恢复为目标分支状态。
- `-m`：切换前 stash 冲突改动，切换后重新应用；重放冲突则存入 stash，解决后 `git stash drop`。
- `-t`：设置上游，隐含 `-c`；未给 `-c` 时从远程跟踪分支名推导本地名。
- `--guess`（默认）：唯一远程同名分支时自动 `-c --track`。

**引用**
- `@{-N}`：第 N 次 switch/checkout 的分支/提交；`-` 等价 `@{-1}`。

**示例**
```bash
git switch master                  # 切换分支
git switch -c feature origin/feature  # 创建并跟踪远程分支
```

**注意**：`--force` 是 `-f` 别名；`--no-track` 禁止自动上游。

- `git tag` 操作 `refs/tags/` 引用，默认创建、`-d` 删除、`-l` 列出、`-v` 校验。
- 轻量标签直接指向对象；附注标签用 `-a`/`-s`/`-u` 创建 tag 对象，需消息（`-m <msg>`/`-F <file>`，否则开编辑器）。若给 `-m`/`-F`/`--trailer` 而未给 `-a/-s/-u`，隐含 `-a`。
- `-s` 用默认密钥签名；`-u <key-id>` 指定密钥。签名后端由 `gpg.format` 控制（默认 OpenPGP），`gpg.program` 指定签名程序；`--no-sign` 覆盖 `tag.gpgSign`。
- 同名标签已存在时需 `-f` 强制替换。
- 列出：`-l`/`--list`，无参数默认列出全部；支持 shell 通配符 pattern（`fnmatch`）。`-n<num>` 显示附注行数，默认不显示；无数字显示首行；非附注则显示提交信息。
- 过滤与排序：`--contains <commit>`/`--no-contains <commit>` 按包含关系过滤；`--merged <commit>`/`--no-merged <commit>` 按可达性过滤；`--sort=<key>` 排序，`-` 前缀降序，支持 `version:refname`（版本排序），多次 `--sort` 以最后一次为主键，默认受 `tag.sort` 控制；`--ignore-case` 大小写不敏感。
- 附注标签含创建时间、打标签者信息、消息及可选签名；轻量标签仅对象名。`git describe` 默认忽略轻量标签。

```bash
# 创建轻量标签
git tag v1.0
# 创建附注标签（签名）
git tag -a v1.0 -m "release 1.0"
git tag -s v1.0 -m "signed release"
# 删除 / 列出 / 校验
git tag -d v1.0
git tag -l "v-*"
git tag -v v1.0
```

- `--no-merged [<commit>]`
  - 仅列出提交不可从 `<commit>` 到达的标签（即未合并的标签）
  - `<commit>` 默认值为 `HEAD`

- `--points-at [<object>]`
  - 仅列出指向 `<object>` 的标签
  - `<object>` 默认值为 `HEAD`
  - 隐含启用 `--list` 模式

```bash
# 列出未合并到当前 HEAD 的标签
git tag --no-merged

# 列出未合并到指定提交的标签
git tag --no-merged <commit>

# 列出指向当前 HEAD 的标签
git tag --points-at

# 列出指向指定对象的标签
git tag --points-at <object>
```

### git worktree 核心知识点

- **`git worktree add` 省略 `<commit-ish>` 时**：若未用 `--detach`/`--orphan`，且无有效本地分支（指定 `--guess-remote` 时含远程分支），则自动按 `--orphan` 处理，创建新 unborn 分支。分支名默认取 `<path>` 的 `basename`（除非用 `-b`/`-B` 指定）。
- **易错**：若用 `--guess-remote` 但远程/本地均无分支，命令失败并警告先 `fetch`；可用 `-f`/`--force` 覆盖。

```bash
git worktree add <path> [<commit-ish>]
git worktree add -b <new-branch> <path>   # 显式指定新分支
```

- **`git worktree list`**：列出所有 worktree，主 worktree 在前。每项显示：
  - 是否 bare
  - 当前检出的 revision
  - 当前分支（无则为 `detached HEAD`）
  - 是否 `locked`
  - 是否 `prunable`（可被 `prune` 清除）

- **`git worktree lock`**：用于可移动设备或不常挂载的网络共享上的 worktree，防止管理文件被自动 `prune`，也防止被移动/删除。可用 `--reason` 附加原因。

```bash
git worktree lock <worktree> --reason "portable drive"
```

- **`git worktree move`**：移动 worktree 到新位置。注意：主 worktree 或含子模块的链接 worktree **不可移动**。

- 政策目的：保护 Git 商标，维护项目因开源贡献赢得的声誉。
- 政策权限：判定合规；修改政策；授予任意例外。
- 发现违规使用：联系 trademark@sfconservancy.org。
- 使用疑问/许可申请：同上，或致函 Software Freedom Conservancy。

---
来源：consolidated/cmd-tools/Git 版本控制.md