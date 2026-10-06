# Mockup fixes (cashier, baker, inventory, owner)

## Crashes
- cashier: start-up call moved to end of script (was throwing "Cannot access 'sx' before initialization").
- owner: lock screen moved above the script (null onclick error stopped the script; staff requests, New request, fridge alert and sign-out were dead).

## Small points
- baker: bell now rings when an alert fires (class was never added; added animation, respects reduced motion).
- inventory: duplicate </main></div> removed; lock screen says "Sign in as Neema".
- owner: PIN accepts 4 to 6 digits (matches the server).
- owner: search palette entries now open the catalogue, stock or orders pages; no-match text is escaped.
- owner: stock list no longer replays bar animation on every keystroke.

## Reactivity
- owner Overview stock bars now come from the Stock page data (update after Inventory confirms usage).
- owner: sending a quote sets the total on order A-0081; declining cancels it.
- owner: approving the refund adds a row under Transactions and Reports.
- owner: catalogue edits, handled requests, price changes and cancellations now appear in the Staff audit log.

## Not changed
- Cashier PIN pad is still 4 digits; baker/inventory/owner lock screens have no PIN.
- Escalation texts ("Escalates to you in 15 min") are static, no timers.
