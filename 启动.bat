@echo off
chcp 65001 >nul 2>&1
title TDSF Terminal Agent - Launcher
cd /d "d:\ai\linux教学一体\tdsf-terminal-agent-clone"
echo ============================================
echo   TDSF Terminal Agent - Starting...
echo   First build may take 2-5 min. Please wait.
echo ============================================
echo.
rem 指定 sidecar Python 解释器（优先使用项目内 .venv，依赖已装齐）
set TDSF_SIDECAR_PYTHON=d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\.venv\Scripts\python.exe
pnpm tauri:dev
echo.
echo ============================================
echo   Application has exited.
echo   If no window appeared, check errors above.
echo ============================================
pause >nul
