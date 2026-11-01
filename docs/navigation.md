# Names and navigation

One page of words and places, so the same thing is called the same thing everywhere and every role finds things in the same way.

## The screen, the same for every role

- **Top bar** (identical on every page): logo, connection dot, search, bell, menu button.
- **Tabs** under the bar: the few pages used all day. At most five.
- **Menu** (the button at the right of the bar): your name and My account, then every page of your role in groups, then Sign out.
- The page's own title is the first thing on the page, and it is the same word as in the menu.

## Words

| Say | Not |
| --- | --- |
| Payments | Transactions |
| Requests | Inbox, approvals |
| Custom cakes | Special orders |
| Usage reports | Consumption |
| Daily count | Stocktake |
| Needs you | Pending, to do |
| Sign out | Log out |

## Where things are

| Role | Tabs | Menu groups |
| --- | --- | --- |
| Owner | Overview, Requests, Orders, Payments | **Today** Overview, Requests, Orders. **Money** Payments, Reports. **Shop** Catalogue, Stock, Staff, Settings |
| Cashier | Sell, Orders, Custom cakes, Today's sales | **Today** Sell, Open tickets, Orders, Custom cakes, Requests. **Money** Today's sales |
| Baker | Queue, Tickets, Batches, Usage reports, Requests | **Today** Queue, Tickets, Requests. **Kitchen** Batches, Usage reports |
| Inventory | Stock, Usage reports, Daily count, Requests | **Today** Stock, Usage reports, Daily count, Requests |
| IT | Health, Devices, Records, Backups | **Watch** Health, Records, Logs. **Fix and control** Sessions. **Connect** Devices and location, Backups and Google. The bell opens Health and counts what needs IT. Console arrives with a later phase |

The theme, language, PIN and contact details are in **My account**. The alert sound switch (baker and inventory) is in the menu above Sign out.

## The IT page

Health opens first: a **Selling** line (registered devices seen in the last hour, and any quiet for a day or more), **Needs you** (the system's alerts for IT, people locked out with a **Let in** button, and devices quiet for a day), four check cards that open their tab, and the system details. **Records** is the plain list of who did what for now; sealing the records is a later phase. **Backups** has the two sync buttons and the Google accounts. The design and build order are in the IT spec (phases 1 to 8).

**Sessions** lists everyone signed in now (name, role, device, when they signed in and were last active), read-only and with no token or PIN. **Logs** shows the newest 200 lines of the server's log, filtered by level and time and searchable; it is read-only too, and secrets are hidden when the line is written. Ending sessions and the other changing operations come in phase 6, each with a preview.

**Records** is the sealed record of everything done in the system. Every action is written to the activity record and sealed to the one before it (a fingerprint chain, kept in `circuits/seal.ts`), so a change or removal made afterwards shows as a mismatch. The page opens with a **Seal** card (how many records are sealed, when sealing began, the latest seal code, the last check and what it found) and two buttons: **Check now** (what is new since the last good check) and **Check everything** (every link, and the number of entries that were never sealed). A check also runs by itself once a day; a failed check raises a **The sealed records do not match** alert for IT. Below it, **Who did what** lists records newest first, 40 at a time with **Show more**, filtered by Everything, Only refused or Only opened. Money and stock records (payments, orders, stock, counts, usage, batches, day close, offline sales, price changes) show only as a lock until IT taps one to open it; opening shows the details and whether they still match the seal, and is itself recorded. Records whose details have moved to the archive keep their seal. The chain holds fingerprints only, never names or amounts. Known limit: someone holding every key could rewrite and re-seal the chain; the planned Drive fingerprint is the guard against that.

**What IT did** (owner, Staff page) is a read-only list of everything people with the IT role did, newest first, 25 at a time.

**Copy on Drive** (IT, Records page) and **Records matched Drive today** (owner, Overview). The server saves the chain's newest fingerprint to the connected Google account as a small text file in `Cake POS/Fingerprints`, whenever the records have moved on and the last copy is over six hours old. The file's name carries the day, the number of sealed records and the fingerprint itself, so comparing needs no download and the file holds no names, amounts or secrets. About every three hours (and when IT taps **Compare with Drive now**) every fingerprint from the last 120 days is checked against the record it names; a changed or missing record is a mismatch. The page shows last saved, last compared and whether it matched today. A mismatch, or no new fingerprint reaching Drive for a day while records keep being written, rings IT's bell. The owner's line is shown straight away, not after a day: it says the records matched today, were not compared yet, do not match, or could not be compared, or that no Google account is connected. The automatic runs write one line a day to the activity record when all is well, and one when the answer turns bad or good again. Files are put in whichever connected account has room first, so for the copy to be out of IT's hands that account must be the owner's own Google account, and its version history is the owner's check on the files themselves.

**Alerts for IT** are raised by the one-minute check from what the machine says: failed syncs, a failed backup, a Google account that needs signing in or is full, someone locked out by wrong PINs, and a nearly full disk (under 10% or 500 MB). They reach IT only, in the bell and by the channels IT chose, never the owner. A quiet device only shows on Health, with no ring. When one has been open for a day, the owner's Overview shows one line, "A system problem has been open for a day. IT has been told.", and no detail; it goes when the problem is fixed.

## Two screens that changed

- **Sell**: each cake is one card with its lowest price and its number of options. Tapping it opens a sheet to choose size, filling and kind; the price and stock follow the choice. A cake that comes only one way is added with one tap, as before.
- **Overview** (owner): **Needs you** comes first (late orders, price and other requests, low or finished stock), then revenue. When nothing needs the owner it is one calm line.
