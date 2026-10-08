# Hosted runtime proof runs

Claude spend of each real run, as metered by the runtime from the API's usage fields at the published per-token prices. The lane's hard cap is 3 USD in total.

| When (UTC) | Run | Claude USD | Note |
|---|---|---|---|
| 2026-10-08 11:08:34 | devnet | 0.0000 | incomplete; 1 failed checks |
| 2026-10-08 11:21:01 | devnet | 0.4606 | minbpe devnet, 1 candidate(s): accepted; 0 failed checks |
| 2026-10-08 12:23:40 | sim | 0.4303 | minbpe, 2 candidate(s): rejected, accepted; 0 failed checks |

Notes. The first devnet row stopped at its first RPC read (public devnet HTTP 429) before sending anything; the backoff was added and the rerun passed 18/18. In the sim run the first runtime process stopped launching new attempts once the vault could no longer pay for one but did not close the usage epoch (the exhausted flag was cleared every tick while the vault still held more than it owed). It was stopped with SIGTERM, whose graceful stop closed and posted the epoch; the bug is fixed in `packages/runtime/src/runtime.ts` with a regression test, and the script now ends its wait when the runtime has stopped.
