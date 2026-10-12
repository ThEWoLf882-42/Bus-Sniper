#!/usr/bin/env bash
# Linux: start the Bus Sniper GUI (it opens in your default browser).
# First time only:  chmod +x start-gui.sh   then run ./start-gui.sh
cd "$(dirname "$0")" || exit 1

node_major() { command -v node >/dev/null 2>&1 && node -p 'parseInt(process.versions.node)' 2>/dev/null || echo 0; }

# a Node installed with nvm isn't on the PATH of scripts: load it
NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
if [ "$(node_major)" -lt 22 ] && [ -s "$NVM_SH" ]; then
  . "$NVM_SH"
  nvm use --silent 22 >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1
fi

if [ "$(node_major)" -lt 22 ]; then
  echo "Bus Sniper needs Node.js 22 or newer (you have: $(node -v 2>/dev/null || echo none))."
  echo
  echo "Install it without sudo using nvm:"
  echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "  (close and reopen the terminal)"
  echo "  nvm install 22"
  echo
  echo "Then run ./start-gui.sh again."
  exit 1
fi
exec node gui.mjs
