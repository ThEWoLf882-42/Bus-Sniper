@echo off
setlocal EnableDelayedExpansion
rem Windows: update from GitHub, then start the Bus Sniper GUI.
rem A file named .no-auto-update in this folder turns the update off.
rem Everything is in one block, which cmd reads in full before running it:
rem the update may replace this very file while it runs.
(
  title Bus Sniper - keep this window open
  cd /d "%~dp0"
  if not exist ".no-auto-update" if exist ".git" (
    where git >nul 2>nul
    if errorlevel 1 (
      echo git is not installed - skipping the update.
    ) else (
      echo Checking for updates...
      for /f %%h in ('git rev-parse HEAD') do set BEFORE=%%h
      set GIT_TERMINAL_PROMPT=0
      set GCM_INTERACTIVE=never
      git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 pull --ff-only --quiet 2>nul
      if errorlevel 1 (
        echo Could not update, offline or files changed here - starting the current version.
      ) else (
        for /f %%h in ('git rev-parse HEAD') do set AFTER=%%h
        if "!BEFORE!"=="!AFTER!" (
          echo Already up to date.
        ) else (
          echo Updated:
          git --no-pager log --format="  - %%s" !BEFORE!..!AFTER!
        )
      )
      echo.
    )
  )
  set NODEMAJOR=0
  for /f %%v in ('node -p "parseInt(process.versions.node)" 2^>nul') do set NODEMAJOR=%%v
  if !NODEMAJOR! LSS 22 (
    echo Bus Sniper needs Node.js 22 or newer.
    echo Get the LTS installer from https://nodejs.org, then double-click this again.
    pause
    exit /b 1
  )
  node gui.mjs
  pause
  exit /b
)
