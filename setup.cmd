@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Kaddiya needs Node.js 22 or newer. Install your company-approved Node.js LTS release, then reopen this file.
  pause
  exit /b 1
)
node scripts\setup.mjs
if errorlevel 1 pause
