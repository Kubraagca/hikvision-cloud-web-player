@echo off
setlocal
set "PAYLOAD_DIR=%~dp0payload"
if exist "%PAYLOAD_DIR%" rmdir /s /q "%PAYLOAD_DIR%"
mkdir "%PAYLOAD_DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%~dp0payload.zip' -DestinationPath '%~dp0payload' -Force"
if errorlevel 1 exit /b 1
powershell -NoProfile -ExecutionPolicy Bypass -File "%PAYLOAD_DIR%\install-agent.ps1"
endlocal
