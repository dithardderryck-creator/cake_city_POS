# New screens: checkpoint

Where the new screens (from the four HTML designs) stand, how to try them, and what is left. Updated 11 Oct 2026.

## Try it

```
npm install
npm run dev               # (same as npm run ui:try) builds the screens, fills a demo shop, starts it
npm run ui:try -- --fresh # same, from clean demo data
```

Open http://localhost:8787/. A phone on the same wifi can use the address it prints. Demo PINs: owner 1111, cashier 2222, baker 3333, inventory 4444. Demo data lives in `.try-data/` (delete it to reset). The demo has no stock list or recipes and no custom cakes: add ingredients on the Inventory screen (New item) and ingredient amounts in its drawer, and make custom cakes on the Cashier screen, to see the baker and usage flows.

Automated browser tests: `npm run ui:test` (cashier, baker, inventory, inventory-edge, owner; real server, real Chromium, desktop and phone width; screenshots go to `/tmp/ui-shots-<role>/`).

## Status

| Screen | Wired to server | Browser test | Notes |
|---|---|---|---|
| Sign-in | yes | passes | |
| Cashier | yes | passes | |
| Baker | yes | passes | |
| Inventory | yes | passes (`inventory.mjs` and `inventory-edge.mjs`) | Edge test covers real stock numbers after confirming, accept-as-reported, double-click safety, refused receive and write-off, new packaging, count Edit/Resume/Discard, theme, role redirect. |
| Owner | yes | passes (`owner.mjs`) | All eight tabs real: overview, requests (price custom cakes, staff requests, announcements), catalogue, orders (with refunds and price changes), stock, payments, staff, reports; settings drawer (shop details, warning rules). |
| IT | not started | none | Set aside for now. Until it exists, an IT sign-in goes to `/it.html`, which is missing. |
| Old React app (`apps/web`) | removed | | `npm run build` and `npm start` now use `apps/ui`. |

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

### Owner
- [ ] Overview: revenue and chart (7 and 30 days), due soon, running low, needs your decision, staff activity.
- [ ] Requests: a cashier's custom cake price request appears with photos; send a price, decline (reason needed). The cashier's ticket updates by itself.
- [ ] Announcements: post one needing acknowledgement; see who has read it; take it down.
- [ ] Catalogue: New item with sizes and prices; a size without a price keeps it a draft; Hidden removes it from the cashier's Sell screen; switch it off for today; archive.
- [ ] Orders: board, search, select several and cancel; open an order: change a price you gave (reason needed), refund (reason and amount), cancel.
- [ ] Payments: pick another day; filter refunds; outstanding balances open the order.
- [ ] Stock: list, filters, forecast line, usage waiting, stock requests.
- [ ] Staff: add someone, change role, set a PIN, deactivate and reactivate, alert contact details, audit log filter.
- [ ] Settings (sliders icon): shop name appears on tickets and receipts; warning rules save.
- [ ] Reports: 7 and 30 days; usage compared with suggestions; refunds, count differences, write-offs.
- [ ] Phone width: every tab.

### Both roles, always
- [ ] Sign out returns to sign-in; signing in as another role lands on that role's page; opening another role's page redirects.
- [ ] Light and dark theme.
- [ ] Two windows of the same role show the same data after a change in one (no reload).

## Left to do

1. **IT screen** (later): "Panel map" (`panel_map`) and Requests (`request_inbox`). IT can read only these.
2. Hand-test everything above on real devices, and decide the open questions in `docs/blueprint.md` (Google account, archive folder, live online database or Drive copies, alert thresholds and recipients, SMS and WhatsApp provider, HTTPS on the shop network).

Done: inventory test, owner screen and its test, old React app removed, `npm run build` and `npm start` serve `apps/ui`.

## Known gaps (honest list)

- The cashier gets no alert when the owner prices a custom cake; the ticket just changes in Orders.
- Receipts are shared by WhatsApp and text links the person taps, not sent by the server (no message provider yet).
- No alerts for requests addressed to IT.
- Waste and usage have amounts but no money value (ingredients have no prices).
- Packaging has no recipes or usage amounts.
- The inventory screen shows quantities in each item's base unit (kg, l, pcs), as the design did; receive and write-off accept smaller units.
- Google Drive, SMS, WhatsApp and push alerts have not been tried against real accounts.
- The owner page has no table of what each role can do, and no movement history per ingredient (no feed for it).
- The old `packages/design-system` (React tokens and components) is not used by the shop pages. It is kept for now; delete it if you do not want it.
