---
source: bash-docs
category: cmd-tools
url: consolidated/cmd-tools/Bash 与 Shell 手册.md
title: Bash 与 Shell 手册
---

- Shell: bash, dash
- 命令: chmod, printf, stat, man, vim
- 接口与机制: isatty, strcmp/strcoll, strftime, readline, regex

## bash(1) 核心知识点

- **概述**：sh 兼容命令解释器，融合 ksh/csh 特性，符合 POSIX。
- **调用**：`bash [options] [command_string | file]`

### 常用选项
- `-c`：从字符串读取命令，字符串后第一个参数给 `$0`，其余为位置参数
- `-i` 强制交互式；`-l`/`--login` 登录；`-r`/`--restricted` 受限
- `-s`：从 stdin 读取命令，可设位置参数
- `-v` 读入时回显；`-x` 执行时打印命令与参数（调试）
- `-D`：列出 `$"..."` 可翻译字符串，隐含 `-n`
- `-O/+O opt`：设置/取消 shopt 选项；无参数打印全部
- `--` 结束选项；多字符选项（`--posix` 等）须在单字符选项前

### 参数与退出状态
- 无 `-c`/`-s` 时，第一个非选项参数为脚本，`$0`=文件名
- 退出状态 = 最后一条命令的退出状态；无命令则为 0
- 脚本查找：当前目录 → `PATH`

### 启动文件
- **登录 shell**：`$0` 首字符为 `-` 或 `--login`；按序读 `/etc/profile` → `~/.bash_profile` → `~/.bash_login` → `~/.profile`（只读第一个可读）；`--noprofile` 禁用
- **交互式 shell**：无 `-c` 且无脚本参数（除非 `-s`），且 stdin/stderr 连终端；`$-` 含 `i`
- 交互式读 `/etc/bash.bashrc` 和 `~/.bashrc`；可用 `--rcfile file` 替代
- 登录退出时读 `~/.bash_logout`
- **易错点**：以 `sh` 调用 bash 时默认启用 `--norc`，不读 bashrc

- **交互式非登录**：读 `/etc/bash.bashrc`、`~/.bashrc`；`--norc` 禁止，`--rcfile file` 替代。
- **非交互式（脚本）**：读 `BASH_ENV` 指定文件，扩展后执行；不用 `PATH` 搜索。
  ```bash
  if [ -n "$BASH_ENV" ]; then . "$BASH_ENV"; fi
  ```
- **以 `sh` 调用**（POSIX）：
  - 登录：读 `/etc/profile`、`~/.profile`；`--noprofile` 禁止
  - 交互：读 `ENV` 指定文件；`--rcfile` 无效
  - 非交互：不读启动文件
- **`--posix`**：交互式只读 `ENV`。
- **rshd/sshd 调用**：非交互式读 `/etc/bash.bashrc`、`~/.bashrc`；以 `sh` 调用则不读。
- **有效 UID/GID ≠ 真实且未用 `-p`**：不读启动文件；不继承函数；忽略 `SHELLOPTS`、`BASHOPTS`、`CDPATH`、`GLOBIGNORE`；有效 UID 重置。用 `-p` 不重置。
- **定义**：
  - blank：空格/Tab
  - word：shell 视为整体的字符序列
  - name：字母数字下划线，字母/下划线开头
  - metacharacter：`| & ; ( ) < > space tab newline`
  - control operator：`|| & && ; ;; ;& ;;& ( ) | |& <newline>`
- **保留字**：未加引号识别，如 `if` `then` `else` `fi` `for` `while` `do` `done` `case` `esac` `function` `select` `time` `{` `}` `!` `[[` `]]`。

未提供章节正文，无法提炼。

- bash 为 sh 兼容解释器，融合 ksh/csh，遵循 POSIX。
- 语法：`bash [options] [command_string | file]`

### 主要选项
- `-c`：从首个非选项参数读命令，第一个参数赋 `$0`，其余为位置参数。
- `-i`：交互式 shell。
- `-l`/`--login`：登录 shell。
- `-r`/`--restricted`：受限 shell。
- `-s`：从 stdin 读取命令，可设位置参数。
- `-v`：读入时打印输入行。
- `-x`：执行时打印命令及参数。
- `-D`：打印所有 `$"..."` 字符串（隐含 `-n`）。
- `-O`/`+O`：设置/取消 shopt 选项。
- `--`：结束选项处理。
- `--dump-po-strings`：同 `-D`，输出 gettext po 格式。
- `--init-file file`/`--rcfile file`：交互时替代默认启动文件。
- `--noprofile`：不读 profile 系列文件。
- `--norc`：不读 bashrc；以 `sh` 调用时默认开启。
- `--posix`：POSIX 模式。
- `--version`：显示版本。

### 参数与退出状态
- 无 `-c`/`-s` 时首参数为脚本：`$0=文件名`，其余为位置参数。
- 退出状态为最后命令状态；无命令时为 0。
- 若当前目录无文件，按 `PATH` 搜索。

### 调用类型
- **登录 shell**：`$0` 首字符为 `-`，或使用 `--login`。
- **交互式 shell**：无非选项参数（除非 `-s`）、无 `-c`，且 stdin/stderr 连到终端，或 `-i`；此时设 `PS1`，`$-` 含 `i`。

### 易错点
- `-c` 后第一个参数赋 `$0`，位置参数从 `$1` 开始。
- `--norc` 只影响交互式 shell；`--noprofile` 用于登录 shell。
- 多字符选项必须位于单字符选项之前。

Bash 启动时按调用方式读取配置文件；文件不存在则忽略，存在但不可读报错，文件名支持波浪号展开。

- **交互式登录 shell** 或**非交互 shell 带 `--login`**：先读 `/etc/profile`，再按顺序查找 `~/.bash_profile`、`~/.bash_login`、`~/.profile`，只读第一个存在且可读的。`--noprofile` 禁止此行为。
- **交互式登录 shell 退出**/非交互登录 shell 执行 `exit`：读 `~/.bash_logout`（若存在）。
- **交互式非登录 shell**：读 `/etc/bash.bashrc` 和 `~/.bashrc`。`--norc` 禁止；`--rcfile file` 强制改为读取 `file`。
- **非交互 shell**（如运行脚本）：查找环境变量 `BASH_ENV`，展开其值作为文件名读取执行，等效于：
  ```bash
  if [ -n "$BASH_ENV" ]; then . "$BASH_ENV"; fi
  ```
  注意：不使用 `PATH` 搜索文件名。
- **以 `sh` 调用**：模仿传统 sh 并符合 POSIX。
  - 交互登录/`--login`：依次读 `/etc/profile`、`~/.profile`；`--noprofile` 可禁止。
  - 交互 shell：读环境变量 `ENV` 展开后的文件；`--rcfile` 无效果。
  - 非交互：不读其他启动文件。
  - 启动文件读完后进入 **posix 模式**。
- **`--posix` 启动**：交互 shell 只读 `ENV` 变量指定的文件，不读其他启动文件。
- **网络连接调用**（由 rshd/sshd 启动，非交互）：读 `/etc/bash.bashrc` 和 `~/.bashrc`（以 `sh` 调用除外）；`--norc`/`--rcfile` 可选但通常不被传递。
- **权限差异**：若有效 uid/gid 与真实不一致且未用 `-p`，则跳过启动文件（原文未完整，但上下文如此）。

## chmod — 修改文件模式位

**语法**
```bash
chmod [选项] MODE[,MODE]... FILE...
chmod [选项] OCTAL-MODE FILE...
chmod [选项] --reference=RFILE FILE...
```

**符号模式**
- 格式：`[ugoa...][[-+=][perms...]...]`，可逗号分隔多个模式
- `u`=属主，`g`=属组，`o`=其他，`a`=全部；缺省等同 `a`，但受 umask 影响
- 操作符：`+` 添加，`-` 移除，`=` 精确设置（未提及位被清除；目录的 setuid/setgid 不被清除）
- 权限：`r`=读，`w`=写，`x`=执行/搜索，`X`=仅当目标是目录或已有执行权时添加 `x`，`s`=setuid/setgid，`t`=sticky；也可用单个 `u`/`g`/`o` 引用对应类别的现有权限

**八进制模式**
- 1~4 位（0-7），省略位视为前导 0
- 第 1 位：setuid=4，setgid=2，sticky=1；第 2/3/4 位分别对应属主/属组/其他人：r=4，w=2，x=1

**易错点**
- 不修改符号链接本身权限；命令行显式给出的链接作用于其指向的文件，递归遍历时忽略链接
- 普通文件 setgid 位在属组不匹配用户有效/附加组且无特权时被清除
- 目录默认保留 setuid/setgid；八进制清位需前导零 `00755`、前导减 `-6000` 或前导等 `=755`
- sticky 位在目录上为受限删除标志（如 `/tmp`），非属主不能删除/改名其中文件；旧系统普通文件上为交换保存加速

**常用选项**
- `-c` 仅报告变更；`-f` 抑制错误；`-v` 每文件输出诊断
- `-R` 递归；`--reference=RFILE` 复制 RFILE 的模式
- `--preserve-root` 拒绝递归操作 `/`（默认 `--no-preserve-root`）

# tcsh/csh 核心知识点

- tcsh 是 csh 增强版，支持编辑/补全/历史/作业控制；`(+)` 为 tcsh 新增，`(u)` 为 csh 未文档化。

## 启动参数

- `-b`：停止选项解析
- `-c`：从下一参数读命令，存入 `command`，其余入 `argv`
- `-e`：命令非零退出即 shell 退出
- `-f`：不加载启动文件
- `-i`：强制交互
- `-l`：登录 shell（仅能唯一参数）
- `-n`：只解析不执行
- `-s`：从标准输入读命令
- `-t`：只执行单行
- `-v`：设置 `verbose`，历史替换后回显
- `-x`：设置 `echo`，执行前回显
- `-V`/`-X`：在加载 `~/.tcshrc` 前设置
- `--help`/`--version`

脚本首字符非 `#` 时，用系统标准 shell 执行。

## 启动/关闭文件

- 登录 shell：`/etc/csh.cshrc` → `/etc/csh.login` → `~/.tcshrc`（无则 `~/.cshrc`）→ `~/.history` → `~/.login` → `~/.cshdirs`
- 非登录：`/etc/csh.cshrc` + `~/.tcshrc`/`~/.cshrc`
- 登出执行 `/etc/csh.logout` 和 `~/.logout`，设 `logout` 变量
- 终端设置（如 `stty`）放 `~/.login`
- 兼容 csh/tcsh：检查 `tcsh` 变量，或让 `~/.tcshrc` source `~/.cshrc`
- 正常提示符为 `>`

## 易错点

- `-l` 必须单独使用才生效
- 不带 `-c/-i/-s/-t` 时，第一个参数会被当作脚本文件名
- 历史文件变量为 `histfile`，目录栈文件变量为 `dirsfile`（默认 `~/.cshdirs`）
- 空行输入 `^D`、`logout` 或 `login` 均可退出登录 shell

- 行编辑生效条件：交互 shell 默认设置 `edit` 变量；`bindkey` 可查看/修改键位绑定。
- 默认 emacs 风格，可用 `bindkey` 整体切换为 vi 风格。
- 方向键固定绑定（除非与其他单字符绑定冲突）：
```text
down  -> down-history
up    -> up-history
left  -> backward-char
right -> forward-char
```
- 用 `settc` 将方向键转义序列置空可取消绑定；ANSI/VT100 序列始终绑定。
- 编辑器对“词”的界定与 shell 不同：由 `wordchars` 变量及非字母数字字符决定。

## 补全与列表

- Tab 键触发 `complete-word`，如 `ls /usr/lost` 补全为 `/usr/lost+found/`。
- 补全目录末尾加 `/`，其他词加空格；可 `unset addsuffix` 禁止。
- 无匹配响铃；若已完整则自动补后缀。
- 补全可在行中任意位置，右侧文本被右推；在词中间补全可能残留右侧字符需手动删除。
- 命令补全沿 `path` 搜索，也支持路径前缀；变量/命令补全方式类似。
- 常用查看命令：
```zsh
bindkey              # 显示所有绑定
bindkey -L           # 以可重放格式列出
bindkey -M <map>     # 指定键位映射表
```

- 仓库：Debian 全部 manpage 在线仓库（manpages.debian.org）
- URL 格式：`/<suite>/<binarypackage>/<manpage>.<section>.<language>.html`
  - 除 `<manpage>` 外均可省略，自动重定向
- 章节导读：`intro(1)` … `intro(9)`，如 `intro.5` 查命令/文件格式
- 仓库索引：
  - `/contents-trixie.html`
  - `/contents-trixie-backports.html`
  - `/contents-testing.html`
  - `/contents-unstable.html`
  - `/contents-experimental.html`
- 浏览器快捷：地址栏输 `manpages.debian.org` + TAB + 手册名 + ENTER
- 更多：`/about.html` 或 wiki.debian.org/manpages.debian.org

**emacs(1)** — GNU Emacs，可扩展；用法：`emacs [选项] [文件...]`

交互帮助：
- `C-h`/`F1` 帮助；`C-h t` 教程；`C-h a` 按模式找命令；`C-h k` 描述键序列；`C-h f` 描述函数

通用选项：
- `[文件]`：编辑文件；`+行号`/`+行:列`：定位（`+` 与数字间无空格，仅作用下一文件）
- `-q`：不加载 init；`-Q`：等同 `-q --no-site-file --no-splash`
- `--debug-init`：调试 `~/.emacs`
- `--daemon[=名称]`：后台守护，用 `emacsclient` 连接

Lisp 选项：
- `-f 函数`；`-l 文件`；`--eval=表达式`

批处理：
- `--batch`：批量模式，消息送 stderr
- `--script 文件`：运行 Elisp 脚本

X 选项：
- `--name=名称`（窗口名）；`-T 名称`（标题）
- `-r`：反色；`-fn 字体`：设字体（**仅等宽**）
- `--color[=模式]`：`never`/`auto`/`always`/`ansi8`
- `-g 几何`：宽/高/位置（按字符计，默认 80x35-40）

易错点：
- `+` 与数字间不能有空格
- `-t 文件`（终端）必须是命令行第一个参数
- 字体名与开关间要有空格；等宽识别：第 11 字段为 `m`/`c`，或形如 `宽x高`，或名为 `fixed`

## Emacs 显示选项 & X 资源

### 命令行选项（X/图形显示下）

- 颜色：`-fg color`（文字）、`-bg color`（背景）、`-bd color`（边框）、`-cr color`（光标）、`-ms color`（鼠标）
- `-d display`：指定显示设备，**必须是第一个选项**
- `-nw`：不建图形框架，终端内运行
- `-nbc`：禁用光标闪烁
- `-fs`/`-mm`/`-fw`/`-fh`：全屏/最大化/全宽/全高
- 查看合法颜色：`M-x list-colors-display`

### X 资源（.Xresources）

格式：`emacs.keyword:value`

常用关键字：

- `background` 背景色；`foreground` 文字色
- `font` 字体
- `cursorColor` 光标色；`cursorBlink` 默认 `on`，设 `off` 关闪烁
- `borderColor` 边框色；`borderWidth` 边框宽；`internalBorder` 内部边框宽
- `lineSpacing` 行间距（像素）
- `geometry` 窗口几何
- `fullscreen`：`fullboth`/`maximized`/`fullwidth`/`fullheight`
- `menuBar`：`on`/`off`
- `minibuffer`：`none` 表示帧无独立 minibuffer

## isatty(3)

测试文件描述符是否指向终端。

```c
#include <unistd.h>
int isatty(int fd);
```

- 返回：`1` = 是终端；`0` = 否，并设置 `errno`
- 错误：
  - `EBADF`：`fd` 无效
  - `ENOTTY`：`fd` 指向非终端（旧内核可能返回 `EINVAL`，违反 POSIX）
- 线程安全：MT-Safe
- 标准：POSIX.1-2001/2008、SVr4、4.3BSD
- 相关：`fstat(2)`、`ttyname(3)`

易错点：返回 `0` 不代表函数失败，而是“非终端”，需结合 `errno` 判断；常用于检测 stdin/stdout 是否连接终端（如是否为交互式会话）。

- **ksh**：命令与编程语言；**rksh** 为受限版本，用于受控执行环境。
- **元字符**：`; & ( ) | < >` 及换行、空格、tab。

## 命令结构
- **简单命令**：`变量赋值` + `空白分隔的词`；第一个词为命令名，其余为参数。
- **管道**：命令间用 `|` 连接；默认退出状态为最后一条命令；启用 `pipefail` 后，任一失败即失败。
- **列表操作符**（优先级从低到高）：
  - `;`（顺序执行）、`&`（异步执行）、`|&`（异步执行并建立双向管道，可用 `print -p`/`read -p` 与协程通信）
  - `&&`（前命令成功才执行）、`||`（前命令失败才执行）
  - `!` 可前置管道，反转退出状态。

## 循环与选择
```bash
# 传统 for
for vname [in word ...]; do list; done
# 无 word 列表时遍历位置参数 $1 起

# C 风格 for
for ((expr1; expr2; expr3)); do list; done

# select 菜单
select vname [in word ...]; do list; done
```
- `select`：在 stderr 打印编号菜单，`PS3` 提示输入；选中项存 `vname`，原始输入存 `REPLY`；空行重印菜单；`break` 或 EOF 退出。

## 易错点
1. 管道中除最后一条命令外均在子 shell 异步执行；未开 `monitor`/`pipefail` 时只等最后一条。
2. `&` 与 `|&` 不同：后者建立双向管道（协程）。
3. `for` 省略 `in` 列表时遍历位置参数，而非空。
4. `select` 空输入重印菜单；`REPLY` 为空则下轮先重印列表。

- **case**：`case word in pattern|...) list;; ... esac`；`;;` 终止；`;&` 继续执行后续 list。
- **if**：`if list;then list;elif list;then list;...;else list;fi`；list 退出码为 0 为真，执行对应 then；全不成立且无 else 时 if 返回 0。
- **while/until**：`while list;do list;done`；while-list 最后命令退出码为 0 则执行 do-list，否则循环退出；`until` 取反判据。
- **文件扫描循环**：`while inputredirection;do list;done`；每行内容赋给 `REPLY`，字段拆分为位置参数，list 内标准输入重定向到 `/dev/null`；开启 `posix` 选项时禁用。
- **算术**：`((expr))`；表达式值非零→退出码 0，为零→1。
- **子shell**：`( list )`；嵌套时若需两个连续左括号必须加空格，避免被解析为 `(( ))`。
- **花括号组**：`{ list; }`；`{`/`}` 是保留字，须在行首或 `;` 后识别。
- **条件**：`[[ expression ]]`；真时退出码 0。
- **函数**：`function varname { list; }` 或 `varname() { list; }`；varname 含 `.` 时为纪律函数，且最后 `.` 前部分须指向已存在变量。
- **namespace**：`namespace identifier { list; }` 在命名空间运行命令。
- **后台池**：`& [name [arg...]]`；用 `&` 终止的命令放入池 name，省略 name 用默认未命名池；命名池可远程执行。

`login` 建立新会话，由 getty 自动调用；shell 中必须用 `exec login`，否则新用户可回到调用者会话。密码不回显且限次。登录后设置 UID/GID、`$HOME`、`$SHELL`、`$PATH` 等；子系统登录时 shell 首字符为 `*`，home 作新根。

```bash
login [-p] [-h host] [username] [ENV=VAR...]
login [-p] [-h host] -f username
login [-p] -r host
```

选项：`-f` 免认证（需指定 username）；`-h` 指定远程主机；`-p` 保留环境；`-r` rlogin。`-h`/`-f`/`-r` 仅 root。

易错点：`login` 不清理 utmp，需 getty/init 处理；必须用 `exec`。login 可被伪造，用 SAK 建立可信路径。

`/etc/login.defs` 关键项：
- `DEFAULT_HOME`：无法 cd 到 home 时默认拒绝登录（yes 则进入 `/`）
- `ENV_PATH`/`ENV_SUPATH`：普通/root 的 PATH
- `ERASECHAR`/`KILLCHAR`：擦除/杀行字符（默认 010/025）
- `FAIL_DELAY`：失败重试延迟
- `LOGIN_RETRIES`：最大重试次数（PAM 可覆盖）
- `LOGIN_TIMEOUT`：登录超时
- `LOG_UNKFAIL_ENAB`：记录未知用户名（有泄露风险）
- `TTYGROUP`/`TTYPERM`：终端属组/权限（默认 `0600`）
- `USERGROUPS_ENAB`：控制同名组的自动建/删
- `FAKE_SHELL`：替代用户 shell
- `CONSOLE_GROUPS`：控制台附加组，慎用

相关文件：`/var/run/utmp`、`/var/log/wtmp`、`/etc/passwd`。

- `/etc/shadow`：安全用户账户信息
- `/etc/motd`：系统当日消息
- `/etc/nologin`：阻止非 root 用户登录
- `/etc/ttytype`：终端类型列表
- `$HOME/.hushlogin`：抑制打印系统消息
- `/etc/login.defs`：shadow 密码套件配置

## man — 系统手册分页查看工具

语法：
```bash
man [选项] [章节] 页面名
man -k 关键词    # 搜索简介和页名（=apropos）
man -K 关键词    # 全文搜索
man -f 页面名    # 显示简短描述（=whatis）
man -l 文件      # 查看本地手册文件
man -w 页面      # 仅显示手册页路径
```

常用选项：
- `-a`：连续显示所有匹配章节
- `-P`：指定分页器
- `-t`：格式化为 troff/groff 输出
- `-T`：指定输出设备

手册章节：
| 章节 | 内容 |
|------|------|
| 1 | 用户命令 |
| 2 | 系统调用 |
| 3 | 库函数 |
| 4 | 特殊文件 |
| 5 | 文件格式 |
| 6 | 游戏 |
| 7 | 杂项 |
| 8 | 系统管理命令 |
| 9 | 内核例程 |

默认搜索顺序：`1 n l 8 3 0 2 3type 3posix 3pm 3perl 3am 5 4 9 6 7`，可用 `$MANSECT` 或 `/etc/manpath.config` 的 `SECTION` 覆盖。

易错点：
- 指定章节：`man 7 man` 或 `man 'man(7)'`——括号必须加引号转义，防 shell 解释。
- `-T` 输出到 stdout，需重定向；`-t` 默认输出 PostScript。
- `$MANOPT` 可设默认选项，空格参数需转义；`-D` 可忽略。

手册页标准结构：NAME、SYNOPSIS、DESCRIPTION、OPTIONS、EXIT STATUS、ENVIRONMENT、FILES、STANDARDS、NOTES、BUGS、EXAMPLES、AUTHORS、SEE ALSO。

SYNOPSIS 排版约定：
- **粗体**：原样输入
- *斜体*：替换为参数
- `[-abc]`：可选参数
- `-a|-b`：互斥
- `arg ...`：可重复

- 确定预处理器优先级：
  1. 命令行 `-p` 或环境变量 `$MANROFFSEQ`；
  2. 若未设置，解析 nroff 文件首行，格式须为 `'\" <string>`（`string` 为 `-p` 允许的字母组合）；
  3. 都没有则用默认集。

- 格式化管道由 filters + 主格式化器组成：`nroff`，或 `troff`/`groff -t`。
- 若 man 树根存在可执行 `mandb_nfmt`（`-t` 时用 `mandb_tfmt`），则改由它执行，参数为：源文件、预处理器串、`-T`/`-E` 指定设备。

- 选项重复规则：无参数选项重复（命令行或 `$MANOPT`）无害；带参数选项每次重复覆盖前值。

## 通用选项
- `-C file, --config-file=file`：指定用户配置文件，默认 `~/.manpath`
- `-d, --debug`：打印调试信息
- `-D, --default`：通常作为第一个选项，重置 `$MANOPT` 中的设置；其后选项正常生效
- `--warnings[=warnings]`：启用 groff 警告；`warnings` 为逗号分隔列表，默认 `mac`；前缀 `!` 禁用，如 `--warnings=mac,!break`

## 主要操作模式
- `-f, --whatis`：近似 `whatis`，显示手册页简短描述
- `-k, --apropos`：近似 `apropos`，在简短描述中搜索关键字并显示匹配
- `-K, --global-apropos`：全文暴力搜索所有手册页，慢，尽量指定 section；可配 `--regex` 使用正则；搜索源文件而非渲染文本，可能误报/漏报
- `-l, --local-file`：本地模式，将参数视为 nroff 源文件，不生成 cat 文件；参数 `-` 表示从 stdin 读入；参数含 `/` 时 man 自动按本地文件处理
- `-w, --where, --path, --location`：不显示手册页，只打印将格式化的源 nroff 文件位置

0install-core 手册页含 5 个命令：
- `0desktop(1)` — 桌面集成
- `0install(1)` — 主程序
- `0launch(1)` — 运行应用
- `0store-secure-add(1)` — 安全添加
- `0store(1)` — 存储管理

- 配置(5)：`99user.ldif`、`certmap.conf`、`dirsrv`、`dirsrv.systemd`、`slapd-collations.conf`
- 工具(1)：`dbscan`、`ds-logpipe`、`ds-replcheck`、`ldap-agent`、`ldclt`、`logconv`、`pwdhash`
- 服务/迁移(8)：`ns-slapd`、`openldap_to_ds`

Debian bookworm 中 bash 手册页：
- `bash-builtins(7)`：bash 内建命令参考
- `bash(1)`：bash 主手册
- `bashbug(1)`：提交 bug 工具
- `clear_console(1)`：清屏工具
- `rbash(1)`：受限 bash

## printf

按 FORMAT 格式化并输出 ARGUMENT（类似 C 的 printf）。

```bash
printf FORMAT [ARGUMENT]...
```

**转义序列**（FORMAT 内）：
- `\"` 双引号；`\\` 反斜杠；`\a` 响铃；`\b` 退格；`\c` 终止后续输出；`\e` ESC；`\f` 换页；`\n` 换行；`\r` 回车；`\t` 水平制表；`\v` 垂直制表
- `\NNN`：八进制字节（1~3 位）；`\xHH`：十六进制字节（1~2 位）
- `\uHHHH`（4 位）或 `\UHHHHHHHH`（8 位）：Unicode 字符
- `%%`：输出单个 `%`

**格式说明符**：支持 C 规范 `%d` `%i` `%o` `%u` `%x` `%X` `%f` `%F` `%e` `%E` `%g` `%G` `%c` `%s`，支持变宽（如 `%5s`）。

**特殊说明符**：
- `%b`：对 ARGUMENT 解释 `\` 转义后输出，但八进制须用 `\0` / `\0NNN`
- `%q`：以可重新作为 shell 输入的形式输出，不可打印字符用 `$''` 转义

**易错点**：shell 通常内置 `printf` 且优先于外部 coreutils 版本，格式/选项可能不同。

```bash
printf "%s:%d\n" "x" 42
printf "\x41\n"        # A
printf "%b" "a\tb\n"
printf "%q\n" "a b"    # a\ b
```

- `readline(prompt)` 从终端读取一行，返回 `malloc` 分配的字符串（调用者须 `free`），去除末尾换行；`prompt` 为 `NULL`/空串则不提示。
- 返回：空行返回 `""`；行首 EOF 返回 `NULL`；非空行遇 EOF 视为换行。
- 默认 Emacs 编辑模式，可切换 vi 模式；支持 kill/yank 和 kill ring。

- 按键记号：`C-x`=Ctrl+x；`M-x`=Meta+x（无 Meta 键时用 `ESC x`）；`M-C-x`=ESC+Ctrl+x。
- 数字参数常为重复次数；负参数使前进方向命令反向（如 `kill-line`）。

### 初始化文件 inputrc
- 查找顺序：`$INPUTRC` → `~/.inputrc` → `/etc/inputrc`。
- 语法：空行忽略；`#` 注释；`$` 条件构造；其余为键绑定/变量设置。
- 键绑定格式：`keyname: function-name` 或 `"keyseq": "macro"`。
  ```
  Control-u: universal-argument
  Meta-Rubout: backward-kill-word
  "\C-u": universal-argument
  "\C-x\C-r": re-read-init-file
  "\e[11~": "Function Key 1"
  ```
- 符号键名：`DEL`、`ESC`、`TAB` 等；`keyseq` 支持 `\C-`、`\M-`、`\e`，以及 `\a \b \d \n \r \t \v \nnn \xHH`。
- 宏用引号包裹；未加引号视为函数名。
- 变量：`set variable-name value`；`On`/`Off`（或 `1`/`on`）。
- Bash 可用 `bind` 查看/修改绑定，`set -o` 切换编辑模式。

- `active-region-start-color`：活动区域文本前置/背景色转义序列，须不占字符位，默认取 terminfo standout，示例 `"\e[01;33m"`。
- `active-region-end-color`：活动区域结束后恢复终端显示，示例 `"\e[0m"`。
- `bell-style (audible)`：响铃策略；`none` 不响，`visible` 可视铃，`audible` 响铃。
- `bind-tty-special-chars (On)`：On 时绑定内核终端驱动特殊控制字符到 readline 等价键。
- `blink-matching-paren (Off)`：On 时插入右括号时短暂移动光标到匹配左括号。
- `colored-completion-prefix (Off)`：On 时补全列表的公共前缀用不同颜色，颜色取自 `LS_COLORS`；支持自定义 `readline-colored-completion-prefix` 条目。
- `colored-stats (Off)`：On 时补全项按文件类型用不同颜色，颜色取自 `LS_COLORS`。
- `comment-begin ("#")`：vi 模式执行 `insert-comment` 时插入的字符串；emacs 绑定 `M-#`，vi 命令模式绑定 `#`。
- `completion-display-width (-1)`：补全匹配显示列数；<0 或 >屏幕宽忽略；0 则每行一项。
- `completion-ignore-case (Off)`：On 时文件名匹配与补全忽略大小写。
- `completion-map-case (Off)`：On 且启用 `completion-ignore-case` 时，忽略大小写匹配中 `-` 与 `_` 等价。
- `completion-prefix-display-length (0)`：公共前缀超过此长度时用省略号显示；0 表示原样显示。
- `completion-query-items (100)`：补全项数达到该值时询问用户是否显示列表。

- POSIX 正则（`<regex.h>`，链接 `-lc`）
- 核心函数：`regcomp()` 编译；`regexec()` 匹配；`regerror()` 错误转字符串；`regfree()` 释放。
- `int regcomp(regex_t *preg, const char *regex, int cflags);`
- `int regexec(const regex_t *preg, const char *string, size_t nmatch, regmatch_t pmatch[], int eflags);`
- cflags：
  - `REG_EXTENDED`：ERE 语法；否则 BRE。
  - `REG_ICASE`：忽略大小写。
  - `REG_NOSUB`：不记录匹配位置，忽略 nmatch/pmatch。
  - `REG_NEWLINE`：`.`/`[^...]` 不匹配换行；`^`/`$` 可匹配换行前后空串。
- eflags：
  - `REG_NOTBOL`：`^` 不匹配行首。
  - `REG_NOTEOL`：`$` 不匹配行尾。
  - `REG_STARTEND`：用 `pmatch[0]` 的 rm_so/rm_eo 限定输入范围，支持嵌入 NUL（BSD 扩展）。
- 匹配位置：`typedef struct { regoff_t rm_so, rm_eo; } regmatch_t;`
  - `pmatch[0]` 为整个匹配，`pmatch[i]` 为第 i 个括号子表达式，未用元素为 -1；需 N 个子表达式时 `nmatch` 至少为 `N+1`。
- 返回值：`regcomp`/`regexec` 成功均返回 0；失败时分别返回错误码或 `REG_NOMATCH`。
- 易错点：必须先 `regcomp` 编译，才能 `regexec`。
- 常见错误码：`REG_EBRACE`/`REG_EBRACK`/`REG_EPAREN`（括号/方括号不匹配）、`REG_ERANGE`（范围非法）、`REG_BADRPT`（重复符开头）、`REG_ESPACE`（内存不足）。

- `regcomp()`：编译正则，失败返回非0；`REG_NEWLINE` 使 `.` 不匹配换行
- `regexec()`：成功返回0；`pm[0]` 存 `rm_so`/`rm_eo`；全局偏移=`rm_so+(s-str)`；循环匹配后 `s+=rm_eo`
- 易错：`pm` 数组大小须≥捕获组数+1

```c
off = pm[0].rm_so + (s - str);
len = pm[0].rm_eo - pm[0].rm_so;
s += pm[0].rm_eo;
```

# dash

Debian 标准 shell，遵循 POSIX，非 ksh clone。

调用：`dash [-options] [file [args...]]`、`dash -c command_string [name [args...]]`、`dash -s [args...]`。无参数且 stdin 为终端时为交互 shell；参数 0 以 `-` 开头按登录 shell 处理，读 `/etc/profile`、`.profile`；非选项首参数为脚本文件。

常用选项（`-o name` 等价；`-` 开 `+` 关）：
- `-c`：从字符串读命令；`-s`：从 stdin 读命令；`-i`：交互
- `-a`：赋值自动导出；`-C`：`>` 不覆盖已有文件；`-f`：禁用路径名展开
- `-e`：非交互下未测试命令失败即退出；`-u`：展开未设置变量报错并不交互退出；`-n`：语法检查不执行；`-v`：读入回显；`-x`：执行前输出（前缀 `+`）
- `-I`：交互忽略 EOF；`-l`：按登录 shell；`-m`：作业控制；`-V`/`-E`：vi/emacs 行编辑；`-p`：不重置有效 UID

词法：按空白与操作符分词。控制符：`& && ( ) ; ;; | || <newline>`；重定向符：`< > >| << >& >& <<- <>`。

引用：`\` 保留下一字符字面义，`\`+换行续行；单引号、双引号去除对应特殊含义。

### 引号
- 单引号：全字面，内部不能含单引号。
- 双引号：保留除 `$`、`` ` ``、`\` 外字面；反斜杠仅转义 `` $ ` " \ `` 和换行。

### 保留字
行首或控制操作符后识别：`! elif fi while case else for then { } do done until if esac`

### 别名
`alias name=value`；在保留字检查后、命令执行前替换。慎用。

### 命令
行首首词非保留字→简单命令；否则复合命令。

### 简单命令流程
1. 剥离 `name=value`（命令环境）及重定向。
2. 展开剩余词；首词为命令名，其余作参数；无命令名则赋值作用于当前 shell。
3. 执行重定向。

### 重定向
格式 `[n] redir-op file`（n=0–9）

| 操作 | 含义 |
|---|---|
| `[n]> file` | 输出/fd n 覆盖到 file |
| `[n]>| file` | 同上，强制覆盖 `-C` |
| `[n]>> file` | 追加 |
| `[n]< file` | 输入/fd n 从 file |
| `[n1]<&n2` | 复制 fd n2 为输入 |
| `[n]<&-` | 关闭标准输入/n |
| `[n1]>&n2` | 复制 fd n2 为输出 |
| `[n]>&-` | 关闭标准输出/n |
| `[n]<> file` | 读写打开 file |

易错：`<&` `>&` 方向以符号朝向为准；`>|` 覆盖 noclobber。

### Here-document
```
[n]<< delimiter
text...
delimiter
```
分隔符前内容作为命令标准输入。

```c
int stat(const char *restrict pathname, struct stat *restrict statbuf);
int fstat(int fd, struct stat *statbuf);
int lstat(const char *restrict pathname, struct stat *restrict statbuf);
int fstatat(int dirfd, const char *restrict pathname, struct stat *restrict statbuf, int flags);
```

- `stat` 取路径状态（需目录执行权限）；`lstat` 不追踪符号链接；`fstat` 经 fd 等价；`fstatat` 通用：相对路径基于 dirfd，`AT_FDCWD` 为当前目录，绝对路径忽略 dirfd。
- `fstatat` flags：`AT_EMPTY_PATH`（空串操作 dirfd，需 `_GNU_SOURCE`）、`AT_SYMLINK_NOFOLLOW`（同 lstat）。
- 失败返回 -1 并设 `errno`。`EACCES` 无搜索权限；`ENOENT` 缺失/悬空/空串无 flag；`ENOTDIR` 前缀或 dirfd 非目录；`EBADF` fd 无效；`ELOOP` 链接过多；`EOVERFLOW`：32 位未配大文件支持。
- 易错：`stat` 字段非原子快照；`lstat` 对链接字段可移植性有限；`st_blocks`/`st_blksize` 各系统/NFS 下解释不同。

- `stat` 结构体：`old_kernel_stat`（窄字段）、`stat`（`st_ino` 变大，有填充）、`stat64`（`st_ino` 更大，`st_uid/gid` 扩展至 32 位；Linux 2.6 后填充被设备 ID 与纳秒时间戳占用）
- glibc：`stat()` 自动调用内核最新系统调用并兼容旧二进制；现代 64 位系统为单一系统调用；`fstatat()` 底层是 `fstatat64()`/`newfstatat()`
- `lstat()` 示例：
  ```c
  struct stat sb;
  if (lstat(argv[1], &sb) == -1) { perror("lstat"); exit(1); }
  printf("dev: [%x,%x]\n", major(sb.st_dev), minor(sb.st_dev));  // 需 <sys/sysmacros.h>
  ```
- 常用字段：`st_mode`、`st_ino`、`st_nlink`、`st_uid/gid`、`st_size`、`st_blocks`、`st_atime/ctime/mtime`；输出用 `%ju`/`%jd`
- 文件类型用 `S_IFMT` 掩码判断：`S_IFBLK`/`S_IFCHR`/`S_IFDIR`/`S_IFIFO`/`S_IFLNK`/`S_IFREG`/`S_IFSOCK`
- `major()`/`minor()` 设备号用十六进制 `%x`，需 `<sys/sysmacros.h>`
- `st_ctime` 是状态变更时间，非创建时间
- 相关：`ls(1)`、`stat(1)`、`statx(2)`、`access(2)`、`chmod(2)`、`chown(2)`

## strcmp / strncmp — 字符串比较

- 头文件：`#include <string.h>`
- 原型：
```c
int strcmp(const char *s1, const char *s2);
int strncmp(const char s1[.n], const char s2[.n], size_t n);
```
- 功能：按**无符号字符**逐字节比较，不考虑 locale（locale 感知用 `strcoll(3)`）。
- 返回值：
  - `0`：相等；
  - 负值：`s1` < `s2`；
  - 正值：`s1` > `s2`。
- `strncmp` 仅比较前 `n` 字节（至多）。

**易错点**
- 返回值不一定是 `-1`/`1`，而是**最后比较字节的算术差**（glibc 中为 `s1` 字节减 `s2` 字节），如 `'C' - '\0' = 67`。
- 比较使用 `unsigned char`，二进制高位字符不会因符号位被误判。
- `strncmp` 遇 `\0` 即停止，未达到 `n` 字节也可能返回。
- 标准：POSIX.1-2001/2008、C99、SVr4、4.3BSD；线程安全（MT-Safe）。

- **功能**：按当前 locale 的 `LC_COLLATE` 规则比较字符串 `s1` 与 `s2`。
- **原型**：
```c
#include <string.h>
int strcoll(const char *s1, const char *s2);
```
- **返回值**：`<0` / `0` / `>0`，对应 `s1` 小于/等于/大于 `s2`。
- **关键点**：
  - 受 `setlocale(3)` 影响，比较规则由 `LC_COLLATE` 决定。
  - 在 POSIX 或 C locale 下，行为等同于 `strcmp()`。
  - 线程安全：MT-Safe locale。
- **易错点**：未调用 `setlocale()` 时，默认 "C" locale，此时与 `strcmp` 无差别；需本地化排序时务必先设置 locale。

```c
size_t strftime(char s[restrict .max], size_t max,
                const char *restrict format,
                const struct tm *restrict tm);
```

功能：按 `format` 格式化 `tm` 到 `s`，返回写入字符数；缓冲区过小返回 0。普通字符原样复制。

**日期**
- `%Y` 四位年；`%C` 世纪（年/100）
- `%m` 月 01–12；`%b`/`%B` 月名缩写/全名
- `%d` 日 01–31；`%e` 前导 0 换空格
- `%j` 年内第几天 001–366
- `%F` = `%Y-%m-%d`

**时间**
- `%H` 24 时；`%I` 12 时；`%M` 分；`%S` 秒 00–60
- `%p` AM/PM；`%P` 小写
- `%T` = `%H:%M:%S`；`%R` = `%H:%M`；`%r` = `%I:%M:%S %p`
- `%s` 1970 起秒数

**星期/周**
- `%a`/`%A` 星期缩写/全名
- `%u` 1–7（周一=1）；`%w` 0–6（周日=0）
- `%U` 周数（周日始）；`%W`（周一始）；`%V` ISO 8601 周

**其他**
- `%c` locale 日期时间；`%n` 换行；`%t` 制表符
- 修饰符 `%E`/`%O`

**易错点**
- `%D` 美式格式，非国际通用
- `%U`/`%W`/`%V` 周数基准不同
- `%e` 与 `%d` 前导字符不同
- `%S` 可为 60（闰秒）
- `%c`、`%a`、`%B` 随 locale 变化

### strftime 核心知识点

**常用格式符**
- `%W`：年周数（00–53），以第一个周一为第01周起点，由 `tm_yday`、`tm_wday` 计算
- `%x`：区域设置日期（无时间），POSIX 区域等价 `%m/%d/%y`
- `%X`：区域设置时间（无日期），POSIX 区域等价 `%H:%M:%S`
- `%y`：两位年份（00–99），由 `tm_year` 计算
- `%Y`：四位年份，由 `tm_year` 计算
- `%z`：UTC 偏移，格式 `+hhmm` 或 `-hhmm`（SU）
- `%Z`：时区名称或缩写
- `%+`：`date(1)` 格式的日期时间（TZ，glibc 2 不支持）
- `%%`：字面量 `%`

**修饰符**
- `E` / `O` 前缀表示区域替代格式；若当前区域无对应替代，行为同未修饰
- `O` 修饰：替代数字符号（如罗马数字）
- `E` 修饰：区域相关替代表示（如 `ja_JP` 的和历纪元）
- 典型替代：`%Ec` `%EC` `%Ex` `%EX` `%Ey` `%EY` `%Od` `%Oe` `%OH` `%OI` `%Om` `%OM` `%OS` `%Ou` `%OU` `%OV` `%Ow` `%OW` `%Oy`

**strftime_l()**
- 等同 `strftime()`，但使用指定 `locale`；`locale` 无效或为 `LC_GLOBAL_LOCALE` 时行为未定义

**返回值与易错点**
- 成功：返回写入 `s` 的字节数（不含终止 null 字节）
- 若结果含终止 null 字节超过 `max`，返回 0，`s` 内容未定义
- **返回 0 未必是错误**：如 `%p` 在多数区域产生空串，空格式串也返回 0

**环境变量**
- 受 `TZ` 和 `LC_TIME` 影响

**线程安全**
- `strftime()` / `strftime_l()`：MT-Safe env locale

- **功能**：gawk 时间扩展，提供 `gettimeofday()` 和 `sleep()` 两个函数。
- **加载**：`@load "time"`
- **⚠️ 已弃用**：建议改用 `gawkextlib` 项目中的 `timex` 扩展；当前加载会告警，未来将从 gawk 发行版移除。

## 函数
- `gettimeofday()`：返回自 Epoch 起的秒数（浮点数，含亚秒精度）；出错返回 -1 并设置 `ERRNO`。
- `sleep(seconds)`：暂停指定秒数，支持小数；`seconds` 为负或调用失败时返回 -1 并设置 `ERRNO`，成功返回 0。

## 示例
```awk
@load "time"
printf "It is now %g seconds since the Epoch\n", gettimeofday()
sleep(2.5)
```

## 易错点
- 不要在新代码中使用此扩展，优先 `timex`。
- 使用前必须 `@load "time"`，否则函数未定义。

# vim 核心知识点

- 定位：Vi 增强版，支持多级撤销、多窗口/缓冲、语法高亮、可视选择。
- 启动：`vim [options] [file ..]`（`:next` 切换后续文件）；`vim -` 读 stdin；`vim -t tag` 定位；`vim -q [errorfile]` quickfix 模式（`:cn` 下一错误）。文件名以 `-` 开头时，文件列表前加 `--`。
- 变体：`ex`=Ex 模式；`view`=只读；`gvim`=GUI；`evim`=easy GUI；`rvim`=受限模式（禁 shell）。
- 关键选项：
  - `+num`：光标到第 num 行；无 num 到最后一行
  - `+/{pat}`：定位第一个匹配
  - `+{command}`/`-c {command}`：读入后执行 Ex 命令（最多 10 个）
  - `--cmd {command}`：vimrc 加载前执行（独立于 `-c`）
  - `-S {file}`：读入后 source；省略 file 用 `Session.vim`
  - `-b` 二进制；`-d` diff 模式（需 2~8 个文件）
- 易错点：
  - 选项可在文件名前/后任意顺序；无参选项可合并于一个 `-` 后
  - `-q` 默认错误文件：`errors.err`（非 Amiga）
  - `-c` 命令含空格必须用双引号包裹

### Vim 启动选项核心知识点

- **`-M`**：禁止修改（`modifiable`/`write` off，可 `:set` 重开）。
- **`-N`**：非兼容模式，重置 `compatible`（无 .vimrc 也生效）。
- **`-n`**：不用交换文件，崩溃不可恢复；等效 `:set uc=0`，可用 `:set uc=200` 恢复。
- **`-o[N]` / `-O[N]`**：水平/垂直分 N 窗口；省略 N 时每文件一窗口。
- **`-p[N]`**：N 标签页；省略 N 时每文件一标签页。
- **`-R`**：只读模式（置 `readonly`）；`:w!` 强制写，`:set noro` 取消；隐含 `-n`。
- **`-r`**：列出交换文件；`-r {file}` 恢复崩溃会话。
- **`-s {scriptin}`**：读脚本作键盘输入（等效 `:source!`），读毕继续读键盘。
- **`-u {vimrc}`**：用指定 vimrc 初始化；`NONE` 跳过全部。
- **`-U {gvimrc}`**：指定 GUI 初始化；`NONE` 跳过。
- **`-V[N]`**：冗长模式，N 为 `verbose` 值，默认 10。
- **`-w` / `-W {scriptout}`**：记录键入到文件（追加/覆盖）。
- **`-x`**：写文件加密，提示密钥。
- **`-X`**：不连 X server，启动快，但窗口标题/剪贴板不可用。
- **`--`**：选项结束，后续参数视为文件名（编辑以 `-` 开头文件）。
- **`--clean`**：不使用个人配置（vimrc、插件等）。

---
来源：consolidated/cmd-tools/Bash 与 Shell 手册.md