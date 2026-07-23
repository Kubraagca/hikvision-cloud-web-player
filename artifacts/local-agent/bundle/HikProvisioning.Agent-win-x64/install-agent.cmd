@echo off
cd /d %~dp0
powershell -ExecutionPolicy Bypass -File "%~dp0install-agent.ps1"
pause
