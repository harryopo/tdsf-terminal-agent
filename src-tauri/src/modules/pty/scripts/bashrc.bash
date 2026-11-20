# tdsf-shell-integration (bashrc)
#
# Differences vs zsh integration:
# - We emulate login-shell init manually (/etc/profile, profile files) because
#   bash ignores --rcfile when started with -l.
# - Pre-exec marker uses a DEBUG trap, the same protocol as the SSH injection:
#   `633;E;<cmd>;<nonce>` carries the command line itself. `history 1` is NOT
#   used as the command text — multi-line history entries, HISTCONTROL=ignorespace
#   and HISTIGNORE all make the retrieved text differ from what the user actually
#   ran, which corrupts downstream command correction with a wrong command string.
# - `633;F;<segments>;<valid>;<nonce>` (CORR-02 C3) is emitted right before
#   `133;D`. It states whether the captured text is the complete input line and a
#   single simple command, so the exit code can be attributed safely. history is
#   used only as completeness evidence, never as the reported text.
# - If the user already owns the DEBUG trap (bash-preexec/extdebug), we do not
#   override it and degrade to no E/C/F reporting: block.command stays empty, so
#   correction never fires on a guessed string (safe degradation).

if [ -z "$__TDSF_HOOKS_LOADED" ]; then
  __TDSF_HOOKS_LOADED=1

  [ -f /etc/profile ] && source /etc/profile
  [ -f /etc/bashrc ] && source /etc/bashrc
  if [ -f "$HOME/.bash_profile" ]; then
    source "$HOME/.bash_profile"
  elif [ -f "$HOME/.bash_login" ]; then
    source "$HOME/.bash_login"
  elif [ -f "$HOME/.profile" ]; then
    source "$HOME/.profile"
  fi
  # .bashrc may have been sourced already by .bash_profile; sourcing again is
  # safe for idempotent rc files (the common case). If yours has side effects
  # on reload, guard with a flag.
  [ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"

  _tdsf_urlencode() {
    local LC_ALL=C s="$1" i c
    for (( i=0; i<${#s}; i++ )); do
      c="${s:i:1}"
      case "$c" in
        [a-zA-Z0-9/._~-]) printf '%s' "$c" ;;
        *) printf '%%%02X' "'$c" ;;
      esac
    done
  }

  # OSC 633;E 的命令字段：分号是 nonce 分隔符，反斜杠是转义前缀，必须转义。
  _tdsf_escape_osc_value() {
    local v="$1"
    v="${v//\\/\\\\}"
    v="${v//;/\\x3b}"
    printf '%s' "$v"
  }

  # ---------------------------------------------------------------------------
  # 命令行完整性校验（CORR-02 C3）。
  #
  # DEBUG trap 在复合命令/管道里每个简单命令各触发一次，$BASH_COMMAND 只是
  # 当前片段；133;D 的退出码却属于整行最后一个命令。把首段当完整原文参与
  # 失败纠错/学习会张冠李戴（实测：`printf ROOT_OK; missing` 的 633;E 是
  # `printf ROOT_OK`，133;D 是 127）。
  #
  # 这里只用 history 作**证据**，命令文本始终取 $BASH_COMMAND，绝不把
  # history 文本拼成原文。以下任一情况都判为不可信（返回 1）：
  #   - 本轮没有进入历史（HISTCONTROL=ignorespace/HISTIGNORE/ignoredups 等）；
  #   - history 最后一条不是本轮（号与 HISTCMD 不一致或未推进）；
  #   - history 文本（去行首空白后）与 $BASH_COMMAND 不完全一致
  #     （复合/管道/多行/后台等）。
  # ---------------------------------------------------------------------------
  _tdsf_line_complete() {
    local want="$1" h num text
    [ -n "${HISTCMD:-}" ] || return 1
    # 用户设置的时间戳格式不影响校验；只在函数内清空，不改用户全局设置。
    local HISTTIMEFORMAT=
    h=$(builtin history 1 2>/dev/null) || return 1
    [ -n "$h" ] || return 1
    [[ "$h" =~ ^[[:space:]]*([0-9]+)[[:space:]]{1,2}(.*)$ ]] || return 1
    num="${BASH_REMATCH[1]}"
    text="${BASH_REMATCH[2]}"
    [ "$num" = "$HISTCMD" ] || return 1
    if [ -n "${__TDSF_LAST_HISTCMD:-}" ] && [ "$num" = "$__TDSF_LAST_HISTCMD" ]; then
      return 1
    fi
    # BASH_COMMAND 不含行首空白；history 保留用户原文的前导空格。
    text="${text#"${text%%[![:space:]]*}"}"
    [ "$text" = "$want" ]
  }

  # preexec: DEBUG trap 捕获命令行原文 → 633;E + 133;C。
  # 同一输入行的后续简单命令只计数（__TDSF_LINE_SEGMENTS），不再上报文本；
  # 完整性与段数在 precmd 由 633;F 一起交给前端，后者据此决定能否学习/纠错。
  _tdsf_preexec() {
    trap '_tdsf_preexec' DEBUG
    local c="$BASH_COMMAND"
    case "$c" in _tdsf_*|__TDSF_*|local\ _tdsf_*) return ;; esac
    if [ "${__TDSF_CMD_ACTIVE:-0}" = "1" ]; then
      __TDSF_LINE_SEGMENTS=$(( ${__TDSF_LINE_SEGMENTS:-1} + 1 ))
      return
    fi
    [ "${__TDSF_CMD_REPORTED:-0}" = "1" ] && return
    __TDSF_CMD_REPORTED=1
    __TDSF_CMD_ACTIVE=1
    __TDSF_LINE_SEGMENTS=1
    _tdsf_block_seen=1
    # CORR-03 P0（ROOT CAP-01）：上报文本一旦被截断或清洗，就不再是完整原文，
    # 完整性必须降为 0；512 上限保留，避免任意长输入进入 OSC。
    local _tdsf_lossy=0
    if [ "${#c}" -gt 512 ]; then _tdsf_lossy=1; fi
    local _tdsf_clean="${c//$'\a'/}"
    _tdsf_clean="${_tdsf_clean//$'\e'/}"
    _tdsf_clean="${_tdsf_clean//$'\r'/ }"
    _tdsf_clean="${_tdsf_clean//$'\n'/ }"
    if [ "$_tdsf_clean" != "$c" ]; then _tdsf_lossy=1; fi
    if [ "$_tdsf_lossy" = "0" ] && _tdsf_line_complete "$c"; then
      __TDSF_LINE_VALID=1
    else
      __TDSF_LINE_VALID=0
    fi
    __TDSF_LAST_HISTCMD="${HISTCMD:-}"
    __TDSF_LINE_NONCE="${RANDOM}${RANDOM}"
    c="$_tdsf_clean"
    printf '\e]633;E;%s;%s\e\\' "$(_tdsf_escape_osc_value "${c:0:512}")" "$__TDSF_LINE_NONCE"
    printf '\e]133;C\e\\'
  }

  _tdsf_precmd() {
    local _tdsf_ret=$?
    # 完整性标记必须在 133;D 之前发出；没有真实命令的空回车不发 F。
    local _tdsf_seg="${__TDSF_LINE_SEGMENTS:-0}"
    local _tdsf_val="${__TDSF_LINE_VALID:-0}"
    local _tdsf_nonce="${__TDSF_LINE_NONCE:-}"
    __TDSF_CMD_ACTIVE=0
    __TDSF_LINE_SEGMENTS=0
    __TDSF_LINE_VALID=0
    __TDSF_LINE_NONCE=""
    case "$_tdsf_seg" in ''|*[!0-9]*) _tdsf_seg=0 ;; esac
    if [ "$_tdsf_seg" -gt 0 ]; then
      printf '\e]633;F;%s;%s;%s\e\\' "$_tdsf_seg" "$_tdsf_val" "$_tdsf_nonce"
    fi
    printf '\e]133;D;%s\e\\' "$_tdsf_ret"
    printf '\e]7;file://%s%s\e\\' "${HOSTNAME:-$(uname -n 2>/dev/null)}" "$(_tdsf_urlencode "$PWD")"
    if [ -n "$TDSF_BLOCKS" ]; then
      # Host renders its own input bar: suppress the shell prompt (B marker
      # only) and reserve header/gap rows, mirroring the zsh integration.
      if [ -n "$_tdsf_block_seen" ]; then
        PS1='\n\n\[\e]133;B\e\\\]'
      else
        PS1='\n\[\e]133;B\e\\\]'
      fi
    elif [ -z "$__TDSF_PS1_INJECTED" ]; then
      PS1='\[\e]133;B\e\\\]'"$PS1"
      __TDSF_PS1_INJECTED=1
    fi
    printf '\e]133;A\e\\'
    # 用户 PROMPT_COMMAND 里执行的命令不是用户输入，不能上报成 633;E：
    # 数组模式由末尾复位项在用户钩子之后清零，字符串模式在这里清零。
    __TDSF_CMD_REPORTED="$__TDSF_PROMPT_ARRAY"
    if [ "$__TDSF_NO_TRAP" = "0" ]; then trap - DEBUG; fi
    if [ -n "${__TDSF_ORIG_PC:-}" ]; then eval "$__TDSF_ORIG_PC"; fi
    if [ "$__TDSF_NO_TRAP" = "0" ]; then trap '_tdsf_preexec' DEBUG; fi
  }

  # 只有未占用 DEBUG trap（无 extdebug、无既有 trap）时才安装：
  # 覆盖用户的 bash-preexec/调试钩子会破坏其环境，且上报文本也不可信。
  __TDSF_NO_TRAP=1
  if [ -z "$(trap -p DEBUG 2>/dev/null)" ] && ! shopt -q extdebug 2>/dev/null; then
    __TDSF_NO_TRAP=0
  fi

  # bash 5.1+ 把 PROMPT_COMMAND 当数组执行；直接字符串拼接会破坏用户钩子。
  __TDSF_PROMPT_ARRAY=0
  if (( BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 1) )) &&
     [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    __TDSF_PROMPT_ARRAY=1
    PROMPT_COMMAND=("_tdsf_precmd" "${PROMPT_COMMAND[@]}" "__TDSF_CMD_REPORTED=0")
  else
    __TDSF_ORIG_PC="${PROMPT_COMMAND:-}"
    PROMPT_COMMAND="_tdsf_precmd"
  fi

  if [ "$__TDSF_NO_TRAP" = "0" ]; then trap '_tdsf_preexec' DEBUG; fi

  _tdsf_precmd
fi
