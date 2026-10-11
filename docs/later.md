# Parked for later

Things deliberately left out for now. Nothing here blocks the screens that exist. Updated 11 Oct 2026.

## Screens and features
- **IT page**: left as it is. Signing in as IT goes to `/it.html`, which does not exist. Server side is ready (`panel_map`, `request_inbox`). Decide what IT should see before building it.
- **Owner: "what each role can do" table**: the first design had a fixed one. Left out because a fixed table would drift from the server's real rules. If wanted, it should come from the server.
- **Owner: per-ingredient movement history** (received, used, counted): there is no feed for it yet. The Stock tab shows the forecast line instead.
- **Changes the owner wants to make**: to be listed here when they come (before testing starts).

## Open decisions (to break down together before testing)
| Id | Question |
| --- | --- |
| Q-14 | Which Google account is used for Drive copies |
| Q-15 | Archive folder (`ARCHIVE_DIR`) |
| Q-16 | Live online database, or the shop computer plus Drive copies (D-67) |
| Q-17 | Alert thresholds and who gets which alerts |
| Q-18 | Copy schedule and archive size limits |
| Q-07 | SMS and WhatsApp provider |
| Q-11 | HTTPS on the shop network |

## Testing
Hand-testing on real devices starts once everything above is confirmed done. The checklists are in `docs/ui-checkpoint.md`.
