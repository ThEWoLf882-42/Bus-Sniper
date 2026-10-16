#!/bin/bash
# macOS: double-click to update from GitHub, then start the Bus Sniper GUI.
# First time only, in Terminal:  chmod +x "Start GUI.command"
# A file named .no-auto-update in this folder turns the update off.
#
# Everything runs from main(), which bash reads in full before starting:
# the update may replace this very file while it runs.

main() {
  cd "$(dirname "$0")" || exit 1
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  update
  # a Node installed with nvm isn't on the PATH of scripts: load it
  NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [ "$(node_major)" -lt 22 ] && [ -s "$NVM_SH" ]; then
    . "$NVM_SH"
    nvm use --silent 22 >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1
  fi
  if [ "$(node_major)" -lt 22 ]; then
    echo "Bus Sniper needs Node.js 22 or newer (you have: $(node -v 2>/dev/null || echo none))."
    echo "Get the LTS installer from https://nodejs.org, then double-click this again."
    read -r -p "Press Enter to close."
    exit 1
  fi
  node gui.mjs
  read -r -p "Press Enter to close."
}

update() {
  [ -e .no-auto-update ] || [ ! -d .git ] && return
  command -v git >/dev/null 2>&1 || { echo "git is not installed - skipping the update."; return; }
  echo "Checking for updates..."
  local before after
  before=$(git rev-parse HEAD 2>/dev/null)
  if GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 pull --ff-only --quiet 2>/dev/null; then
    after=$(git rev-parse HEAD)
    if [ "$before" = "$after" ]; then echo "Already up to date."
    else echo "Updated:"; git --no-pager log --format='  - %s' "$before..$after"; fi
  else
    echo "Could not update (offline, or files changed here) - starting the current version."
  fi
  echo
}

node_major() { command -v node >/dev/null 2>&1 && node -p 'parseInt(process.versions.node)' 2>/dev/null || echo 0; }

main "$@"; exit $?
