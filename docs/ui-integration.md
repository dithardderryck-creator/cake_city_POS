# New UI: how the four mockups connect to the server

Status: plan, written 6 Oct 2026. The four HTML mockups were wired into `apps/ui/pages/` and replaced the old React app (`apps/web`, removed 11 Oct 2026).
Decisions from the owner: keep them as plain HTML (no React), build the missing server parts first, remove the old UI now.

## Rules that do not change

- The page holds no business logic (BR-22). It shows feeds and sends intents. Prices, totals, next steps and permissions come from the server.
- Every button that changes something sends one intent with a fresh `requestId`. The page then re-reads the feed (or receives the live push). It never edits its own copy of the data.
- "Demo:" buttons and demo data in the mockups are removed. Anything that cannot be real yet is hidden, not faked.
- Sign-in is a PIN of 4 to 6 digits (the keypad gets an "OK" key).

## The shared script (`apps/ui/src/cake.js`)

One small script every page loads, built from `@cake-pos/client`:

- device registration (a one-time code, then a secret kept in `localStorage`), sign-in and sign-out, token kept in `localStorage`, redirect to the page for the person's role;
- `feed(name, params, render)` subscribes over the WebSocket, falls back to polling, and calls `render(data)` after every change;
- `send(intent, input)` returns `{ok, error}`, shows the server's plain-language message in the toast, and never retries by itself on a refusal;
- connection state ("Server unreachable") drives the offline banner, and writes are blocked while offline (no hidden queue, see D-24);
- the shared header (clock, bell badge from `alert_inbox`/requests, theme toggle, sign-out).

## Screen by screen

`Have` = feed or intent exists today. `Gap` = the server must grow first. `Fit` = the mockup must change to match the server.

### Cashier

| Screen | Server | Notes |
| --- | --- | --- |
| Sell: catalogue tiles, cart, take payment | Have: `catalogue_grid`, `orders/create_order`, `orders/add_catalogue_line`, `payments/record_payment` | Cart is a draft order on the server. |
| Orders ticket board | Have: `order_list`, `order_card`, `orders/advance_line`, `orders/set_delivery` | Board columns come from `status`. The ticket shows the first line and "+N more". |
| Custom cakes | Have: `orders/add_custom_line`, `quotes/request`, photos | Quote answer arrives in `order_card`. |
| Today's sales | Gap: a `payments_today` feed (list, totals by method, refunds) | Same feed serves the owner's Transactions page. |
| Requests | Gap: requests circuit | See below. |
| Receipts (print/send) | Gap: `receipt` feed | Highest-priority missing feature. |
| PIN lock | Have: `auth/sign_in` | Variable length PIN. |

### Baker

| Screen | Server | Notes |
| --- | --- | --- |
| Queue and Tickets | Have: `bake_queue`, `orders/advance_line` | |
| Recipe mode | Have: `recipe_rules`, `usage_form` | |
| Usage reports | Have: `usage_form`, `usage/report`; Gap: a list of the baker's own reports (history) | Extend `usage_inbox` for the baker role. |
| Batches | Gap: batches circuit (log a batch of ready-made stock, which feeds catalogue `onHand`) | |
| Requests | Gap: requests circuit | |

### Inventory

| Screen | Server | Notes |
| --- | --- | --- |
| Stock list and item drawer | Have: `ingredient_list`, `inventory/update_ingredient`, `inventory/receive`, `inventory/write_off` | Reorder level and range checks already validated server-side. |
| Usage reports | Have: `usage_inbox`, `usage/confirm`, `usage/send_back` | |
| Daily count | Have: `inventory/count` per item; Gap: a count session (list for today, who counted, differences, done/closed) | |
| Requests | Gap: requests circuit | |

### Owner

| Screen | Server | Notes |
| --- | --- | --- |
| Overview (revenue chart, stock bars, needs-you) | Gap: `reports_overview` feed (revenue by day, vs last period). Have: `stock_forecast`, `alert_inbox` | |
| Requests (quotes, refunds, restock, staff messages) | Have: `quote_inbox`, `quotes/provide`, `quotes/decline`, `payments/approve_refund`; Gap: requests circuit and a refund-request flow from the cashier | The page shows quotes and refunds as request cards, built from those feeds plus the new requests feed. |
| Catalogue | Have: `catalogue_grid` and the catalogue intents. Fit: the mockup shows flat "sizes and prices" and Published/Draft/Hidden. The server has option groups, combinations and archive. Decision: show each option group value as a "size"; Draft/Hidden become a new `visibility` field (Gap: `catalogue/set_visibility`) | |
| Stock | Have: `ingredient_list`, `stock_forecast`, `usage_inbox` | |
| Orders | Have: `order_list`, `order_card`, `orders/cancel_order`. Gap: owner changing the total of an order that has started (`orders/adjust_total`, reason required, audited) | |
| Transactions | Gap: `payments_today` / `payments_list` feed | |
| Staff | Have: `staff_list`, `staff/create`, `staff/set_pin`, `staff/set_active`, `audit_view`. Gap: `staff/set_role` | PIN 4 to 6. |
| Reports | Gap: `reports` feed (sales mix, payment methods, usage vs suggestion, refunds, count differences, waste) | Usage and waste data exist; refunds and counts are partly there. |
| Announcements | Gap: announcements circuit (post, needs-acknowledgement, who has seen) | |

## New server pieces (all built, 7 Oct 2026)

| Piece | Feeds | Instructions | Notes |
| --- | --- | --- | --- |
| Staff requests (D-69) | `request_inbox` | `requests/*` | Escalation through the alert engine |
| Payments list and receipts | `payments_ledger`, `receipt` | none (read only) | Receipts are shared with wa.me and sms: links |
| Shop details, customer phone, role change, hide catalogue items | `shop_settings`, `order_card` | `settings/update`, `staff/set_role`, `catalogue/set_hidden` | The mockup's "Draft" is derived (not every version priced); Published/Hidden is `catalogue/set_hidden` |
| Announcements (D-70) | `announcements` | `announcements/*` | Owner posts; staff read and acknowledge |
| Daily count and packaging (D-71) | `count_session`, `ingredient_list` (`kind`, `countedAt`) | `count/*` | Saved on the server while counting, applied at the end |
| Batches (D-72) | `batch_log` | `batches/*` | Adds to counter stock; 30 minutes to take one back |
| Reports (D-73) | `reports` | none (read only) | Feeds both the Overview and the Reports page |

The mockup's "change the price of an order" is `quotes/revise`, so no separate `orders/adjust_total` was built. The baker's own usage history is the `usage_inbox` feed, which now shows a baker their own reports.

## Wiring order

Foundation and sign-in, then Cashier sell and orders, Baker queue, Inventory stock and usage, Owner (orders, catalogue, staff, stock), then each new circuit with its screens.

## Not in scope for the first release

Live timers for escalation text (the server decides, the page shows what the feed says), and any change to how the server handles money, backups or archiving.
