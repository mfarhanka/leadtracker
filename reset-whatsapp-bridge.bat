@echo off
cd /d "%~dp0"

echo Stopping LeadTracker WhatsApp bridge...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*whatsapp-bridge.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

echo Removing saved WhatsApp session and browser cache...
if exist ".wwebjs_auth" rmdir /s /q ".wwebjs_auth"
if exist ".wwebjs_cache" rmdir /s /q ".wwebjs_cache"

echo Starting LeadTracker WhatsApp bridge...
start "LeadTracker WhatsApp Bridge" /min cmd /c npm.cmd run whatsapp

echo Done. Refresh LeadTracker and wait a few seconds for the new QR.
pause
