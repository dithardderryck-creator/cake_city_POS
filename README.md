# Cake POS

A point-of-sale and operations system for a cake shop, built around **orders**. It works offline first and installs as a web app on phones, tablets and desktops.

The full plan lives in [`docs/blueprint.md`](docs/blueprint.md): decisions, business rules, assumptions and open questions all have stable IDs (D-xx, BR-xx, A-xx, Q-xx). Start there when something feels unclear.

## The idea: a circuit box

Every wire runs into one place, the **panel**, and the UI is pure I/O.

- The UI **reads feeds** (display-ready data like "the order card") and **sends intents** (plain instructions like "record payment").
- The panel checks each intent through three breakers in order: **PIN and role, validation, audit**. Then a circuit does the work.
- Storage, cloud sync, WhatsApp/SMS, the printer and the recipe generator plug in as swappable **terminals**.

Because of this, permissions, the audit log and the offline outbox each live in one place, and the UI can be swapped (for native apps, say) without touching any rules.

## Layout

```
packages/panel          Pure TypeScript. No UI, no browser needed to test it.
packages/design-system  Tokens (CSS variables), React components, living docs page.
apps/web                The installable web app. Only talks to the panel through feeds and intents.
docs/blueprint.md       The single source of truth.
```

## Run it

```bash
npm install
npm run dev        # open the printed address
npm test           # panel rules + end-to-end UI tests
npm run typecheck
npm run build      # production build with offline service worker
```

Open `#/design` (for example `http://localhost:5173/#/design`) for the design system.

**Demo mode:** the first launch seeds staff and three cakes. PINs are shown on the sign-in screen: owner 1111, cashier 2222, baker 3333, inventory 4444, IT 9999. Data is saved in the browser's IndexedDB.

## What is built

Sign-in with PINs and roles, the catalogue with its variation grid and manual prices, selling catalogue goods (add, pay, hand over or deliver), partial-payment exceptions, owner-only refunds, stock that drops only at completion, an audit trail, and the IT panel map. See section 18 of the blueprint for the full status table.

## Known limitations

- **No cloud sync yet.** Changes queue in the outbox on the device and the panel map shows the backlog.
- **PIN hashing is demo-grade** and sessions live in memory. Real sign-in should be verified on a server once sync exists.
- **IndexedDB writes are not transactional across records** yet, so a browser crash mid-intent could leave a partial change. A unit of work around each intent is the planned fix.
- The UI has been tested in jsdom, not yet on real phones and tablets.

## Rules for contributing

1. A new capability is a new **circuit** plus its intents and feeds. Add it to `IntentMap`, then update the blueprint.
2. **No business logic in the UI.** If a screen needs to decide something, add it to a feed.
3. Every colour, size and radius comes from a `--cp-*` token. No hard-coded values in components.
4. Change a rule? Add a decision entry, mark the old one superseded, bump the blueprint version.
