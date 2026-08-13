@echo off
title OpenCode Service Watchdog
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0watchdog.ps1" %*
