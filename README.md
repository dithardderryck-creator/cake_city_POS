# Cake POS

A point-of-sale and operations system for a cake shop, built around **orders**. A **shop server** on the shop's own network holds the data and the rules. Phones, tablets and computers connect to it over the shop wifi, so **selling does not need the internet**.

The full plan is in [`docs/blueprint.md`](docs/blueprint.md): decisions, business rules, assumptions and open questions all have stable IDs (D-xx, BR-xx, A-xx, Q-xx). Start there when something feels unclear.

## The idea: a circuit box

Every wire runs into one place, the **panel**, and the UI is pure I/O.

- A UI **reads feeds** (display-ready data such as "the order card") and **sends instructions** (plain requests such as "record payment").
- Each instruction passes three breakers in order: **sign-in and role, validation, audit**. Then a circuit does the work, **alone and all-or-nothing**.
- Storage, backups, cloud sync, WhatsApp/SMS, the printer and the recipe generator plug in as swappable **terminals**.

## Layout

```
packages/panel          The rules. Pure TypeScript, no UI, no network.
packages/server         The shop server: HTTP + WebSocket, SQLite, backups, admin tool.
packages/client         Client library for UIs (framework-agnostic core + React hooks).
packages/design-system  Tokens (CSS variables), React components, living docs page.
apps/web                A working reference UI. Runs standalone, or against the server.
docs/                   blueprint.md (the plan), api.md + api-reference.md (build a UI), runbook.md (run the server), known-issues.md (open bugs and gaps)
deploy/                 Start-up files for macOS and Windows (not yet tested on those systems)
```

## Quick start (development)

Needs **Node 20 or newer**.

```bash
npm ci
npm test                 # panel rules, server (HTTP, backups, crash tests), and UI tests
npm run typecheck
npm run build && npm run acceptance   # plays the owner against the built server: set up, sell, back up, crash, recover, restore

# Run the real thing:
npm run build
npm run admin -- create-owner --name "Amina"     # asks for a PIN
npm run start                                    # prints the addresses to open on other devices
```

To try the reference UI against the server:

```bash
# terminal 1
npm run dev:server
# terminal 2  (allowed by default: http://localhost:5173)
VITE_SERVER_URL=http://localhost:8787 npm run dev
```

Without `VITE_SERVER_URL`, `apps/web` runs standalone with demo data in the browser (open `#/design` for the design system). For a throwaway demo database on the server: `npm run admin -- seed-demo --yes` (owner PIN 1111, **never on a real shop**).

## If you are building the UI

Read [`docs/api.md`](docs/api.md). Every instruction and feed, with its fields and who may use it, is in [`docs/api-reference.md`](docs/api-reference.md), **generated from the code** (`npm run docs:api`; a test fails if it is stale).

## If you are running the shop computer

Read [`docs/runbook.md`](docs/runbook.md): setup, starting automatically, backups, restoring, what to do when the computer breaks, and a pilot checklist to complete before relying on it.

## What is built

Sign-in with PINs, lockout and expiring sessions; staff management; the catalogue with its variation grid and manual prices; selling catalogue goods (add, pay, hand over or deliver); partial-payment exceptions; owner-only refunds; stock that drops only at completion; an audit trail; retry-safe requests; nightly verified backups with cloud-folder copies; restore and admin tools; the IT panel map. Section 18 of the blueprint has the full table, including what is **not** built yet (custom cake orders, production and ingredient tracking, messages and alerts, reports, receipts).

## Known limits

- **One server, no failover.** If the server computer or the shop wifi is down, devices cannot sell. See the runbook for the recovery plan and paper fallback.
- **Tested on Linux only.** The Windows and macOS start-up files have not been run on those systems.
- **The UI has been tested in a simulated browser, not on real phones and tablets.**
- **The PIN is a lock, not strong security.** Anyone on the shop network can reach the server. Keep customers on a separate wifi. HTTPS is optional and needs a certificate on each device.
- Cloud backup copies go to a folder your cloud app syncs. Direct upload to a storage service is not built.

## Rules for contributing

1. A new capability is a new **circuit** plus its instructions and feeds. Add it to `IntentMap` and `schemas.ts` (the compiler checks they agree), then run `npm run docs:api`.
2. **No business logic in the UI.** If a screen needs to decide something, add it to a feed.
3. Every colour, size and radius comes from a `--cp-*` token.
4. Change a rule? Add a decision entry, mark the old one superseded, bump the blueprint version.
5. A safeguard needs a test that **fails when the safeguard is removed**. Several bugs here were found only because a test was made to fail first.
