@echo off
title Smart WebRTC Classroom - Dedicated LAN Edition
echo ========================================================
echo   Starting Smart WebRTC Classroom (LAN-Only Edition)
echo ========================================================
echo.
cd /d "%~dp0"
if not exist "node_modules\ws" (
    echo [INFO] First time run detected. Installing ws dependency...
    call npm install
)
echo [TIP] If other PCs cannot connect, ensure Windows Firewall allows Node.js on Private Networks.
echo.
node server.js
pause

