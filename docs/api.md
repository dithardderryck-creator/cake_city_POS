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

`apps/web` shows a full UI against the real server (set `VITE_SERVER_URL`, see the runbook), but it uses `createClient` through its own small bridge rather than these hooks. The hooks are tested against a real server in `packages/server/src/client-react.test.tsx`. See [known-issues.md](known-issues.md), O-2.

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

## Things that will bite you on a shop network

- **Plain `http://` addresses are "insecure" to browsers.** On `http://192.168.x.x` a browser disables `crypto.subtle`, `crypto.randomUUID()` and **service workers** (so no installable-app offline shell). The client library avoids the first two. For the third, run the server with HTTPS (see the runbook), or accept that each device loads the app from the server when it opens (fine, because nothing works without the server anyway).
- **Different origin in development.** Add your dev address to `ALLOWED_ORIGINS` (the default allows `http://localhost:5173`).
- **Your UI must not assume it is alone.** Feeds change under you when other devices act. Keep no copy of server data in your own state beyond what the hooks give you.

## Limits

Request body 256 KB (pictures: 5 MB). WebSocket message 64 KB. 30 live feeds per connection. Sign-in 20 per minute per address. Orders list shows the latest 200, activity the latest 200.
