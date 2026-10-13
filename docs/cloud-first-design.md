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
3. Whether the lobby signs people out sooner when they stop using it than a normal sign-in does (a normal one lasts 10 hours of no use). **Decided (owner, 12 Oct 2026):** 30 minutes.
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

## Build plan (drafted 12 Oct 2026, for the owner to approve before any code)

*Nothing here is built. It turns the agreed design into an order of work, based on what the code does today.*

**Starting point.** The server is one process with a SQLite file. It already has: a change log written in the same transaction as every save (`panel/src/changelog.ts`), a retry-safe push to an online endpoint (`server/src/online-sync.ts`), order numbers with a per-device prefix (so two servers cannot make the same number), registered devices, and a role check on every instruction.

**Recommended hosting shape: run the same server in the cloud, not a rewrite.** The cloud copy is this same server on a small always-on host with its disk kept safe (continuous copy of the SQLite file to storage). The shop computer runs the same program as the fallback. This avoids porting every circuit to a different database, and it keeps the owner's pages, the tests and the audit trail identical in both places. A hosted database (Postgres) stays possible later if the shop grows; it is a bigger job and nothing in the design needs it yet. (Choice of host is still open: see question 1 below.)

**Stages.** Each ends with all suites green and can be stopped there.

1. **Two-way sync between two servers.** Finish the part that is missing: the cloud server accepts changes (ignoring ids it already has), and the shop server pulls what the cloud has. Rules: money and stock movements are only ever added; plain records (catalogue, prices, staff) last write wins by time; two devices selling the last unit is flagged for the owner, not auto-fixed. Known gap to close here: a product's stock count is stored as a number, so after a merge it must be recomputed from the movements instead of trusting either copy. Test: two servers, both sell offline, reconnect, both end identical.
2. **Which server do the shop devices use.** Devices try the cloud first and fall over to the shop computer after a short failure, and move back when the cloud returns. Also: sign-in and sessions must work on whichever server is up (sessions are local to a server today, so a failover means signing in again with the PIN). Test: stop the cloud server mid-sale and prove the sale completes on the shop computer exactly once.
3. **Refund cooldown.** Small and independent: refuse a refund for about 2 minutes after the sale. Can be done at any point, even before the rest.
4. **Staff lobby, server side first.** Add "needs presence" to every instruction (default: needs it), a short allowlist for the lobby, trimmed read-only feeds, 30-minute idle sign-out, PIN again on return. The server decides presence; pages only show it.
5. **Proving presence.** Wifi proof first (device reached the shop server). GPS as a second signal. If the owner wants more than a deterrent, the shop computer issues short-lived "present" tokens. See question 3.
6. **Owner and IT remote screens**, sync state (waiting, last sent, last error) and the "held for review" list for queued changes from a session that left the shop.

**What I would do first if you approve:** stage 3 (it is tiny and safe), then stage 1, because every other stage depends on two servers agreeing.

**Questions only the owner can answer.**
1. Where the cloud server lives (a small monthly host in a region near Dar es Salaam, or a free tier to start) and who pays and holds the account. This replaces Q-16.
2. Whether a refund cooldown of 2 minutes is right, or longer.
3. How strict "at the shop" must be: is a GPS check that a determined person could fake acceptable, or do you want the shop screen to show a code that must be typed in?
4. Whether the shop computer is allowed to keep selling when it cannot reach the cloud for many hours (my assumption: yes, it is the whole point of the fallback).

**Effect on the error-handling pass (item 5 of the change requests).** The bad-input checks (very long names, huge numbers) do not depend on any of this, but "stop the server part-way through an action" does, because what the user should see depends on which server they fall back to. So that part waits for stage 2.

## Hosting options (researched 12–13 Oct 2026)

*Prices and limits come from third-party pages and change often. Check each provider's own page before paying. "Unverified" means I could not confirm it.*

| Option | What it is | Fit for this shop |
| --- | --- | --- |
| Render free plan | Sleeps after 15 minutes without traffic, no persistent disk, may restart at any time. Free database is deleted after 30 days. | **No.** Cannot hold a SQLite file or serve a till. |
| Google Cloud free small server | Free only in three US regions (none in Africa). The disk must be the "standard" type, and a public address costs about $3.65 a month anyway. | **Testing only.** US round trips make the till feel slow. |
| Oracle Always Free | 2026 reports say the free ARM allowance fell to about 2 CPUs and 12 GB, can be reclaimed when idle, may fail with "out of capacity", has no guarantee, and can start charging past the limit if a card is on file. Region and sign-up rules unverified. | **Testing only**, with a budget alert. Not for the live copy. |
| Fly.io | No free plan. Smallest always-on machine plus a small disk is about $2.34 a month in the US, about $6.85 with 1 GB of memory. Has a Johannesburg region (price unverified). Data going out of Africa is $0.12 per GB. | **Good candidate.** Same server in a container, disk kept, small cost. |
| AFRICLOUD (Johannesburg VPS) | African host, eight plan sizes, no price found. About 43 ms to Arusha. | **Good candidate**, once the price is checked. |

**Recommendation.** Pay for a small always-on server in Johannesburg for the live copy. The expected cost is a few dollars a month (to be confirmed with the real price pages). Use a free tier only as a throw-away test copy while the two-way sync is built. Distance matters: Johannesburg is about 43 ms from Tanzania, while a US server is several times slower, and the tills will use the cloud first. A card that works for foreign payments is needed; ask the owner whether a virtual Visa or Mastercard is available.

## IT command centre (idea from the owner, 12 Oct 2026)

One screen where IT sees what is happening in the whole system, and the owner can see the same status in plain words. **Not built.**

Panels:
1. **Health.** Is the cloud copy up, is the shop computer up, when did each last answer, which devices are online, how far behind is sync (waiting, last sent, last error). Disk space, backup age, clock drift.
2. **Failures and interruptions.** A timeline: server restarts, failovers to the shop computer, failed syncs, failed messages, refused instructions that repeat. Each item says what happened, since when, and the usual first step.
3. **Security.** Failed PIN attempts, lockouts, new device pairings and revoked devices, sign-ins at odd hours, refunds and write-offs outside normal patterns, lobby sessions that tried shop-only actions.
4. **Accounts and subscriptions.** A register, not a password vault: service, what it is for, who owns the account, monthly cost, renewal date, status, link to its own dashboard. Covers the host, domain, Google account used for copies, message provider, backup storage, the AI monitor's provider. An alert goes out before a renewal and when a payment fails. **No passwords or keys are stored here**; those stay in a password manager held by the owner.
5. **Runbook.** For each alert, a short "what to do" written by us, so a failure never leaves IT guessing.

Most of the signals exist already (the audit log, alerts, sync state, device list, `panel_map`). The work is mainly a read-only IT feed that gathers them, plus the accounts register.

## AI monitor (idea from the owner, 12 Oct 2026)

A helper that watches the system next to IT. **Not built; the safety rules below come first.**

**What it does.** Reads the health and security signals, notices unusual patterns, writes a short plain-language summary ("Sync has been 40 minutes behind since 14:10; the cloud answered slowly; likely cause X; try Y"), ranks alerts by urgency and drafts the runbook step. It can also draft the daily and weekly status for the owner.

**Rules that keep it safe.**
- **Checks first, AI second.** Fixed rules (a number over a limit, a service not answering) raise the alert. The AI only explains and prioritises. A free service being slow or down must never mean the shop loses its alarms.
- **Read-only.** It gets a read-only feed. It cannot send any instruction, change money, stock, staff or settings, restart anything, or see passwords and keys. At most it suggests, and a person acts.
- **Minimal data.** It is given counts, timings, error messages and trimmed log lines. Not customer names, phone numbers, addresses or receipts.
- **Everything it says is logged**, with the data it was shown, so IT can check it.
- **Free tiers are unreliable.** Free AI plans have small daily limits and their terms change (one 2026 report says Gemini's free plan became Flash-only on 1 April 2026; unverified). Design for a switchable provider and for working with no AI at all.
- **Not a replacement for security basics** (updates, backups, device approval, PIN limits). It is an extra pair of eyes.

**Decisions for the owner.**
1. Does the AI monitor only advise (my recommendation), or may it ever take a safe action itself, such as restarting a stuck sync?
2. Which provider and who pays if the free plan is not enough.
3. Who receives its alerts and how: the IT screen only, or also a phone message.

## Updated build plan

The IT command centre and the AI monitor are **stage 7 and stage 8**, after the lobby and two-way sync. The accounts register and a basic health screen can be built earlier because they do not depend on the cloud move.

## Decisions (owner, 13 Oct 2026)

The four questions from the build plan are answered:

1. **Cloud host:** start with a **free test copy** to build and test the two-way sync. The paid host is chosen before going live (shortlist: Fly.io or AFRICLOUD in Johannesburg; prices still to be checked). Nothing live depends on a free tier.
2. **Refund cooldown:** **5 minutes** after a sale, for everyone including the owner. Following the "nothing hard-coded" rule it is a shop setting (default 5 minutes), not a number in the code.
3. **Proving "at the shop":** **shop wifi first, GPS as a backup.** It is accepted that GPS from a phone can be faked, so it is a deterrent. A code from a shop screen stays an option if this proves too weak.
4. **Long outages:** **yes, the shop computer keeps selling** while it cannot reach the cloud, and the owner is alerted that it is running offline. Everything syncs when the cloud returns.

**Future plan (not now):** the IT command centre (stage 7) and the AI monitor (stage 8) are parked as future plans. Their open questions stay recorded above.
