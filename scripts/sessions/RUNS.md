# Live agent panel runs (plan L4)

## 2026-10-09, local network, Claude author

`bun scripts/network.ts --recipes fixture-b58 --author anthropic --max-usd 0.9 --port 9662 --web-port 9664 --no-web --verifiers 2`, dashboard `bun apps/web/server.ts --port 9663 --core http://127.0.0.1:9662 --dev`.

- Session `a3bdd1e7...4ece`, claude-opus-5-5: 4 turns, 21 events (reads of src/lib.rs and both protected harness files, one edit of src/lib.rs lines 19 to 40, one sandbox run with all five phases, self-judged accepted, submit).
- Seen live in a headless browser at 1280 px (state Live, cursor on `examples/lineage_equiv.rs` lines 1 to 28, no edit text served) and at 390 px right after the commit (state sealed, 22 hatched lines, run output sealed).
- Candidate accepted by 2 verifier replays: encode_ir ratio 0.0927. The panel then served the edit text and replayed the session with it typed in.
- Claude spend: 0.1098 USD (12 input, 3235 output, 19749 cache read tokens), one attempt; lane cap 2 USD.

## 2026-10-09, local network, scripted author

`bun scripts/network.ts --recipes fixture-b58 --author scripted --port 9662 ...`: every fixture patch recorded as one `patch` event per hunk ("applying patch perf_encode, hunk 1 of 1"). One page opened while the session was sealed switched to a replay with the edits 18 s later, when the verdict landed.

## UI check

`bun scripts/sessions/ui-check.ts --pw <dir with node_modules/playwright-core> --web http://127.0.0.1:9663`: 18/18 on the Claude session and 160/162 over 9 scripted sessions at 1280 and 390 px (window and glow, replay to the end, tabs, cursor, edits typed in or sealed, run strip, no horizontal page scroll, no monospace, no console errors). The 2 failures came from the check's own snapshot: a session listed as sealed went final during the run, so the panel correctly showed open edits where the check expected sealed ones.

## 2026-10-10, panel lane P2: the browser window on the machine

The panel is now a Chrome-style desktop window (tabs with site-initial favicons, toolbar, omnibox with the code host's own address, profile avatar, macOS window controls, light and dark) around a code host's file view, on the shared `<lineage-device>` machine by default (`frame` device, window or none). The pointer is a system arrow and I-beam on eased, slightly overshooting curves in stepped frames (12 fps default, `fps` 6 to 60): it clicks tabs or opens a new one and types the address, types searches into the site's search field, scrolls to the range and drag-selects it, and types open edits with a human rhythm, hiding while it types. Sandbox runs open as `lineage://sandbox/run-<n>`; the machine's lights follow the run's phases. Reel and explorer thumbnails draw the same window.

Headless only (chromium-headless-shell via playwright-core in a scratch dir), dashboard `bun apps/web/server.ts --port 9662 --dev --core https://157-245-71-188.sslip.io --market https://157-245-71-188.sslip.io` on the live site's real sessions: `bun scripts/sessions/ui-check.ts --pw <dir> --web http://127.0.0.1:9662` 126/126 (Claude session 60105fb1 and routed session b37d35f4, each at 1280 and 390 px in light and dark: machine with the window, theme, system pointer, stepped motion 9 to 13 positions in 3 s, omnibox address, replay to the end, edits typed in, runs and verdict, no horizontal scroll, no monospace in the panel, no console errors; reduced motion: the pointer jumps, nothing blinks; token page on the machine at 1280 and 390; embed `<lineage-screen frame="window">`, `frame="device" fps="24"` and reel thumbnails at 1280 and 390 in both themes). Result in scripts/sessions/UI-CHECK-LAST.json.
