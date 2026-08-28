@echo off
title TDSF Terminal Agent - Dev (Logged)
cd /d "%~dp0"
echo ============================================
echo   TDSF Terminal Agent - Starting (logged)
echo.
echo   Log file: .tdsf-data\dev-run.log
echo   KEEP THIS WINDOW OPEN (minimize is OK).
echo   Closing this window will STOP the app.
echo ============================================
if not exist ".tdsf-data" mkdir ".tdsf-data"
rem Point sidecar to the project venv python (deps installed there)
set "TDSF_SIDECAR_PYTHON=%~dp0src-tauri\sidecar\.venv\Scripts\python.exe"
rem Redirect ALL output (vite + cargo + tauri + sidecar) to the log file
pnpm tauri:dev > "%~dp0.tdsf-data\dev-run.log" 2>&1
echo.
echo ============================================
echo   App exited. Log saved to .tdsf-data\dev-run.log
echo ============================================
pause >nul
