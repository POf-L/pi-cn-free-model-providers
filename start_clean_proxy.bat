@echo off
title OpenCode Zen Clean Proxy (:8643)
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] python not found. Install Python and add it to PATH.
    pause
    exit /b 1
)

REM Inject upstream proxy so zen_proxy forwards via system proxy (v2ray/clash 10808)
if "%HTTP_PROXY%"=="" set HTTP_PROXY=http://127.0.0.1:10808
if "%HTTPS_PROXY%"=="" set HTTPS_PROXY=http://127.0.0.1:10808

echo Starting Zen clean proxy: http://127.0.0.1:8643 -^> https://opencode.ai/zen/v1
echo Session-id rewriting + rotation every 10min. Ctrl+C to stop.
echo Upstream proxy: %HTTPS_PROXY%
echo.
python zen_proxy.py --port 8643
if errorlevel 1 (
    echo.
    echo [ERROR] proxy exited abnormally. Press any key to close.
    pause
)
