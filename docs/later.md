# Parked for later

Things deliberately left out for now. Nothing here blocks the screens that exist. Updated 11 Oct 2026.

## Screens and features
- **IT page**: left as it is. Signing in as IT goes to `/it.html`, which does not exist. Server side is ready (`panel_map`, `request_inbox`). Decide what IT should see before building it.
- **Owner: "what each role can do" table**: the first design had a fixed one. Left out because a fixed table would drift from the server's real rules. If wanted, it should come from the server.
- **Owner: per-ingredient movement history** (received, used, counted): there is no feed for it yet. The Stock tab shows the forecast line instead.
## Change requests from the owner (11 Oct 2026), to be broken down before building
1. ~~**Currency**~~ **DONE (11 Oct 2026).** Amounts show as "TSh 25,000" everywhere; cents are refused (whole shillings only); demo prices are realistic. Still worth a look later: receipts shared by link and the xlsx archive (check they read TSh).
2. ~~**Cashier: sales vs orders**~~ **DONE (11 Oct 2026, backend and cashier page).** New instruction `orders/quick_sale`: walk-in pickup sales of ready-made products are one all-or-nothing step (order, completed lines, stock drop, full payment, receipt). Phone, delivery and part-payment orders still use tickets. Browser tests pass (`npm run ui:test`). Note: a finished instant sale still shows in the Orders board's Closed column.
3. ~~**Login page**~~ **DONE (11 Oct 2026).** Three states: cannot reach the server (Try again), this device is not registered (type a pairing code), and name + PIN. Unregistered devices see no staff names (the server refuses `/api/staff` too). No staff yet says so plainly. Still open: showing the shop's own name on this page needs a small public setting; shifts, float and Z-report are a later step.
4. **Nothing hard-coded**: the system should be a pipe for live data. Audit for baked-in names, labels, categories, prices, thresholds, demo data.
5. **Error handling everywhere**: every button and screen needs a proper error and empty state. Example: Daily count with nothing in the system still says "in progress".
6. **Online first**: the owner's design is in `docs/cloud-first-design.md` (cloud is the main copy, the shop computer is the fallback, geofencing for cashier/baker/inventory, a refund cooldown). **Not built beyond part 1; do not build more until the owner says so.** **PART 1 BUILT (11 Oct 2026); needs Q-16 to finish.** Every saved or deleted record is now written to a change log in the same transaction as the work, sent in order to an online endpoint every 10 seconds, resent safely after failures (each change has a unique id; the receiver must ignore ids it already has), with back-off when the endpoint is down. Selling never waits for it. Turn it on with `ONLINE_DB_URL` (https) and `ONLINE_DB_TOKEN`; `sync/full_copy` queues everything that exists for a new or rebuilt database; `sync/flush` sends now. Sessions, lock state, phone subscriptions and picture data are never sent. **Still to do:** (a) choose the online database (Q-16) and build its receiver for `POST {url}/sync/push` with `{deviceId, changes[]}`; (b) reading back from the online database (a second shop computer, restoring a lost shop computer from it); (c) conflict rules if two devices ever write the same record; (d) show sync state (waiting, last sent, last error) on the IT and owner screens; (e) decide whether the online database becomes the main copy (D-67 still says the shop computer is).
7. ~~**Delete staff**~~ **DONE (11 Oct 2026).** New instruction `staff/delete` (owner only; not yourself, not an owner). The person is signed out everywhere, cannot sign in, disappears from the sign-in list and staff list, loses PIN, contact details and phone notifications; the record stays as a bare name so old orders, payments and audit lines still say who did them. Their name can be reused. "Remove" button on the owner page (browser test of the owner page passes, but does not yet click Remove).
8. ~~**Registered devices**~~ **DONE (11 Oct 2026).** Browsers cannot read a MAC address, so each approved device holds a secret the server issued (only its hash is kept). The owner or IT makes a one-time code (about 10 minutes, one use, 8 characters) with the device's name; typing it on the device registers it. Revoking signs out everyone on that device at once. You cannot revoke the device you are using. Sign-ins are tied to the device they were made on. The very first device is registered with `npm run admin -- device-code --name "Office laptop"` on the server computer. `REQUIRE_DEVICE=0` switches the check off (local try-outs). Devices and codes stay on the shop server and are never sent online. Limits to know: a stolen sign-in token used from another browser is not caught by the device check once signed in (it is the same risk as any session); the IT page has no Devices screen yet (the owner page does); codes are guarded by a rate limit of 10 tries a minute per address.

Notes from the owner (Gemini) on a POS login flow, to be used where they fit: terminal identification (registered device, printer and cash drawer check), fast PIN sign-in (NFC or fingerprint are options for later), role and permission checks on sign-in, **opening a shift with a counted starting cash float and a closing end-of-day report (Z-report)**, then loading the latest catalogue and prices.

## Open decisions (to break down together before testing)
| Id | Question |
| --- | --- |
| Q-14 | Which Google account is used for Drive copies |
| Q-15 | Archive folder (`ARCHIVE_DIR`) |
| Q-16 | Live online database, or the shop computer plus Drive copies (D-67) |
| Q-17 | Alert thresholds and who gets which alerts |
| Q-18 | Copy schedule and archive size limits |
| Q-07 | SMS and WhatsApp provider |
| Q-11 | HTTPS on the shop network |

## Testing
Hand-testing on real devices starts once everything above is confirmed done. The checklists are in `docs/ui-checkpoint.md`.
