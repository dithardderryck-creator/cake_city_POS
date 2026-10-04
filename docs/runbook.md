# Running the shop server

For the person who sets up and looks after the shop computer. No programming needed beyond typing the commands shown.

> **Status:** the server is tested on Linux. The Windows and macOS start-up files in `deploy/` are written for those systems but **have not been run on them yet**. Treat your first setup as a trial, and follow the pilot checklist at the end before relying on it.

## What you need

- A computer that stays on during opening hours: a small desktop or an old laptop. **Wired ethernet** is better than wifi. A **UPS** (a small battery backup) is strongly recommended, because it turns a power cut from "lost sales" into "a clean shutdown".
- **Node.js 20 or newer** (the current LTS is fine): https://nodejs.org
- The shop's wifi router. Devices reach the server over the shop network. **The internet is not needed for selling.**

## First-time setup

```bash
# 1. Get the code onto the computer (unzip it, or git clone), then in that folder:
npm ci
npm run build            # builds the server and the web app

# 2. Pick where the data lives (optional; there is a sensible default, shown when it starts)
#    Windows: set DATA_DIR=D:\CakePOS-data       macOS/Linux: export DATA_DIR=~/CakePOS-data

# 3. Create the first owner. It asks for a PIN, and hides what you type.
npm run admin -- create-owner --name "Amina"

# 4. Start the server
npm run start
```

It prints the addresses, for example `http://192.168.1.20:8787`. Open that on any phone, tablet or computer on the shop wifi.

**Give the server computer a fixed address** in your router settings (look for "DHCP reservation" or "static IP"), so the address never changes.

**Firewall:** the first start may ask to allow incoming connections. Allow it on **private networks only** (Windows) or "Allow" (macOS). Without that, other devices cannot connect.

### Serving your own UI from the server

Build your UI, then point the server at the folder: `STATIC_DIR=path/to/dist`. Devices then just open the server's address, with no separate hosting.

## Settings

Set these as environment variables before starting. All are optional.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | 8787 | Port to listen on |
| `HOST` | 0.0.0.0 | `0.0.0.0` lets other devices connect. `127.0.0.1` allows this computer only |
| `DATA_DIR` | per system (see below) | Where the database, logs and backups live |
| `BACKUP_DIR` | `DATA_DIR/backups` | Where local backups go. Point at an external drive for extra safety |
| `CLOUD_BACKUP_DIR` | none | A folder your cloud app syncs (see Backups) |
| `BACKUP_TIME` | 02:00 | Nightly backup time, 24-hour, shop local time |
| `BACKUP_KEEP` | 30 | How many local backups to keep |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Other web addresses allowed to call the API. Comma-separated, or `*` |
| `STATIC_DIR` | none | Folder of a built UI to serve |
| `TLS_CERT`, `TLS_KEY` | none | Paths to a certificate and key, to serve HTTPS. Set both or neither |
| `DEVICE_PREFIX` | S | 1 to 3 letters at the start of order numbers (S-0001) |
| `LOG_LEVEL` | info | debug, info, warn or error |

Default data folder: Windows `%APPDATA%\CakePOS`, macOS `~/Library/Application Support/CakePOS`, Linux `~/.local/share/cakepos`. A wrong setting stops the server with a message saying exactly which one.

## Starting automatically, and restarting if it stops

The server stops itself cleanly if it hits something unexpected, and relies on the computer to start it again. Set that up once.

- **macOS:** `deploy/macos/com.cakepos.server.plist`. Edit the paths, copy to `~/Library/LaunchAgents/`, then `launchctl load ~/Library/LaunchAgents/com.cakepos.server.plist`. It starts at login and restarts if it stops. For starting without anyone logging in, use a LaunchDaemon instead.
- **Windows:** edit `deploy/windows/start-server.cmd` (paths and settings), then run `deploy/windows/install-task.ps1` once in PowerShell **as Administrator**. It creates a task that starts at boot and restarts every minute if it stops.

Test it: restart the computer and check the address works without anyone touching it.

## Backups

Every night at `BACKUP_TIME` the server:

1. Takes a snapshot of the database at a moment when nothing is half-saved.
2. **Checks the snapshot** (it must open and pass an integrity check). A snapshot that fails is thrown away and reported.
3. Keeps it in `BACKUP_DIR` as one file, `cakepos-YYYYMMDD-HHMMSS.sqlite` (the time is UTC).
4. If `CLOUD_BACKUP_DIR` is set, copies it there. If that fails (no internet, folder missing), the local copy is kept and the copy is **retried every 10 minutes** until it works.

If a night's backup fails, it retries after 30 minutes. IT sees "last backup failed" on the Panel map with the reason.

**Cloud copy:** set `CLOUD_BACKUP_DIR` to a folder that OneDrive, iCloud Drive, Dropbox or Google Drive is already syncing. That app does the uploading whenever the internet is available. Only the newest `BACKUP_KEEP` files are kept there.

**Pictures are inside the backup.** Reference photos for custom cakes are stored in the database, so every backup and restore includes them, and they grow the file. At 5 MB maximum and a typical 300 KB to 1 MB each, a busy shop can add a few hundred megabytes a year. Check the database size on the Panel map now and then.

> **Backups contain every sale, customer name, payment and customer photo. Protect that cloud account** with a strong password and two-step sign-in.

A backup is taken on demand with: `npm run admin -- backup`

### Restoring (practise this before you need it)

```bash
# 1. Stop the server.
# 2. Pick a backup file (local, or from the cloud folder) and restore it:
npm run admin -- restore path/to/cakepos-20260929-020000.sqlite
# 3. Start the server.
```

- The restore **checks the file first** and refuses a damaged one without touching anything.
- The data that was there before is **kept** next to the database (`cakepos.sqlite.before-restore-...`), so a restore can itself be undone.
- It refuses to run while the server is running.
- Anything that happened after that backup is not in it. If last night's backup is restored at 3 pm, that day's sales so far are gone from the system. The kept copy still has them.

**Do a restore drill once a month** on a spare computer: copy a cloud backup there, restore it, start the server, and look at yesterday's orders. A backup you have never restored is a hope, not a backup.

## Other everyday jobs

| Job | How |
| --- | --- |
| Forgot a PIN, and the owner can't reset it | `npm run admin -- reset-pin --name "Amina"`. Also unlocks the account and signs it out everywhere |
| An owner can reset anyone else's PIN | In the app: Staff, then Reset PIN |
| See who exists | `npm run admin -- list-staff` |
| Check the database is healthy | `npm run admin -- check` |
| Where are the logs? | `DATA_DIR/logs/server-YYYY-MM-DD.log`, one JSON line per event, kept 30 days. **PINs and sign-in tokens are never written to them** |

### Updating the server

1. `npm run admin -- backup`
2. Stop the server, replace the code, `npm ci`, `npm run build`, start it.
3. Database changes apply automatically on start. A database written by a **newer** version refuses to open under an older one, rather than being damaged.

## If the server computer breaks

The shop cannot sell on devices until the server is back, so decide this **before** it happens:

1. Keep a second computer with Node installed and the code on it.
2. Install the code, copy the newest backup (from the cloud folder) to it, `restore`, start it.
3. Give it the old computer's fixed address in the router, so devices find it without changes.

This takes about 15 minutes if you have practised. Until then, take orders on paper and enter them afterwards.

## HTTPS (optional)

Browsers disable the "install as an app" and offline-shell features on plain `http://` addresses. If you want them on shop devices, serve HTTPS with a certificate those devices trust. The simplest route is a free tool like [mkcert](https://github.com/FiloSottile/mkcert) on the server computer: it makes a certificate and a trusted root you install on each device. Then set `TLS_CERT` and `TLS_KEY`. The server works without this.

## Troubleshooting

| Problem | Likely cause and fix |
| --- | --- |
| "Another Cake POS server is already using ..." | Another copy is running. Stop it. If you're sure none is, delete `server.lock` in the data folder |
| Other devices can't connect | Firewall (allow it on private networks), the wrong address, or `HOST=127.0.0.1` |
| "Cannot reach the shop server" on a device | Wifi dropped, or the server is off. Nothing was saved; try again when it is back |
| Everyone signed out | The server was off for over 24 hours, or each person's sign-in expired. Just sign in |
| "Too many wrong PINs" | Wait the time shown, or the owner resets the PIN |
| Backup shows "failed" | Read the reason on the Panel map. Usually a full disk or an unplugged drive |
| Server says it can't start: `...must be a whole number` | A setting is wrong. The message names it |
| `npm ci` fails with `gyp ERR!` or talks about compilers | The project's `.npmrc` (which skips install scripts) was not used. Run `npm ci --ignore-scripts`. The database library ships ready-made binaries and needs no compiler |

## What this does NOT protect against

- **Anyone on the shop network can reach the server.** The PIN stops casual misuse and records who did what; it is not strong security. Keep customers on a separate guest wifi.
- Without HTTPS, traffic on the shop wifi is not encrypted. PINs and sales travel in the clear on your own network.
- A stolen or broken server computer with no backup loses the data. Check the cloud copies exist.
- The system runs on one computer. There is no automatic failover.

## Pilot checklist (before relying on it)

On a developer machine, `npm run acceptance` automates the crash, backup and restore parts of this list against a throwaway database. It does not replace trying them on the real shop computer.

- [ ] Restart the computer: the server comes back by itself
- [ ] Unplug the internet: selling still works
- [ ] Unplug the server's power (or kill the process) mid-sale: after restart, no half-saved orders, nobody signed out
- [ ] Take a backup, copy it to another computer, restore it there, and see yesterday's data
- [ ] Switch off a test person: their device is signed out within seconds
- [ ] Run alongside your current method (paper or old till) for at least a week, and compare the day's totals every evening
- [ ] Let staff use it on their real devices over the real wifi at a busy time
