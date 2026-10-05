# Known issues

Findings from a review of the repo, each re-checked against the code. **FIXED** items have tests that fail if the fix is removed. **OPEN** items are left for the owner of the UI/tooling to fix; each says where and what the fix is.

Last updated after the alerts, forecast, metric-units and phone-notification work.

## Fixed

| # | Finding | What changed |
| --- | --- | --- |
| F-1 | `useSession` never noticed a sign-in ended by the server when no live connection was open (the token was cleared without any event firing) | The client now has an `onSignedOut` event, fired whenever the sign-in is lost. `useSession` uses it. Tests: `client-react.test.tsx` (one case with a live feed, one with plain requests only) |
| F-2 | `signOut()` while the server was unreachable dropped the result, so the server-side sign-in was never ended | The device signs out immediately, then retries ending the sign-in in the background (every 20 s, up to 40 tries). `signOut()` returns `{ serverEnded }`. Test: `e2e.test.ts`, "signs out on this device at once even when the server is unreachable" |
| F-3 | A server that accepts connections but never answers froze a tap for roughly a minute | Every call now has an overall deadline (15 s default, per-attempt 8 s, 2 retries). Tests: "gives up on a server that accepts connections but never answers" and one pinning the defaults |
| F-4 | `useSession` / `useFeed` / `useRun` / `useConnection` were untested | `packages/server/src/client-react.test.tsx` runs them against a real server (7 tests). Its dependencies are declared in `packages/server/package.json` |
| F-5 | The test "never writes PINs or tokens to the logs or the database file" failed at random: a bare 4-digit PIN can appear by chance inside random hex ids in the database file | It now looks for the PIN written as a value (`"7391"`, `pin=7391`, `pin: 7391`). Found while re-running the suite, not part of the original review |

## Open

### O-1. Undeclared dependencies in `apps/web`
`apps/web/src/server-mode.test.tsx` imports `@cake-pos/server`, `ws` and Node built-ins. None of these (nor `@types/node`) is declared in `apps/web/package.json`. It works only because npm hoists them to the root. Declare them as devDependencies, or move that test next to the server's tests (where `client-react.test.tsx` now lives).

### O-2. `apps/web` does not use the client React hooks
`apps/web/src/lib/panel.tsx` has its own bridge and only imports `createClient` and `localStorageTokenStore`. The hooks are covered by tests (F-4) but no UI uses them. `docs/api.md` previously called `apps/web` "a complete working example" of the hooks; that sentence is corrected. Either move `apps/web` onto the hooks or leave the docs as they now read.

Related gap in the hooks: `useSession` reports `signedOut` when the server cannot be reached at page load, because `restore()` returns `null` in that case. The saved sign-in is kept, but the UI cannot tell "nobody signed in" from "server not reachable yet". It needs a third state (for example `unreachable`).

### O-3. Demo PINs shown on the sign-in screen in server mode
`apps/web/src/screens/SignIn.tsx` (the "Demo mode. PINs: ..." note) prints the demo PINs unconditionally. Gate it on standalone/demo mode only (`!SERVER_MODE` in `lib/panel.tsx`).

### O-4. "Offline, saving here" chip uses `navigator.onLine`
`apps/web/src/App.tsx` shows the chip from `useOnline()` (`navigator.onLine`) in `lib/panel.tsx`. Under D-54 the app is offline when it cannot reach the shop server, which `navigator.onLine` does not tell it (wifi can be up with the server down). In server mode the chip should follow the client's connection state; the "saving here" wording is only true in standalone mode.

### O-5. The `sync` outbox rows grow forever
Every successful instruction still writes a `sync` row to the `outbox` table (`enqueueSync` in `packages/panel/src/kernel.ts`). Nothing reads or prunes these rows. The *notification* rows (messages to phones, SMS, WhatsApp) are consumed, retried and pruned by `maintain()`, so the table is no longer a dead end, but `sync` rows still add up, one per action. They are meant to feed the online copy of the data (not built yet); until then, or if that is dropped, stop writing them.

### O-6. No CI and no lint
The only checks are `npm test`, `npm run typecheck` and the generated-docs staleness test, all run by hand. Suggested:
- GitHub Actions: install, typecheck, lint, test, `npm run docs:api` followed by a diff check, build, `npm run acceptance`. Linux required; Windows and macOS allowed to fail at first (the start-up files have never been run on them).
- ESLint with typescript-eslint, `import-x/no-extraneous-dependencies` (this catches O-1 automatically) and `react-hooks`.

### O-7. The reference UI has no custom cake screens
`apps/web` was built before custom cakes. It still compiles and passes its tests, but it cannot create custom cakes, send or answer quotes, attach photos, or show the baker's queue. The server, the feeds and the client library all support them (see "Custom cakes" in `docs/api.md`). This is expected while the real UI is being built separately.

### O-8. Dates and time zones
Delivery dates are plain calendar dates, and "today", "tomorrow" and "late" in `bake_queue` are worked out in the **server computer's time zone**. If the server computer is set to the wrong time zone, those labels are off by a day near midnight. Check the computer's time zone when installing.

### O-9. Custom cake details are not final (Q-04)
The set of cake attributes follows the blueprint plus `allergyNotes` and `sizeNote`. The owner and baker still need to confirm what the recipe generator will need (blueprint Q-04). Changing the set later means a migration for cakes already stored; the stored `spec` is a single object, so adding optional fields is cheap but renaming or removing is not.

### O-10. Recipe suggestions are empty until the shop enters its recipes
The suggestion can only be as good as the recipe lines. A new shop has none, so the first cakes get a warning and an empty suggestion until the owner or baker adds ingredients and recipe lines. The lines are rough averages: the result is a starting point the baker corrects, and Inventory's confirmed figures are what matter. Confirmed usage does not yet adjust the recipe lines (parked, blueprint "recipe feedback loop").

### O-11. Alerts: what is not covered
Alerts, the stock forecast and delivery to phones, SMS and WhatsApp are built. Not covered: general requests, notes and announcements between staff (the Messages circuit, BR-15 to BR-17); alerts for things that have no data yet (closing review, counter day). Usage reports waiting for Inventory appear in `usage_inbox` and raise `usage_waiting` alerts (D-61).

### O-12. (closed) Ingredient units are now converted
Stock is stored in metric base units and other units are converted on input (D-62), so this no longer applies.

### O-13. Phone push needs HTTPS
Browsers only register service workers and push subscriptions on HTTPS (or `localhost`). On `http://192.168...` the in-app sound, vibration and system notification work while the app is open, but nothing arrives when it is closed. Fix: serve the app over HTTPS (runbook, "HTTPS"); open question Q-11 is how to do that on a shop network without certificate warnings.

### O-14. A closed phone plays its own sound
A web page cannot choose the sound of a notification that arrives while the app is closed; the phone uses its notification sound (set by the person in the phone's settings; Android lets them raise the channel's importance). The loud repeating siren plays only while the app is open. iPhone additionally needs the app added to the Home Screen before it can receive push at all.

### O-15. Africa's Talking responses not verified live
The Africa's Talking SMS integration was written from its public documentation and tested against a stand-in server. Its per-recipient status codes (which mean "accepted" and which mean "rejected for good") should be checked with a sandbox send before relying on it. Twilio and the webhook route were tested the same way, not against live accounts.

### O-16. WhatsApp templates and the 24-hour window
Business WhatsApp (through Twilio) only allows free-form messages within 24 hours of the person last writing to the shop. Alerts sent outside that window need a pre-approved template, which this server does not send yet. SMS and phone push have no such limit.

### O-17. Forecast confidence starts low
The forecast learns from confirmed usage. In the first days it has no usual rate and no calibration, so it uses the recipe suggestions alone and labels itself `low` confidence. Alerts from it are most useful after a week or two of confirmed usage.

## Corrected claims

- `docs/blueprint.md` said the client library was "tested through the reference UI against a real server". It was not. It is now tested directly (F-4), and the build-status table says so, and has a row for the outbox that points at O-5.
- `docs/api.md` said `apps/web` is a complete working example of the hooks. See O-2.
