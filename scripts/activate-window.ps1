$h = (Get-Process | Where-Object {$_.ProcessName -eq "tdsf-terminal-agent"} | Select-Object -First 1).MainWindowHandle
if ($h -eq 0) { Write-Host "No window"; exit 1 }
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
[WinAPI]::ShowWindow($h, 3) | Out-Null
[WinAPI]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Seconds 1
Write-Host "Activated $h"
