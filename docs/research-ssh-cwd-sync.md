# SSH 终端 cwd 同步修复 — 调研报告与方案（2026-08-09）

> **触发**：用户反馈 SSH 终端输入命令时"弹出别的字眼"，如
> `yum install httpdyum install httpd* -y'; printf '\033]7;file://localhost%s\007' "$(pwd -P)"`。
> **结论**：这是 TDSF 魔改加的「cd 命令拦截改写」hack 的 bug，非终端本身问题。
> 修复方向已定：改用开源标准方案（PROMPT_COMMAND 注入），删除 hack。
> 本报告归档调研依据 + 推荐实施路径，供开发与后续接手参考。

---

## 一、现象与根因（为什么"弹出别的字眼"）

### 1.1 当前 SSH 终端链路

```
TerminalPane.tsx (xterm.js 渲染)
  └─ transport.write → SshTerminalHost.openTransport.write   ← bug 所在
       ├─ 行缓冲 inputBufferRef: 累积所有无换行输入（永不清理）
       ├─ 命中 /^cd(?:\s+(.+))?$/ 时：
       │    └─ 丢弃用户原始输入，改写为
       │       `cd <dir>; printf '\033]7;file://localhost%s\007' "$(pwd -P)"\r`
       └─ 未命中：原样透传
```

代码位置：[SshTerminalHost.tsx](src/modules/ssh-explorer/SshTerminalHost.tsx#L127-L188)
（commit `9ec558e` "Phase 2 OSC 7 cwd sync for SSH Space" 引入，2026-07-31）

### 1.2 三个致命 bug

1. **无换行输入无限残留**：`inputBufferRef.current += data` 后，无 `\r\n` 时走
   else 分支 `handle.write(data)` 原样发出，**但 buffer 不清空**。逐键输入/粘贴分片
   永久堆积。
2. **残留 + 新输入拼接 → 误判 cd**：buffer 残留（如半截 `cd `、历史粘贴分片）与
   新输入拼接后若以 `cd ` 开头，正则命中 → **用户整条命令被当作 cd 参数丢弃**，
   替换成 `cd '<垃圾>'; printf OSC7` 写入终端 → 用户看到"弹出来的字眼"。
3. **元字符黑名单不全**：`*`、`?` 通配符不在 `[;&|`$(){}[\]<>!"\\]` 中，
   `yum install httpd* -y` 能直接通过校验被改写。

### 1.3 直接后果

- 输入命令被篡改执行（安全 + 正确性双重问题）
- 多行粘贴时 `\r` 之后的内容被静默丢弃（cdMatch 命中只写改写命令）
- 左侧远程资源管理器 cwd 跟随不可靠

---

## 二、为什么会有这个 hack（历史背景）

SSH PTY 建立流程：[session.rs](src-tauri/src/modules/ssh/session.rs#L245-L333)

```
channel_open_session → request_pty → request_shell（远端默认登录 shell，无法传参）
```

`request_shell` 无法携带 `--rcfile`/`ZDOTDIR` 等注入参数，导致本地终端那套
标准 shell integration（OSC 133 + OSC 7）在 SSH 端无法复用。TDSF 于是退化成
前端"监听 cd 命令 → 追加 printf"的拦截改写 hack，埋下 §1.2 的 bug。

---

## 三、开源方案调研（结论：有成熟标准，且本项目本地端已在用）

### 3.1 行业标准做法（VS Code / Tabby / Warp 一致）

- **本地终端**：shell 启动时注入参数/环境变量（bash `--rcfile`、zsh `ZDOTDIR`、
  fish `$XDG_DATA_DIRS`）→ 钩子（bash `PROMPT_COMMAND` / zsh `precmd` /
  fish `fish_prompt`）里发 `OSC 133 ; ...` + `OSC 7 ; file://<host><urlencode(cwd)>`。
  完全静默。
- **SSH 终端**：VS Code 官方文档明确指出
  "automatic script injection will not work ... through a regular `ssh` session
  (when not using the Remote - SSH extension)"。
  Remote-SSH 扩展的做法：**向远端写 shell integration 脚本 + 修改远端 rcfile
  source 它**（持久化注入）；或手动在 `~/.bashrc` 加一行 `PROMPT_COMMAND` 钩子。
- **参考资料**：
  - VS Code 官方文档 <https://code.visualstudio.com/docs/terminal/shell-integration>
  - VS Code shellIntegration-bash.sh（bash 用 `--init-file` 或 `PROMPT_COMMAND` 注入）
  - 本地调研报告 `d:\ai\linux教学一体\docs\idea-to-dev-output\07-开源项目调研-SSH远程操控.md`
    （Tabby MIT / WebSSH2 MIT / ssh2 为 SSH 客户端架构参考）

### 3.2 本项目本地终端的标准实现（可直接复用的模板）

[Rust shell_init.rs](src-tauri/src/modules/pty/shell_init.rs) + [bashrc.bash](src-tauri/src/modules/pty/scripts/bashrc.bash)

```bash
_terax_precmd() {
  printf '\e]133;D;%s\e\\' "$?"
  printf '\e]7;file://%s%s\e\\' "${HOSTNAME}" "$(_terax_urlencode "$PWD")"
  ...
}
case ":$PROMPT_COMMAND:" in *":_terax_precmd:"*) ;; *) PROMPT_COMMAND="_terax_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;; esac
```

> ⚠️ SSH 端**不能**整段复用该 bashrc：它会 source /etc/profile、.bash_profile
> （SSH 登录 shell 本就会 source，重复可能副作用），并改写 PS1。SSH 端只需要
> 一个**最小 PROMPT_COMMAND 钩子**（发 OSC 7，可选 OSC 133）。

### 3.3 复用清单佐证

- `docs/technical/开源项目复用清单.md`：SSH 客户端架构参考 tabby（MIT）——
  tabby 使用 ssh2 + xterm.js + node-pty；Electron SSH 架构复用点 P0。
- SSH 协议层本项目用 **russh 0.61**（非 ssh2），`Channel::exec(want_reply, cmd)`
  可执行任意远端命令（[session.rs](src-tauri/src/modules/ssh/session.rs#L632-L643) 已有
  `exec_command` 先例）——这是 SSH 端静默注入的基础能力。

---

## 四、修复方案对比

| 维度 | 方案 A：Rust 静默注入（推荐） | 方案 B：前端轻量注入 |
|------|------------------------------|---------------------|
| 原理 | open_pty 改为 `request_pty` + `exec(true, "<shell> --rcfile/ZDOTDIR/-C 注入脚本 -i")`；注入脚本先经 exec 写到远端 `/tmp` | 保留 `request_shell`，连接就绪后向 PTY 写一行 `PROMPT_COMMAND` 注入命令 |
| 回显 | 无（启动时注入，同本地终端） | 有（注入命令会显示一瞬，需 stty -echo + 清屏掩盖） |
| 体验 | 与本地终端一致 | 可见注入命令 |
| shell 覆盖 | bash / zsh / fish 全支持（探测后按类型注入，其他 shell 回退无集成） | 仅 bash 可靠 |
| 改动面 | Rust `session.rs` open_pty + 3 个注入脚本 + 探测；前端删 hack | 仅前端 `sshStore`/`SshTerminalHost` |
| 风险 | 探测失败回退 `request_shell`（无集成但无 bug）；exec 启动交互 shell 是 ssh2 生态（Tabby/Electerm/VS Code）常用做法 | 注入时序敏感；命令可见 |

**共同点**：都删除 `SshTerminalHost` 的 cd 拦截 hack；前端 `registerCwdHandler`
（remote 分支，[useTerminalSession.ts](src/modules/terminal/lib/useTerminalSession.ts#L853-L871)）
已能解析 OSC 7，无需改动。

### 4.1 方案 A 实施要点

1. 认证成功后，用 `exec_command` 探测远端默认登录 shell：`basename "$SHELL"`。
2. 按类型生成最小钩子脚本（bash `PROMPT_COMMAND` / zsh `precmd` / fish
   `fish_prompt`，均只发 `OSC 7`），经 exec 以 base64 方式写入
   `/tmp/tdsf-shell-integration.<id>.<ext>`（临时文件，随会话清理）。
3. open_pty 流程改为：
   - bash：`request_pty` + `exec(true, "bash --rcfile <tmp> -i")`
   - zsh：`exec(true, "ZDOTDIR=<tmpdir> zsh -i")`
   - fish：`exec(true, "fish -C 'source <tmp>'")`
   - 其他：回退 `request_shell`（无集成，但不再篡改用户输入）。
4. 前端删除 `SshTerminalHost` 行缓冲 + cd 改写逻辑（净删 ~60 行）。

### 4.2 方案 B 实施要点

1. `sshStore` 连接就绪（首次 on_data 后）向 PTY 写入：
   ```bash
   stty -echo; PROMPT_COMMAND='printf "\033]7;file://${HOSTNAME}%s\007" "$(pwd -P)"'; stty echo; clear
   ```
2. 前端删除 cd 拦截 hack。
3. 简单但注入命令可见、仅 bash、时序依赖 prompt。

---

## 五、决策

用户已选"注入 PROMPT_COMMAND（推荐）"，即方案 A（Rust 静默注入）优先，
方案 B 为降级备选。最终选型与实施记录见 DEV-JOURNAL §38.x。

## 六、参考来源

- 本项目代码：`SshTerminalHost.tsx` / `useTerminalSession.ts` / `osc-handlers.ts` /
  `session.rs`（ssh）/ `shell_init.rs` + `scripts/bashrc.bash`（pty）
- VS Code Terminal Shell Integration 官方文档
- 上级目录调研资产：
  - `d:\ai\linux教学一体\docs\idea-to-dev-output\07-开源项目调研-SSH远程操控.md`
  - `d:\ai\linux教学一体\docs\technical\开源项目复用清单.md`
  - `d:\ai\linux教学一体\opensource-reference\tabby\`（MIT，架构参考）
