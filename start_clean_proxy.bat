@echo off
setlocal enabledelayedexpansion
title OpenCode Zen Clean Proxy (:8643)
cd /d "%~dp0"

set "PORT=8643"

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] python not found. Install Python and add it to PATH.
    pause
    exit /b 1
)

REM --- Detect port usage: if %PORT% is already LISTENING, ask to kill it ---
set "PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /c:":%PORT% " ^| findstr /c:"LISTENING"') do (
    set "PID=%%P"
)

if defined PID (
    echo.
    echo [WARN] Port %PORT% is already in use by PID !PID!.
    set /p "ANSWER=Kill PID !PID! and restart the proxy? [Y/N]: "
    if /i "!ANSWER!"=="Y" (
        taskkill /f /pid !PID! >nul 2>nul
        if errorlevel 1 (
            echo [ERROR] Failed to kill PID !PID!. Try running as Administrator.
            pause
            exit /b 1
        )
        echo [OK] Killed PID !PID!.
        timeout /t 1 /nobreak >nul
    ) else (
        echo [INFO] Exit. Port %PORT% is occupied.
        pause
        exit /b 1
    )
)

REM Route upstream via local proxy (v2ray/clash 10808) for egress IP
if "%HTTP_PROXY%"=="" set HTTP_PROXY=http://127.0.0.1:10808
if "%HTTPS_PROXY%"=="" set HTTPS_PROXY=http://127.0.0.1:10808

echo Starting Zen clean proxy: http://127.0.0.1:%PORT% -^> https://opencode.ai/zen/v1
echo Session-id rewriting, per-session stable ids rotated every 10 min. Ctrl+C to stop.
echo Upstream proxy: %HTTPS_PROXY%
echo.
python zen_proxy.py --port %PORT%
if errorlevel 1 (
    echo.
    echo [ERROR] proxy exited abnormally. Press any key to close.
    pause
)
