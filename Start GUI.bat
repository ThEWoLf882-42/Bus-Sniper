@echo off
title Bus Sniper - keep this window open
cd /d "%~dp0"
set NODEMAJOR=0
for /f %%v in ('node -p "parseInt(process.versions.node)" 2^>nul') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 22 (
  echo Bus Sniper needs Node.js 22 or newer.
  echo Get the LTS installer from https://nodejs.org, then double-click this again.
  pause
  exit /b 1
)
node gui.mjs
pause
