# Cake POS — Cloud-first architecture and geofencing (design, agreed 11 Oct 2026)

> Owner's design. **Not built yet.** Nothing in the code follows it so far; the sync work already in the repo (change log, retry-safe flush) is the base it builds on. See `docs/later.md` item 6.
Oct 11, 2026

Cake POS moves from a shop-only local server to a cloud-hosted backend as the source of truth, with the shop desktop as an offline fallback, geofencing for on-site roles, and a refund cooldown to remove the one real sync race. Agreed with the owner, 11 October 2026.

## Why change

The current build (see `docs/later.md`, item 6) treats the shop desktop as the one true database, with the cloud only as a backup copy and a one-way change log. That has two problems in practice.

First, the owner cannot use the system at all when away from the shop: the owner and IT pages only ever talk to the local server over the shop wifi, and reading from a remote copy (change log part two) was never built. Second, the shop is subject to a real recurring failure: power cuts, reported by the owner as a common Sunday occurrence, which take down the shop wifi and the desktop server together, stopping all sales until power or the machine is restored.

The fix agreed here is to invert which side is primary.

## The new shape

(Architecture diagram: cloud primary, shop desktop fallback. Not included in this copy.)

The cloud backend becomes the primary, always-on system, hosted the way an ordinary website is hosted. It is the source of truth. The owner and IT sign in to it directly from anywhere; no sync engine or special handling is needed for them, since they were always meant to be remote.

The shop desktop keeps running a local server, but it changes role: it is now a fallback, not the main system. By default every device, including the cashier, baker and inventory devices at the shop, talks straight to the cloud backend, over wifi or mobile data, whichever is available. The local desktop only takes over automatically when a shop device can reach neither the cloud nor mobile data. Because Sunday power cuts are a real recurring risk here, the desktop should sit on a small UPS or battery backup, so it can keep serving the shop's wifi locally through a power cut even though the grid is down.

This keeps the offline-first engine already built (the change log, retry-safe sync) but changes which side is primary: the cloud is now the system of record, and the shop desktop is cheap insurance for the rare case for when both wifi and mobile data fail at once.

## Connectivity scenarios

| Situation | What happens |
| --- | --- |
| Shop wifi and internet both up | Every device talks straight to the cloud backend. Normal operation. |
| Internet down, shop wifi and power up | Cashier, baker and inventory devices fail over to the shop desktop automatically and keep selling locally; it syncs to the cloud once the internet returns. Only the owner's remote access and cloud sync pause. |
| Power cut (the recurring Sunday case) | Shop wifi and the desktop both lose power unless the desktop is on a UPS. With a UPS, the desktop keeps serving shop wifi and selling continues locally. Devices with their own mobile data may also reach the cloud directly and skip the desktop entirely. |
| Power up, but a device has no wifi and no mobile data | Falls back to the shop desktop over shop wifi, if the desktop itself has power. |
| Everything down: no power, no wifi, no mobile data anywhere | No device can sell. This is the one unavoidable gap, same as today, and the reason a UPS on the desktop matters so much. |

In short: the cloud is the default path for all five roles, mobile data on staff phones quietly covers most outages on its own, and the shop desktop with a UPS is the insurance for the specific case of a local power cut with no mobile signal.

## Money and stock: events, not edits

Multi-writer sync normally needs conflict rules, but money and stock mostly avoid the problem by not being edits at all. A sale is not "the stock count changed from 10 to 9"; it is the fact "one unit was sold". Treated as an append-only event, in the same shape as the change log already built for part one of online sync, two devices selling different items while both offline just produce two separate events that both replay cleanly once reconnected. Payments work the same way: never merged, just added to the ledger and totalled.

Plain fields such as catalogue items, prices and staff names, which one person edits at a time, can keep simple last-write-wins-by-timestamp behaviour; conflicts there are rare and low-stakes.

The one real conflict that is a business problem, not a sync problem, is two devices selling the last unit of the same scarce item while both offline. No algorithm can invent a second cake, so this is flagged for the owner to resolve by hand after the fact rather than silently auto-resolved. An alternative, not adopted here, would be to only reserve stock while genuinely online and refuse an offline sale of the last unit of something scarce; worth revisiting if this turns out to happen often.

## Geofencing: locking the three shop roles

Cashier, baker and inventory sessions are tied to the shop. The owner and IT are exempt entirely: no geofencing, no local-network proof, full use of the system from anywhere.

Wifi gives the strongest and cheapest signal, so it is the first check. A device connected to the shop's own wifi network (checked by whether it can reach the local server's address directly, which only works on that network) counts as proven presence, wifi range being naturally short, and no GPS is needed in that case.

Off the shop wifi and on mobile data, there is no free local-network proof, so the device falls back to GPS: its coordinates must sit inside a radius around the shop. Location permission is requested once, at account set-up, with a plain explanation of why ("needed to confirm you're at the shop when off wifi"); once granted it persists at the OS level and later checks run quietly in the background with no repeat prompts. A worker who declines the permission can still use the system, but only while on the shop's own wifi.

While signed in, the device is checked periodically. Shop wifi lost but GPS still shows the shop's radius: treated as a wifi hiccup, the session stays live and queues changes offline. Shop wifi lost and the device has also left the radius: the session drops to the **staff lobby** (next section) instead of locking.

## Staff lobby: what staff can do away from the shop

*Added 12 Oct 2026 at the owner's request.* A cashier, baker or inventory person who is outside the shop (off wifi and outside the GPS radius, or who never gave location permission) is not locked out. They land in a **lobby**: they stay signed in, but only for simple tasks that cannot cost the shop money or corrupt stock. Anything serious waits until they are back at the shop. The owner and IT are exempt as before and never see the lobby.

**Principle.** The lobby may read and communicate. It may not change money, stock, orders or prices. Back at the shop (wifi or GPS inside the radius), full access returns on its own.

**Proposed split, to be confirmed by the owner.** Nothing is built; this is the starting list, based on what the system can do today.

| In the lobby (allowed away from the shop) | Shop only (blocked in the lobby) |
| --- | --- |
| Read announcements and acknowledge them | Any sale, quick sale or payment |
| Send and answer staff requests, see alerts addressed to them | Refunds (owner only anyway) |
| Change their own PIN, sign out | Creating, editing or cancelling orders and tickets |
| See their own past actions and shifts (when shifts exist) | Quotes and prices, catalogue changes |
| Baker: view the bake queue and tickets read-only | Moving a ticket along (in production, ready, handed over) |
| Inventory: view stock levels and forecasts read-only | Receive stock, write off, usage confirmation, daily count |
| Cashier: view today's orders read-only (no totals of money collected) | Anything that opens the cash drawer or changes a total |

**Decided (owner, 12 Oct 2026):** a baker may report ingredient usage from the lobby. It only creates a suggestion that Inventory must confirm at the shop, so it cannot change stock by itself.

**How it would work, on top of what exists.**

- Every instruction already has a role list. Add one more property: whether it needs the person to be at the shop. The default is **needs presence**, and only a short allowlist is open to the lobby. Forgetting to classify a new instruction then fails safe (blocked), not open.
- This must be enforced by the server, not the page. A page that hides the Sell button is not protection. The server decides what "at the shop" means for each session and checks it on every instruction.
- Feeds work the same way: lobby feeds are read-only and trimmed (no money totals).
- Offline queued changes: when a session drops to the lobby, anything it queued while it was still inside the shop is **kept and held for the owner to review**, not discarded. This answers the open question below about queued changes. It also means a lobby session can never create new queued sales.

**Things to settle.**

1. How "at the shop" is proven to the server. Wifi proof (the device reached the local server) is reasonably trustworthy. A GPS position that the phone reports is easy to fake, so on mobile data it is a deterrent rather than a guarantee. If this matters, the shop computer (or a code shown only on a shop screen) could issue short-lived "present" tokens.
2. **Decided (owner, 12 Oct 2026):** coming back to the shop asks for the PIN again before full access returns.
3. Whether the lobby signs people out sooner when they stop using it than a normal sign-in does (a normal one lasts 10 hours of no use). Proposed: 30 minutes. Not decided.
4. Whether the lobby is shown for someone who declined location permission and is off wifi. The design above says yes: they can still use the system, but only the lobby until they are on shop wifi.
5. How this interacts with registered devices (done): a staff member's own phone would be a registered device, and the lobby works per sign-in, not per device.

## Refund cooldown

A universal cooldown of roughly 90 seconds to two minutes applies after any sale, before it can be refunded by anyone, owner included. This replaces an earlier, more complex idea of ordering rules for remote actions on a recently-touched order. If a sale is not yet refundable at all, there is nothing for a remote refund and a live in-shop action to race against. It is also a sensible rule on its own merits, guarding against mis-taps, independent of the sync problem it solves.

## Open questions and next steps

- Choice of cloud database and hosting (this supersedes the repo's existing Q-16, which assumed the shop computer stayed primary; see `docs/later.md`).
- What happens to a cashier, baker or inventory device's queued offline changes if its session leaves the shop radius mid-queue: proposed answer in the staff lobby section (hold for the owner to review, never discard). To confirm.
- Exact geofencing radius around the shop, and how directly browsers can read wifi network identity versus relying on reaching the local server's address as the proof.
- Whether a small UPS for the shop desktop is feasible to source and maintain for this shop.
- This builds on, rather than replaces, the existing change-log and retry-safe sync work (`docs/later.md`, item 6); part two (reading back from a remote copy) is the piece this design finally completes.
