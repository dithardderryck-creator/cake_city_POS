# New screens: checkpoint

Where the new screens (from the four HTML designs) stand, how to try them, and what is left. Written 10 Oct 2026.

## Try it

```
npm install
npm run ui:try            # builds the screens, fills a demo shop, starts it
npm run ui:try -- --fresh # same, from clean demo data
```

Open http://localhost:8787/. A phone on the same wifi can use the address it prints. Demo PINs: owner 1111, cashier 2222, baker 3333, inventory 4444. Demo data lives in `.try-data/` (delete it to reset). The demo has no stock list or recipes and no custom cakes: add ingredients on the Inventory screen (New item) and ingredient amounts in its drawer, and make custom cakes on the Cashier screen, to see the baker and usage flows.

Automated browser tests: `npm run ui:test` (cashier, baker, inventory; real server, real Chromium, desktop and phone width; screenshots go to `/tmp/ui-shots-<role>/`).

## Status

| Screen | Wired to server | Browser test | Notes |
|---|---|---|---|
| Sign-in | yes | passes | |
| Cashier | yes | passes | |
| Baker | yes | passes | |
| Inventory | yes | **not passing yet** | First run stopped at "receive stock updates the open drawer". Could be a test expectation (unit text such as "12 kg") or a page fault. Not investigated. |
| Owner | **no** | none | Still the unedited design with demo data and a fake PIN lock. |
| IT | not started | none | Set aside for now. Until it exists, an IT sign-in goes to `/it.html`, which is missing. |
| Old React app (`apps/web`) | still there | | Keep until the Owner screen is done. |

## Hand-test checklist

Tick these on the demo shop. "Second screen" means a second browser window signed in as someone else.

### Cashier
- [ ] Sell: tap items, change quantity, Clear. Totals and "free" counts look right.
- [ ] Walk-in cash sale: enter an amount received, see change, take payment, receipt opens.
- [ ] Mobile money, card and bank transfer sales work.
- [ ] Phone order with delivery: name, phone (with +255), date, address; part payment leaves a balance.
- [ ] Wrong input is refused in plain words (bad phone number, delivery with no address, overpaying).
- [ ] Orders board: filters, search, columns; "Open ticket" shows lines and the buttons the server offers; take payment, change delivery, cancel.
- [ ] Receipt: share links (WhatsApp, text), Copy text. Check a receipt for an unpaid custom cake says why it cannot be given yet.
- [ ] Custom cake: servings and flavour required; up to 3 photos; sends a price request. Second screen as owner prices it; the ticket updates by itself.
- [ ] Today's sales: totals by method, rows open a receipt, "Still owed" list.
- [ ] Requests: send one, take one, mark done, confirm. Alerts can be taken or hidden for 4 hours.
- [ ] Announcement from the owner appears; "I have read this" removes the button.
- [ ] Unplug the wifi or stop the server: the red banner shows, buttons stop working, and it recovers by itself.
- [ ] Phone width (390 px): every tab, no sideways scrolling, ticket sheet opens from the bottom.

### Baker
- [ ] A custom cake that the cashier sent and the owner priced appears without reloading.
- [ ] Detail shows allergy notes, writing, photos, recipe suggestion.
- [ ] Start baking opens recipe mode; ticks work; Mark ready moves it to Ready.
- [ ] Report usage: pick amounts, add an extra ingredient, send. Inventory confirms and the baker sees "Confirmed". Inventory sends back and the baker sees the reason and can report again.
- [ ] Batches: log, note, Take back (30 minutes for the baker).
- [ ] Tickets tab and its filter. Search (Ctrl K). Sound toggle.
- [ ] Requests and announcements as for the cashier. Phone width.

### Inventory
- [ ] Stock: Ingredients and Packaging tabs, Low tags, days left.
- [ ] Item drawer: receive (try grams on a kilogram item), write off, change reorder level, add and remove usage amounts. A bad range is refused and the drawer stays open.
- [ ] New item: ingredient and packaging.
- [ ] Usage reports: confirm with typed amounts, accept as reported, send back with a reason.
- [ ] Daily count: Matches system, type a number, Skip, Edit from the review, Submit. A difference of 10% or more reaches the owner as a request. Close the screen mid-count and Resume.
- [ ] Requests, announcements, search, phone width.

### Both roles, always
- [ ] Sign out returns to sign-in; signing in as another role lands on that role's page; opening another role's page redirects.
- [ ] Light and dark theme.
- [ ] Two windows of the same role show the same data after a change in one (no reload).

## Left to do

1. **Inventory test**: find out why the receive-stock check fails, fix, run `npm run ui:test` until all three pass.
2. **Owner screen** (`apps/ui/pages/owner.html`, 700 lines of design). Screens and the server feeds to use:
   - Reports: `reports` (7 and 30 days).
   - Orders: `order_list`, `order_card`.
   - Quotes to price: `quote_inbox`, `quotes/provide`, `quotes/decline`, `quotes/revise`.
   - Refunds and payments: `payments/approve_refund`, `payments_ledger`.
   - Stock forecast: `stock_forecast`.
   - Catalogue: `catalogue_grid` and the `catalogue/*` intents (published or hidden is `catalogue/set_hidden`).
   - Staff: `staff_list`, `staff/*`.
   - Activity log: `audit_view`.
   - Announcements: `announcements`, `announcements/post`, `announcements/retire` (owner sees who has read each).
   - Alerts and settings: `alert_inbox`, `alert_settings` and `alerts/configure`, `shop_settings` and `settings/update`.
   - Requests: the shared list (`Cake.mountRequests`).
   Same rules as the other pages: no shop logic in the page, one intent per action, server labels shown as given, nothing faked. Then write `apps/ui/test/owner.mjs` in the style of `cashier.mjs`.
3. **IT screen** (later): "Panel map" (`panel_map`) and Requests (`request_inbox`). IT can read only these.
4. **Remove the old React app**: `apps/web`, the `@cake-pos/web` entries in the root `package.json` scripts (`dev`, `build`, `test`, `typecheck`), `apps/ui/mockups/`. Update `scripts/acceptance.mjs`, `docs/runbook.md` (build and start steps), `docs/blueprint.md`, `docs/known-issues.md`, then typecheck, all tests and acceptance.
5. Serve the new screens in the real start path: today `npm run start` serves whatever `STATIC_DIR` points at, and `npm run build` still builds the old app. Point both at `apps/ui/dist` when the old app goes.

## Known gaps (honest list)

- The cashier gets no alert when the owner prices a custom cake; the ticket just changes in Orders.
- Receipts are shared by WhatsApp and text links the person taps, not sent by the server (no message provider yet).
- No alerts for requests addressed to IT.
- Waste and usage have amounts but no money value (ingredients have no prices).
- Packaging has no recipes or usage amounts.
- The inventory screen shows quantities in each item's base unit (kg, l, pcs), as the design did; receive and write-off accept smaller units.
- Google Drive, SMS, WhatsApp and push alerts have not been tried against real accounts.
