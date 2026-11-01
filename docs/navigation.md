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

**Alerts for IT** are raised by the one-minute check from what the machine says: failed syncs, a failed backup, a Google account that needs signing in or is full, someone locked out by wrong PINs, and a nearly full disk (under 10% or 500 MB). They reach IT only, in the bell and by the channels IT chose, never the owner. A quiet device only shows on Health, with no ring. When one has been open for a day, the owner's Overview shows one line, "A system problem has been open for a day. IT has been told.", and no detail; it goes when the problem is fixed.

## Two screens that changed

- **Sell**: each cake is one card with its lowest price and its number of options. Tapping it opens a sheet to choose size, filling and kind; the price and stock follow the choice. A cake that comes only one way is added with one tap, as before.
- **Overview** (owner): **Needs you** comes first (late orders, price and other requests, low or finished stock), then revenue. When nothing needs the owner it is one calm line.
