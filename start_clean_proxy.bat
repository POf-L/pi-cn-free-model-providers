@echo off
title OpenCode Zen Clean Proxy (:8643)
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] python not found. Install Python and add it to PATH.
    pause
    exit /b 1
)

REM 经本机代理端口(v2ray/clash 10808)访问上游, 出口 IP 走本机代理
if "%HTTP_PROXY%"=="" set HTTP_PROXY=http://127.0.0.1:10808
if "%HTTPS_PROXY%"=="" set HTTPS_PROXY=http://127.0.0.1:10808

REM 上游直连 opencode.ai (zen_proxy.py 默认), 无额外出口 Worker

echo Starting Zen clean proxy: http://127.0.0.1:8643 -^> https://opencode.ai/zen/v1
echo Session-id rewriting, per-session stable ids rotated every 10 min. Ctrl+C to stop.
echo Upstream proxy: %HTTPS_PROXY%
echo.
python zen_proxy.py --port 8643
if errorlevel 1 (
    echo.
    echo [ERROR] proxy exited abnormally. Press any key to close.
    pause
)
