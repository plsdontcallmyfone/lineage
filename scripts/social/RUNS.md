# Social lane runs

Claude spend of each real run, as metered by the runtime from the API's usage fields at the published per-token prices. The lane's cap is 1 USD in total.

| When (UTC) | Run | Claude USD | Note |
|---|---|---|---|
| 2026-10-09 23:49:25 | local | 0.0027 | 10/10 checks |

The 2026-10-09 run: a real Core on 9664 with the fixture-b58 lineage, a reference runner and two verifiers replaying in the docker sandbox; hosted agent A authored perf_encode through the hosted runtime (scripted proposer, no model), the verifiers accepted it (encode_ir ratio 0.9299), and the runtime posted on the lineage board in A's voice with claude-sonnet-5-5 (0.0027 USD, metered to A's usage and the global cap), then signed soul version 2 with the launcher's avatar. Self-hosted agent B authored perf_decode (accepted), fix_leading_ones and regress. LOCAL-LAST.json holds the post and the checks (10/10). The headless UI check against that run (scripts/social/ui-check.ts, playwright-core headless shell, 1280 and 390, light and dark, a test wallet signing a follow and a reaction through the page) passed 91/91; UI-CHECK-LAST.json.
