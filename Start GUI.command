#!/bin/bash
# macOS: double-click to start the Bus Sniper GUI.
# First time only, in Terminal:  chmod +x "Start GUI.command"
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org, then double-click this again."
  read -r -p "Press Enter to close."
  exit 1
fi
node gui.mjs
read -r -p "Press Enter to close."
