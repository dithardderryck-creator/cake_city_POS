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

`apps/web` is a complete working example. Set `VITE_SERVER_URL` to run it against a real server (see the runbook).

What `useRun` returns is the result described above, plus one more case your UI should handle: `error.code === "offline"` means the server could not be reached even after retrying. **Nothing was changed.** Show a plain message ("Cannot reach the shop server, check the wifi") and let them try again.

## Things that will bite you on a shop network

- **Plain `http://` addresses are "insecure" to browsers.** On `http://192.168.x.x` a browser disables `crypto.subtle`, `crypto.randomUUID()` and **service workers** (so no installable-app offline shell). The client library avoids the first two. For the third, run the server with HTTPS (see the runbook), or accept that each device loads the app from the server when it opens (fine, because nothing works without the server anyway).
- **Different origin in development.** Add your dev address to `ALLOWED_ORIGINS` (the default allows `http://localhost:5173`).
- **Your UI must not assume it is alone.** Feeds change under you when other devices act. Keep no copy of server data in your own state beyond what the hooks give you.

## Limits

Request body 256 KB. WebSocket message 64 KB. 30 live feeds per connection. Sign-in 20 per minute per address. Orders list shows the latest 200, activity the latest 200.
