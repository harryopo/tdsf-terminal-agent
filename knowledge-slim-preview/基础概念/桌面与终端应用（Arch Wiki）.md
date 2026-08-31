---
source: archwiki
category: basic-ops
url: consolidated/basic-ops/桌面与终端应用（Arch Wiki）.md
title: 桌面与终端应用（Arch Wiki）
---

- 桌面/终端：`Xorg`/`xinit` 显示栈，`awesome`/`KDE` 桌面，`tmux`/`GNU Screen` 复用，`Emacs` 编辑。

- **awesome**：基于 Xorg 的平铺窗口管理器，高度可配置。
- **安装**：`pacman -S awesome`；如需最新版，用 AUR 包 `awesome-git`。
- **启动**：在 `~/.xinitrc` 加 `awesome`；或用显示管理器。
- **配置**：Lua 文件 `~/.config/awesome/rc.lua`。复制模板：
  ```bash
  mkdir -p ~/.config/awesome/
  cp /etc/xdg/awesome/rc.lua ~/.config/awesome/
  ```
  **易错**：升级后 API 变化，异常时重新复制模板。
- **自启动**：创建 `~/.config/awesome/autorun.sh`：
  ```sh
  #!/bin/sh
  run() { if ! pgrep -f "$1"; then "$@"& fi; }
  run "program [args]"
  ```
  在 `rc.lua` 中：`awful.spawn.with_shell("~/.config/awesome/autorun.sh")`
- **键盘布局**：临时切换 `setxkbmap -layout "us,de" -option "grp:alt_shift_toggle"`；在 `rc.lua` 的 `globalkeys` 绑定：
  ```lua
  awful.key({ "Shift" }, "Alt_L", function () mykeyboardlayout.next_layout(); end)
  ```
- **主题**：用 Beautiful 库动态换色/壁纸。

**主题配置**：默认主题在 `/usr/share/awesome/themes/default`，复制到 `~/.config/awesome/themes/` 后，`rc.lua` 中用 `beautiful.init(theme_path)` 指定，其中 `local theme_path = string.format("%s/.config/awesome/themes/%s/theme.lua", os.getenv("HOME"), "default")`。切换主题时替换 `"default"`；加 `beautiful.useless_gap = 5` 增加间隙；⚠️ 不支持位图字体。

**壁纸**：`theme.lua` 中设 `theme.wallpaper = "/绝对路径"` 或 `theme_path .. "path/to/wallpaper.png"`；`rc.lua` 中设 `beautiful.wallpaper = awful.util.get_configuration_dir() .. "path/to/wallpaper.png"`。

**wibox 隐藏/显示**（4.0）：绑定 `modkey+b`，动作：
`myscreen = awful.screen.focused(); myscreen.mywibox.visible = not myscreen.mywibox.visible`。

**截图**：装 `scrot`，用 `awful.util.spawn("scrot -e 'mv $f ~/screenshots/ 2>/dev/null'", false)` 绑定 `Print`。

**移除窗口间隙**：在 `awful.rules.rules` 的 `properties` 加 `size_hints_honor = false`。

**透明度**：聚焦/失焦信号中设 `c.opacity = 1` / `0.7`，也可同时设 `c.border_color`。

## 桌面条目

- XDG Desktop Entry 规范定义应用集成到桌面环境菜单的标准，格式类 INI
- 文件后缀 `.desktop`，含 `[Desktop Entry]` 区段；`Type`、`Name` 必填
- 三种类型：
  - `Type=Application`：启动应用及 MIME 支持，可配合 XDG Autostart 自启动
  - `Type=Link`：URL 快捷方式
  - `Type=Directory`：定义子菜单外观（用 `.directory` 后缀）
- 存放位置：系统级 `/usr/share/applications/`、`/usr/local/share/applications/`；用户级 `~/.local/share/applications/`（用户条目优先，可覆盖/隐藏系统条目）
- 命令行调用：`dex /usr/share/applications/firefox.desktop`

```ini
[Desktop Entry]
Type=Application
Version=1.0
Name=jMemorize
Comment=Flash card based learning tool
Path=/opt/jmemorise
Exec=jmemorize
Icon=jmemorize
Terminal=false
Categories=Education;Languages;Java;
```

关键点/易错：
- 规范仅要求 `Type`、`Name`；但 Application 条目至少需 `Name=`、`Exec=` 才可定位可执行文件
- `Exec` 指定可执行文件（可带参数）；`Path` 为运行目录；`Terminal` 控制是否在终端运行
- 部分启动器（如 dde-open）要求 .desktop 文件具可执行位

### Desktop Entry 核心
- `Type`必填：常用`Application`
- `Name`必填：应用正式名称
- `GenericName`：通用功能名，如 Firefox→Web Browser
- `Comment`/`Keywords`：辅助搜索
- `TryExec`/`Exec`：指定程序

```ini
Name=Pidgin
GenericName=Internet messenger
```

### Exec 字段码
- `Exec`使用可执行名或绝对路径（后者更安全）
- `%f/%F`：单/多文件；`%u/%U`：单/多URL；`%i`：展开为`--icon`+`Icon`值

### Flatpak 文件转发
```bash
Exec=/usr/bin/flatpak run --command=imhex --file-forwarding net.werwolv.ImHex @@u %U @@
```
- `@@`间为文件路径，`@@u`~`@@`为URI导出（非持久）

### 上下文菜单动作
示例 `~/.local/share/contractor/notify-send.contract`：
```ini
[Contractor Entry]
Name=Notify
Icon=dialog-information
Description=Create a notify-send notification with the current filename(s)
MimeType=!inode;
TryExec=notify-send
Exec=notify-send %i -u low "Message from Files" "%F"
```
- `%i`展开为`--icon dialog-information`，参数顺序重要。

## 3. 桌面通知

- 异步被动弹窗；libnotify 提供 `notify-send`。

### 通知服务器

- GNOME 等内置自动启动，一般不可替换；KDE Plasma：系统托盘设置禁用 Notifications，再 Autostart 添加，需重新登录。

### 独立服务器

- 注册为 D-Bus 服务，首次调用自动拉取。若缺失，创建 `$XDG_DATA_HOME/dbus-1/services/org.freedesktop.Notifications.service`：

```ini
[D-BUS Service]
Name=org.freedesktop.Notifications
Exec=/usr/lib/notification-daemon-1.0/notification-daemon
```

### 常用实现

- Dunst（极简，平铺 WM，1.6+ 支持 Wayland）、mako（Wayland 轻量）、swaync（GTK/Sway）、fnott（wlroots）、notification-daemon（原版）、xfce4-notifyd（配置 `xfce4-notifyd-config`）。

### 技巧

向另一用户发通知（root 后台）：

```bash
# systemd-run --machine=target_user@.host --user notify-send 'Hello world!' 'This is an example notification.'
```

# 桌面通知（notify-send）

- 替换通知：`notify-send` 不报 ID；用 `notify-send.py`，或加 `-h string:x-canonical-private-synchronous:my-notification` 使新通知替换旧通知（部分服务器适用）。
- 按钮/点击：`notify-send.py` 的 `--action id:label` 添加按钮；`--hint boolean:action-icons:true` 显示图标；`default` 监听默认点击，输出触发标识或 `close`。
- 多服务器：覆盖 `org.freedesktop.Notifications.service` 指定 D-Bus 服务。
- 故障：应用挂起 1 分钟，通知服务虚假可用；检查：`find /usr/share/dbus-1/services/ -name '*Notif*'`；`journalctl -g notif`。

# Emacs

- 安装：`emacs`（GUI）、`emacs-nox`（无 GUI）、`emacs-wayland`（PGTK）；拼写需 `aspell` + `aspell-en`。
- 启动：`emacs`（GUI），`-nw`（终端），`-Q -nw`（快速，不读配置）；退出/教程：`C-x C-c` / `C-h t`。
- 守护进程：`emacs --daemon`；`emacsclient -nc`（新 GUI frame）、`-t`（终端）、`-n`（不等待）；Git/Mutt 须等待，用 `emacsclient -a "" -t`，勿加 `-n`。
- systemd：26.1 起自带用户单元（非系统级）；Wayland 需 drop-in（除非 `emacs-wayland`）；不继承登录 shell 环境变量。

### 守护进程与 emacsclient
- `VISUAL`/`EDITOR` 设为 `emacsclient`；**勿**用 `-n`（否则不等待编辑完成）。

### 帮助
- `C-h t` 教程；`C-h i` info（`m` 选手册）。

### 配置
- `M-x customize` 后 `Apply and Save`。
- init 顺序：`~/.emacs`、`~/.emacs.el`、`~/.emacs.d/init.el`、`~/.config/emacs/init.el`。

### TRAMP 远程文件
路径：`/[protocol]:[[user@]host]:<file>`

```lisp
C-x C-f /sudo::/etc/hosts
C-x C-f /ssh:you@remotehost:~/example.txt
```

### Eglot（LSP）
```lisp
(add-hook 'foo-mode-hook 'eglot-ensure)
```
- `foo` 替换为语言名；全局用 `prog-mode-hook`。

### 复用 emacs 会话
init 中：
```lisp
(require 'server)
(unless (server-running-p)
  (server-start))
```

- 别名不足（变量/独立会话）：用 `.bashrc` 定义同名函数。
- 无参数：`/usr/bin/emacs` 防递归；有参数：`emacsclient`。

```bash
emacs() { [[ $# -eq 0 ]] && /usr/bin/emacs || emacsclient "$@"; }
```

## Folding@home
- 安装：`foldingathome` (AUR)；GPU 需 `ocl-icd`+OpenCL，NVIDIA 加 `CUDA`。
- 服务：`fah-client.service`；配置仅 Web Control，Machines 页点 Fold All。
- 账户：`Username`（匿名用 Anonymous）、`Team`（Arch 45032）、`Passkey`（官网获取）、`Cause`（默认 any）。
- 调度：`Only When Idle`/`While On Battery`/`Keep Awake`；资源：`CPUs`/`GPUs`。
- 权限：>7.6.9 默认受限，GPU 需 `video` 组。
- 监控：`tail -10 /var/log/fah-client/log.txt`；NVIDIA `nvtop`，AMD `radeontop`。
- AMDGPU Disabled：Navi 10+ 与 ROCm 冲突。修复：替换核心 `libstdc++.so.6`（先 `cd /var/lib/fah-client/cores/openmm-core-*/centos-*-64bit/release/fahcore-*-centos-*-64bit-release-*`，再复制 `/usr/lib/libstdc++.so.6` 覆盖；新核心需重做）；或 `/etc/fah-client/config.xml` 加 `<gpu v='true'/>`；试用 `rocm-opencl-runtime`/`opencl-amd`；移除 `opencl-mesa`，确保 `/etc/OpenCL/vendors` 唯一。

## GNU Screen
- 终端复用器；分屏，会话分离后进程继续。安装：`screen`。
- 命令：`Ctrl+a` + 绑定键；转义键可自定义。

## GNU Screen 核心知识点

- 默认前缀键 `Ctrl+a`，以下组合均基于此前缀。
- 常用操作：
  - `Ctrl+a c` 新建窗口；`Ctrl+a 0-9` 切换窗口；`Ctrl+a A` 重命名；`Ctrl+a "` 窗口列表
  - `Ctrl+a S`/`|` 水平/垂直分屏；`Ctrl+a tab` 切换区域；`Ctrl+a X` 关闭当前区域；`Ctrl+a Q` 关闭其他区域
  - `Ctrl+a d` 脱离会话（后台继续），用 `screen -r` 恢复
- 命令模式 `Ctrl+a :`：`quit` 退出；`source ~/.screenrc` 重载；`sessionname newname` 重命名会话
- 命名会话：
  ```bash
  screen -S name        # 创建
  screen -list          # 列出
  screen -r name        # 附加
  screen -x name        # 强制附加（多终端）
  ```
- `~/.screenrc`：
  - 改前缀键：`escape ^Jj`（或 `screen -e ^Jj`），第二个字符传入字面 `Ctrl+j`
  - `startup_message off` 关闭欢迎消息；`term screen-256color` 启用256色
- 嵌套：外层用 `Ctrl+a`，对内层发命令先按 `Ctrl+a a`，如 `Ctrl+a a d` 分离内层
- 自动进入（Bash/Zsh）：
  ```bash
  [[ -z "$STY" ]] && screen -xRR session_name
  ```
  加入 `~/.bashrc` 或 `~/.zshrc`
- 状态栏：`hardstatus alwayslastline '...'` 设底部状态栏；`hardstatus firstline` 置顶

### GNU Screen

`~/.screenrc` 配置：
```screenrc
termcapinfo xterm*|rxvt*|kterm*|Eterm* ti@:te@
vbell off
rendition so =00
caption string "%{03} "
altscreen on
windowlist string "%4n %h%=%f"
```
- 第1行启用终端滚轮；`vbell off` 关闭视觉铃；`rendition so =00` 去除垂直条；`caption string "%{03} "` 隐藏水平条（无效换 `"%{00} "`，默认黑白 `"%{00}%3n %t"`）；`altscreen on` 修复关闭编辑器后残留文本；`windowlist string` 修复列表名仅显示bash。
- 纳入已运行程序：安装 `reptyr`，`ps ax` 查PID，Screen窗口内执行 `reptyr pid`
- 区分提示符：`~/.bashrc` 中根据 `$STY` 设置不同 PS1：
```bash
if [ -z $STY ]; then PS1="正常提示符"; else PS1="Screen提示符"; fi
```

### MPD

- 服务端-客户端架构播放器，占用低；替代品 `mopidy`（Python，支持云服务插件）
- 安装：`mpd` 包
- 配置位置：用户模式 `~/.config/mpd/mpd.conf`；系统模式 `/etc/mpd.conf`
- 常用配置项：`pid_file`、`db_file`、`state_file`、`playlist_directory`、`music_directory`、`sticker_file`
- 初始化用户配置：
```bash
mkdir -p ~/.config/mpd
cp /usr/share/doc/mpd/mpdconf.example ~/.config/mpd/mpd.conf
```
- 音频后端：先配置 ALSA，可选 PulseAudio/PipeWire

- 配置：`~/.config/mpd/mpd.conf`
- 启用 playlist/state 前先建目录：`mkdir -p ~/.config/mpd/playlists ~/.local/state/mpd`
- 启动：`mpd [config]`；建库：`mpc update` 或 `auto_update "yes"`

- 音频输出：
  - ALSA：`audio_output { type "alsa" name "ALSA" }`
  - PulseAudio：`audio_output { type "pulse" name "Pulse" }`
  - PipeWire：`audio_output { type "pipewire" name "PipeWire" }`
  - 查看设备：`aplay --list-pcm`；sink/target：`pactl list short sinks`
  - 易错：Pulse/PipeWire 不指定 target 时可能无法用 `pavucontrol` 切换

- Unix socket（仅本机）：`bind_to_address` 须为绝对路径/变量，相对路径失败
```
bind_to_address "$XDG_RUNTIME_DIR/mpd/socket"
export MPD_HOST="$XDG_RUNTIME_DIR/mpd/socket"
```

- systemd 用户服务：`mpd.service` 以用户运行，默认读 `~/.config/mpd/mpd.conf`，自定义路径需编辑 unit
- tty 登录自启：`~/.profile` 加 `mpd`

- MPD 启动（无其他用户实例时）：`[ ! -s ~/.config/mpd/pid ] && mpd`
- 脚本化配置：`mpd-configure` 生成 bit-perfect 播放配置（无重采样/转换），使用 ALSA 硬件地址 `hw:x,y`
- 系统级配置：默认 `/etc/mpd.conf`，数据目录 `/var/lib/mpd`（属主/组为 MPD）。PulseAudio 用户需变通以独立用户运行 MPD
- 音乐目录：由 `music_directory` 定义。MPD 需对所有父目录有执行权限、对音乐目录有读权限，与 `~/Music` 默认权限冲突。解决：改用 per-user 配置；或将 `mpd` 用户加入用户组并授予组执行权限

## MPD
- 权限：`gpasswd -a mpd user_group_name`；`chmod 710 /home/user_directory`
- 音乐库可整体移动、绑定挂载或 Btrfs 子卷；持久化写 `/etc/fstab`
- 仅支持单音乐目录；多目录在 `/var/lib/mpd` 下建符号链接并设权限
- 父目录放 `.mpdignore`，每行 shell 通配符，匹配当前及子目录
- 可读取压缩包内音乐（tar 除外）
- systemd 启动 `mpd.service`；用 `ncmpc` 测试

## KDE Plasma
- 安装：`plasma-meta`/`plasma` 完整；最小用 `plasma-desktop`；NVIDIA 需启用 DRM KMS
- 应用组：`kde-applications-meta`/`kde-applications`（不含 Plasma）
- Plasma 6.4+ 默认 Wayland；X11 会话需 `plasma-x11-session`，6.8 将移除
- 显示管理器选 *Plasma (Wayland)* / *Plasma (X11)*
- Wayland 启动：`/usr/lib/plasma-dbus-run-session-if-needed /usr/bin/startplasma-wayland`
- X11 启动：`.xinitrc` 加 `export DESKTOP_SESSION=plasma` 和 `exec startplasma-x11`，或 `startx /usr/bin/startplasma-x11`
- 配置存于 `~/.config/`；图形化用 `systemsettings`
- 多屏：`Super+p` 切换镜像/扩展；`kscreen` 管理
- 主题：`lookandfeeltool` 应用全局主题，另有 Plasma 主题、应用样式、图标主题

# KDE 相关
- 第三方主题有执行任意代码风险；Qt5 应用需 `plasma5-integration` 兼容主题（如 `breeze5`），编辑主题装 `plasma-sdk`。
- GTK 应用：装 `kde-gtk-config` 后重登，系统设置选 `Breeze`。Plasma 会覆盖手动 GTK 配置，可 `chmod -w ~/.config/gtk-3.0/settings.ini` 避免。
- 头像：`/var/lib/AccountsService/icons/`，系统设置 > 用户配置。
- 部件：AUR 安装或桌面右键 > 编辑模式 > 添加部件。
- 声音：`plasma-pa`（默认）或 `kmix`；步长在 `~/.config/kmixrc` `[Global]` 加 `VolumePercentageStep=1`。

# tmux
- 终端复用器，可分离/后台重附；安装 `tmux`。
- 配置：`$XDG_CONFIG_HOME/tmux/tmux.conf`（默认 `~/.config/tmux/tmux.conf`），全局 `/etc/tmux.conf` 默认无。
- 前缀 `Ctrl+b`：
  - `%` 垂直分割；`o` 交换窗格；前缀+方向键调大小。
  - `c` 新建窗口；`n`/`p` 切换；`l` 上一个；`w` 列表；`0-9` 跳转；`f` 查找。
- 改前缀示例：
```
unbind C-b
set -g prefix C-a
bind C-a send-prefix
```
- 复制模式：`Ctrl+b [` 进入；默认 emacs 风格，`VISUAL`/`EDITOR` 含 vi 则用 vi；`q` 退出。

- 浏览 URL：需安装 urlview，绑定按键捕获窗格缓冲区
  ```
  bind-key u capture-pane \; save-buffer /tmp/tmux-buffer \; run-shell "$TERMINAL -e urlview /tmp/tmux-buffer"
  ```

- 256 色：设 default-terminal
  ```
  set -g default-terminal "tmux-256color"
  ```
  异常时强制：`alias tmux="tmux -2"`

- 24 位色：终端支持时加入 terminal-features（示例 alacritty，其他终端替换为 $TERM 值）
  ```
  set -as terminal-features ",alacritty*:RGB"
  ```

- xterm-keys：开启后需用 tic 编译自定义 terminfo，TERM 设为 xterm-screen-256color
  ```
  set-option -g xterm-keys on
  ```

- terminfo：终端不支持 bce 时，`use=screen-256color-bce` 解析失败；检查用 `tic -c xterm-screen-256color`。
- 编译：`tic xterm-screen-256color`，输出至 `$HOME/.terminfo`（root 为 `/usr/share/terminfo`）。
- 主题：打印 256 色码：
```bash
for i in {0..255}; do printf "\x1b[38;5;${i}mcolor${i} - ██████████\n"; done
```
- 用色码修改 tmux 状态栏颜色。

- 状态栏：`set -g status-bg "color4"`、`set -g status-fg "color7"`、`set -g status-right "%l:%M %p"`

- 边框颜色：  
  `set -g pane-border-style fg="colour255"`  
  `set -g pane-active-border-style fg="colour33"`
- 滚动缓冲：`set -g history-limit 10000`
- 鼠标切换：`bind-key m set-option -g mouse \; display "Mouse: #{?mouse,ON,OFF}"`
- systemd 自启：模板 `/etc/systemd/system/tmux@.service`，启用 `tmux@username.service`。关键配置：  
  `[Unit] Description=tmux session for user %I`  
  `[Service] Type=forking User=%I`  
  优势：启动新会话更快，会话可持久化。

## systemd 管理 tmux

- 系统服务模板会话名用 `%I`，勿用 `%u`（服务中为 root）。
  ```ini
  [Service]
  Type=forking
  ExecStart=/usr/bin/tmux new-session -s %I -d
  ExecStop=/usr/bin/tmux kill-session -t %I
  [Install]
  WantedBy=multi-user.target
  ```
- 图形环境：改 `WantedBy=graphical-session.target`，`[Unit]` 加 `After=graphical-session.target`。
- 用户实例：`~/.config/systemd/user/tmux.service`，`WantedBy=default.target`；daemon-reload 后 enable/start。
- Socket 激活：`tmux@.socket`（`ListenStream=/tmp/tmux-%U/%i`, `SocketMode=0600`）+ `tmux@.service`（`ExecStart=tmux -D`, `ExecStartPost=tmux -L%i start`）；启用 socket 后客户端 `tmux -L NAME`，防 session-cleanup。

## xinit

- 安装 `xorg-xinit`；将 `/etc/X11/xinit/xinitrc` 复制为 `~/.xinitrc` 并替换末尾默认程序。
- 长时程序加 `&` 后台，WM 前用 `exec`；`xrdb` 不后台化。
- 保留默认 `xinitrc` 末尾 `if` 块以 source `/etc/X11/xinit/xinitrc.d`。
- `~/.xserverrc` 启动 X server；缺省 `/etc/X11/xinit/xserverrc`；可 `startx -- vt1` 指定终端。

- Xorg 须与登录同一 VT 启动并传 VT 号；`startx` 自动处理。`xinit` 时在 `~/.xserverrc`：
```sh
#!/bin/sh
exec /usr/bin/Xorg -nolisten tcp "$@" vt$XDG_VTNR
```
可加 `-nolisten local` 隔离；`-keeptty` 保留日志。

- 启动：`startx`；多显示：`xinit -- :1`
- 退出：`pkill -15 Xorg`；仅当前 VT：`pkill -15 -t tty"$XDG_VTNR" Xorg`

- 覆盖 xinitrc 测 WM/DE：`startx /usr/bin/i3`（绝对路径）；带参数加引号：`startx "/usr/bin/application --key value"`；加 X 选项：`startx /usr/bin/enlightenment -- -br +bs -dpi 96`；跳过 xinitrc.d 时可能需 `DISPLAY=:display_number startx /usr/bin/i3`

- 自动启动（`~/.bash_profile`/`~/.zprofile`）：
```sh
if [ -z "$DISPLAY" ] && [ "$XDG_VTNR" -eq 1 ]; then
  exec startx
fi
```
`-eq 1` 可改 `-le 3`；`exec` 使 X 退出即注销。

- 切换 DE/WM：用 display manager 或扩写 `~/.xinitrc`。

## Xinit
- `~/.xinitrc` 按参数选择会话，默认 xfce：
```bash
session=${1:-xfce}
case $session in
    i3|i3wm) exec i3;;
    kde) exec startplasma-x11;;
    xfce|xfce4) exec startxfce4;;
    *) exec $1;;
esac
```
- 传参：`startx ~/.xinitrc session`
- 无 WM 启动应用：`~/.xinitrc` 中 `exec chromium`，或直接运行二进制；窗口几何需自行设置。
- 无 GUI/测试：`xvfb-run command`（安装 `xorg-server-xvfb`）。

## Xorg
- 安装 `xorg-server`（`xorg` 组含 server、apps、字体）。
- 通用驱动 `modesetting`（KMS + Glamor）；硬件专用 DDX 视为遗留：
  - AMD：`xf86-video-amdgpu` / `xf86-video-ati`
  - Intel（Gen2–9）：`xf86-video-intel`
  - NVIDIA：`xf86-video-nouveau` 或专有 `nvidia-utils`（含 `nvidia_drv.so`）
- 回退顺序：专用 → `fbdev` → `vesa` → `modesetting`
- 启动：由 DM 或 `xinit` 启动，不直接运行 Xorg。
- 配置：默认无需配置；`/etc/X11/xorg.conf.d/` 以 `.conf` 结尾，按 ASCII 顺序读取，冲突以后者为准；`xorg.conf` 最后处理。

- 自动生成：`Xorg :0 -configure`（已运行 X 用 `:2`）；生成 `/root/xorg.conf.new` 并复制到 `/etc/X11/xorg.conf`。配置关键字忽略大小写与 `_`。
- 输入设备：默认 libinput，udev 自动检测；热插拔配置在 `/usr/share/X11/xorg.conf.d/`。查看实际驱动：`grep -e "Using input driver " Xorg.0.log`；驱动不支持则安装 `xorg-drivers` 组。
- 显示器：新版 Xorg 自动配置；多显卡在 Device 段指定 Driver 和十进制 BusID，用 `lspci -d ::03xx` 获取 ID。
- DPI：默认 96，可用 `-dpi` 设置，影响字体渲染。

---
来源：consolidated/basic-ops/桌面与终端应用（Arch Wiki）.md