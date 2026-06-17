@echo off
cd /d "%~dp0"

if "%TELEGRAM_BOT_TOKEN%"=="" (
    set /p TELEGRAM_BOT_TOKEN=Paste Telegram bot token: 
)

if "%LEADTRACKER_APP_URL%"=="" (
    set "LEADTRACKER_APP_URL=http://127.0.0.1/leadtracker/index.php"
)

npm.cmd run telegram
