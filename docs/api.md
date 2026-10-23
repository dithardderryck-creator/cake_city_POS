# Building a UI against the shop server

The server speaks plain JSON over HTTP, plus a WebSocket for live updates. Anything that can do that can be a UI: React, native apps, a script. A React client library is included (`@cake-pos/client`).

Every instruction and feed, with its fields and who may use it, is in [api-reference.md](api-reference.md). That file is generated from the code, so it is always right.

## The two things a UI does

1. **Read feeds.** A feed is ready-to-show data: "the baker queue", "the order card". Ask for it once, or subscribe and receive it again after every change.
2. **Send instructions.** An instruction is a plain request like "record this payment". The server checks the person's role, checks the request, does it all-or-nothing, and records who did it.

A UI never works out prices, totals, permissions or next steps. If a screen needs one of those, it is missing from a feed. Add it there.

## Signing in

```
GET  /api/staff                      -> who can sign in (public, no PINs)
POST /api/sign-in  { userId, pin }   -> { ok, token, session: { userId, name, role } }
POST /api/sign-out                   -> ends this sign-in
```

Send the token on every other call as `Authorization: Bearer <token>`.

- A sign-in ends after **10 hours without use**, or **24 hours** after it began.
- It **survives a server restart**.
- It ends at once if the owner switches that person off or resets their PIN, or if the person changes their PIN on another device.
- **Five wrong PINs lock the account** for 1 minute, then 5, 15 and 60 on later lockouts. A correct sign-in clears the count. The owner can reset a PIN to unlock someone immediately.
- Sign-in is also limited to 20 attempts per minute per device address.

## Sending instructions

```
POST /api/dispatch
{ "type": "payments/record_payment",
  "payload": { "orderId": "ord_x", "method": "cash", "amount": 20 },
  "requestId": "6f1c...unique per attempt" }
```

Success: `{ "ok": true, "data": ..., "warnings": [...], "summary": "Paid in full: 20" }`

- `summary` is a short sentence you can show as a confirmation.
- `warnings` are things worth telling the person that did not stop the action (for example, stock was short).
- `data` carries ids you may need, such as `orderId`.

Failure: `{ "ok": false, "error": { "code": "...", "messages": ["..."] } }`

| HTTP | `error.code` | What it means | What the UI should do |
| --- | --- | --- | --- |
| 401 | `unauthenticated` | No sign-in, or it ended | Show the sign-in screen |
| 403 | `forbidden` | This role cannot do that, or a PIN was wrong | Hide the control; for a PIN, show the message |
| 422 | `invalid` | The request was refused: a rule, or the wrong shape | Show `messages` next to the form |
| 500 | `error` | Something failed inside. **Nothing was saved** | Offer to try again |
| 413, 415, 429 | | Too large, not JSON, too many sign-ins | Show the message |

Messages are written for the person using the screen. Show them as they are.

### Retrying safely: `requestId`

Wifi drops. If the server did the work but your app never saw the answer, retrying would normally do it twice (two payments). Send the **same `requestId`** on a retry and the server returns the original answer instead of running it again. Use a new `requestId` for each new action.

- Remembered for 7 days, per person.
- Only successes are remembered, so a corrected retry of a refused request works.
- The client library does this for you, including automatic retries when the network fails.

## Reading feeds

```
POST /api/feed  { "name": "order_card", "params": { "orderId": "ord_x" } }
-> { "ok": true, "data": { ... } }
```

## Live updates (WebSocket)

Connect to `/api/live` (`ws://` or `wss://`). Then, as JSON messages:

```
you:    { "op": "auth", "token": "<token>" }
server: { "op": "auth", "ok": true }              (or ok:false)
you:    { "op": "subscribe", "id": "a1", "name": "order_list", "params": {} }
server: { "op": "feed", "id": "a1", "result": { "ok": true, "data": [...] } }   <- now, and after every change
you:    { "op": "unsubscribe", "id": "a1" }
you:    { "op": "ping" }   server: { "op": "pong" }
```

Sign in within 10 seconds of connecting or the server closes the connection. Up to 30 live feeds per connection. If a person's sign-in ends while they are subscribed, the next push is an `unauthenticated` result.

The client library reconnects by itself (1 to 15 seconds apart), signs in again, and re-subscribes, so a screen simply catches up when the wifi returns.

## Using the React library

```tsx
import { createClient, localStorageTokenStore } from '@cake-pos/client';
import { ClientProvider, useSession, useFeed, useRun, useConnection } from '@cake-pos/client/react';

const client = createClient({ baseUrl: '', tokenStore: localStorageTokenStore() }); // '' = the server serves this app

function BakerQueue() {
  const { data, error, loading, stale } = useFeed('order_list', {});
  const run = useRun();
  // data updates by itself. `stale` is true while the connection is down.
}
```

The shop's own screens (`apps/ui`) are plain HTML and use the core client (`createClient`) through `apps/ui/src/cake.ts`, not these hooks. The hooks are tested against a real server in `packages/server/src/client-react.test.tsx`. See [known-issues.md](known-issues.md), O-2.

What `useRun` returns is the result described above, plus one more case your UI should handle: `error.code === "offline"` means the server could not be reached even after retrying. **Nothing was changed.** Show a plain message ("Cannot reach the shop server, check the wifi") and let them try again.

## Custom cakes

A custom cake is a line on an order (`kind: "custom"` in the `order_card` feed). The panel decides every step; your UI shows what the feeds offer.

**The cashier's side**

1. `orders/create_order` with a `deliveryDate` (a quote needs one), then `orders/add_custom_line` with the cake details. The line starts as a *draft* and shows "Not priced yet".
2. Optionally add pictures (below), and fix details with `orders/update_custom_line`.
3. `quotes/request` sends it to the owner. The line is *awaiting quote*. `canWithdrawQuote` is true until the owner answers, and `quotes/withdraw` takes it back to a draft so it can be edited.
4. The owner answers with `quotes/provide` (a price, and an optional note) and the line becomes *new*. If the owner uses `quotes/decline` instead, the line goes back to a draft with the owner's reason in `quote.answer`, and the cashier can adjust it and ask again.
5. Payment is refused until every custom cake on the order has a price (`canRecordPayment` says so, and the refusal explains it).

**Reading it.** `order_card` lines have `cake` (the details), `quote` (status, price, the notes), and the flags `canEdit`, `canRequestQuote` (with `quoteBlockedReason` when it cannot), `canWithdrawQuote`, `canRemove` and `actions`. `quote_inbox` is the owner's list of requests waiting for a price, soonest delivery first, plus the last 20 answered. It updates live.

**The baker's side.** The `bake_queue` feed lists priced cakes that are not yet handed over, soonest delivery first, each with `dueLabel` ("Today", "2 days late"), `urgency`, the cake details, pictures, allergy notes, and `actions` for that person. The baker sends `orders/advance_line` with `to` set to one of those actions: *new → in production → ready*. If the owner has switched on the Decorating stage (`settings/update`, read from `shop_settings`), it goes *in production → decorating → ready*. Handover (`ready → completed`, or out for delivery first) is the cashier's. The baker's feeds carry no prices or payments.

**Changing things later.** `orders/set_delivery` changes the date, pickup or delivery, and address (the result warns when the baker has already started). `quotes/revise` lets the owner change a price until baking starts, with a reason, and warns about money already taken. The cashier can remove a cake until it is priced and paid; after that, or once baking starts, only the owner can (`canRemove` tells you).

### Ingredients and usage

#### Units (metric base)

Stock is **always stored in metric base units**: `kg` for anything weighed, `l` for anything measured by volume, `pcs` for anything counted. Every number the panel stores or returns (`onHand`, `reorderLevel`, range `min`/`max`, recipe `quantity`, suggestions, usage) is in the ingredient's base unit, so the figures always add up.

- **Typing in other units.** Intents that carry a quantity accept an optional `unit` (`inventory/receive`, `count`, `write_off`, `recipes/save_rule`, `inventory/update_ingredient`, and per item on `usage/confirm`). The panel converts it: receiving `2` with `unit: 'lb'` adds 0.907185 kg. Leave `unit` out and the number is taken to be in the ingredient's base unit.
- **Creating an ingredient.** `unit` on `inventory/create_ingredient` can be any unit; its kind decides the base unit (`g` or `lb` give `kg`, `cup` gives `l`, `dozen` gives `pcs`) and the opening stock, reorder level and ranges in that request are read in that unit.
- **Wrong kind of unit.** Kilograms for something counted, or litres for flour, is refused in plain words and nothing changes.
- **Display text.** Feed rows carry ready-to-show text next to the numbers (`onHandText: "250 g"`, `rangeText: "100 g to 200 g"`, `quantityText`, `suggestedText`), so a screen never needs to convert.
- **Conversion table.** The `unit_list` feed returns every unit with its kind, base unit and how many base units it is (`perUnit`). Available to owner, baker and Inventory. Kitchen units follow the metric convention: 1 cup = 250 ml, 1 tbsp = 15 ml, 1 tsp = 5 ml (a US cup is 237 ml, so say so if a supplier uses one).
- **Precision.** Stock is kept to a milligram or millilitre. A quantity too small to count is refused rather than recorded as zero.


After a custom cake goes into production the system knows what it probably needs, the baker reports what was really used by tapping amounts, Inventory confirms the exact figures, and only then does stock go down.

1. **Set up (Inventory and owner, once).** `inventory/create_ingredient` with a unit (any from the `unit_list` feed, for example `g`, `kg`, `lb`, `ml`, `l`, `cup`, `pcs`, `dozen`), opening stock, a reorder level, and the **preset amounts** the baker will tap, each with a name and a range (for example "Light" 100 to 200 g). Then the owner or baker adds **recipe lines** with `recipes/save_rule`: "20 g of flour per serving", "10 g of cream per serving for each gap between layers", "2 eggs for every cake", optionally limited to certain flavors or fillings, only for cakes with a dietary tag (an egg substitute for eggless), or left out for a tag (no eggs in eggless). The `recipe_rules` feed returns each line with a one-sentence `summary` to show as it is.
2. **Suggestion.** When `orders/advance_line` moves a custom cake to `in_production`, the panel adds up every recipe line that fits that cake and stores the list. It is plain arithmetic, the same answer every time, and needs no internet. It is never changed afterwards. If no line fits, the result carries a warning and the baker can still report.
3. **Baker reports.** The `usage_form` feed (`orderId`, `lineId`) lists the suggested ingredients, each with its preset amounts and `suggestedRangeId` (the one that fits, so the baker can just accept it), plus `extras`, every other ingredient the baker could add. `usage/report` sends the ticked ingredients, one chosen amount each. **Stock does not move.** The ingredient shows `pending` in `ingredient_list`. `bake_queue` rows carry `usage.state` and `usage.canReport`.
4. **Inventory confirms.** The `usage_inbox` feed is Inventory's list of reports waiting, with the suggestion and what is on hand beside each item. `usage/confirm` takes the exact quantity for every ingredient in the report (0 if none was used) and takes it off stock. The result warns when a figure is outside the amount the baker chose. If there is not enough on hand, stock stops at zero, the shortfall is recorded, and a warning says to do a count. `usage/send_back` returns a report with a reason so the baker can report again.
5. **Stock jobs.** `inventory/receive` (a delivery), `inventory/count` (set to what was counted), `inventory/write_off` (spoiled or spilled, with a note), `inventory/update_ingredient` (rename, reorder level, amounts, switch off). Every change is recorded and audited.

**Days of stock left** (`daysLeft` and `daysLeftLabel` in `ingredient_list`) use confirmed usage only, over the last 14 days. With fewer than 3 confirmed uses, or under 3 days of history, the label says "Not enough data yet" instead of guessing. `low` is true when on hand is at or below the reorder level.

### Pictures

Reference photos are binary, so they use two plain HTTP calls (the client library wraps both), not an instruction:

| | |
| --- | --- |
| `POST /api/photos` | Body is the picture, `Content-Type: image/jpeg`, `image/png` or `image/webp`, with the usual `Authorization: Bearer ...`. Up to 5 MB. Returns `{ ok: true, photoId, mime, size }`. Owner and cashier only |
| `GET /api/photos/{photoId}` | Returns the picture. Owner, cashier and baker only. Needs the `Authorization` header, so an `<img src>` cannot fetch it; use `client.photo(id)` and `URL.createObjectURL(blob)` |

Then attach it with `orders/attach_reference_photo` (up to 6 per cake, each picture on one cake only) or remove it with `orders/remove_reference_photo`. The server checks the first bytes of the file, not its name or header, so a renamed document is refused. **Shrink phone photos in the browser first** (about 1600 pixels on the long side is plenty) and convert iPhone HEIC to JPEG; the server will not. A picture that is uploaded but never attached is deleted after a day.

```ts
const up = await client.uploadPhoto(file); // file is a File or Blob
if (up.ok) await client.dispatch('orders/attach_reference_photo', { orderId, lineId, photoId: up.photoId });
const shown = await client.photo(photoId);
if (shown.ok) img.src = URL.createObjectURL(shown.blob);
```

## Alerts, forecast and phone notifications

### Alerts

The panel watches stock, usage reports, quotes and deliveries and raises an **alert** when something needs a person. Nothing is raised by the UI. Alerts are de-duplicated (one open alert per condition), clear themselves when the problem is fixed, and are routed by role. A **critical** alert also goes to the owner, whoever it was first aimed at.

| Kind | Raised when | Goes to |
| --- | --- | --- |
| `stockout` | An ingredient is out, or the forecast says it runs out within `stockoutDays` (default 3) | Inventory, owner |
| `low_stock` | The forecast says an ingredient hits its reorder level or runs out within `reorderDays` (7) | Inventory |
| `usage_waiting` | A baker's usage report has waited `usageWaitHours` (4); the owner is told too after twice that | Inventory (then owner) |
| `quote_waiting` | A quote request has waited `quoteWaitHours` (2) | Owner |
| `order_not_started` | A custom cake is due within `dueSoonDays` (2) and baking has not started | Baker, owner |
| `overdue_delivery` | An order's delivery date has passed and items are not handed over | Cashier, owner |
| `count_difference` | A recent stock count was off by `countDifference` (3) or more | Owner |
| `request_waiting` | A staff request nobody has taken: an urgent one alerts the people it is for at once and the owner after `urgentRequestMinutes` (15, critical); an ordinary one alerts them after `requestWaitHours` (4) and the owner after twice that | The people it is for, then owner |

Out of the box, `stockout` and `count_difference` are critical; the owner can change that with `alerts/configure`.

- **Feeds.** `alert_inbox` (everyone with a role; `open`, `snoozed`, `recent`, `unseen`, `critical`; updates live) and `alert_settings` (owner).
- **Instructions.** `alerts/mark_seen` (stops the alarm on that phone and every other), `alerts/acknowledge` ("I'm on it": silences notifications for everyone, the alert stays open until the problem clears), `alerts/snooze` (hides it from your list for 1 to 72 hours), `alerts/configure` (owner: thresholds and which kinds are critical).
- **Timing.** The server checks every minute, and the panel also re-checks straight after orders, quotes, inventory, usage, stock and recipe instructions.

### Staff requests

A message from one member of staff to a role (anyone with that role may act) or to one person. The owner sees every request. Everyone else sees what they sent and what is for them.

**Lifecycle:** Sent, Seen, Acknowledged ("I'll take it", shows who owns it), Done, Confirmed (the sender agrees). The sender can *reopen* a request that was marked done, and *withdraw* one nobody has taken yet. A request sent with `choices` (2 to 4 answers) is a question: the answer closes it and the sender sees it (used for approvals such as "Approve restock" or "Approve refund").

- **Feed.** `request_inbox` (every role including IT; updates live). Each row has everything a screen needs: `steps` and `step` for the progress bar, `seenBy`, `takenByName`, `needsYou`, `mine`, `forMe`, `escalatesAt` / `escalated`, `timeline`, and `actions`, the list of things this person may do right now (`acknowledge`, `done`, `decide`, `confirm`, `reopen`, `withdraw`). Show only those buttons. The feed also gives `targets` (who can be asked) and `categories` for the "new request" form, and `counts.needsYou` for a badge. The `navigation` feed's "Requests" item carries the same number as `badge`.
- **Instructions.** `requests/send` (`toRole` or `toUserId`, `category`, `title`, optional `body`, `urgent`, `link`, `orderId`, `choices`), `requests/mark_seen` (send when the person opens a request addressed to them; safe to repeat; the sender and the owner looking in do not count), `requests/acknowledge`, `requests/done`, `requests/decide` (`choice`), `requests/confirm`, `requests/reopen`, `requests/withdraw`.
- **Escalation.** Handled by the alert engine (`request_waiting`, above). An urgent request nobody has taken is escalated to the owner as a critical alert after `urgentRequestMinutes`. The feed's `escalatesAt` says when, so a screen can show "Escalates to you at 14:30" without any logic.
- **Limits.** 50 open requests per person. Requests to the IT role show in the IT inbox but do not raise phone alerts.

### Announcements

A message from the owner to all staff. Not a conversation: staff can read it and, when the owner asked, acknowledge it.

- **Feed.** `announcements` (every role; updates live). Newest first. Each row has `text`, `requiresAck`, `postedByName`, `createdAt`, and for the person looking `seenByMe`, `ackedByMe` and `needsAck` (show the "I have read this" button only when `needsAck` is true). The feed also gives `unseen` and `needAck` for a badge and `can.post` (true for the owner). The **owner's** rows also carry `readers` (one chip per active person with `seen` and `acked`) and `progress` ("2 of 4 acknowledged", or "1 of 4 have read it" when no acknowledgement was asked for). Staff never see each other's status.
- **Instructions.** `announcements/post` (owner; `text` up to 500 characters, `requiresAck`), `announcements/mark_seen` (send when a person opens one; safe to repeat; the owner opening it does not count), `announcements/acknowledge` (not the owner; refused if the announcement did not ask for it; counts as reading it), `announcements/retire` (owner; takes it down for everyone but keeps it in the record).
- **Limits.** 20 announcements up at once. People who are no longer active are not counted as readers.

### Reports

One feed for the owner's Overview and Reports screens. Everything is built from what the server already holds. It never estimates, and it says so when there is too little data.

- **Feed.** `reports` (owner only), with `days` 7 or 30 (default 7). The period is the last `days` days ending today.
  - `sales`: money received less refunds, by day (`series`, with ready labels like "Wed 7"), `total`, `perDay`, the same number of days before (`previousTotal`, `changePercent`, null when there was nothing to compare), `today` against `yesterday` (`todayChangePercent`) and the best day.
  - `methods`: net by payment method, with `share` (0 to 1).
  - `bestSellers`: the top 5 by value on orders placed in the period (cancelled and unpriced lines left out; all custom cakes together), then "Everything else".
  - `stockDays`: the ingredients that will run out first (up to 6), with `level` (`critical` under 2 days, `low` under 4, `ok`). `noData` counts those without enough history.
  - `usage`: for cakes whose usage was confirmed in the period, what the system suggested against what Inventory confirmed. `flagged` when more than 10% apart (`direction` more or less).
  - `refunds`, `countDifferences` (from the daily count and from counter items found short) and `waste` (stock written off, with the reason).
- **Limits.** "Sales" is money received on the day, not the value of orders placed. There are no ingredient prices, so waste has amounts but no money value.

### Batches (finished items)

The baker logs a batch of ready-made items (brownies, cupcakes). It adds to the counter stock of that version of the product, so the cashier sees it straight away.

- **Feed.** `batch_log` (baker, owner and inventory; inventory can only look). `options` lists every active product version by name, with `onHand`, for the product picker. `rows` are the latest 40 batches (newest first, those taken back are left out) with `label`, `qty`, `note`, `byName`, `timeText` and `canUndo`. `today` has the batch and item totals. `can.log` says whether this person may log, and `undoMinutes` is 30.
- **Instructions.** `batches/log` (`combinationId`, `qty` a whole number 1 to 1000, optional `note` up to 80 characters; baker and owner), `batches/undo` (`batchId`). The baker who logged a batch can take it back for 30 minutes; the owner at any time. It is refused if some of the batch has already been sold (the stock would go below zero). Both write a stock movement and the audit log.

### Daily count and packaging

**Packaging.** Stock items have a `kind`: `ingredient` (default) or `packaging` (boxes, boards, ribbon). Packaging is counted and reordered like an ingredient but has no baker usage amounts and cannot be in a recipe rule. Set it with `kind` on `inventory/create_ingredient` or `inventory/update_ingredient`. `ingredient_list` rows carry `kind` and `countedAt` (when the item was last counted, or null), so the screen can offer Ingredients and Packaging tabs.

**The daily count.** Counts are kept on the server while the person works through the list, so a count can be put down and picked up again, even on another device. Stock does not change until the count is submitted.

- **Feed.** `count_session` (owner and inventory). `countedToday` is the time of day of today's count or null. `session` is null when no count is in progress; otherwise it has `done`, `total`, `skipped`, `differences`, `big` and `items`. Each item has what is expected, what has been counted (or null), `difference` and `differenceText` ("−1 kg", "matches"), `big`, `step` (how much the + and − buttons change the number), `lastCountedText`, and `kind` (ingredients come first, then packaging). `history` lists the last 10 submitted counts. `bigDifferencePercent` is 10.
- **Instructions.** `count/start` (starts one, or picks up the one already in progress and says `resumed: true`), `count/record` (`sessionId`, `ingredientId`, `counted`, optional `unit`; `counted: null` skips the item or clears its count), `count/submit` (applies everything counted, leaves skipped items alone), `count/discard` (throws it away).
- **Big differences.** A difference of 10% or more is "big". When someone other than the owner submits a count with big differences, the owner gets a request ("Count differences need a look") listing them, and the result says `ownerNotified: true`. Each applied difference is a stock correction ("Daily count") and can raise a low-stock alert.
- **Closing review.** The review of differences before saving is the screen reading the same feed (`difference`, `big` and the `differences` and `big` totals). Nothing is applied until `count/submit`.

### Payments list, receipts and shop details

- **`payments_ledger`** (owner, cashier; `{ day?: "YYYY-MM-DD" }`, today by default). Every payment, deposit and refund of that day, newest first, with `totals`, `byMethod` (with `share` for a bar), and `outstanding`: orders that still owe money (orders still waiting for a price are left out). A *deposit* is a payment that did not finish paying the order. A refund puts the refunded amount back on what the customer owes.
- **`receipt`** (owner, cashier; `{ orderId }`). Everything for a receipt, already worded: `shop` (name, address, phone, footer), `lines`, `payments`, `refunds`, `paidLabel`, `balanceLabel`, `statusLabel` ("Paid in full", "Balance due"...), and `text`, the whole receipt as plain text for printing or sending. `share.whatsappUrl` and `share.smsUrl` are ready-made links that open WhatsApp or the phone's messages with the receipt filled in (present when the order has a customer phone). `blockedReason` says why a receipt cannot be given yet (nothing paid, cake not priced, cancelled). No message provider is needed for this.
- **Customer phone.** `orders/create_order` and `orders/set_delivery` take `customerPhone` (with country code, for example `+255712345678`; `null` clears it).
- **Shop details.** `settings/update` also takes `shopName`, `shopAddress`, `shopPhone`, `receiptFooter` (owner). `shop_settings` returns them to everyone signed in.
- **Roles.** `staff/set_role` (owner) moves someone between cashier, baker, inventory and IT, and signs them out. The owner's role cannot be changed and nobody can be made owner this way.
- **Hiding an item.** `catalogue/set_hidden` (owner) takes a product off the counter without archiving it. `catalogue_grid` marks it `hidden`; only the owner's list still contains it, and it cannot be sold while hidden.
- **Bakers and usage.** `usage_inbox` now also works for a baker, showing only the reports they sent, so they can follow what happened to them.

### End of day and the cash count

`day_report` (feed, optional `{ day: "YYYY-MM-DD" }`, today by default) is the one screen the owner needs to end a day: money taken and refunded by method, refunds with their reasons, items sold and the top five, offline sales that went through that day and those still waiting, orders that still owe money, stock counts that came out different, and the cash drawer sum (`cash.expected` = what the last close left in the drawer + cash taken − cash refunded). `closed` is `null` until someone has counted the drawer for that day.

`day/close` (`{ day?, countedCash, floatKept?, note? }`) records the count. `floatKept` is the cash left in the drawer for tomorrow and becomes tomorrow's starting figure (default 0). A count that differs from what was expected needs a `note`. Rules:

- **Who may close** is a shop setting, `dayCloseBy` in `shop_settings` and `settings/update`. `"owner"` (the default): only the owner can see the report or close. `"cashier_and_owner"`: a signed-in cashier can too, and the report names who closed.
- **Language.** The shop has one display language, `language` in `shop_settings` and `settings/update` (`"en"` by default, or `"sw"` for Kiswahili; owner only). `deviceStatus` returns it too, so the sign-in page can follow it before anyone signs in. The server, the database and every message it writes stay in English. Only the screens translate what they show, from a word list in `apps/ui/src/lang/*.txt` (`English ||| Kiswahili`, with `{n}` for numbers and `{*}` for names). Anything with no entry shows in English.
- **Location check (the lobby).** Off by default. The owner or IT (`settings/set_location`, feed `location_check`) records the shop's spot (`lat`, `lng`, from a device standing in the shop), a radius (`radiusM`, 30 to 2000 m, default 150) and switches the check on (`enabled`; refused until a spot exists). While it is on, the owner and IT are never held. A cashier, baker or inventory person must report where their device is with `session/report_place` (`lat`, `lng`, optional `accuracyM`); the answer says `inside`, the `distanceM` and, if outside, a `reason` (`far` or `vague`). A report lasts 10 minutes; a missing, old or vague (over 300 m) position counts as outside. Anyone outside gets `lobby: true` on their session and is **held in the lobby**: the server refuses every instruction and feed except signing out, `session/report_place`, changing their own PIN or contact details, and the announcements, with a message starting "You are outside the shop" (code `forbidden`); photos are blocked too. The pages turn that into a full-screen lobby with Check again, My account and Sign out. Reports are not written to the activity log (a blocked attempt is). This is a reminder for honest staff, **not security**: a phone can be made to report a false position. A till that cannot reach the server is not held by the page (offline selling is its own pass).
- **Closing locks nothing.** Closing the same day again replaces the count (both are in the audit trail). Money recorded after a close shows as `closed.changedSince` so the report says the count is out of date; those sales are part of that day's report if they were made that day.
- A day that has not happened yet cannot be closed. An earlier day that was forgotten can.
- Cards, bank transfers and mobile money are in the report but never in the drawer sum. Only cash is.

### Stock forecast

The `stock_forecast` feed (owner, baker, Inventory) gives one line per ingredient: real stock up to today, projected stock after. It is worked out from **two inputs** and shown as **one** line:

1. **The recipe suggestions** for cakes already booked (what the cakes due in the coming days should need).
2. **What the chefs actually used**, from confirmed usage reports, as a daily rate. The booked cakes are scaled by a **calibration** (confirmed use divided by suggested use on past cakes), so a recipe that is always too generous or too tight corrects itself.

The next few days follow the bookings. Further out, bookings are thin because customers have not ordered yet, so the line drifts toward the usual rate; it never goes below what is already booked. Each row has `status`, `daysUntilOut` / `outDate`, `daysUntilReorder` / `reorderDate`, `shortfallInHorizon`, `usualPerDay`, `next7Days`, `calibration` (`factor`, `samples`, `applied`), a one-sentence `text`, `confidence` (`high` when both the usual rate and bookings exist, `medium` for one, `low` for neither) and `series` for the graph. With fewer than 3 confirmed uses or 3 days of history it says so instead of guessing. `method` is a plain-words description to show under the graph. Parameters: `ingredientId` for one ingredient, `horizonDays` (default 14).

### Notifications: phone sound, WhatsApp and SMS

Each new alert is turned into a message to each person it concerns, on the channels they chose. This happens outside the instruction queue, so a slow provider never delays a sale.

- **Setup feed.** `notification_setup` returns the person's settings, which channels the server can use (`channels`), the key a browser needs (`push.publicKey`), which of the person's devices are registered, and `notes` (plain reminders such as "no phone number saved").
- **Instructions.** `staff/set_contact` (phone number; `sms` and `whatsapp` each `off`, `critical` or `all`; owner can change anyone, others only themselves), `push/subscribe` and `push/unsubscribe` (a phone or browser), `notify/send_test` (once a minute).
- **Log.** `notification_log` (owner, IT) lists recent messages with the outcome of each delivery (`sent`, `failed`, `skipped`, `pending`) and the last error.
- **Retries.** A failed delivery is retried after 1, 2, 5, 15, 60 and 180 minutes, then marked failed. An alert that was cleared or acknowledged before the message went out is skipped. A phone that has uninstalled the app (the push service says it is gone) is removed.
- **Providers (server settings, see the runbook).** SMS through Twilio, Africa's Talking or a webhook; WhatsApp through Twilio or a webhook; phone push built in.

### The alarm on a phone or tablet

`@cake-pos/client` provides the part that makes noise, so your UI only has to mount it:

```ts
import { createAlertWatcher, browserAlarm, enablePhoneNotifications } from '@cake-pos/client';

const alarm = browserAlarm();
const watcher = createAlertWatcher({ client, effects: alarm });
// On any tap (sign-in button, "Turn on alarm sound"): browsers keep pages silent until then.
await alarm.unlock();
// Once per phone, from a button: asks permission and registers it with the shop.
const r = await enablePhoneNotifications(client);
watcher.subscribe((state) => render(state)); // state.open, state.unseen, state.ringing, state.muted
await watcher.markAllSeen(); // "Stop"
```

- **While the app is open:** a new alert plays a short sound and vibrates; a **critical** one plays a siren, vibrates and **repeats every 30 seconds** (up to 10 times) until someone sees it, takes it, or the problem clears. It also shows a system notification.
- **While the app is closed:** the shop server sends a Web Push. The phone shows it with **its own notification sound**; a web page cannot choose a louder one when it is closed. Copy `packages/client/service-worker/alert-sw.js` to the root of the web app so it is served as `/alert-sw.js`.
- **Requirements.** Browsers only allow service workers and push on **HTTPS** (or `localhost`). Over plain `http://192.168...` the in-app sound and vibration work but closed-app push does not. See the runbook for HTTPS. On iPhone the app must be added to the Home Screen first.

### Archived orders

Old finished orders are moved out of the database into spreadsheets (see the runbook). After that they are **not in any feed** and instructions on them answer "That order no longer exists". The panel map (IT role) shows Google Drive status and archive progress. Order numbers are never reused. Nothing in the API changes: your UI does not need to know about archiving.

## Selling when the connection is gone

Only instant sales (`orders/quick_sale`) can be saved on a till and sent later. Use `client.offline`:

- `client.offline.status()`: whether a sale can be saved here (`canSell`), how many are waiting, what is left of the limits, and `notices` (sales that were held for the owner, refused, or could not be sent). Notices stay until `clearNotices()`.
- `client.offline.quickSale({ items, method, expectedTotal })`: sells now; if the server cannot be reached it saves the sale on the device and returns `{ ok: true, queued: true, seq, madeAt }`. Always pass `expectedTotal`, the total the customer was shown.
- `client.offline.flush()`: sends what is waiting. The client also does this by itself when the connection returns and every 15 seconds while something waits.
- Pass `offlineStore: localStorageTokenStore('cake-pos-offline')` to `createClient` so the queue survives reloads.

The pages and the catalogue are also kept on the device, so a till that reloads while the server is down still opens and sells (the page copies need https or localhost). The client asks for an offline pass after every sign-in. The owner switches the feature on in the shop settings (`offlineEnabled`, `offlinePassHours`, `offlineMaxSales`, `offlineMaxTotal`); it is off by default. The pass key is removed from the device at sign-out; sales already saved can still be sent.

`POST /api/offline/replay` with `{ passId, actions: [{ seq, requestId, type, payload, queuedAt, tag }] }` and the `X-Device-Token` header sends a queue. No sign-in is needed. The answer is `{ ok: true, results: [{ seq, status, message, ... }] }` where `status` is `done`, `duplicate`, `held`, `rejected` or `retry`. See `docs/offline-queue-design.md` for what is checked.

## Things that will bite you on a shop network

- **Plain `http://` addresses are "insecure" to browsers.** On `http://192.168.x.x` a browser disables `crypto.subtle`, `crypto.randomUUID()` and **service workers** (so no installable-app offline shell). The client library avoids the first two. For the third, run the server with HTTPS (see the runbook), or accept that each device loads the app from the server when it opens (fine, because nothing works without the server anyway).
- **Different origin in development.** Add your dev address to `ALLOWED_ORIGINS` (the default allows `http://localhost:5173`).
- **Your UI must not assume it is alone.** Feeds change under you when other devices act. Keep no copy of server data in your own state beyond what the hooks give you.

## Limits

Request body 256 KB (pictures: 5 MB). WebSocket message 64 KB. 30 live feeds per connection. Sign-in 20 per minute per address. Orders list shows the latest 200, activity the latest 200.
