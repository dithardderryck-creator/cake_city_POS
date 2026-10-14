# Selling when the connection is gone (design, 13 Oct 2026)

Owner's choice: option 2 of the offline question. A till that loses its connection keeps selling, remembers what it did, and the cloud **replays it later under the same checks as an online sale**. Built to be provable: every claim below has a test.

## What can be queued

Only `orders/quick_sale` (an instant sale of ready-made products: order, items, stock drop and payment in one step). It is self-contained, so replaying it needs nothing else to have happened first. Everything else (refunds, price changes, stock changes, tickets, custom cakes, staff, settings) is **never** queued: it needs the cloud.

## The pieces

1. **Offline pass.** While online, signed in, on a registered device, the till asks for a pass (`offline/get_pass`). The server returns a pass id, a secret **pass key** (only this device and the server can know it), an expiry (default 12 hours), and limits (number of sales and total money). The owner switches the feature on and sets the limits in settings; it is **off by default**.
2. **Queue.** Offline, each sale is stored on the device with: a sequence number, a request id, the sale details, the total the customer was shown (`expectedTotal`), the time on the device, and a **tag**: an HMAC (SHA-256) with the pass key over the pass id, sequence number, the tag of the previous sale, request id, intent name, the details and the time. Each tag depends on the one before it, so the queue is a chain.
3. **Replay.** Back online, the device sends the queue (`panel.replayOffline`). For every sale, in order, the server checks everything below, then runs it as the **person who made it**, through the normal pipeline (role check, shape check, the sale's own rules, audit), as its own all-or-nothing step. The same request id means a repeated send never sells twice.
4. **Held for review.** A sale that cannot be replayed *honestly* (the price changed since the customer was shown the total, an item no longer exists, a limit was passed) is not dropped and not forced through. It is stored as **held** with the reason and shown to the owner, who approves it (runs it at today's prices) or dismisses it with a note.

## What the server checks on replay

Two kinds of failure, treated differently on purpose. **Proof failures** mean the sale may not be genuine: it is refused, logged as a security event, and nothing is sold. **Policy failures** mean the sale is genuine (its tag proves it came from that person on that till) but should not simply go through: it is **held** for the owner. Cash was taken for a held sale, so it is never silently dropped, and a held sale never blocks the sales after it.

| Check | Kind | If it fails |
| --- | --- | --- |
| The request comes from a registered, not revoked device, and the pass is that device's (same answer for "no such pass" and "someone else's pass") | Proof | Refused, logged |
| The person is still active and still allowed to sell (checked again for every sale) | Proof | Refused, logged |
| The sequence number is the next expected one (no gaps, no reordering). A repeat of a finished sale returns its stored answer; a different sale under a used number is refused | Proof | Refused, logged |
| The tag is valid (the content was not altered or invented) | Proof | Refused, logged |
| The sale is an allowed intent (`orders/quick_sale` only) | Policy | Held, cannot be approved |
| The device time is not before the pass was issued, not after it expired, not in the future, and never goes backwards along the chain (5 minutes of clock difference allowed) | Policy | Held |
| The pass was replaced by a newer one: only sales made before the replacement count | Policy | Held |
| Count and money limits of the pass (held sales do not use them up) | Policy | Held |
| The sale says what total the customer was shown, and it equals the total at replay | Policy | Held |
| The sale's own rules (item exists, payment method allowed, amounts) | Policy | Held |

A held sale that the owner approves runs again as the person who made it (or under the owner's name if that person can no longer sell), at today's prices, stamped with the time it really happened.

## Threat model: what is and is not protected

| Threat | Protection |
| --- | --- |
| Someone invents sales for a till | Needs the pass key; without it the tag cannot be made |
| Someone edits a queued sale (price, items, method, time, request id) | The tag no longer matches |
| Removing or reordering sales in the middle of the queue | The chain and sequence numbers break |
| Replaying the same queue twice | Sequence numbers and request ids: the second time changes nothing |
| A stolen or lost device | The owner revokes the device: its passes stop working at once. Sales queued on it after that are rejected, not paid |
| A fired or switched-off person | Replay checks the person is still active |
| One device farming many passes | Only one pass is active per device; a new one closes the old one |
| Selling more than the shop allows offline | Count and money limits, set by the owner |
| A cashier selling at a price the customer was not shown | `expectedTotal` is compared with the real total |
| **Not protected:** the person on the till lying (taking cash and queueing nothing) | Same as an online till. Daily reconciliation of the cash drawer remains the control |
| **Not protected:** the device clock being changed to make a sale look as if it happened inside the pass window | The window and the limits bound the harm; the server also records its own receive time next to the device time |
| **Not protected:** the last sales in a queue never being sent (device lost, never reconnects) | The cloud cannot know about them. The IT screen should show passes whose device has not synced for a long time |
| **Not protected:** a pass key stolen from an unlocked, signed-in device while offline | Limits and expiry bound it; revoke the device |

## Build stages

1. **Server (panel), done 14 Oct:** pass, tag, replay, held list, owner review, settings, `expectedTotal`. Tested on its own, including every row of the tables above.
2. **Client and server transport:** the queue in the browser (kept across reloads), the replay request, the device header.
3. **Cashier screen:** what the person sees offline (a clear "offline, sales will be sent later" bar, a provisional receipt, a count of sales waiting), and what happens when a sale was held.
4. **Owner screen:** the "needs review" list.
5. **Real-world pieces:** keeping the page itself available offline (a service worker), and alerts about old unsent queues.
