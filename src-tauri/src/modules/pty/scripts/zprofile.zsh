# tdsf-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _tdsf_user_zdotdir="${TDSF_USER_ZDOTDIR:-$HOME}"
  [ -f "$_tdsf_user_zdotdir/.zprofile" ] && source "$_tdsf_user_zdotdir/.zprofile"
  unset _tdsf_user_zdotdir
}
:
