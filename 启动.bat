@echo off
title TDSF Terminal Agent - Launcher
cd /d "%~dp0"
echo ============================================
echo   TDSF Terminal Agent - Starting...
echo   First build may take 2-5 min. Please wait.
echo ============================================
echo.
rem Point sidecar to the project venv python (deps installed there)
set "TDSF_SIDECAR_PYTHON=%~dp0src-tauri\sidecar\.venv\Scripts\python.exe"
pnpm tauri:dev
echo.
echo ============================================
echo   Application has exited.
echo   If no window appeared, check errors above.
echo ============================================
pause >nul
