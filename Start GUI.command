#!/bin/bash
# macOS: double-click to start the Bus Sniper GUI.
# First time only, in Terminal:  chmod +x "Start GUI.command"
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

node_major() { command -v node >/dev/null 2>&1 && node -p 'parseInt(process.versions.node)' 2>/dev/null || echo 0; }

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
