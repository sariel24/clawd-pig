@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动小猪 Clawd，窗口马上就会出现在桌面上…
echo 如果没看到，把本窗口的报错复制发给开发者即可。
npm start
echo.
echo 小猪已关闭。
pause
