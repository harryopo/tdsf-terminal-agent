; "Open in TDSF" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).
; TDSF 2026-08-01: 清理上游残留 (可执行文件名与右键菜单名迁移到 TDSF 命名；
; 下方注册表键名为待清理的旧键，不可改名否则清理失效)。

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTDSF" "" "Open in TDSF Terminal Agent"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTDSF" "Icon" '"$INSTDIR\tdsf-terminal-agent.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTDSF" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTDSF\command" "" '"$INSTDIR\tdsf-terminal-agent.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTDSF" "" "Open in TDSF Terminal Agent"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTDSF" "Icon" '"$INSTDIR\tdsf-terminal-agent.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTDSF" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTDSF\command" "" '"$INSTDIR\tdsf-terminal-agent.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTDSF" "" "Open in TDSF Terminal Agent"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTDSF" "Icon" '"$INSTDIR\tdsf-terminal-agent.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTDSF" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTDSF\command" "" '"$INSTDIR\tdsf-terminal-agent.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInTDSF"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInTDSF"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInTDSF"
  ; 清理上游残留菜单
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInTerax"
!macroend
