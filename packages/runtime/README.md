# @lineage/runtime

The hosted runtime (SPEC 17.2): runs every hosted launched agent automatically, paid from each
agent's compute vault. A launcher launches a hosted agent, binds it to the key this runtime
generated, and the agent authors on its target lineage for as long as trading fees keep its vault
above `sleep_threshold`.

## What it does

1. **Discovers** hosted agents: simulated mode from Core (`GET /v1/agents`, `kind = launched`,
   `hosted = true`), devnet mode from `units_launch` (`AgentLaunch.hosted`).
2. **Generates its own signing key per agent** (`<state_dir>/keys/<agent>.json`, mode 600) and
   writes a bind request with the public key only (`<state_dir>/bind-requests/<agent>.json`). The
   owner binds it (identity plan I1):
   - devnet: the Wallet page's Identity tab builds `rotate_agent_key` to the runtime's key and the
     owner's wallet signs; `lineage-runtime cosign --config <file> --agent <id> --tx <base64>` adds
     the new key's signature after checking the transaction and sends it;
   - simulated mode: the launcher posts the bind request's `body` to
     `POST /v1/agents/:id/keys/rotate`, signed with the agent's current key.
   The launcher's key never reaches the runtime. If the owner later rotates away or revokes, the
   runtime stops running that agent.
3. **Authors** with a worker per bound, awake agent (`packages/worker`, Claude proposer), on the
   agent's target repository's lineages (or `lineages` from the config). Heartbeats and activity
   are signed by the runtime key under the agent's unchanged id (job `author`).
4. **Caps spend.** Each attempt runs under the lowest of: `attempt_max_usd`; what the vault still
   pays at the published price after what the agent already owes and `sandbox_reserve_s`; the
   per-agent epoch cap `agent_epoch_max_usd`; the onchain `max_debit_per_epoch` left this usage
   epoch (devnet); and the lifetime cap `global_max_usd` (persisted). Attempts below
   `min_attempt_usd` are not started. The proposer stops before a turn whose projected spend would
   cross the cap and prices each response at the rate of the model that answered it.
5. **Meters** model tokens and USD from the API's `usage` fields and sandbox seconds from the
   transcripts of the author's own evaluations, into a per-agent usage record of the open usage
   epoch.
6. **Posts usage.** A usage epoch closes after `usage_epoch_s`, or earlier when an agent with usage
   can no longer afford a minimal attempt (`close_when_exhausted`). Devnet: `post_usage` with the
   Merkle root of the per-agent leaves (`{ agent, amount, epoch, model_tokens, sandbox_s }`, sorted
   by hash), then `debit_compute` per agent with its proof, signed by the runtime authority.
   Simulated mode: Core's `POST /v1/admin/usage`, idempotent by `ref`. The vault pays; the chain
   (or Core) puts the agent to sleep below `sleep_threshold` and wakes it at `wake_threshold` when
   new fees arrive; the runtime sends `refresh_awake` when a plain transfer crossed a threshold.
7. **Attests provenance** (identity plan I5): for every candidate it signs
   `signStatement(runtimeKey, "provenance", record)` (models, proposer and harness digest, worker
   version, recipe, tokens, USD spend, amount charged, sandbox seconds, times) and stores it in
   Core, which publishes it once the candidate is final.

Operational safety: one process per state directory (lock file), graceful stop on SIGINT or
SIGTERM (no new attempts, running ones finish, usage closed and posted where the chain clock
allows, lock released; a second signal leaves at once), crash recovery from the persisted state
(closed epochs that did not finish are reposted, checking `UsageEpoch` and `DebitReceipt` accounts
or Core's `ref` so nothing lands twice), and no secrets in logs: every line is redacted and the
model key is read from `~/.config/lineage/model.env` without being printed.

## Run

```
bun packages/runtime/src/main.ts run --config <runtime.json> [--max-candidates <n>]
bun packages/runtime/src/main.ts status --config <runtime.json>
bun packages/runtime/src/main.ts bind-request --config <runtime.json> --agent <id>
bun packages/runtime/src/main.ts cosign --config <runtime.json> --agent <id> --tx <base64> [--dry-run]
```

Config (JSON): `mode` (`sim` or `devnet`), `core`, `state_dir`, `runtime_key` (the runtime
authority keypair: Core's `--runtime-key`; on devnet `LaunchConfig.runtime_authority`), `rpc_url`
(devnet, default `devnetRpcUrl()`), `model` (default `claude-opus-5-5`), `effort`, `max_turns`,
`max_evals`, `attempt_max_usd`, `agent_epoch_max_usd`, `global_max_usd`, `min_attempt_usd`,
`compute_price_line_per_usd`, `compute_price_line_per_sandbox_s` (whole `$LINE` as decimal
strings), `sandbox_reserve_s`, `usage_epoch_s`, `close_when_exhausted`, `poll_ms`,
`max_concurrent`, `lineages`, `max_candidates_per_agent`. Every price and cap is a TEST value until
the owner sets launch values (SPEC 20).

## Tests and proofs

- `bun test packages/runtime`: price and cap arithmetic, config validation, redaction, the lock,
  Claude proposer metering with a fake model client (projected cap, fallback model pricing),
  discovery, binding, budgets, usage posting, sleep on drain, wake on fees, restart recovery and
  the global cap against an in-process Core, provenance rules in Core, the devnet usage tree; and,
  with Docker, one full hosted attempt in the real sandbox with a fake model client (candidate,
  metered tokens and sandbox seconds, attested provenance, usage posted).
- `bun scripts/runtime/sim-run.ts`: real Claude, simulated mode (Core, reference runner and two
  verifiers on the calibrated minbpe lineage; results in `scripts/runtime/SIM-LAST.json`).
- `bun scripts/runtime/devnet-run.ts`: real Claude on devnet with this lane's TEST hosted agent;
  every signature is appended to `onchain/DEVNET.md` (results in
  `scripts/runtime/DEVNET-LAST.json`).
- Claude spend of every proof run is logged in `scripts/runtime/RUNS.md`.
