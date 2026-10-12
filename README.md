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

## Use

1. **Log in**: click *Log in with 42*. A separate window of your default browser opens
   (its own profile; your normal browsing isn't touched). Log in, tick *Remember me* if shown;
   the window closes by itself.
2. Click buses in the order you want them (#1 is tried first; #2 only if #1 fails or is full).
3. Press **Arm**. Keep the console open; the PC is kept awake while armed
   (a closed laptop lid can still put it to sleep).

When the login expires (every 7 days) it renews by itself in the background while 42 still
remembers you; otherwise the login window pops up again, also ~1 minute before a bus opens.

The login window works with Chrome, Brave, Chromium, Vivaldi, Opera, Edge and Firefox.
If your default browser is Safari, Arc or a Flatpak browser, another installed one is used.
To force one: set `BUS_BROWSER=/path/to/browser`.

## Terminal version

```
node bus.mjs            menu, then wait and book
node bus.mjs --list     show buses and opening times
node bus.mjs -r 152,120 book route 152, fallback 120
node bus.mjs --login    log in, then exit
node bus.mjs --help     all options
```

## Files

- `core.mjs`: booking engine (timing, clock sync, requests)
- `login.mjs`: login window
- `gui.mjs` + `gui.html`: GUI · `bus.mjs`: terminal version
- `cookie.txt` and `.login/` hold your login: don't share them
