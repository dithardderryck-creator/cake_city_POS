# The free test copy

A throw-away copy of the shop on the internet, to try the system from a phone or a second device without the shop computer. **Demo data only. Never put real customers or real money in it.** The live shop will use the paid host chosen later (see `docs/cloud-first-design.md`).

## What you get, and what you do not

- The same server and pages as the shop computer, on a public `https://` address. That address also lets the till pages install and keep working offline, which plain `http://` on the shop wifi cannot do.
- Demo staff, cakes and prices. The owner PIN is 1111 (the other demo PINs are in `docs/runbook.md`).
- **Nothing is kept.** Render's free plan has no permanent disk. Per [Render's own page](https://render.com/docs/free), local files are lost whenever the service restarts, redeploys or spins down, and it spins down after 15 minutes without traffic (waking takes about a minute). So every wake-up is a fresh demo shop and every device has to be paired again. A page left open keeps it awake.
- 750 free hours a month per Render account. When they run out, free services stop until the next month.

## Starting it (about 10 minutes, no card)

1. Sign up at render.com. Signing in with the GitHub account that holds this repository is simplest, and lets Render read the repository.
2. **New → Blueprint**, choose this repository, and press **Apply**. Render reads `render.yaml` in the repository and builds the `Dockerfile`. The first build takes several minutes.
3. When the service says **Live**, open its **Logs** tab and find the boxed message `TEST COPY`. The line **First device code** is a one-time code that works for 30 minutes.
4. Open the service address (shown at the top of the page, like `https://cake-pos-test-xxxx.onrender.com`) on your phone or computer. Type the code in. That device is now registered.
5. Sign in as the owner with PIN 1111. On the Staff tab the owner can make more device codes for other phones.

If the service has gone to sleep and woken, look at the Logs again: there is a new code every time it starts.

## How it works

`render.yaml` sets four things: `TEST_COPY=1`, `TRUST_PROXY=1`, `PORT=10000` and the time zone.

- **`TEST_COPY=1`** makes the server fill an empty database with the demo shop when it starts, and print a fresh first-device code. If the database already has data it is left alone, so a plain restart does not erase anything that survived. Do not set it on the real shop: nothing stops it, and it would make a stray device code at every start.
- **`TRUST_PROXY=1`** tells the server one proxy (Render's) sits in front of it, so the sign-in and pairing try-limits count each visitor separately instead of counting everyone as Render's address. Without it, ten wrong tries from anyone would lock out everybody. The server takes the visitor's address from the right-hand end of `X-Forwarded-For`, so a visitor writing a made-up address into that header gains nothing.
- Registered devices are still required, so someone who finds the address cannot see staff names or sign in without a code from the logs.

## What has and has not been checked

Checked here: the build, starting with `TEST_COPY=1`, the demo being filled, the code registering one device once, a restart keeping data and making a new code, and per-visitor limits with `TRUST_PROXY` (server tests in `packages/server/src/test-copy.test.ts`).

Not checked, because this workspace has no Docker and cannot reach Render: building the `Dockerfile` itself, and Render running it. If the first build fails, the log at the end of the failed build says why; the most likely trouble is `better-sqlite3` (the database library), which the `Dockerfile` has build tools ready for.

## Turning it off

Delete the service in the Render dashboard. Nothing else was created.
