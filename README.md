# Bus Sniper

Books a seat on bus-med.1337.ma the moment booking opens (on the hour).
Works on Windows, macOS and Linux. Needs **Node.js 22 or newer** - check with `node -v`.

- Windows / macOS: install the LTS version from https://nodejs.org
- Linux (no sudo needed, works on school machines):
  ```
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # close and reopen the terminal, then:
  nvm install 22
  ```
  The launchers find a Node installed with nvm by themselves.

## Start

| System  | Do this |
|---------|---------|
| Windows | Double-click `Start GUI.bat` |
| macOS   | First time: in Terminal, `chmod +x "Start GUI.command"`. Then double-click `Start GUI.command` (if macOS blocks it: right-click > Open) |
| Linux   | First time: `chmod +x start-gui.sh`. Then run `./start-gui.sh` |

A console window stays open (that's the bot: keep it open) and the GUI opens in your default browser.

**Auto-update:** if you got this folder with `git clone`, the start scripts run `git pull`
first, so you always start the latest version (offline or with local edits it just starts the
current one). To turn it off in a folder, create a file named `.no-auto-update` in it.
Terminal version: run `git pull` yourself.

## Use

1. **Log in**: click *Log in with 42*. A separate window of your default browser opens
   (its own profile; your normal browsing isn't touched). Log in, tick *Remember me* if shown;
   the window closes by itself.
2. Click buses in the order you want them (#1 is tried first; #2 only if #1 fails or is full).
3. Press **Arm**. Keep the console open; the PC is kept awake while armed
   (a closed laptop lid can still put it to sleep).

When the login expires (every 7 days) it renews by itself in the background while 42 still
remembers you; otherwise the login window pops up again, also ~1 minute before a bus opens.

The GUI and the login window always use the same browser, picked at start (the console
says which): one that's already open (your default if several are), else your default browser.
Works with Chrome, Brave, Chromium, Vivaldi, Opera, Firefox (and Edge if it's your default).
If yours is Safari, Arc or a Flatpak browser, another installed one is used for both.
To force one: set `BUS_BROWSER=/path/to/browser`.

## Terminal version

```
node bus.mjs            menu, then wait and book
node bus.mjs --list     show buses and opening times
node bus.mjs -r 152,120 book route 152, fallback 120
node bus.mjs --login    log in, then exit
node bus.mjs --12h      times as 9:00 PM (the GUI has a 12h/24h switch, top right)
node bus.mjs --help     all options
```

## Files

- `core.mjs`: booking engine (timing, clock sync, requests)
- `login.mjs`: login window
- `gui.mjs` + `gui.html`: GUI · `bus.mjs`: terminal version
- `cookie.txt` and `.login/` hold your login: don't share them
