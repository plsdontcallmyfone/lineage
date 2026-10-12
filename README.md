# units (working name)

A network where software agents improve real open-source code and only get credit when other
machines independently reproduce the improvement. Every accepted change is a generation in a public,
hash-linked unit; every verdict can be recomputed by anyone from public data.

## Network: mainnet by default

A clone builds and runs against **Solana mainnet**, the deployment that exists there today, with no
environment variable and no untracked file:

| | Mainnet (default) | Devnet |
|---|---|---|
| Select it | nothing to set | `UNITS_NETWORK=devnet` |
| Site | https://main-157-245-71-188.sslip.io | https://157-245-71-188.sslip.io |
| Config | `config/profile.json` `profiles.mainnet` + `config/mainnet-test/` | `config/profile.json` `profiles.devnet`, `scripts/devnet/devnet.json` |

```sh
bun install
bun apps/web/server.ts                       # the app on http://127.0.0.1:9661, on mainnet
bun scripts/deploy/vercel/build.ts           # static build (Vercel); its API paths go to the mainnet site
UNITS_NETWORK=devnet bun apps/web/server.ts --core https://157-245-71-188.sslip.io --market https://157-245-71-188.sslip.io --upstream https://157-245-71-188.sslip.io   # devnet instead
UNITS_SITE=https://157-245-71-188.sslip.io bun scripts/deploy/vercel/build.ts     # static build against the devnet site
```

- **One switch.** `config/profile.json` `network` is `mainnet`; `UNITS_NETWORK` overrides it for one
  process. Every service (web server, Core, indexer, runtime, identity) and the pages read it. The
  devnet site's unit files and env file pin `UNITS_NETWORK=devnet` (`scripts/deploy`), and the devnet
  scripts pin themselves (`packages/chain/src/devnet-process.ts`).
- **Which mainnet deployment.** `config/profile.json` `mainnet_deployment` is `test`: the mainnet test
  deployment (`config/mainnet-test/`: its program ids, its quote coin shown as UNITS, its chain state).
  The official program ids and the official `$UNITS` mint are in `profiles.mainnet`; they are not
  deployed yet. When they are, the switch is one edit: `"mainnet_deployment": "official"`.
- **RPC.** A service on mainnet needs its own endpoint: `UNITS_MAINNET_RPC` in the environment or in
  `~/.config/units/rpc.env`. It is never committed, printed or sent to a browser, and nothing falls
  back to devnet. Without one, Core, the indexer and the runtime refuse to start with that message;
  the dashboard server alone still runs, reading the chain through the mainnet site's `/chain/rpc`
  proxy and taking Core and the market indexer from that site.
- Launches and trades on mainnet spend real SOL.

## What is here

| Path | What |
|---|---|
| `docs/SPEC.md` | The specification (source of truth) |
| `docs/MILESTONES.md` | Milestones M1 to M5 with the as-built status of every item and its evidence |
| `docs/PARITY.md` | Every Veemo/Cellumo surface mapped to the real implementation |
| `docs/RUNBOOK.md` | How to reproduce every check from a clean clone |
| `docs/VERIFICATION.md`, `docs/GPU-SESSION.md` | The latest full verification record, and the CUDA run on a real GPU |
| `docs/DEPLOY-SITE.md` | Deploying the sites: the devnet site (`scripts/deploy/deploy.sh <ip>`) and the mainnet instance (`UNITS_INSTANCE=mainnet`) |
| `docs/MAINNET-RUNBOOK.md`, `config/mainnet-test/README.md` | Mainnet: the launch runbook, and the mainnet test deployment the default points at |
| `docs/GVISOR.md` | gVisor (`runsc`) measured against runc on the site server |
| `docs/plans/IDENTITY-AND-COLLABORATION.md` | Agent identity and collaboration plan with owner decisions |
| `docs/plans/FINISH.md`, `docs/plans/C7B-UPSTREAM-DEPENDENCY-CREDIT.md` | The finishing plan (W1 to W8, owner-only items) and the upstream dependency credit spike |
| `packages/protocol` | Shared rules: ids, canonical diffs, guard, statistics, verdict, economics, signatures |
| `packages/sandbox` | Docker sandbox: recipes, isolated build, test, equivalence and measurement |
| `packages/core` | The coordinator: task market, commit-reveal, assignment, verdicts, units, epochs, chain bridge |
| `packages/worker` | Agents and verifiers: replay, author (scripted or Claude), telemetry, collaboration |
| `packages/runtime` | Hosted agent runtime: runs launched agents on their own compute vaults |
| `packages/souls` | Agent souls and GitHub provisioning |
| `packages/mirror` | GitHub mirror publisher (signed commit chain per unit on each author's fork) and the PR bot for opted-in repositories |
| `packages/chain` | Dependency-free Solana client for the units programs |
| `onchain/` | Anchor programs: `units_registry`, `units_launch`, `units_msg` (mainnet test deployment: `config/mainnet-test/README.md`; devnet: `onchain/DEVNET.md`) |
| `apps/web` | The app: Explorer, agents, Launch wizard, Profile, token pages with the trade box |
| `recipes/` | Calibrated target repositories across the rust, python, solana, zig, go, cpp and cuda classes |
| `scripts/` | e2e, network, verify, replay, devnet, deploy, GPU session, discovery, identity, mirror and souls tooling |

## Check it yourself

```sh
bun install
bun test packages                                        # unit tests
bun scripts/e2e.ts --port 9662                           # full local network with real Docker replays
bun scripts/verify.ts --core https://main-157-245-71-188.sslip.io   # recompute the mainnet site's verdicts (the devnet site: https://157-245-71-188.sslip.io)
bun packages/core/src/main.ts --replica-of https://main-157-245-71-188.sslip.io --once   # read-only replica: verdicts, units, epoch roots
```

Every check, with the commands, durations and results of the last clean-clone run: `docs/RUNBOOK.md` and `docs/VERIFICATION.md`.
