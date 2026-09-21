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

REM Auto-detect system proxy from Windows Internet Settings
set "SYS_PROXY="
for /f "tokens=3" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable 2^>nul ^| findstr /i "REG_DWORD"') do set "PROXY_ENABLED=%%A"
set "ZEN_PROXY_ARG="
if "%PROXY_ENABLED%"=="0x1" (
    for /f "tokens=2*" %%A in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer 2^>nul ^| findstr /i "REG_SZ"') do set "SYS_PROXY=%%B"
    if defined SYS_PROXY (
        echo [INFO] Detected system proxy: !SYS_PROXY!
        for /f "tokens=1 delims=," %%P in ("!SYS_PROXY!") do set "SYS_PROXY=%%P"
        echo !SYS_PROXY! | findstr /i "^http" >nul 2>nul
        if errorlevel 1 set "SYS_PROXY=http://!SYS_PROXY!"
        set "ZEN_PROXY_ARG=--proxy !SYS_PROXY!"
    )
)
if not defined ZEN_PROXY_ARG (
    echo [INFO] No system proxy detected, using direct connection.
)

echo Starting Zen clean proxy: http://127.0.0.1:%PORT% -^> https://opencode.ai/zen/v1
echo Session-id rewriting, per-session stable ids rotated every 10 min. Ctrl+C to stop.
echo Upstream proxy: %HTTPS_PROXY%
echo.
python zen_proxy.py --port %PORT% !ZEN_PROXY_ARG!
if errorlevel 1 (
    echo.
    echo [ERROR] proxy exited abnormally. Press any key to close.
    pause
)
