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

# 4. Register this computer's browser as the first device (the system only opens on registered devices)
npm run admin -- device-code --name "Office laptop"
#    It prints a code like 7QKX-2MPD. Valid 10 minutes, works once.

# 5. Start the server
npm run start
```

Open the address on the computer, type the code on the first screen, then sign in with the owner's PIN. After that the owner registers every other phone, tablet and computer from **Staff → Devices** (Make a code, type it on the new device). Revoke a lost or stolen device there too: everyone signed in on it is signed out straight away.

**Devices, wifi and getting locked out.** A device is recognised by a secret its browser keeps, never by the wifi or address it is on. Switching between the shop wifi, mobile data or a hotspot does not sign anyone out or un-register a device (the server only needs to be reachable; away from the shop wifi the sign-in page says it cannot connect and works again when the device is back). Both the owner and IT can see, rename, re-register and revoke devices (IT does it on its own page, `/it.html`). Safeguards:
- You cannot revoke the device you are using, and the last registered device can never be revoked.
- A browser that lost its secret (cleared site data, new browser, private window) shows the registration page. Open **Devices** on another registered device and press **Re-register** next to its name: the code it makes replaces the old record, so the name is not listed twice. Revoke is for lost or stolen devices.
- If the only registered device is lost, make a code on the server itself (step 4 above) and register a new one.
- A revoked till refuses any offline sales it had not sent yet. Revoke a till only after it has reconnected, unless it is lost or stolen.

It prints the addresses, for example `http://192.168.1.20:8787`. Open that on any phone, tablet or computer on the shop wifi.

**Give the server computer a fixed address** in your router settings (look for "DHCP reservation" or "static IP"), so the address never changes.

**Firewall:** the first start may ask to allow incoming connections. Allow it on **private networks only** (Windows) or "Allow" (macOS). Without that, other devices cannot connect.

### The screens

`npm run build` builds the pages into `apps/ui/dist`, and `npm start` serves them from the same address as the server, so devices just open the server's address (no separate hosting). To serve a different folder, set `STATIC_DIR=path/to/folder`.

### Kiswahili

The owner picks the language for the whole shop in Settings (the "Language everyone sees on screen" choice). Everyone sees the change, including the sign-in page. Only what is shown on screen changes: the database, reports saved earlier and the server logs stay in English. Names the shop typed in (products, people, devices) are shown as typed.

The Kiswahili was written without a native speaker. Before the shop relies on it, ask someone at the shop to read through each screen and note what sounds wrong. The wording lives in `apps/ui/src/lang/*.txt`, one line per phrase (`English ||| Kiswahili`), so a correction is one line. Run `npm run build` after editing; the build stops if a line loses a number or name placeholder. A phrase with no line shows in English.

### Settings, My account and the location check

**Owner → Settings** is a list of sections, each with its own Save button: Shop details, Selling (ways of paying, refund wait, who closes the day, decorating step), Stock and warnings, Offline selling, Language, Location check. Nothing is saved until you press Save in that section.

**My account** is under the name at the top of every page, for every role: change your own PIN, set your phone number and how you want alerts (text message, WhatsApp), pick light or dark, and sign out. The language is shop-wide and is changed by the owner in Settings.

**Location check (off until you switch it on).** Owner → Settings → Location check, or the Location card on the IT page. Stand inside the shop with your phone, tap **Use where I am now**, then switch the check on. Cashiers, bakers and inventory staff who are away from the shop (more than the radius, 150 m to begin with) sign in as usual but only reach a lobby: they can read announcements and change their PIN, and cannot sell or work. The owner and IT are never held. Phones and tablets are good at this; a computer with no GPS may guess a position several hundred metres off, so set the spot from a phone. If a phone refuses to share its location it is held in the lobby too, with the reason shown. This is a reminder for honest staff, not a lock: a phone can be made to report a false position, and a till that has lost the server keeps selling under the offline rules. If it ever gets in the way, the owner or IT switches it off and everyone is released at once.

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
| `TRUST_PROXY` | `0` | How many proxies sit in front of the server (0 to 5), so each visitor gets their own sign-in and pairing limit. Set to 1 behind a host such as Render |
| `TEST_COPY` | off | `1` on a throw-away online copy only: fill an empty database with demo data and print a one-time device code at every start. See `docs/test-copy.md` |
| `STATIC_DIR` | `apps/ui/dist` when started with `npm start`, otherwise none | Folder of built pages to serve |
| `TLS_CERT`, `TLS_KEY` | none | Paths to a certificate and key, to serve HTTPS. Set both or neither |
| `REQUIRE_DEVICE` | on | Only registered devices can sign in or see staff names. Set `0` to switch it off (try-outs only) |
| `CURRENCY_LABEL` | TSh | The word in front of every amount |
| `TZ` | the computer's own | The shop's time zone, for example `Africa/Dar_es_Salaam`. Today's date, due dates and reports follow it, so set it if the computer is on UTC |
| `DEVICE_PREFIX` | S | 1 to 3 letters at the start of order numbers (S-0001) |
| `LOG_LEVEL` | info | debug, info, warn or error |
| `SMS_PROVIDER` | none | `twilio`, `africastalking` or `webhook`. Needs the matching settings below |
| `WHATSAPP_PROVIDER` | none | `twilio` or `webhook` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | none | Twilio login (SMS and WhatsApp) |
| `TWILIO_SMS_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | none | The number or sender name SMS comes from |
| `TWILIO_WHATSAPP_FROM` | none | Like `whatsapp:+14155238886` |
| `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID`, `AT_SANDBOX` | none | Africa's Talking (`AT_SANDBOX=1` for testing) |
| `MESSAGE_WEBHOOK_URL`, `MESSAGE_WEBHOOK_TOKEN` | none | Any other service: the server posts each message there |
| `BACKUP_EVERY_HOURS` | 0 | Also back up (and upload to Google Drive) this often, 1 to 24. 0 means nightly only |
| `CLOUD_BACKUP_KEEP` | 60 | How many backups to keep in Google Drive |
| `ARCHIVE_DIR` | `DATA_DIR/archive` | Where archived spreadsheets are kept on this computer. Point it at any folder, for example one on an external drive or a shared office folder |
| `ARCHIVE_WHEN_FULL_MB` | 500 | The database counts as "full" when the data in it reaches this size |
| `ARCHIVE_MIN_AGE_DAYS` | 90 | Only orders this many days past their delivery date are archived |
| `ARCHIVE_ACTIVITY_DAYS` | 365 | Activity-log entries older than this are archived too |
| `PUSH_CONTACT` | none | An email address for phone push (required by the phone makers' services). Push is off until it is set |

Default data folder: Windows `%APPDATA%\CakePOS`, macOS `~/Library/Application Support/CakePOS`, Linux `~/.local/share/cakepos`. A wrong setting stops the server with a message saying exactly which one.

## Starting automatically, and restarting if it stops

The server stops itself cleanly if it hits something unexpected, and relies on the computer to start it again. Set that up once.

- **macOS:** `deploy/macos/com.cakepos.server.plist`. Edit the paths, copy to `~/Library/LaunchAgents/`, then `launchctl load ~/Library/LaunchAgents/com.cakepos.server.plist`. It starts at login and restarts if it stops. For starting without anyone logging in, use a LaunchDaemon instead.
- **Windows:** edit `deploy/windows/start-server.cmd` (paths and settings), then run `deploy/windows/install-task.ps1` once in PowerShell **as Administrator**. It creates a task that starts at boot and restarts every minute if it stops.

Test it: restart the computer and check the address works without anyone touching it.

## Alerts to phones, WhatsApp and SMS

Alerts always appear in the app. To also reach people when the app is closed:

1. **Phone push (no extra cost).** Set `PUSH_CONTACT` to an email address and restart. The server makes its own keys the first time and keeps them in the database (so restoring a backup keeps phones registered). Each person then opens the app on their phone and presses the button to turn on phone notifications. **This needs HTTPS** (see below); over plain `http://` on the shop wifi the phone will refuse. On iPhone, first use Share, then Add to Home Screen. A closed phone plays its own notification sound; the siren only plays while the app is open.
2. **SMS or WhatsApp.** Pick a provider, create an account, and set the settings in the table above. Without them the app says "SMS is not set up on this server" rather than failing silently. WhatsApp business messaging through Twilio needs a WhatsApp sender approved by Meta, and messages sent outside a 24-hour customer window must use an approved template; plan for that. SMS through Africa's Talking: the response codes were written from its public documentation and have not been tried against a live account, so send a test first.
3. **Each person's phone number** is saved by them (or the owner) in the app with `staff/set_contact`. Use international format, for example `+254712345678`.
4. **Check it.** Each person can send themselves a test; the owner and IT can read the delivery log (what was sent, what failed and why).

## Online copy: Google Drive

The shop computer stays the main copy of the data (it keeps working with no internet, and every sale is saved on it first). **Google Drive adds an online copy**: whenever the wifi is up, the server uploads each database backup to your Drive, and when the database gets full it moves old orders into Google Sheets there. If the internet is down, uploads wait and are retried every 10 minutes.

**What goes where** (all inside one Drive folder, "Cake POS" by default):

| Folder | Contents |
| --- | --- |
| `Backups` | Complete copies of the database, newest `CLOUD_BACKUP_KEEP` kept. Restoring one rebuilds the whole shop (see Restoring) |
| `Archive` | Google Sheets of old finished orders and old activity-log entries |

The server can only see files it created itself (the `drive.file` permission), never the rest of your Drive.

**One-time setup (about 15 minutes, needs a Google account and a phone):**

1. Open the Google Cloud Console (`console.cloud.google.com`) signed in as the Google account that should own the shop's files. Create a project, for example "Cake POS".
2. Enable the **Google Drive API** for that project.
3. Set up the **OAuth consent screen**: user type External, an app name, your email. Add the scope `.../auth/drive.file`. **Then publish the app to "In production".** While it is left in "Testing", Google ends the sign-in after 7 days and uploads would start failing. The `drive.file` permission is the narrow one, so Google does not require a review for it.
4. Create credentials: **OAuth client ID**, application type **TVs and Limited Input devices**. Copy the client ID and client secret.
5. On the shop computer, in the project folder: `npm run admin -- google-auth`. Paste the client ID and secret when asked. It shows a short code and a web address. Open the address on your phone, enter the code, sign in and press Allow. The tool then creates the folders and saves the sign-in in the data folder (`google-drive.json`, readable only by the server's user).
6. Restart the server. The Panel map now lists Google Drive as connected.

Check it any time with `npm run admin -- drive-check`. If the Google password is changed, or access is removed in the Google account's security page, run `google-auth` again. (These steps follow Google's documented flow; the screens change from time to time, and I could not try them against a real Google account, so do a backup and look for it in Drive before relying on it.)

> **Drive holds customer names, phone numbers and sales.** Use two-step sign-in on that Google account.

**Frequent copies:** set `BACKUP_EVERY_HOURS=3` to have the online copy never more than about 3 hours behind (a backup takes a second or two for a normal shop). The database file is uploaded whole each time, so a very large database uses more data; archiving keeps it small.

## Archiving old orders

When the data in the database reaches `ARCHIVE_WHEN_FULL_MB`, the server (checking hourly) moves **finished orders** out into a spreadsheet:

- An order is finished when every item is handed over (or the order is cancelled), the money is settled (no balance, nothing waiting to be refunded), no price request or usage report is waiting, and its delivery date is more than `ARCHIVE_MIN_AGE_DAYS` ago. Anything else stays.
- Each spreadsheet (up to 1000 orders) has sheets for Summary, Orders, Items, Payments, Refunds, Quotes and Ingredient use. It is saved as `.xlsx` in `ARCHIVE_DIR` and, when Drive is connected, as a Google Sheet in `Cake POS / Archive`. Reference photos are saved on the shop computer in a folder next to the spreadsheet (they are not uploaded to Drive).
- **Safety order:** the file is written and read back, then uploaded, then a fresh backup is taken, and only then are the orders removed. If any step fails (Drive unreachable, disk full) **nothing is removed** and the server tries again at the next hourly check. The Panel map shows the last problem.
- The activity log is archived the same way (entries older than `ARCHIVE_ACTIVITY_DAYS`) once orders alone did not make enough room.
- Order numbers keep counting up; archived orders are never renumbered or reused.
- The database file does not get smaller on disk after archiving (SQLite reuses the freed space). That is fine; "full" is measured by the data inside, not the file size.

By hand (stop the server first):

```bash
npm run admin -- archive-status                 # size, what has been archived, Drive connected or not
npm run admin -- archive --dry-run              # what it would move; changes nothing
npm run admin -- archive --now                  # move everything old and finished, even if not "full"
npm run admin -- archive --now --older-than-days 30
```

Archived orders are gone from the app's screens. To look one up, open the spreadsheet.

## Backups

Every night at `BACKUP_TIME` the server:

1. Takes a snapshot of the database at a moment when nothing is half-saved.
2. **Checks the snapshot** (it must open and pass an integrity check). A snapshot that fails is thrown away and reported.
3. Keeps it in `BACKUP_DIR` as one file, `cakepos-YYYYMMDD-HHMMSS.sqlite` (the time is UTC).
4. If `CLOUD_BACKUP_DIR` is set, copies it there, and if Google Drive is connected, uploads it there too. If that fails (no internet, folder missing), the local copy is kept and the copy is **retried every 10 minutes** until it works.

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
