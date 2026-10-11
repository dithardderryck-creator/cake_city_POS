# Parked for later

Things deliberately left out for now. Nothing here blocks the screens that exist. Updated 11 Oct 2026.

## Screens and features
- **IT page**: left as it is. Signing in as IT goes to `/it.html`, which does not exist. Server side is ready (`panel_map`, `request_inbox`). Decide what IT should see before building it.
- **Owner: "what each role can do" table**: the first design had a fixed one. Left out because a fixed table would drift from the server's real rules. If wanted, it should come from the server.
- **Owner: per-ingredient movement history** (received, used, counted): there is no feed for it yet. The Stock tab shows the forecast line instead.
## Change requests from the owner (11 Oct 2026), to be broken down before building
1. **Currency**: the whole system takes and shows money in TSh (Tanzanian shillings). Today amounts have no currency and the demo prices are tiny.
2. **Cashier: sales vs orders**: ready-made catalogue products should be an instant sale (pay, receipt, done), not an order with a ticket that has to be walked through the Orders board. Tickets and progress tracking only for custom cakes, which take time.
3. **Login page**: redesign the page and the flow. Today it lists staff names before anyone signs in and is not professional.
4. **Nothing hard-coded**: the system should be a pipe for live data. Audit for baked-in names, labels, categories, prices, thresholds, demo data.
5. **Error handling everywhere**: every button and screen needs a proper error and empty state. Example: Daily count with nothing in the system still says "in progress".
6. **Online first**: the system mainly works against an online database, and survives connection loss without corrupting it, for example an offline shop server that syncs to the online database when the connection returns. This changes the architecture (today the shop server is the one source of truth, with backups to Drive, D-67), so it needs a design and a decision first.
7. **Delete staff**: the owner can only deactivate people today. Add real removal (while keeping the history of what they did).
8. **Registered devices**: only devices the owner or IT has registered can use the system; the owner and IT can register and revoke them. Browsers cannot read a MAC address, so identity would be a secret token the server issues to each approved device.

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
