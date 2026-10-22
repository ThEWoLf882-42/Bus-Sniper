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

The owner must first provide `access-public.pem` and a signed `access.json` for
your 42 login. Without a valid access file the app refuses to book.

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
- `access.mjs`, `access-public.pem` and `access.json`: verifies the signed allowed-login list
- `manage-access.mjs`: owner tool for issuing access files

## Allowed logins (owner setup)

Access is tied to the 42 login returned by the bus site's authenticated endpoint.
The GUI, terminal, pasted cookies, login renewal and booking requests all use the
same access check. Missing, invalid, modified or expired access files are rejected.

On your own computer, run once:

```sh
node manage-access.mjs init
node manage-access.mjs add yourlogin
```

Replace the example names with the actual 42 logins. `init` saves the private
signing key in **`~/.bus-sniper-owner/` outside this project folder**, and puts
only the public key in `access-public.pem`. On Windows, the private directory is
`%USERPROFILE%\.bus-sniper-owner\`. Keep it private and backed up; never put it in
Git or in the folder you share. Recipients do not run `init`.

Add or remove individual logins on the owner computer without retyping the
existing list, then distribute the updated `access.json`:

```sh
node manage-access.mjs add friendlogin
node manage-access.mjs add anotherlogin thirdlogin
node manage-access.mjs remove friendlogin
node manage-access.mjs show
```

You can separate multiple logins with spaces or commas. `add` keeps existing
logins and ignores duplicates; `remove` keeps everyone else. Removing the last
login creates a signed empty list that denies everyone. The first `add` creates
the access file if needed. Both commands verify the existing signature before
changing the list. Access errors tell users to **Contact Aymane Gimi**.

Both commands keep the existing expiry. To set or renew it, use
`node manage-access.mjs add yourlogin --expires YYYY-MM-DD` with a future date;
it expires at 00:00 UTC on that date. A new list has no expiry unless specified.
Expiry uses the local clock. The older `issue` command is still available to
replace the entire list; it resets expiry unless `--expires` is supplied.

Share the application with `access-public.pem` and `access.json`; the signing
key is not needed to run it. Editing the signed login list, or signing with an
unrelated key while keeping the application's public key, invalidates access.
Deleting the access files does not disable the check. `manage-access.mjs` cannot
issue a valid replacement without your private key.

**Local protection is a deterrent.** Recipients control their computers: they
can rewrite the verifier, replace the public key, spoof requests, change the
clock or use an older unrestricted copy. An old signed access file also keeps
working until its expiry; removing a name from a new file cannot revoke copies
already distributed. Allowed users can share their authenticated sessions too.
For enforceable access and revocation, keep the booking engine and authorization
on a server you control. See [OWASP's authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html#verify-that-authorization-checks-are-performed-in-the-right-location).

Run the offline security checks with `node --test test/access.test.mjs`. Tests
use temporary keys and a local mock bus API; they never book on the real site.
