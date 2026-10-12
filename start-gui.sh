#!/usr/bin/env bash
# Linux: start the Bus Sniper GUI (it opens in your default browser).
# First time only:  chmod +x start-gui.sh   then run ./start-gui.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node 22 or newer (https://nodejs.org or your package manager)."
  exit 1
fi
exec node gui.mjs
