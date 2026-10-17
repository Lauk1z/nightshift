@echo off
chcp 65001 >nul
title Agent Chat
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。请先安装 Node.js 18 或更新的版本：https://nodejs.org/
  pause
  exit /b 1
)
node server\index.js --open
echo.
echo Agent Chat 已退出。
pause
