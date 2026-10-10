# Provider sessions (plan M)

Real authoring attempts through the runtime's provider routing, one per provider with a key. Spend is the registry price of the tokens the API reported.

| at (UTC) | model | recipe | outcome | USD | tokens in / out / cache read | sandbox s | provenance |
|---|---|---|---|---|---|---|---|
| 2026-10-09 23:31 | anthropic/claude-haiku-4-5 | fixture-b58 | error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"adaptive thinking is not supported on this | 0.0000 | 0 / 0 / 0 | 0 | anthropic: claude-haiku-4-5, anthropic anthropic/1 |
| 2026-10-09 23:32 | anthropic/claude-haiku-4-5 | fixture-b58 | anthropic: spend cap reached (0.2764 USD spent, cap 0.3000) | 0.2764 | 8614 / 2430 / 5283 | 0 | anthropic: claude-haiku-4-5-20251001, anthropic anthropic/1 |
| 2026-10-09 23:33 | anthropic/claude-haiku-4-5 | fixture-b58 | anthropic: turn limit reached | 0.0698 | 11474 / 7054 / 72242 | 4 | anthropic: claude-haiku-4-5-20251001, anthropic anthropic/1 |

Notes:
- 23:31: the native proposer sent adaptive thinking and effort to Haiku 4.5, which answers 400 to both; fixed (anthropic.ts `NO_ADAPTIVE`). No tokens billed.
- 23:32: the API reports the dated snapshot `claude-haiku-4-5-20251001`, which the meter did not match to the requested model and priced at the ceiling (Fable 5.1). The 0.2764 USD shown is that overcount; at Haiku 4.5's registry rate the same tokens (8614 in, 2430 out, 5283 cache read, 5395 cache write) cost 0.0280 USD. Fixed (snapshot ids price as their model), with a test.
- 23:33: a full session after both fixes: 14 turns, one sandbox evaluation, 0.0698 USD.
- Real spend of this lane on 2026-10-09: 0.0978 USD (Anthropic only; no other provider key exists).
