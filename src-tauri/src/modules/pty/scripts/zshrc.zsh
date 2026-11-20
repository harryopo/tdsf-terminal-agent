# tdsf-shell-integration (zshrc)
#
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D (prompt-start / prompt-end / pre-exec /
# command-done-with-exit-code) so the host can detect command boundaries and
# track cwd without re-parsing the prompt. `status` is a read-only special in
# zsh, so we shadow $? into `_tdsf_ret`.

{
  _tdsf_user_zdotdir="${TDSF_USER_ZDOTDIR:-$HOME}"
  [ -f "$_tdsf_user_zdotdir/.zshrc" ] && source "$_tdsf_user_zdotdir/.zshrc"
  unset _tdsf_user_zdotdir
}

# Re-source guard within a single shell (e.g. user runs `source ~/.zshrc`).
# This is NOT exported, so each nested zsh installs its own hooks — desired,
# since every interactive shell needs its own prompt integration.
if [[ -z "$__TDSF_HOOKS_LOADED" ]]; then
  __TDSF_HOOKS_LOADED=1
  autoload -Uz add-zsh-hook 2>/dev/null

  # URL-encode $PWD byte-wise so multi-byte paths stay valid in the `file://`
  # URI emitted via OSC 7. `no_multibyte` forces ${s[i]} to index bytes (not
  # code points), and LC_ALL=C keeps the [a-zA-Z0-9...] class single-byte.
  _tdsf_urlencode() {
    emulate -L zsh
    setopt localoptions no_multibyte
    local LC_ALL=C s="$1" i byte
    for (( i=1; i<=${#s}; i++ )); do
      byte="${s[i]}"
      case "$byte" in
        [a-zA-Z0-9/._~-]) printf '%s' "$byte" ;;
        *) printf '%%%02X' "'$byte" ;;
      esac
    done
  }

  _tdsf_precmd() {
    local _tdsf_ret=$?
    printf '\e]133;D;%s\e\\' "$_tdsf_ret"
    printf '\e]7;file://%s%s\e\\' "${HOST}" "$(_tdsf_urlencode "$PWD")"
    # In block mode the host renders its own input bar, so suppress the shell
    # prompt entirely (keep only the OSC 133 B marker) and add a leading blank
    # line so frozen command blocks get vertical breathing room.
    if [[ -n "$TDSF_BLOCKS" ]]; then
      # Spacing reserved for the host-drawn block header lives in the prompt
      # (the grid is WebGL, not CSS). Later prompts get two blank rows: the
      # upper one is the previous block's end gap (above its divider), the lower
      # one is this command's header row. The very first prompt has no block
      # above it, so it gets a single row (header only) to avoid a tall top gap.
      if [[ -n "$_tdsf_block_seen" ]]; then
        PS1=$'\n\n%{\e]133;B\e\\%}'
      else
        PS1=$'\n%{\e]133;B\e\\%}'
      fi
      RPROMPT=''
    elif [[ "$PS1" != *$'\e]133;B\e\\'* ]]; then
      # Re-inject prompt-end marker in case a framework rebuilt PS1 (p10k, starship).
      PS1=$'%{\e]133;B\e\\%}'"$PS1"
    fi
    printf '\e]133;A\e\\'
  }

  _tdsf_preexec() {
    # Mark that a real command ran, so the next prompt switches from one blank
    # row (first prompt, no block above) to two (end gap + header row).
    [[ -n "$TDSF_BLOCKS" ]] && _tdsf_block_seen=1
    local cmd="${1//[[:cntrl:]]/ }"
    # CORR-02 C3：zsh preexec 的 $1 是整行原文；这里保守判断它是否是单一简单
    # 命令（出现未加引号的 shell 运算符/换行即视为复合）。引号内的运算符会
    # 被误判为复合，方向是安全的：只损失自动纠错，不会张冠李戴。
    # CORR-03 P0（ROOT CAP-01）：控制字符会被清洗、超 256 会被截断，两者都
    # 使上报文本不再是原文 → 完整性降为 0。
    local _tdsf_simple=1
    local _tdsf_nonce="${RANDOM}${RANDOM}"
    if [[ "$1" == *[';&|<>()']* || "$1" == *[[:cntrl:]]* || ${#1} -gt 256 ]]; then
      _tdsf_simple=0
    fi
    printf '\e]133;C;%s\e\\' "${cmd[1,256]}"
    printf '\e]633;F;1;%s;%s\e\\' "$_tdsf_simple" "$_tdsf_nonce"
  }

  if (( $+functions[add-zsh-hook] )); then
    add-zsh-hook precmd _tdsf_precmd
    add-zsh-hook preexec _tdsf_preexec
  fi

  # Warp/iTerm2-style word-end navigation: zsh's default `forward-word` (M-f /
  # Option+Right) overshoots to the START of the next word; `emacs-forward-word`
  # stops at the END of the current word, which is what nearly every other shell
  # and GUI editor does. Only rebind when the binding is still the stock zsh
  # default — respects any explicit remap in the user's .zshrc.
  if (( $+widgets[emacs-forward-word] )) \
     && [[ "$(bindkey '\ef')" == '"^[f" forward-word' ]]; then
    bindkey '\ef' emacs-forward-word
  fi

  _tdsf_precmd
fi
:
