; "Open in TDSF" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).
; TDSF 魔改 2026-08-01: 修复上游 terax 残留 (exe 名 terax.exe → tdsf-terminal-agent.exe,
; 菜单名 OpenInTerax → OpenInTDSF)。

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
  ; 清理上游 terax 残留菜单
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInTerax"
!macroend
