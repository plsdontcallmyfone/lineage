# Public devnet site: deploy

One public Linux server runs Core in devnet chain mode, the dashboard and the Wallet page, so anyone
can browse units, watch the live wall, recompute verdicts (`scripts/verify.ts --core https://<site>`)
and use the devnet wallet flows (faucet, launch, bond, claims, bounties). Everything is devnet and every
amount is a TEST value. The kit is `scripts/deploy/`; one command brings a fresh box up and the same
command is safe to run again:

```sh
scripts/deploy/deploy.sh <server IPv4>
```

## What the owner provides

| What | Why |
|---|---|
| A fresh Ubuntu 24.04 server, amd64 is fine (see "Size and cost") | runs everything |
| Root SSH with the key `~/.ssh/lineage_site` (or `SSH_KEY=<path>`) | deploy.sh logs in as root; provisioning copies root's authorized key to the `lineage` user |
| Optional: a domain whose A record points at the server (`DOMAIN=lineage.example`) | served next to `<ip-with-dashes>.sslip.io`, which needs no DNS |
| Optional: `ACME_EMAIL=<email>` | Let's Encrypt expiry notices |
| On this machine: `~/.config/lineage/devnet/core-authority.json`, `faucet.json`, `~/.config/lineage/devnet-deployer.json` | already here (devnet wiring lane); see "Secrets" |
| Optional: `WITH_AUTHOR=1` and `AUTHORS=<recipes>` (default `minbpe`) | one TEST author agent per listed recipe submits its prepared candidates (`recipes/<name>/candidates`) on the site (real verdicts, no model spend); launch the agents first with `bun scripts/deploy/site-authors.ts --recipes <same list>` (see "The full unit set") |
| `WITH_RUNTIME=1` and `~/.config/lineage/model.env` | the hosted runtime authors with Claude; spends real money, at most 10 USD of model usage per UTC day across all hosted agents (owner decision 2026-10-09; see "Hosted runtime") |

No DigitalOcean token is needed: create the droplet in the console (Ubuntu 24.04, add the public half
of `~/.ssh/lineage_site`), then run deploy.sh with its address.

## What the kit does

`deploy.sh <host>` (mode `full`) runs, in order:

1. **provision** (`provision.sh`, idempotent, as root): base packages; user `lineage` (no password, no
   sudo, root's authorized key); ufw deny incoming except 22, 80, 443; fail2ban for sshd; unattended
   upgrades; sshd keys only; journald capped at 500 MB; a 4 GiB swapfile when RAM is under 8 GiB;
   Docker (`docker.io` from Ubuntu, `lineage` the only user in the docker group); Bun 1.3.13 checked against the
   release's SHASUMS256.txt; Caddy from the Caddy project's apt repository (memory cap 256 MB).
2. **ship**: `git bundle` of HEAD (the repo has no remote; the working tree never ships; `DEPLOY_REF=<commit>`
   ships an ancestor), cloned on the server into `/opt/lineage/releases/<sha>` as `lineage`, then
   `bun install --frozen-lockfile`.
3. **sandbox images and amd64 calibration**: builds the images the served recipes use
   (`lineage/rust:m1`, `lineage/python:m1` for the default set) from `images/<class>` on the server, then
   `arch-recipes.ts` re-pins `fixture-b58`, `base58-py`, `minbpe` (or `UNITS_RECIPES`) in that release
   only: `requires.arch` to the server's arch and the image pin to the image id built there. Why: the
   committed recipes pin arm64 image ids measured on an Apple M4; cachegrind counts and image ids differ
   on amd64, so an amd64 reference runner and amd64 verifiers can only serve recipes calibrated on amd64.
   The re-pinned recipe has a new recipe id, so the site has its own units, calibrated on the server
   by its reference runner (step 6). Images are never rebuilt with `--pull`, so their ids, the recipe ids
   and the units stay the same across deploys. An arm64 server (not offered by DigitalOcean; Hetzner
   CAX, AWS Graviton) whose images match the committed ids keeps the recipes as committed.
4. **keys** (see "Secrets"): makes the site's own keys on the server and copies only the keys the
   server needs from this machine, checked by public key first.
5. **fund and chain**: `fund-site.ts` runs here (the deployer key stays here): SOL and UNITS to the
   site's verifier owner, SOL to the Core authority. Then `site-chain.ts` on the server registers the
   site's reference runner and two verifiers on devnet (`register` with the server's capabilities digest,
   `bond` min_bond for the two verifiers), owner = the site's owner key. Every transaction is appended
   to `scripts/deploy/SITE-DEVNET.md`.
6. **activate** (ordering: "Zero-downtime activate" below): backs up Core's database online (when the
   release changes), writes `/var/lib/lineage/site/network.json` (config/network.json plus the devnet
   `chain` block, daily epochs), sets up the service users and gives each its files (see "Service
   users"), installs the units, the timers and the Caddyfile, tells the background units to drain,
   switches `/opt/lineage/current`, restarts the public units one by one with a health check each (a
   failed check rolls the release back), then queues `lineage-bootstrap` (recipes, snapshots, reference
   flag, calibrations: minutes per recipe) and the workers on the new release.

| Unit | What | User | Listens | Memory cap |
|---|---|---|---|---|
| `lineage-core` | Core, chain mode devnet, data `/var/lib/lineage/core` | `lineage-core` | 127.0.0.1:9660 | 1 GB |
| `lineage-web` | dashboard, Wallet page, `/chain` RPC proxy and faucet | `lineage-web` | 127.0.0.1:9661 | 768 MB |
| `lineage-gate` | rate limits, CORS, method and path allowlists, body cap and read deadline, stream cap (`gate.ts`) | `lineage-gate` | 127.0.0.1:9662 | 1 GB (256 MB was OOM-killed on an event-stream backlog) |
| `lineage-indexer` | market indexer (`packages/indexer`): agent tokens, DBC and DAMM v2 trades, fee cranks, holders; read API `/market/*`; data `/var/lib/lineage/indexer/market.db` | `lineage-indexer` | 127.0.0.1:9668 | 256 MB |
| `lineage-identity` | GitHub identity service (see its section) | `lineage-identity` | 127.0.0.1:9665 | 256 MB |
| `caddy` | HTTPS for `<ip-dashes>.sslip.io` and `DOMAIN`, gzip, security headers (CSP, HSTS, nosniff, frame DENY, Permissions-Policy, COOP); everything to the gate | `caddy` | 80, 443; admin on a unix socket | 256 MB |
| `lineage-bootstrap` | one shot per deploy: units for the served recipes | `lineage` | | 1 GB |
| `lineage-reference` | reference runner (calibrations, reference replays, audits) | `lineage` | | 1 GB |
| `lineage-verifier@v1`, `@v2` | two honest verifiers, bonded on devnet | `lineage` | | 1 GB each |
| `lineage-author@<name>` (optional, one per name in `AUTHORS`) | TEST author agent of recipe `<name>`, scripted candidates | `lineage` | | 1 GB each |
| `lineage-runtime` (optional, disabled) | hosted runtime (`packages/runtime`) | `lineage` | | 1 GB |
| `units-backup.timer` | hourly Core snapshot (see "Backups") | `lineage-core` | | 512 MB |
| `lineage-backup-state`, `lineage-backup-identity` (started with `lineage-backup`) | hourly secrets+state snapshot, age-encrypted (see "Backups") | `lineage`, `lineage-identity` | | 512 MB each |
| `units-monitor.timer` | checks every 5 minutes, alerts (see "Monitoring") | `lineage-monitor` | | 256 MB |

Only `lineage` is in the docker group: it runs the sandboxes and everything that starts containers. Every
other unit has its own system user with no shell, no home and no docker (see "Service users"). Core, the
gate, the dashboard and the indexer run with systemd sandboxing on top of `NoNewPrivileges`:
`ProtectSystem=strict` with only their data directory writable, private devices, kernel and cgroup
protection, no namespaces, no capabilities, `AF_INET`/`AF_INET6`/`AF_UNIX`/`AF_NETLINK` only and the
`@system-service` syscall set; the gate, the dashboard and the indexer cannot see `/home`, Core sees it
read only with `~lineage/.config` hidden. Check a unit with `systemd-analyze security <unit>`.

The worker caps cover the Bun processes. Sandboxes run under dockerd with each recipe's own limits
(`limits` in `recipe.yml`: 2 CPUs and 2048 MB for the default recipes), outside the unit caps.

Public surface (the gate refuses everything else before it reaches Core or the dashboard):

| Path | Methods | Limit per client address | CORS |
|---|---|---|---|
| `/v1/*` except `/v1/admin/*` | GET, HEAD | 120 per minute, burst 60 | `*` |
| `/api/*`, `/live/*` (not `/api/admin*`, no encoded slashes or `//`) | GET, HEAD | 240 per minute, burst 120 | `*` |
| `/v1/bounties/:id/terms`, `/api/bounties/:id/terms` | PUT | 10 per minute | `*` |
| `/chain/rpc` | POST (web keeps its method allowlist) | 120 per minute, burst 40 | same origin only (Origin header required) |
| `/chain/faucet` | POST (web keeps its per-wallet 24 h and 30 per hour limits) | 3 per hour | same origin only (Origin header required) |
| pages and assets | GET, HEAD | 600 per minute | none |
| event streams (`/live/events`, `/api/events`, `/v1/events`) | GET | 4 open per address, 400 in all | |
| `/market/*` (gate to `lineage-indexer`) | GET, HEAD, OPTIONS (the indexer answers its own preflight) | 240 per minute, burst 120 | the indexer's (`*` unless `UNITS_CORS_ORIGINS`) |
| `/souls/*` | refused (405): drafts spend the model key, and opening them on the site is an owner decision | | |

"Per client address" means per IPv4 address or per IPv6 /64 (an IPv4-mapped address counts as its IPv4); the gate holds at most 50,000 buckets (least recently used evicted). A stream slot is reserved before the upstream answers. Upstreams see one `X-Forwarded-For` and no `Forwarded`, `X-Real-IP`, `Cookie` or `Authorization` from the client. Bodies over 64 KB are refused by the gate as soon as they pass the cap (256 KB by Caddy), and a body must arrive within 10 s (408). Core's write API is not public on this
site: outside workers cannot join through it (open `POST /v1/*` in `gate.ts` when they should).

### Market indexer (launchpad L2)

`lineage-indexer` runs `bun packages/indexer/src/main.ts --port 9668 --host 127.0.0.1 --db
/var/lib/lineage/indexer/market.db --interval 15` as `lineage-indexer` (remote.sh makes its data directory).
It is one of the core units in `remote.sh` (enabled, restarted and stopped with Core, the dashboard and
the gate), sends nothing on chain and holds no key. RPC: the chain resolver
(`packages/chain/src/endpoint.ts`): `UNITS_DEVNET_RPC` from `/etc/lineage/indexer.env` (remote.sh
writes it from `HELIUS_DEVNET_RPC` in `~lineage/.config/lineage/rpc.env`, copied only when it exists on
this machine), else public devnet. It never prints the URL (`/market/status` shows the host only). Sources per token:
its DBC pool, its DAMM v2 pool after migration, its mint and its `AgentLaunch` account; a quiet source
is polled less often (doubling up to `--max-idle`, 300 s) and `logsSubscribe` makes a token's sources
due again when it sees activity. On public devnet (2026-10-09, 34 tokens) a first backfill took about 4
minutes and a pass about 2.5 minutes, most of it 429 backoff; a keyed RPC is faster. Public devnet
refuses `getProgramAccounts` on Token-2022, so holders there are the latest balances of every token
account seen in an indexed transaction (`source: "transactions"` in `/market/tokens/:mint/holders`;
a legacy plain `transfer`, which does not name the mint, is missed); a keyed RPC that serves it gives
the account list (`source: "accounts"`). The database is derived data: deleting it
and restarting rebuilds it from chain. Check after a deploy:

```
curl -s https://<site>/market/status | jq '{ok, tokens, trades, rpc}'
```

## Secrets

Never printed by any script; keys are compared and reported by public key only. Every key file on the
server is mode 600 in a mode 700 directory, owned by the one service user that uses it.

| File on the server | Public key | Origin | Used by |
|---|---|---|---|
| `~lineage/.config/lineage/site/admin.json` | made on the server | `site-keys.ts` | bootstrap; a copy in `/etc/lineage-core/admin.json` (owner `lineage-core`) is Core's `--admin-key` (only its public half is read) |
| `~lineage/.config/lineage/site/owner.json` | made on the server | `site-keys.ts` | owns the site's verifiers on chain (pays their burn and bond) |
| `~lineage/.config/lineage/site/verifier-{ref,v1,v2}.json` | made on the server | `site-keys.ts` | reference runner and verifiers |
| `/etc/lineage-core/core-authority.json` (owner `lineage-core`) | `CjNUnQ3v2FRQJiMr16CfaFWCdzJ3nqq1VvY2zAgsc4j9` | copied from this machine | Core's chain bridge: `post_epoch`, `slash`, `migrate_agent` |
| `/var/lib/lineage/web/.config/lineage/devnet/faucet.json` (owner `lineage-web`) | `FX4UjRbmbLHJ6K6RTvYcV4bFA9Yai2qntnPNex31GiH6` | copied | the Wallet page's UNITS faucet |
| `~lineage/.config/lineage/devnet/agent-<name>.json` (WITH_AUTHOR=1, each name in `AUTHORS`) | minbpe `BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV`; the others as `site-authors.ts` printed them | copied | `lineage-author@<name>` |
| `~lineage/.config/lineage/devnet/runtime-authority.json` (WITH_RUNTIME=1) | `DCmdy5MoAfnN6fn3nVW27db62ZwtjoksqSqdjAc8VPk4` | copied | `lineage-runtime` (Core only gets the public key file `runtime-authority.pub`) |
| `~lineage/.config/lineage/model.env` (WITH_RUNTIME=1) | | copied | `lineage-runtime` |
| `~lineage/.config/lineage/rpc.env` (only if it exists here) | | copied | workers, runtime, status; remote.sh copies its URL into `/etc/lineage-core/network.json` (Core), `/etc/lineage/web.env` (dashboard, with the soul drafter's `ANTHROPIC_API_KEY` from `model.env`) and `/etc/lineage/indexer.env`, all root or service-user owned, mode 600 |

The devnet deployer key (`CVEZW...`, registry and launch admin, upgrade authority) never leaves this
machine. A key already on the server with a different public key is never replaced (deploy stops).
Core's chain bridge uses the keyed RPC from `rpc.env` when it is on the server, and the public devnet RPC
otherwise. Core publishes `chain.rpc_url` at `GET /v1/chain` redacted to its host.

**One Core authority at a time.** The site's Core holds the registry's Core authority key and posts
every epoch it closes (daily), oldest first, never at or before the chain's last epoch. While the site
runs, `scripts/devnet/e2e-devnet.ts` on this machine (which posts epochs with the same key) races it:
whichever posts epoch N first wins and the other's epoch N is refused. Stop the site's Core
(`deploy.sh <host> stop`) for the duration of a devnet e2e run, or run the site read only (delete
`/etc/lineage-core/core-authority.json` on the server and activate again; its Core then only reads). The same holds for the runtime
authority: run `lineage-runtime` on the site or on this machine, not both.

## The full unit set (FINISH W3)

Deployed 2026-10-08 with:

```sh
bun scripts/deploy/site-authors.ts --recipes base58-py,base58-rs,bitcoin-base58,geth-rlp,lc-text-splitters,ollama-tokenizer,solana-config,zig-clap
UNITS_RECIPES=fixture-b58,base58-py,minbpe,base58-rs,bitcoin-base58,zig-clap,fixture-zigsize,fixture-cu-tally,solana-config,lc-text-splitters,ollama-tokenizer,geth-rlp \
WITH_AUTHOR=1 AUTHORS=minbpe,base58-py,base58-rs,bitcoin-base58,zig-clap,solana-config,lc-text-splitters,ollama-tokenizer,geth-rlp \
  scripts/deploy/deploy.sh 157.245.71.188 code
```

Keep geth-rlp last in `UNITS_RECIPES`: lineage-bootstrap calibrates in list order, and geth-rlp alone takes
about 53 minutes there. The 12 non-CUDA recipes are the ones above. The CUDA recipes need a GPU server
(docs/GPU-SESSION.md).

**amd64 changes, made in the deployed release only** (`arch-recipes.ts`; the committed arm64 recipes are unchanged):

| Recipe | Change | Why |
|---|---|---|
| geth-rlp, ollama-tokenizer | `scripts/deploy/amd64/<name>/lineage/*/entry_amd64.s` copied into the overlay | the harness links `-E=main.lineageEntry`; only an arm64 entry stub was committed |
| bitcoin-base58 | `scripts/deploy/amd64/bitcoin-base58/lineage/Makefile` (adds `-DDISABLE_OPTIMIZED_SHA256`) | on x86_64, sha256.cpp references SSE4/AVX2/SHA-NI units the build does not compile (link error); keeps the portable transform, as arm64 uses |
| zig-clap, fixture-zigsize | `scripts/deploy/amd64/<name>.replace.json`: `-target aarch64-linux-musl` becomes `x86_64-linux-musl` | the aarch64 test and bench binaries cannot run on amd64 |

`images/go` and `images/solana` gained an amd64 branch (Go tarball and platform-tools-linux-x86_64 sha256s);
their arm64 path is unchanged.

**Images built on the server** (`docker build`, measured): cpp 63 s (162 MB), go 78 s (169 MB), zig 176 s
(158 MB), solana 583 s (607 MB); rust and python were already there. Every later deploy reused all six by
their `lineage.build-hash` label.

**Calibration on the server** (5 runs, by lineage-bootstrap; the full records are in
`recipes/<name>/calibration-amd64.json`, read back from Core):

| Recipe | Bootstrap wall | Median evaluation | Largest metric cv |
|---|---|---|---|
| base58-rs | 13 s | 9 s | 0 |
| bitcoin-base58 | 52 s | 48 s | 0 |
| zig-clap | 36 s | 44 s | 2.2e-7 |
| fixture-zigsize | 5 min 0 s | 309 s | 0 |
| fixture-cu-tally | 11 s | 10 s | 0 |
| solana-config | 2 min 2 s | 201 s | 0 |
| lc-text-splitters | 6 min 43 s | 138 s | 1.0e-5 |
| ollama-tokenizer | 8 min 9 s | 239 s | 4.8e-6 |
| geth-rlp | 53 min 2 s | 1348 s | 4.5e-5 |

**geth-rlp cadence.** One geth-rlp evaluation takes about 22.5 minutes on this 4 vCPU droplet (1348 s
median), 75% of the recipe's `wall_s` of 1800. Each candidate needs that once per replayer, and each
verifier's qualification needs it once. The three workers can run in parallel, but three 2-CPU sandboxes
oversubscribe the 4 vCPUs. So a geth-rlp verdict takes about half an hour, and its 4 prepared candidates
keep the workers busy for roughly two hours. That is acceptable for a TEST site. A busier site should
move to the 8 vCPU plan before wall_s becomes the limit.

**Authors.** Chain mode only lets a launched agent author on units of the repository named at launch
(`target_repo`), so each repository has its own TEST author agent. `site-authors.ts` launched them on
devnet, funded each compute vault above Core's wake threshold (2,500 UNITS, TEST), and called
refresh_awake. Every transaction is in `scripts/deploy/SITE-DEVNET.md`. fixture-zigsize has candidates but
no author: its repository `fixture:zigsize` is not an https URL, so `launch_agent` refuses it.

**Server resources** (measured after the deploy, 2026-10-08): 4 vCPU, 7,941 MiB RAM and no swap (the
4 GiB swapfile is only made under 8 GiB RAM). Docker images 10.0 GB, build cache 7.5 GB, disk 140 GB free of
154 GB, 6,694 MiB available with everything running. Everything fits. The limit is CPU time (see geth-rlp
cadence), not disk or memory.

**W9c recipes (2026-10-09).** The 9 recipes bip39-py, bip39-go, btcd-bech32, llama2c, subword-nmt,
hmac-sha256-rs, zig-charm, md5-rs and pyrlp were added in one deploy, each with its own author agent
(`site-authors.ts`). The amd64 changes follow the same pattern as above: entry_amd64.s for bip39-go and
btcd-bech32, and `-target x86_64-linux-musl` for zig-charm. Calibration by lineage-bootstrap:

| Recipe | Bootstrap wall | Median evaluation | Largest metric cv |
|---|---|---|---|
| bip39-py | 2 min 53 s | 67 s | 1.6e-8 |
| bip39-go | 8 min 48 s | 341 s | 1.8e-4 |
| btcd-bech32 | 3 min 59 s | 209 s | 4.2e-5 |
| llama2c | 52 s | 38 s | 0 |
| subword-nmt | 2 min 2 s | 46 s | 4.3e-9 |
| hmac-sha256-rs | 1 min 32 s | 148 s | 0 |
| zig-charm | 1 min 20 s | 105 s | 0 |
| md5-rs | 3 min 1 s | 85 s | 0 |
| pyrlp | 4 min 0 s | 90 s | 6.8e-8 |

**Keyed RPC.** When `~/.config/lineage/rpc.env` exists on the deploying machine, deploy.sh copies it to the
server (mode 600). `site-config.ts` then writes the resolved keyed URL into network.json, which is mode 600
for that reason, so Core's chain bridge, the dashboard and lineage-indexer all use it. Core publishes the
URL only redacted, as `https://devnet.helius-rpc.com (keyed)`.

**Deploy hazards found** (fixed in the kit):
- Verifiers and authors used to be ordered after lineage-bootstrap. While a long calibration ran they
  were held back, Core assigned them a replay they never committed, and the abandon strikes suspended both
  verifiers for the epoch. They now start without waiting; only lineage-reference still waits.
- Never submit a candidate by hand while the verifiers are stopped or draining.
- Workers older than 098ba4f could hang on SIGTERM (a Core request with no timeout) until TimeoutStopSec,
  which is now 45 minutes so that a running geth-rlp replay can finish. Check that the stopping workers have
  no job (`docker ps`) and an empty `pending.json` before killing them by PID.
- Core used to exclude an agent that abandoned a candidate from it forever, so with only two verifiers six
  candidates stuck in `replaying`. Since a48258d the exclusion lasts only until that epoch ends.
- A deploy restarts the scripted authors from the top of their lists, so a candidate still queued at that
  moment is submitted again and rejected as `duplicate`. This is harmless.

## Hosted runtime

Owner decision 2026-10-09: the site runs `lineage-runtime` (packages/runtime, SPEC 17.2), so hosted
launched agents author as real Claude agents, with a global cap of **10 USD of model spend per UTC
day** across all of them. Each agent is further limited by its compute vault (at the published TEST
price), `attempt_max_usd` and `agent_epoch_max_usd`.

`site-config.ts` rewrites `/var/lib/lineage/site/runtime.json` (mode 600) on every install and
activate; a differing previous file is kept as `runtime.json.prev`. The values:

| Key | Value | Meaning |
|---|---|---|
| `global_max_usd`, `global_window_s` | 10, 86400 | at most 10 USD per window; windows are aligned to the Unix epoch, so 86400 is one UTC day and the counter resets at 00:00 UTC. The counter is in the state file (`window`, past windows in `windows`), so a restart keeps it. An attempt's unspent reserve counts against the window while it runs. Without `global_window_s` the cap is a lifetime cap. |
| `attempt_max_usd` | 0.5 | one authoring attempt |
| `agent_epoch_max_usd` | 2 | one agent per usage epoch |
| `compute_price_line_per_usd`, `compute_price_line_per_sandbox_s` | 20, 0.002 | TEST prices of the compute vault debit |
| `max_concurrent` | 1 | attempts at once |
| `rpc_url` | not set | resolved like Core: the keyed `rpc.env` when present, else public devnet |

Secrets (`WITH_RUNTIME=1`, modes `full`, `keys` and `code`): `runtime-authority.json` (public key
checked against `scripts/devnet/devnet.json`, which must equal `LaunchConfig.runtime_authority` on
chain) and `model.env` (refused unless it holds `ANTHROPIC_API_KEY`) are copied over ssh stdin to
`~lineage/.config/lineage/`, owned by `lineage`, mode 600, in mode 700 directories. Neither is
printed (public key and byte count only); the runtime redacts the key from every log line. Since the
service users (OFF-D10) only the units running as `lineage` (workers, runtime) can read these files; the
dashboard's soul drafter gets the model key alone, through `/etc/lineage/web.env`.

Binding an agent. The runtime makes its own signing key per discovered hosted agent and runs only the
agents whose owner rotated the agent's key to it (identity plan I1). The owner signs `rotate_agent_key`
on the Wallet page (Identity tab); the runtime co-signs and sends it on the server:

```sh
ssh -i ~/.ssh/lineage_site root@<host> "runuser -u lineage -- env HOME=/home/lineage bash -c 'cd /opt/lineage/current && bun packages/runtime/src/main.ts bind-request --config /var/lib/lineage/site/runtime.json --agent <id>'"
ssh ... "runuser -u lineage -- env HOME=/home/lineage bash -c 'cd /opt/lineage/current && bun packages/runtime/src/main.ts cosign --config /var/lib/lineage/site/runtime.json --agent <id> --tx <base64>'"
```

The cap and its counter:

```sh
ssh ... "runuser -u lineage -- env HOME=/home/lineage bash -c 'cd /opt/lineage/current && bun packages/runtime/src/main.ts status --config /var/lib/lineage/site/runtime.json' | jq .cap"
ssh ... journalctl -u units-runtime | grep -E 'started|attempt|spend window|global runtime cap'
```

**Enabled 2026-10-09** (release 560a569, `WITH_RUNTIME=1` with the recorded 21 recipes and 18 authors). TEST agent
`6C8N2z5L...` was bound to the site runtime (rotate in `scripts/deploy/SITE-DEVNET.md`). First hour: 9 Claude
attempts, 7 candidates on minbpe (first one, session `8ca556454a56...`, accepted train_ir 0.7683; 4 accepted, 3
rejected so far), sessions live at `/sessions` with navigation events, edits sealed until the verdict and replayed
after it. Usage epoch 1 debited 42,090,400 base units (1.9892 USD, 754,904 tokens, 1,153 sandbox s) from its vault
(2,500,000,000 to 2,457,909,600). The per-agent epoch cap (2 USD) stopped it inside that epoch; the day's counter
read 2.2473 of 10 USD at 23:23 UTC. In chain mode `GET /v1/agents/:id/usage` stays empty (the record is on chain:
`UsageEpoch` and `DebitReceipt`); Core's `compute` follows the vault.

Run the runtime authority on the site only: a local `scripts/runtime/devnet-run.ts` with the same key
races its usage epochs.

## Agent desktops

SPEC 17.7. With `WITH_RUNTIME=1`, `remote.sh install` builds `lineage/desktop` from `images/desktop` (reused while
its build inputs are unchanged) and `runtime.json` gets:

| Key | Value | Meaning |
|---|---|---|
| `desktop_required` | true | every attempt needs its own live desktop; with none free the attempt waits (status `waiting for a desktop: ...`) and is retried after `attempt_gap_s` |
| `desktop_hosts_file` | `~lineage/.config/lineage/desktop-hosts/hosts.json` | dedicated desktop hosts, used first (see Desktop hosts below); re-read every minute |
| `desktops_max` | 2 | desktops on this server at once (each capped at 1.5 CPUs and 1.5 GB) |
| `e2b_max` | 6 | E2B Desktop overflow at once (6 hosted agents bound on 2026-10-10), only when `e2b.env` holds a key |
| `desktop_usd_per_day` | 16 | E2B time per UTC day; at the cap no new E2B desktops start. 4 E2B desktops all day cost 15.90 USD |
| `e2b` | template `lineage-desktop`, 2 vCPU, 4 GiB | built by `packages/desktop/scripts/e2b-template.ts`; 0.1656 USD per desktop-hour (e2b.dev/pricing read 2026-10-10). The stock `desktop` template is 8 vCPU, 8 GiB: 0.5328 USD per desktop-hour |
| `desktop_allow` | github.com, githubusercontent.com, githubassets.com | hosts a desktop's browser may reach |

The runtime serves the live stream on its bind port (9667) at `/desktops/<session>/*`; the gate forwards it.
`deploy.sh` copies `~/.config/lineage/e2b.env` (mode 600, never printed) only when it holds `E2B_API_KEY`.
The desktop containers and the allowlist proxy (`lineage-desk-proxy`) carry the label `lineage=1`.
State: `/var/lib/lineage/runtime/desktops` (stream directories, the session map, held recordings,
`e2b-spend.json`).

### Desktop hosts

Owner decision 2026-10-10: desktops run on dedicated desktop servers we run, with E2B as overflow.
New desktops go to the least loaded healthy desktop host, then to this server's 2 slots, then to E2B.

**What the owner creates:** a fresh Ubuntu 24.04 droplet (for example DigitalOcean, in the site's region),
with the owner's ssh key for root, then runs from this repo:

    scripts/deploy/desktop-host/provision.sh <droplet-ip>

It reaches the droplet through the site (`JUMP`, default the site; after the firewall only the site can
reach it) and, idempotently:
- installs Docker, python3 and ufw; makes the `lineage-desk` user (docker group, locked password) whose
  key runs only `/usr/local/bin/lineage-desk-gw`;
- builds `lineage/desktop` on the host from `images/desktop` (rebuilt only when that tree changed) and
  starts the internal network `lineage-desk` and the allowlist proxy `lineage-desk-proxy`;
- turns off password logins and sets ufw to deny all incoming except ssh from the site;
- on the site: makes the runtime's key `~lineage/.config/lineage/desktop-hosts/id_ed25519`, records the
  host's own host key (read over the owner's root ssh) in `known_hosts` there, measures the host
  (`lineage-desk-gw health`) and registers it in `hosts.json` with `desktops_max` from
  `packages/desktop/src/placement.ts` `hostCapacity`;
- checks from the site with the runtime's key: `health` answers, a command outside the gateway is refused.

The running runtime picks the host up within a minute (no restart). `provision.sh <ip> update` redoes only
the gateway, the image and the proxy: run it after `images/desktop` changes (the site's own image is
rebuilt by `deploy.sh`). `bun scripts/deploy/desktop-host/register.ts --file <hosts.json> --remove <name>`
takes a host out (its running desktops finish; run it as `lineage` on the site).

Capacity per host (`hostCapacity`): one desktop measured 38 % of a core mean and at most 635 MiB on the site
(SPEC 17.7); keep 1 vCPU and 1 GiB for the host, plan CPU at 70 % of its mean and memory at 1.25 times
the peak. A 4 vCPU / 8 GiB droplet gives 5 desktops (CPU bound), 8 vCPU / 16 GiB gives 12.

Failure: hosts are health-checked every 15 s over the runtime's multiplexed ssh connection. A host that
does not answer takes no new desktops; desktops already on it end their live stream (the gate answers
410) and their attempts go on. When it answers again, it takes new desktops; desktops a crashed runtime
left on a host are removed on the first good check.

The site's key and known_hosts for desktop hosts are not in the state backup: after restoring a site,
re-run `provision.sh <ip>` for each host.

Dry run: `scripts/deploy/desktop-host/dryrun.sh` (a privileged systemd Ubuntu 24.04 container with its own
Docker plays the droplet, this machine plays the site; port 9665): provisions twice and updates, checks
the gateway and the firewall, runs a scripted attempt on a desktop on the host through the real gateway
with its stream pulled and served (latency measured), and pauses the host mid-attempt. Results in
`scripts/deploy/desktop-host/DRYRUN-LAST.json`.

## GitHub identity service

`lineage-identity` (packages/identity, SPEC 13.9 "Identity service") runs as the dedicated user
`lineage-identity`, not in the docker, sudo or unit groups. It listens on 127.0.0.1:9665, and Caddy routes
`/identity/*` to it directly, so a pasted token never passes the gate or Core. `remote.sh activate`
sets it up idempotently:

- makes the user;
- gives `/var/lib/lineage` traverse-only permission for others (`o+x`; every directory under it keeps its own mode);
- makes `/var/lib/lineage/identity` and `/etc/lineage-identity` (both mode 700);
- makes the 32-byte key `master.key` once on the server (it is never copied anywhere);
- writes `identity.env` with the keyed RPC from unit's `rpc.env`;
- copies the site admin key to `core-key.json` (Core accepts PR records from it).

`units-identity-cycle.timer` runs the mirror and PR bot cycle every 5 minutes as the same user.

| What | Where |
|---|---|
| Encrypted records (reserve, credentials, status, published commits) | `/var/lib/lineage/identity/records/<kind>/<id>.enc`, mode 600 |
| Key file | `/etc/lineage-identity/master.key`, mode 600 |
| Signing keys while git signs | `/run/lineage-identity*` (tmpfs, mode 700, removed after use) |
| Status | `https://<site>/identity/health`, `/identity/agents/<id>` |

The reserve is topped up from this machine; only logins are printed:

```sh
bun scripts/identity/push-reserve.ts --host <server> [--target 5] [--plan]
```

It first copies the server's assignments back into `~/.config/lineage/github-pool.json`. Accounts it
pushes are marked `server_reserve` there. Launches made before the service first started are never
acted on. Back up `/var/lib/lineage/identity` and the key file together; one without the other cannot
be read. Note that `lineage` is in the docker group, so it is root-equivalent on this box: the separate
user keeps the tokens out of the units' and sandboxes' reach and out of their logs, but it does not
protect them from an operator with root.

## Day to day

```sh
scripts/deploy/deploy.sh <host> status            # units, memory, Core health, chain read, vaults, verifiers, faucet, SOL, disk
scripts/deploy/deploy.sh <host> code              # ship HEAD and activate it
scripts/deploy/deploy.sh <host> fund              # top up and re-register (idempotent)
ssh -i ~/.ssh/lineage_site root@<host> journalctl -u units-core -f
```

`status` prints the Core authority's and the site owner's SOL, the faucet's SOL and UNITS, and the
registry vaults as Core last read them. Top-ups: `fund` (site owner, Core authority from the deployer),
`apps/web/scripts/fund-faucet.ts` (faucet). Private canaries go in `/var/lib/lineage/canaries/<recipe name>/`
(Core rereads it every 60 s); without them the site injects none.

## Roll back

```sh
scripts/deploy/deploy.sh <host> rollback              # previous release, data kept
scripts/deploy/deploy.sh <host> rollback --with-data  # also restores the Core database backed up when the current release was activated
scripts/deploy/deploy.sh <host> code                  # forward again (or DEPLOY_REF=<commit>)
```

Each activation of a new release backs up `core.db` (`VACUUM INTO`, taken online while the old Core
still serves, so writes in the seconds before its restart are not in it) to `/var/lib/lineage/backups/`
(last five kept). `rollback` uses the activate ordering below (public units one by one, background
units draining without holding them); with `--with-data`, or back to a release from before the service
users, the public units are stopped first because the data or its owners change. Core's migrations only go forward, so roll back with `--with-data` when the newer
release added a migration; the data replaced by the restore is kept next to the backups.

## Zero-downtime activate

Incident 2026-10-10 19:42 to about 20:28 UTC: activate for 5fc3208 ran one `systemctl stop` over the
runtime, the authors, the verifiers and the public units together. `lineage-verifier@v2` was draining a
long replay (TimeoutStopSec 45 min) and systemctl waited for it, with web, gate and indexer already
stopped: the whole site answered 502 for about 45 minutes. Since then `remote.sh activate` keeps the two
kinds of unit apart:

1. **Stage** while the old release serves: site config, unit files, service users and keys, an online
   copy of `core.db`, the Caddyfile (validated, the previous one kept as `/etc/caddy/Caddyfile.prev`),
   then a graceful Caddy reload.
2. **Background units drain, no wait**: every running `lineage-runtime`, `lineage-author@*`,
   `lineage-reference` and `lineage-verifier@*` gets `systemctl stop --no-block`. Each drains as before:
   a worker finishes and commits the replay it is running, takes no new assignment and reveals what it
   committed (`packages/worker`, `drain()`); the runtime waits for its running attempts.
   `lineage-identity-cycle` (a oneshot on a timer) is left to finish on its own.
3. **Public units, one by one**: `/opt/lineage/current` switches, then `lineage-core`, `lineage-indexer`,
   `lineage-identity`, `lineage-web`, `lineage-gate` restart in that order, each waiting for its health
   URL (`/v1/health`, `/market/summary`, `/identity/health`, `/live/status`, `/gate/health`) for up to
   `DEPLOY_HEALTH_WAIT` seconds (default 180: on a fresh box Core reads the chain for over 90 s before it listens). A failed check rolls back: current points at the previous
   release again, its units, network config and Caddyfile go back in place, the public units restart on
   it, `previous` is left as it was, and the deploy exits 1.
4. **Background starts queue on the new release**: `systemctl start --no-block` for the workers, the
   wanted authors and the runtime (and any other verifier instance that was running). For a unit still
   draining, systemd runs the start only after the old process has exited: one unit never has two
   processes, so a verifier on the new release cannot run a replay its old process is still running. It
   loads the same `pending.json` and reveals what the old one committed; an assignment the old process
   never committed (killed at TimeoutStopSec) is still `assigned` at Core and runs once on the new release.
5. **Bounded wait**: activate waits at most `DEPLOY_DRAIN_WAIT` seconds (default 120) for the drains,
   prints `DRAINING <unit>` for each one still stopping and returns; `deploy.sh` ends with a
   `still draining:` list (unit, since when, stop timeout). systemd keeps each drain going up to the
   unit's TimeoutStopSec (verifiers and reference 45 min, runtime 25 min, authors 20 min, unchanged).

While a public unit restarts, requests wait instead of failing: Caddy retries a refused dial to the gate
and to the identity service (`lb_try_duration 15s`), the gate retries a refused Core, web or indexer
(`--upstream-wait-ms`, default 15000; `fetchUpstream` in `gate.ts`), and web's `/api/*` and `/market/*`
proxies retry a refused Core or indexer for 15 s. A refused connection never reached the upstream, so
the retry cannot double a write.

Workers mid-request when Core restarts: the worker loop already retries a failed tick, but a commit sent
in the restart window used to fail and lose the replay it was committing. The worker units now set
`UNITS_CORE_RETRY_MS=30000`, so `CoreClient` retries a refused connection (same signed request and
nonce, which Core never saw) until Core is back; it is off (0) everywhere else. Core's own stop closes
open connections (`server.stop(true)`); a commit cut after Core applied it is seen as `committed` on the
next pass and revealed from `pending.json`, one cut before is still `assigned` and is run again.

Caddy older than 2.8 (Ubuntu's package, provision.sh's fallback when the Caddy apt repository refuses)
cannot parse the `|0600` socket mode; activate drops the suffix there (`/run/caddy` is 0750 caddy:caddy
either way) and falls back to a Caddy restart when a reload cannot reach the running Caddy.

A worker that got SIGTERM used to keep taking work: `draining` was set only after its loop returned, so
the tick running at the stop went on to start the next assigned replay (the incident's
`lineage-verifier@v2` revealed at 19:44:41 after its stop and kept working to its 45 min timeout; the
same was seen again at 21:03 to 21:48 UTC). `packages/worker/src/main.ts` now sets it at the signal: the
running job finishes, no new assignment, profile, calibration or authoring step starts, committed
replays are revealed, the process exits (`packages/worker/test/drain-stop.test.ts`). Workers still on an
older release keep the old behaviour until their stop timeout.

A second thing held Core: every worker unit is ordered `After=lineage-core`, so a plain
`systemctl restart units-core` waits until every draining worker has stopped (stop jobs run in reverse
order). The public restarts therefore use `--job-mode=ignore-dependencies`; boot and shutdown keep the
ordering.

Measured (2026-10-10):

| Where | Public units back | Polling `/api/config` during the deploy | Background |
|---|---|---|---|
| dry run (`dryrun.sh`, simulated verifier draining 150 s) | Core 3767 ms, indexer 313, identity 300, web 337, gate 297; all 6 s after activate began | 73 polls every 250 ms: 0 non-200, longest time between two 200 answers 4080 ms, slowest answer 3810 ms | deploy returned after 30 s with the verifier listed as draining; it restarted once on the new release when its old process exited |
| the site, `deploy.sh 157.245.71.188 code` at 3187bf4 | Core 7087 ms, indexer 10047, identity 5590, web 7402, gate 777; all 47 s after activate began | 140 polls every second over the 246 s deploy: 0 non-200, longest time between two 200 answers 8327 ms, slowest answer 7314 ms | runtime and both verifiers still draining when the deploy returned, listed with their stop timeouts |

Before the change the same kind of deploy answered 502 for about 45 minutes. The dry run also checks that
a release whose Core fails its health check is rolled back (`DEPLOY_HEALTH_WAIT=15`, the site answering
again on the previous release).

## Stop

```sh
scripts/deploy/deploy.sh <host> stop        # every lineage unit and Caddy stopped and disabled (site offline, data kept)
scripts/deploy/deploy.sh <host> start
scripts/deploy/deploy.sh <host> wipe-keys   # remove the keys copied from this machine and the keyed RPC URL in network.json
```

To retire the server: `stop`, `wipe-keys`, then destroy the droplet. The site's verifiers keep their
devnet bonds until their owner key (on the server) requests an unbond; back up
`~lineage/.config/lineage/site/` first if those bonds should be recovered.

## Service users (mainnet hardening M4)

Audit OFF-D10. `remote.sh` (`ensure_users` at install, `users_setup` at every activate, idempotent) makes
one system user per service, with no shell, no home and no password, and refuses to continue if any of
them is in the docker, sudo, admin, adm or systemd-journal group:

| User | Units | Reads | Writes |
|---|---|---|---|
| `lineage` (docker group) | bootstrap, reference, verifiers, authors, runtime, `lineage-backup-state` | its keys in `~lineage/.config/lineage` (verifiers, runtime authority, agents, admin), `rpc.env`, `model.env` | sandboxes, mirrors, runtime state |
| `lineage-core` (primary group `lineage`) | `lineage-core`, `lineage-backup` | `/etc/lineage-core/` (700): `core-authority.json`, `admin.json`, `network.json`; the workers' git mirrors and the private canaries through group `lineage` | `/var/lib/lineage/core`, `/var/lib/lineage/core-backups` |
| `lineage-web` | `lineage-web` | `/etc/lineage/web.env` (keyed RPC, soul drafter's model key; root 600, read by systemd); `/var/lib/lineage/web/.config/lineage/devnet/faucet.json` | `/var/lib/lineage/web` (faucet log, soul drafts) |
| `lineage-gate` | `lineage-gate` | nothing but the release | nothing |
| `lineage-indexer` | `lineage-indexer` | `/etc/lineage/indexer.env` (keyed RPC) | `/var/lib/lineage/indexer` |
| `lineage-identity` | identity service and cycle, `lineage-backup-identity` | its own store and key (section above) | `/var/lib/lineage/identity`, `/var/lib/lineage/identity-backups` |
| `lineage-monitor` | `lineage-monitor` | health endpoints, unit states, snapshot ages, `/etc/lineage/monitor.env` | `/var/lib/lineage-monitor` |

The Core authority key and the faucet key are moved out of `lineage`'s home on the first activate
(shredded there) and `deploy.sh keys` copies them straight to their new owners afterwards, so the user
that runs untrusted sandboxes no longer holds a key that posts epochs or pays out UNITS. Core's and the
indexer's data keep group `lineage` (mode 0770, Core with `UMask=0007`), so if a release from before the
service users is activated again the site still runs: `remote.sh rollback` to such a release copies the
two keys back to `lineage` and turns the new timers off; a plain `deploy.sh code` of such a release runs
Core without its key (it reads the chain and posts no epochs, which the monitor reports) and the faucet off
until this release is activated again. Residual on this one-box site: `lineage` is in the docker group,
hence root-equivalent, and owns the release directory the other users run; the separate users keep a
compromised gate, dashboard, indexer or Core away from Docker and from each other's keys, not away from
`lineage`. The mainnet layout below removes that.

## Caddy admin socket

Audit OFF-D12. The Caddyfile sets `admin unix//run/caddy/admin.sock|0600` (owner `caddy`; `/run/caddy`
is the unit's `RuntimeDirectory`), so no other local user can rewrite the proxy; nothing listens on
localhost:2019. `caddy reload` posts the new config to the admin address named in the new config, which
fails whenever a deploy moves the address (it did once, deploying a release from before the socket over
one with it). The caddy.service drop-in (`remote.sh caddy_dropin`, also written by `provision.sh`)
replaces `ExecReload` with a reload to the socket, falling back to localhost:2019, so a reload works
whichever address the running Caddy is on and whichever the new config names. Tested on the site
2026-10-10: two `systemctl reload caddy` in a row moved the admin socket to localhost:2019 and reloaded
again there, then two consecutive `deploy.sh code` runs reloaded Caddy onto the socket and again on it.

## Backups

Two kinds of snapshot, both hourly from `units-backup.timer`, both kept 24 deep on the server, and both
copied off the machine by `deploy.sh <host> backup` (daily from the owner's Mac by a launchd agent).

| Kind | What | Written by | Where | Encrypted |
|---|---|---|---|---|
| Core | `core.db`, Core's blob store, a manifest (sha256, every table's row count, the open epoch) | `lineage-core` (`units-backup.service`) | `/var/lib/lineage/core-backups/core-<UTC>.tar.zst` | no (mode 600) |
| secrets+state: `state` | the hosted runtime's agent signing keys (`runtime/keys/<agent id>.json`), `state.json`, `posts.json`, `trader/`, `bind-requests/`, `worker/`, the desktop session records and pending recording list (not the live stream dir or recordings), and the site's own keys made on the server (`~lineage/.config/lineage/site`: admin, owner, verifier-ref, verifier-v1, verifier-v2) | `lineage` (`units-backup-state.service`) | `/var/lib/lineage/state-backups/state-<UTC>.tar.zst.age` | age |
| secrets+state: `identity` | the identity service's encrypted records (GitHub pool credentials, pasted tokens, cycle state) and its key file `/etc/lineage-identity/master.key` | `lineage-identity` (`units-backup-identity.service`) | `/var/lib/lineage/identity-backups/identity-<UTC>.tar.zst.age` | age |

Not backed up, on purpose: the indexer's `market.db` (derived from chain: delete it and restart
`lineage-indexer` and it backfills, see "Market indexer"); the keys and env files copied from the
owner's machine (Core authority, faucet, runtime authority, agent keys, `rpc.env`, `model.env`,
`e2b.env`, `providers.env`), which stay in `~/.config/lineage` here and are shipped again by `deploy.sh`;
the sandboxes, mirrors and dependency caches (rebuilt).

**Core snapshot.** `scripts/deploy/backup.sh snapshot` copies `core.db` with `VACUUM INTO` (one read
transaction, consistent while Core writes), checks `integrity_check`, adds the blob store and the manifest
and packs it with zstd, with a `.sha256` next to it. It used the sqlite3 shell's `.backup` until
2026-10-10, which restarts whenever another connection writes the source: with Core writing more often
than a copy of the 585 MB database takes, two runs that day timed out at 30 min (15:24 and 17:27 UTC) and
the next took 29 min; `VACUUM INTO` copied the same database in 6 s.
Snapshots hold unrevealed epoch secrets and sealed sessions: keep every copy as private as the server.

**Secrets+state snapshot.** `backup.sh secrets <state|identity>` runs as the user that owns the data, so
no service user can read another's files (M4 separation kept: `lineage-core` never sees the runtime
keys, `lineage` never sees the identity store). It copies the part's files into the unit's RAM directory
(`RuntimeDirectory`, mode 700), writes `SHA256SUMS` and `manifest.json`, and pipes the tar through zstd
into `age -R /etc/lineage/backup-recipient.txt`. The recipient is the public half of an age identity
that exists only on the owner's machine (`~/.config/lineage/backup-age.key`, mode 600, made once with
`age-keygen -o`); `deploy.sh` derives the recipient from it and writes it to the server on every code
ship (a different recipient already there is kept unless `BACKUP_RECIPIENT_REPLACE=1`). The server can
write these snapshots but cannot read them. Without a recipient the two part units are skipped and the
monitor warns (`backup:secrets`).

```sh
scripts/deploy/deploy.sh <host> backup        # newest Core + state + identity snapshots here (BACKUP_DIR, default ~/.lineage/site-backups/<host>, mode 700), each verified
scripts/deploy/deploy.sh <host> restore-test  # Core into a scratch Core on the server, then the secrets parts decrypted here and compared with the live keys
ssh -i ~/.ssh/lineage_site root@<host> bash /opt/lineage/current/scripts/deploy/remote.sh backup    # all three now (the timer's job)
ssh -i ~/.ssh/lineage_site root@<host> bash /opt/lineage/current/scripts/deploy/remote.sh restore <snapshot>   # replace the live Core data
```

`backup` verifies the Core snapshot (archive checksum, `core.db` against the manifest's sha256,
`integrity_check`, every table's row count) and each secrets part (checksum, decrypts with
`BACKUP_AGE_KEY`, every file against `SHA256SUMS`, file count against the manifest; the decrypted copy
lives in a mode 700 temporary directory and is deleted). It refuses when this machine lacks room (ten
times the Core archive plus 2 GiB). Retention here: the newest `BACKUP_KEEP` (3) of each kind, or with
`BACKUP_KEEP_DAYS=<n>` every copy younger than n days; the newest of each kind always stays.

`restore-test` starts a Core on the restored data with the chain bridge read only (authority key
removed from its config, no canaries) and compares what it serves (`/v1/stats?hidden=1` units,
agents, candidates, the open epoch, the set of unit ids) with the snapshot; the live Core is not
touched. It then decrypts the newest `state` and `identity` parts here (the private key never leaves
this machine), computes public facts with `scripts/deploy/backup-facts.ts` (public keys of the runtime
agent keys and site keys; the identity key file's sha256; whether every identity record authenticates
under that key) and compares them with the same facts read live on the server (`remote.sh secrets-facts`,
run as the data's owner). Only public keys, a hash and record names are printed. A key made after the
snapshot is reported, not failed; a key in the snapshot that differs from or is missing on the live
server fails.

`restore` stops the units, moves the current data to `/var/lib/lineage/backups/<UTC>-before-restore`,
extracts the snapshot and starts everything again. Restoring loses whatever Core recorded after the
snapshot, and an epoch posted on chain after it stays on chain, so prefer the newest snapshot.

### Daily copy to the owner's Mac

`scripts/deploy/mac/install.sh` installs `com.lineage.backup-pull` (a launchd agent from
`scripts/deploy/mac/com.lineage.backup-pull.plist`) that runs `scripts/deploy/mac/backup-pull.sh`, that
is `deploy.sh 157.245.71.188 backup` with `BACKUP_KEEP_DAYS=14`, every day at 09:20 local (a run missed
while the Mac sleeps happens on wake). Log: `~/.lineage/site-backups/pull.log`.

```sh
scripts/deploy/mac/install.sh 157.245.71.188 --run   # install (launchctl bootstrap gui/$UID) and run once now
launchctl print gui/$(id -u)/com.lineage.backup-pull | grep -E 'last exit|runs'
scripts/deploy/mac/install.sh --uninstall
```

### What the owner must keep safe

- `~/.config/lineage/backup-age.key`: the only key that decrypts the secrets+state snapshots. Lose it and
  those snapshots are noise; leak it and anyone holding a snapshot has the runtime's agent signing keys,
  the site's admin, owner and verifier keys and the identity service's GitHub credentials. Keep one copy
  offline (printed or on a separate encrypted drive), never on the server, never in the repo.
- `~/.lineage/site-backups/<host>/`: Core snapshots are not encrypted (they hold unrevealed epoch
  secrets); keep the directory private (mode 700) and out of cloud sync that others can read.
- `~/.config/lineage/` as a whole (devnet keys, env files) and `~/.ssh/lineage_site`: a new server is
  rebuilt from these plus the snapshots.

### Disaster recovery

A lost or destroyed server is rebuilt from this machine. Tested end to end on a fresh systemd container
(the dry run image) with the site's real snapshots of 2026-10-10 18:28 UTC: the rebuilt box reported the
same five site public keys as the live site, the eight runtime agent keys and five site keys equal the
snapshot by public key, all 23 identity records authenticated under the restored key file, and its Core
served units 27, agents 67, candidates 202 and open epoch 18, the snapshot's figures; then its own
hourly snapshots and `restore-test` passed there (Core 5/5, secrets proof PASS).

1. New Ubuntu 24.04 server with root ssh for `~/.ssh/lineage_site`; pull the newest copies first if the
   old server still answers (`deploy.sh <old> backup`).
2. `scripts/deploy/deploy.sh <new-ip> provision`
3. `BACKUP_DIR=~/.lineage/site-backups/<old-ip> scripts/deploy/deploy.sh <new-ip> restore-secrets`:
   decrypts the newest `state` and `identity` parts here and writes their files into place on the new
   server, owned by `lineage` and `lineage-identity` with the modes they were saved with (it makes
   `lineage-identity` if missing). It must run before the first code ship: otherwise `install` makes new
   site keys and `identity_setup` a new identity key file, and it then refuses to overwrite them
   (`RESTORE_REPLACE=1` keeps the replaced files in `/var/lib/lineage/backups/`).
4. `BACKUP_DIR=~/.lineage/site-backups/<old-ip> scripts/deploy/deploy.sh <new-ip> restore-core`: copies
   the newest local Core snapshot over, verifies it and, with no release active yet, only places
   `core.db` and the blobs (it refuses if a `core.db` is there).
5. `scripts/deploy/deploy.sh <new-ip> full` with the usual settings (`WITH_RUNTIME=1`, `WITH_AUTHOR=1`,
   `AUTHORS`, `UNITS_RECIPES`, `EXTRA_ORIGINS`; a new server has no site.env to keep them from).
   `install` reuses the restored site keys, `identity_setup` the restored key file, activate sets owners
   and modes and starts Core on the restored data; the indexer backfills from chain; `site-chain.ts` is
   idempotent (an agent already registered is not registered again, a bond already at the minimum is not
   topped up), so with the restored keys it finds the site's verifiers as they are on chain. In the
   rehearsal `fund` and `site-chain` ran as plans only (dry run), so that step is untested against devnet.
6. Point DNS (`DOMAIN`) or the Vercel rewrites at the new IP, then `deploy.sh <new-ip> restore-test` and
   reinstall the Mac agent for the new host (`scripts/deploy/mac/install.sh <new-ip>`).

Whatever Core recorded after the Core snapshot is lost (up to an hour, or up to a day if only the Mac copy
survives), and so is runtime state written after the state snapshot.

Measured on the site 2026-10-10 (release ef15547): one `remote.sh backup` (all three snapshots) took 27 s.
Core: a 589,004,800-byte `core.db` with 271 blobs packed to 19,898,877 bytes. `state`: 26 files, 394,963
bytes, 18,754 bytes encrypted. `identity`: 24 files (23 records and the key file), 21,619 bytes, 18,597
bytes encrypted. `restore-test`: Core PASS 5/5 (restored Core up in 4 s; units 27, agents 67,
candidates 204, open epoch 18), secrets proof PASS (8 of 8 runtime agent keys and 5 of 5 site keys equal
the live ones by public key; identity key file equal; 23 of 23 records authenticate), 36 s in all from
this machine. The launchd agent's first run (kickstarted after install) pulled and verified all three,
exit 0.

## Monitoring

`units-monitor.timer` runs `scripts/deploy/monitor.ts` every 5 minutes as `lineage-monitor`.

| Check | Warn | Fail |
|---|---|---|
| units | | an enabled units-* systemd unit, timer or Caddy not active |
| `core`, `gate`, `public` | | `/v1/health` on 127.0.0.1:9660, `/gate/health` on 9662, `https://<site>/v1/health` not ok |
| `epochs` | | the open epoch more than 1 h past its end; a closed epoch not on chain 2 h after closing; Core without its authority key when one is installed |
| `verifiers` | | a site verifier (ref, v1, v2) without a heartbeat for 10 min |
| `spend` (runtime on) | the hosted runtime's model spend at 80% of its window cap (the message says when the cap is reached) | |
| `souls` | the soul drafter at 80% of its daily cap | |
| `balance:core-authority`, `balance:owner` | under 0.05 SOL | Core authority under 0.01 SOL |
| `faucet` | under 0.02 SOL or fewer than 10 drips of UNITS | |
| `disk:/` | under 20% free | under 10% or 5 GiB free |
| `backup` | | no snapshot, or the newest older than 2 h |
| `backup:state`, `backup:identity` | | no encrypted snapshot of that part, or the newest older than 2 h |
| `backup:secrets` | no age recipient on the server (runtime keys, site keys and identity data not backed up) | |

The runtime's spend lives in its state file (mode 600, owner `lineage`); the unit's root pre-step copies
only the spend window and the cap into `/run/lineage-monitor/spend.json`. Alerts go out when a check turns
warn or fail, when it recovers, and every 6 hours while it stays failing, to whatever the owner puts in
`/etc/lineage/alert.env` (root, mode 600; not written by the kit):

```sh
ALERT_WEBHOOK_URL=https://...          # POST {"text": ..., "content": ...} (Slack and Discord webhooks accept it)
ALERT_TELEGRAM_BOT_TOKEN=...           # and ALERT_TELEGRAM_CHAT_ID=...
```

Without it alerts reach the journal only (`journalctl -u units-monitor -p warning`). `deploy.sh <host>
monitor` runs it now and prints every check; `status` prints the last result. Nothing watches the
watcher on this box: add an external uptime check on `https://<site>/v1/health` for that.

First runs on the site (2026-10-10): during a deploy the timer caught Core, the public route (502), the
epochs and heartbeats reads, `lineage-reference` stopped for its drain and the missing first snapshot as
failures, and the next run after activation reported each of them recovered; the run after that was all
ok: 12 enabled units active, epoch 17 open and 16 on chain, 3 verifiers heartbeating, Core authority
0.2917 SOL, owner 0.0919 SOL, faucet 0.1939 SOL and 96 drips, 131.7 GiB of 153.9 GiB free, snapshot 3 min
old. `systemd-analyze security`: lineage-core 1.8, lineage-web, lineage-gate and lineage-indexer 1.7,
lineage-monitor 3.4, lineage-backup 4.3 (all "OK").

## Docs site

The docs are a web site of their own and a repository of their own:
**https://github.com/plsdontcallmyfone/units-docs** (local checkout `~/units-docs`). Their one
canonical origin is `https://docs.units.gg`: every page names it in its canonical link, its Open
Graph tags and the sitemap. This repository holds no docs page, no docs build and no docs deploy;
the app serves no docs page and redirects to the docs site.

**What lives where.**

| In the docs repository | In this repository |
|---|---|
| the pages (`content/*.md`), the renderer, client script and styles (`src/`), fonts, provider marks, screenshots | `scripts/docs/export.ts`: writes the data the docs show of this repository's code into the docs checkout (`generated/*.json`) |
| the build (`scripts/build.ts`), its tests, the preview server, the headless check (`scripts/ui-check.ts`) | `scripts/docs/api-notes.ts`: the purposes of Core routes that neither `packages/core/README.md` nor a SPEC route table describes, and the indexer's route list |
| the deploy (`scripts/deploy.sh`, `scripts/caddy/docs.caddy.tmpl`), `vercel.json` | `scripts/docs/export.test.ts`: fails when a Core route has no description, a note names a route that is gone, or the indexer list differs from its dispatcher |
| `site.json`: the app origin the docs link to and read live figures from, the canonical origin | `scripts/docs/capture.ts`: captures the docs' real API examples, the verify tutorial's output and the screenshots from the devnet site into the docs checkout (it runs this repository's verification scripts) |
| `generated/` and `captured/`: committed data, written from here | `config/sites.json` `docs_url`, `apps/web/src/docs-url.ts`, the `/docs` redirect |

**After a change here that the docs show** (a Core route added, changed or removed; `config/profile.json`
program ids or profile fields; `config/models.json`; the SPEC changelog; a file the docs link to moved):

```
bun scripts/docs/export.ts ~/units-docs      # rewrites only the generated files whose data changed
cd ~/units-docs && bun test && bun scripts/build.ts
git add generated && git commit && git push
scripts/deploy.sh 157.245.71.188
```

Each generated file names this script and the commit of this repository it was generated from.
`bun scripts/docs/export.ts --check ~/units-docs` writes nothing and exits 1 when a file would
change. The export exits 1 on an undescribed Core route (add its line to `scripts/docs/api-notes.ts`);
`bun test scripts/docs` fails on the same, without a docs checkout.

To capture the examples and screenshots again: `bun scripts/docs/capture.ts --docs ~/units-docs`
(read-only, headless), then commit `captured/` and `public/shots/` in the docs repository.

**The values that tie the two sites together.**

| Value | Where | Meaning |
|---|---|---|
| `docs_canonical` | `config/sites.json` here, `site.json` in the docs repository | `https://docs.units.gg`, fixed |
| `app_url` | `site.json` in the docs repository (and `config/sites.json` here) | the app the docs link to (Explorer, Launch, every `app:` link) and read live figures from; the devnet site until the app has its own domain. Change both together, then build and deploy the docs |
| `docs_url` | `config/sites.json` here | where the app's `/docs` redirects and in-app docs links go; the temporary docs host until the DNS record below exists. `UNITS_DOCS_URL` overrides it (app server, `scripts/deploy/deploy.sh`, the app's Vercel build) |

**Live figures.** The docs pages read `GET <app_url>/v1/config`, `/v1/stats`, `/v1/guard-config` and
`/market/tokens` from the browser, across origins. Core and the indexer answer every origin unless a
list is set, so this works as deployed. If the API is ever limited to a list (`CORS_ORIGINS=...` for
`scripts/deploy/deploy.sh`), the kit adds `https://docs.units.gg` and the temporary docs host to the
list it gives Core and the indexer (`UNITS_CORS_ORIGINS` in `/etc/units/site.env`). The docs deploy
checks both origins against the live API every time and fails when one is refused.

### Hosting on our server

From a checkout of the docs repository:

```
scripts/deploy.sh 157.245.71.188
scripts/deploy.sh 157.245.71.188 status
scripts/deploy.sh 157.245.71.188 rollback
```

(`scripts/deploy/deploy.sh <host> docs` in this repository only prints this.) It builds there, copies
the files to `/var/www/units-docs/releases/<time>-<commit>`, points `/var/www/units-docs/current` at
them and writes Caddy a site block of its own, `/etc/caddy/sites.d/units-docs.caddy`, then reloads
Caddy. No app unit is touched or restarted, an app deploy never changes the docs, and the docs
deploy needs no app deploy. The one thing it needs from the app deploy is the last line of the main
Caddyfile (`scripts/deploy/caddy/Caddyfile.tmpl`): `import /etc/caddy/sites.d/*.caddy`. Caddy serves
the files directly: clean URLs, the docs' own 404 page,
`cache-control: public, max-age=31536000, immutable` for everything under `/assets`, a month for
fonts, an hour for images, `no-cache` for pages, and the docs' own page policy (scripts from the
site only, no inline script, connections to the app origin for the live figures). If Caddy refuses
the new block, the previous block and release are put back.

The site block names two hosts: `docs.units.gg` and the temporary host
`docs-157-245-71-188.sslip.io`, which needs no DNS setup.

**DNS, once.** The owner adds one record at the DNS provider of `units.gg`:

```
A   docs.units.gg   ->   157.245.71.188
```

Caddy then obtains the certificate for `docs.units.gg` by itself; nothing is redeployed. It retries
in the background with growing pauses (for up to 30 days), so the first answer can take a while
after the record appears: `scripts/deploy.sh 157.245.71.188` in the docs checkout asks at once and
reports it. When `https://docs.units.gg` answers, set `docs_url` in `config/sites.json` to
`https://docs.units.gg`, commit, and deploy the app (`scripts/deploy/deploy.sh 157.245.71.188 code`)
so its `/docs` redirect and its links use the real name; `UNITS_DOCS_REDIRECT=301` on that deploy
makes the redirect permanent.

### Hosting on Vercel instead

A Vercel project on the docs repository, Root Directory left at the repository root; its
`vercel.json` holds the build command, the output directory, clean URLs, the headers and cache
rules. Then add the domain `docs.units.gg` to the project and create the DNS record Vercel shows for
it (a CNAME for `docs`, in place of the A record above). The docs repository's README has both ways
(from git, or prebuilt). This configuration has been checked by the docs tests and the local
preview; it has not been deployed to a Vercel account from here.

### The app side

`/docs` and `/docs/<page>` on the app answer a redirect to the same page on the docs site
(`/docs/launch-quickstart` to `<docs_url>/launch-quickstart`): a 302 for now,
`UNITS_DOCS_REDIRECT=301` makes it permanent. Every link from the app to the docs is built by
`apps/web/src/docs-url.ts` from the same value. The app's Vercel build
(`scripts/deploy/vercel/build.ts`) carries the same redirects and no docs page.

## Second instance (mainnet test)

Owner decision 2026-10-11: the mainnet test runs as a second instance on the same server, beside the
devnet site, which stays exactly as it is. `UNITS_INSTANCE=mainnet` selects it; with the variable
unset every command in this document is the devnet site as before. Nothing below was run on the real
server by the lane that built it: it was proven in the dry-run container only ("Tested").

```sh
UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh <host> stage            # ship + install + configs, starts nothing
UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh <host> chain-plan       # read only: the owner key and what the verifiers' registration needs
MAINNET_SEND=yes UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh <host> chain   # 3 registrations, 2 bonds, before activate
UNITS_INSTANCE=mainnet WITH_RUNTIME=1 scripts/deploy/deploy.sh <host> activate   # only once the programs exist on mainnet
UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh <host> status | stop | start
UNITS_FEATURE_OPEN_BOUNTIES=1 UNITS_FEATURE_BOUNTIES=1 UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh <host> activate   # Core's bounty switches: kept in site.env by later deploys, =0 turns one off
UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh <host> sweep-plan       # read only: what the keys on the server hold
MAINNET_SEND=yes UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh <host> sweep <recipient>   # their SOL and quote tokens back
UNITS_INSTANCE=mainnet scripts/deploy/deploy.sh <host> remove [--purge [--force]]   # after the test; --purge deletes its keys, data and accounts
```

**The order, proven on a mainnet fork** (dry run, `DRYRUN_FORK=1`, "Tested"): `stage` (with the chain
state, the overlay and the RPC already on the owner's machine, so they are shipped), `chain-plan`, fund
the owner key it names, `chain`, then `activate`; at the end `stop`, `sweep-plan`, `sweep`, `remove
--purge`. `chain-plan` and `chain` need only what `stage` leaves (the release, `state.json`, the overlay,
`rpc.env` and the site keys made at `stage`): Core does not have to run, and both were run with every
unit of the instance stopped. Running `chain` before `activate` means the verifiers are registered
when their units first start. A `stage` made before the programs exist (no state, no RPC) is fine: run
`stage` again once `test.ts init` has written the two files, and `chain-plan` says so if they are
missing.

`deploy.sh` hands over to `scripts/deploy/instance.sh` (local) and `remote-instance.sh` (server).

| | Devnet site (unset) | Mainnet test (`UNITS_INSTANCE=mainnet`) |
|---|---|---|
| Units | `units-*` | `units-main-core`, `-indexer`, `-web`, `-gate`, `-runtime`, `-bootstrap`, `-reference`, `-verifier@v1`, `-verifier@v2` |
| Release | `/opt/units` | `/opt/units-main` |
| State | `/var/lib/units` | `/var/lib/units-main` |
| Config | `/etc/units`, `/etc/units-core` | `/etc/units-main`, `/etc/units-main-core` |
| Accounts | `units`, `units-core`, `units-web`, `units-gate`, `units-indexer` | `units-main`, `units-main-core`, `units-main-web`, `units-main-gate`, `units-main-indexer` |
| Ports (127.0.0.1) | Core 9660, web 9661, gate 9662, runtime bind 9667, indexer 9668 | Core 9760, web 9761, gate 9762, runtime bind 9767, indexer 9768 |
| Host | `<ip with dashes>.sslip.io` | `main-<ip with dashes>.sslip.io` (`SITE_NAMES` or `MAIN_DOMAIN` override) |
| Network | `UNITS_NETWORK=devnet`, pinned in every unit file and in `/etc/units/site.env` (the repository default is mainnet, so the devnet site never relies on it; `remote.sh` passes the pin to every script it runs) | `UNITS_NETWORK=mainnet`, `UNITS_PROFILE_LOCAL=/etc/units-main/profile.local.json` (the instance's unit files carry `UNITS_NETWORK=mainnet`: `instance.ts` rewrites the pin) |

**How it is built.** The unit files and the Caddy site block are rendered from the devnet site's own
files (`scripts/deploy/systemd`, `caddy/Caddyfile.tmpl`) by `scripts/deploy/instance.ts`: names,
accounts, paths and ports moved, every hardening line kept (`instance.test.ts` checks both). The
accounts are separate so that no devnet process can read a mainnet key; only `units-main` (sandboxes
and the hosted runtime) is in the docker group, as `units` is for devnet. Core takes its port block
from `UNITS_PORT_BLOCK=9760-9769` in its unit. The site block lives in
`/etc/caddy/sites.d/units-main.caddy` and the main Caddyfile imports that directory, so a devnet deploy
(which rewrites `/etc/caddy/Caddyfile`) keeps the mainnet host; the Caddy admin socket is not touched.
A Caddy configuration that does not validate is put back as it was before anything reloads.

**What it reads on the owner's machine** (never printed; keys are compared and reported by public key):

| File | Goes to | Notes |
|---|---|---|
| `scripts/mainnet/mainnet.json` (untracked) | `/etc/units-main/state.json`, mode 644 | the deployed chain state, same shape as `scripts/devnet/devnet.json`; an optional `network_overrides` object replaces Core config keys (its `prepay` block is merged key by key), e.g. `identity_account_recipient`, which in `config/network.json` is the devnet treasury |
| `scripts/mainnet/profile.local.json` (untracked) | `/etc/units-main/profile.local.json`, mode 644 | the profile overlay (quote mint, `swap`); the kit adds `state_file` so every service reads the state above |
| `UNITS_MAINNET_RPC` (environment, or `~/.config/units/rpc.env`) | `/etc/units-main/rpc.env` and the per-role `core.env`, `indexer.env`, `runtime.env`, `web.env`, all mode 600 root | never in `site.env`, a config file, a log or a page |
| `~/.config/units/mainnet/core-authority.json` | `/etc/units-main-core/core-authority.json`, owner `units-main-core` | must equal the state file's `core_authority` |
| `~/.config/units/mainnet/runtime-authority.json` | `/home/units-main/.config/lineage/mainnet/`, owner `units-main` | must equal the state file's `runtime_authority` |
| `model.env`, `providers.env`, `e2b.env` (`WITH_RUNTIME=1`) | `/home/units-main/.config/lineage/`, mode 600 | the same files the devnet runtime uses |

**Stage, then activate.** `stage` works with none of these files: it makes the accounts and
directories, clones and installs the release, makes the instance's own site keys (admin, owner,
verifiers) and installs the unit files, enabled and started nowhere. `activate` is refused, on the
owner's machine and again on the server, until the chain state, the overlay, the RPC and both hot
keys are there; then `scripts/deploy/instance-preflight.ts` reads the endpoint (genesis is the profile's, which is mainnet's unless an overlay made for fork testing names another one, in which case the output says FORK TEST;
the three programs are executable at the profile's ids, registry and launch are initialized, the
registry's mint is the overlay's quote mint, both authorities equal the state file) and only a READY
starts anything. Each public unit is health-checked; a failure stops the instance again and leaves the
devnet site alone.

**Safety values** (`/var/lib/units-main/site/runtime.json`, written by `site-config.ts` under
`UNITS_INSTANCE=mainnet`; configuration, not code):

- model spend: at most 800 USD per UTC day counting every dollar, vault-paid included
  (`global_max_usd` 800, `global_cap_scope` all, `global_window_s` 86400);
- at most 2 attempts at once (`max_concurrent` 1, `max_concurrent_ceiling` 2);
- a live desktop required for every attempt (`desktop_required`), E2B only (`desktops_max` 0,
  `e2b_max` 2: the server's two local desktop slots stay with devnet);
- no agent trading (removed 2026-10-12; the runtime's firewall signs no swap); no faucet and no TEST labels (the mainnet profile refuses both); the hidden list
  starts empty (a fresh Core database);
- the quote token is a throwaway stand-in no feed prices, so the runtime uses the configured rate
  (`price.source` config): the same TEST figures Core publishes from `config/network.json` `prepay`
  with the state file's `network_overrides`.

**The mainnet instance has its own E2B budget (owner 2026-10-12).** Its runtime.json says
`desktop_shared: null`: its `desktop_usd_per_day` (200 USD) and `e2b_max` (50) are its own and do not
depend on the devnet site. Before, both runtimes shared one cap through `desktop_shared`
(`/var/lib/units-shared/e2b-spend`, root:units-e2b 0770) and the mainnet side was strict: with devnet's
spend file missing, malformed or older than 10 minutes it had no E2B budget at all. On 2026-10-12 the
devnet runtime was paused, and the first agent launched on mainnet waited for a desktop that could
never come ("E2B: day cap reached (0.0000 of 0 USD, UTC day)") until this was changed. The devnet
runtime still names the directory and counts a mainnet file of the same UTC day if one is there; the
mainnet runtime no longer writes one. The directory, the group and `SharedDesktopBudget`
(packages/runtime/src/desktops.ts) stay for two instances that should share one cap.

**Not part of the instance.** The GitHub identity service (the mainnet host has no `/identity/*`
route, so a launch there cannot be given a pool account), backups, the monitor, rollback (`stage` and
`activate` an older commit instead) and authors. 

**Sweep before purge.** The site owner key and the three verifier keys exist only on the server.
`sweep-plan` prints what each holds. `sweep <recipient>` (refused without `MAINNET_SEND=yes`) sends the
owner key's whole quote-token balance to the recipient's token account (created if missing, paid by
the owner key), closes the emptied token account so its rent returns, then sends all the SOL of each
key; each key pays its own fees and is left with 0 lamports (the last transfer carries no priority fee,
so its fee is exactly 5,000 lamports). A key holding no more than that one fee is dust and is left.
Bonds are not moved: they stay in the registry (not withdrawable before the unbond cooldown, and lost
when the programs are closed), and the sweep says so per verifier. `remove --purge` reads the same
balances first and is refused while any of those keys holds more than dust, or when the balances
cannot be read; `remove --purge --force` deletes the keys regardless. For the mainnet test the
recipient is the deployer, and the sweep runs before `scripts/mainnet/test.ts close` (which closes the
programs) or after it: it needs the RPC and the quote mint, not the programs.

**Verifiers.** Candidates get verdicts only from registered verifiers. The instance has its own three
(reference, v1, v2; keys made on the server at `stage`, public keys in
`/var/lib/units-main/site/pubkeys.json`), owned by its own owner key. `chain-plan` reads mainnet and
prints the owner key and what registering and bonding them would send and what that key must hold
first: 0.02 SOL at least for fees and rent, and the quote token for three registration burns and two
bonds (13,000,000 base units with the test parameters: 3 burns of 1 and 2 bonds of 5 test coins);
`chain` sends it, is refused without `MAINNET_SEND=yes` and stops before sending anything while the key
is short. It is idempotent: a second run sends nothing. Funding that owner key is
`scripts/mainnet/test.ts fund --to <owner key> --sol 0.05 --coin 20` from the deployer. Neither was
run on mainnet; both were run on a mainnet fork (dry run).

## Mainnet server layout (recommended)

The devnet site is one box. For mainnet, split by what each part can lose:

| Box | Runs | Holds | Never runs |
|---|---|---|---|
| Edge + Core (1) | Caddy, gate, dashboard, indexer, Core, monitor, backups | Core authority (hot key, scoped powers: docs/AUDIT.md powers table), Core's database, admin key | Docker, sandboxes, model keys |
| Verifiers (2 or more, separate operators) | `units-worker` (verifier or reference) with Docker | each its own agent key and bond | Core, any shared key |
| Runtime (1) | hosted runtime, agent desktops (Docker) | runtime authority, model keys, E2B key | Core, the Core authority |

- Releases owned by root on every box (not by the user that runs Docker), installed read only.
- The edge box has no docker group at all; its services keep the users above.
- Core's write API stays closed at the gate except the worker routes the verifiers need, from their
  addresses only.
- Backups leave the edge box to a store the owner controls, encrypted, with `restore-test` run after
  every change of schema and at least monthly.
- Independent verifiers: `quorum` is 2 (config/network.json) and a disputed candidate needs one more
  replayer plus the reference runner (SPEC 10.2), so a class needs at least 3 eligible verifiers that share
  no declared operator with each other or with the author before it can judge every candidate; 4 keeps it
  judging while one is offline (geth-rlp sat disputed on the devnet site for want of a 4th). Calibration
  draws `calib_replayers` (2) class-qualified verifiers. The site's own verifiers count as one operator.

## Adding capacity

How many agents a site carries, what was measured and what to buy: `docs/plans/SCALE-OUT.md`. This is
the runbook. There are two ways to add capacity and they combine.

### A bigger server

Every setting that follows the machine's size is derived on the server at each install and activate
(`scripts/deploy/sizing.ts`, called by `site-config.ts`): the sandbox slots, attempts at once, replays
at once per verifier and Core's `max_open_replays`. It writes `<state>/site/sizing.env`, which the
runtime, verifier, reference and author units read after `site.env`.

```sh
# 1. DigitalOcean: power off, resize (CPU and RAM only keeps the disk), power on
# 2. one deploy of each instance
scripts/deploy/deploy.sh <host> code
UNITS_INSTANCE=mainnet scripts/deploy/instance.sh <host> code
# 3. check (on the server)
cat /var/lib/units-main/site/sizing.env
jq .max_concurrent_ceiling /var/lib/units-main/site/runtime.json
jq .max_open_replays /var/lib/units-main/site/network.json
# what a size gives, without a server:
bun scripts/deploy/sizing.ts --cores 48 --memory-mb 98304
```

Overrides, as root on the server, then deploy the instance again: `/etc/units/sizing.json` (devnet
site) or `/etc/units-main/sizing.json` (mainnet instance), a JSON object with any of `sandbox_slots`,
`attempts`, `replay_slots`, `max_open_replays`, `cpu_shares`, for example `{"attempts": 50}`. An
unknown key or a value out of range stops the deploy with the reason. Remove the file to go back to
the derived values. `UNITS_SANDBOX_SLOTS` in `site.env` no longer decides: `sizing.env` is read after it.

### Capacity hosts

A capacity host is another server that runs sandboxes for a site. It never holds an agent key, a model
key or the runtime authority. It does one or both of:

- **sandbox**: the evaluations of the hosted runtime's attempts. The runtime stays one process on the
  site; each evaluation goes over ssh to the host's gateway (a forced command) and its result comes
  back. With no host free or up an evaluation runs on the site, as before.
- **verifier**: a verifier of its own, with a key made on the host. It reaches the site's Core through
  an ssh tunnel (Core listens on the site's loopback only and the public gate refuses writes).

The host needs Ubuntu 24.04, root ssh for the owner's key, and the site's architecture (amd64).

```sh
# add a host (30 minutes or less; idempotent, run it again at any time)
ROLE=both INSTANCE=mainnet scripts/deploy/capacity-host/provision.sh <host-ip>
#   ROLE=sandbox | verifier | both      INSTANCE=devnet | mainnet      NAME=<a-z0-9-> (default cap-<last part of the ip>)
#   SITE=root@<site ip>  SITE_KEY=<key>  SSH_KEY=<key for root on the host>   (defaults: the devnet site, ~/.ssh/lineage_site)

# after every deploy of the site: bring the host to the site's release (a host on another release
# answers "update the host" and the runtime sends its evaluations elsewhere until then)
ROLE=both INSTANCE=mainnet scripts/deploy/capacity-host/provision.sh <host-ip> update

# remove a host
ROLE=both INSTANCE=mainnet scripts/deploy/capacity-host/provision.sh <host-ip> remove
```

What `full` does: Docker, the `units-cap` user (its key runs only `/usr/local/bin/units-sandbox-gw`),
Bun at the site's version, the instance's release copied from the site (the same re-pinned recipes,
so the same recipe ids), the sandbox images copied from the site's Docker (an image built on the host
would have another id), `/etc/units-cap/env` with the slots from the host's own size, a firewall that
lets only the site reach ssh. Then per role:

- sandbox: a key for the site's runtime user, the host's own host key in its `known_hosts`, and the
  host in `~<instance user>/.config/lineage/sandbox-hosts/hosts.json`. The running runtime re-reads the
  file every minute (`UNITS_SANDBOX_HOSTS_FILE` in its unit): no restart. Check on the site:
  `journalctl -u units-main-runtime | grep 'sandbox host'`.
- verifier: the key (`/etc/units-cap/verifier.json`, mode 600, never printed or copied), the
  instance's `caps.json`, the tunnel unit (`units-cap-tunnel`: an account on the site that can only
  forward to the Core port) and the verifier unit (`units-cap-verifier`), installed and **not started**.

Starting a verifier needs two chain transactions that only the owner can sign; the kit prints them
with the verifier's agent id and the capabilities digest and sends nothing:

1. Register: the owner's wallet signs `units_registry register` for the printed agent id and digest
   (it burns the register burn in the quote coin); the verifier's key co-signs on the host with
   `bun packages/worker/src/main.ts cosign --key /etc/units-cap/verifier.json --tx <base64>` (first with
   `--dry-run`).
2. Bond: the owner's wallet sends `units_registry bond` for that agent, at least `min_bond`.
3. On the site, `/etc/<instance>/sizing.json` gets `"max_open_replays"` of at least the host's replays
   at once (printed), then deploy the instance: Core hands a verifier no more than that.
4. `START=1 ROLE=... INSTANCE=... NAME=... scripts/deploy/capacity-host/provision.sh <host-ip> update`
5. It qualifies on every unit first (one base run each), then takes replays:
   `bun packages/worker/src/main.ts status --core http://127.0.0.1:<core port> --key /etc/units-cap/verifier.json`
   on the host.

Removing: `remove` takes the host out of `hosts.json` (evaluations running there finish, no new ones
start), stops and disables its verifier and tunnel (the verifier is given its stop timeout to finish
and reveal), and removes the tunnel's key from the site. The verifier's key and bond are untouched:
unbond from the owner's wallet before destroying the server. A host that simply dies needs nothing:
the runtime marks it down on the first failed evaluation, runs that evaluation on another host or on
the site, and tries the host again every minute; a dead verifier stops heartbeating and Core reassigns
its replays after their window.

What a host costs and carries (heavy units, `bun scripts/deploy/sizing.ts --role both --cores N`):

| host | sandbox slots | as sandbox host: evaluations at once | as verifier host: replays at once | both: replays + evaluations |
|---|---|---|---|---|
| c-16 (16 vCPU, 32 GiB) | 15 | 15 | 15 | 10 + 5 |
| c-32 (32 vCPU, 64 GiB) | 30 | 30 | 30 | 20 + 10 |
| c-48 (48 vCPU, 96 GiB) | 45 | 45 | 45 | 30 + 15 |

Dry run: `scripts/deploy/capacity-host/dryrun.sh` (two local containers play two servers, the real
`provision.sh` over real ssh, then `scripts/scale/proof.ts`). Results in
`scripts/deploy/capacity-host/DRYRUN-LAST.json` and `scripts/scale/PROOF-LAST.json`.

## Every class on the mainnet instance (2026-10-13)

The mainnet instance served Python units, the Rust fixture and one Rust unit. This section is what was
measured to serve the other non-CUDA recipes there (Rust, Go, Zig, C/C++, Solana, more Python), whose
verifiers are two on the site server and two on the capacity host `cap-nyc1`. Nothing here was deployed.

**How a recipe becomes a unit on an instance.**

1. `UNITS_RECIPES` (deploy.sh / instance.sh `write_env`, kept in `/etc/<instance>/site.env`) names the recipes.
2. On the server, `remote.sh` and `remote-instance.sh` (stage) read each named recipe's `class:` and
   `image:`, and build `lineage/<class>:<tag>` from `images/<class>` unless the image in the server's
   Docker carries the label `lineage.build-hash` of those build files. Both instances use the one Docker
   daemon, so the images are the devnet instance's.
3. `scripts/deploy/arch-recipes.ts` rewrites, in the release only, each recipe's `requires.arch` and its
   image pin to the id of the image built there, applies `scripts/deploy/amd64/<name>.replace.json` and
   copies `scripts/deploy/amd64/<name>/**` into the overlay. The recipe id follows from that text.
4. The instance's bootstrap unit (`site-bootstrap.ts`) registers recipe and snapshot, and the reference
   runner on the site calibrates each recipe that has no unit yet (5 runs, in list order). That creates
   the unit.
5. Core hands every eligible verifier whose declared capabilities satisfy the recipe's `requires` a
   qualification for the unit: one base run with the calibration seed, passed when the stable tests and
   every deterministic base value match within tolerance (`det_tolerance` 0.001, or the metric's own).
6. A capacity host gets the release, the images and the dependency layers from the site
   (`capacity-host/provision.sh ... update`, `RECIPES` defaults to the instance's `UNITS_RECIPES`), so
   ids and digests are the site's. Its verifiers then qualify like any other.
7. Canaries are loaded by Core from the private directory `/var/lib/<instance>/canaries/<recipe name>/`
   only. `recipes/*/canaries` are public test fixtures and must not be put there.

**State found.** The site server's Docker has all six images (python, rust, go, cpp, zig, solana), each
with the build hash of the current `images/<class>`: a deploy reuses them. The devnet instance on the
same server serves 23 amd64 units of every class, and both of its site verifiers hold a passed
qualification on all 23 (read from its Core). So the 4 vCPU site verifiers can replay every class. The
capacity host had only the python and rust images; go, cpp, zig and solana were copied there from the
site's Docker with their ids (the copy `provision.sh` makes).

**Measured on the capacity host** (scratch checkout in `/root/scratch-recipes`, own `UNITS_HOME`, at
most five sandboxes at once; full record `scripts/deploy/amd64/CAPACITY-HOST-LAST.json`, per recipe
`recipes/<name>/{canaries,candidates}/results-amd64.json`): each recipe re-pinned by `arch-recipes.ts`,
calibrated with `scripts/calibrate-recipe.ts` (5 runs, with the seed of the site's recorded calibration)
and judged with `scripts/check-canaries.ts`. Every recipe id equals the one the devnet site serves
(zig-clap aside, below). Largest difference of a base value from the site's record, per class:

| Class | Recipes | Largest difference from the site's base values |
|---|---|---|
| rust | fixture-b58, base58-rs, md5-rs, hmac-sha256-rs | none (Ir equal) |
| cpp | llama2c, bitcoin-base58 | none |
| zig | zig-charm, zig-clap, fixture-zigsize | bytes and Ir equal; fixture-zigsize work_ir 2.3e-8 |
| solana | solana-config, fixture-cu-tally, spl-record | none (CU and bytes equal); spl-record has no site record |
| go | bip39-go, btcd-bech32, ollama-tokenizer, geth-rlp | 5.4e-5 (bip39-go valid_ir) |
| python | base58-py, minbpe, both heavy recipes, bip39-py, subword-nmt, pyrlp, lc-text-splitters, bech32-py | 1.1e-4 with the site's dependency layer digest; 3.5e-4 (pyrlp) and 5.6e-4 (lc-text-splitters) where the layer prepared that day had another digest |

All are inside `det_tolerance` 0.001. The two hosts differ (Xeon Gold 6248 with AVX-512 and kernel 7.0
against DO-Regular and kernel 6.8), and Python and Go counts are not identical across them; the four
Python units already live qualified all four verifiers. Canaries: every one rejected for its expected
reason. Candidates: every one judged as its index expects. bech32-py and spl-record had no amd64
calibration: `recipes/<name>/calibration-amd64.json` now holds the one measured here (not a Core record).

**zig-clap on a 32-core host.** `zig build examples` failed there with `error: SystemResources`: Zig
sizes its thread pools from the host's 32 cores, six compiles ran at once, and the recipe allows 256
pids. `scripts/deploy/amd64/zig-clap.replace.json` now also turns it into `zig build -j2 examples`
(the recipe's 2 CPUs). Base values are unchanged (142368 bytes, parse_ir 31723279, help_ir 24552177), the
amd64 recipe id is new (8f22fe223e86...). The devnet instance still serves the old id: its next deploy
calibrates a second zig-clap unit and the old one must be retired by the admin. Any recipe whose build
starts one worker per core can fail the same way on a capacity host; none of the other 24 did.

**geth-rlp.** One evaluation took 1,279 s on the capacity host (median of 5, with up to four other
sandboxes running) and 1,394 s on the site (Core's record), against the recipe's `wall_s` of 1800; its
calibration alone took 55 minutes here and 53 on the site, and each of its four patches took 1,263 to
1,269 s to judge. It calibrates, its base values agree (largest difference 2.7e-5) and its patches are
judged as expected, but every candidate costs that once per replayer and every verifier once to qualify.
Leave it out of the mainnet list, or put it last.

**To serve them** (owner; the first list is the instance's own at the time, read it from
`/etc/units-main/site.env` again before deploying):

```sh
UNITS_INSTANCE=mainnet \
UNITS_RECIPES=fixture-b58,base58-py,minbpe,base58-py-heavy,minbpe-heavy,gorbagana-chain,base58-rs,hmac-sha256-rs,md5-rs,bech32-py,bip39-py,subword-nmt,pyrlp,lc-text-splitters,llama2c,bitcoin-base58,zig-charm,zig-clap,spl-record,solana-config,btcd-bech32,bip39-go,ollama-tokenizer \
  scripts/deploy/deploy.sh 157.245.71.188 activate
# when units-main-bootstrap has finished (journalctl -u units-main-bootstrap: "done"), and again after any later deploy:
JUMP=none SSH_FROM=any VERIFIERS=2 ROLE=both INSTANCE=mainnet NAME=cap-nyc1 scripts/deploy/capacity-host/provision.sh 157.230.180.62 update
```

No image step and no env edit is needed on either host: the site reuses its six images, the capacity
host has them with the same ids. The bootstrap calibrates the 17 new units on the site in list order;
from the devnet instance's bootstrap walls above that is about 47 minutes plus bech32-py and spl-record,
during which the site verifiers also qualify (one base run per unit each). Run the capacity host's
`update` once right after the deploy as always (release match), and once more when the bootstrap is
done: a dependency layer the site had not prepared yet at the first run is prepared by the host itself
and can get another digest (seen here for base58-rs, pyrlp, lc-text-splitters, solana-config), and the
second run replaces it with the site's. fixture-zigsize and fixture-cu-tally are ready too, but a
fixture repository cannot be launched on and unit setup does not take a fixture unit as its class
reference (`unit-setup.ts`), so they are left out.

**Site verifiers or capacity host only.** The kit can keep a unit off small verifiers only through the
recipe's `requires` (`min_cpus`, `min_memory_mb`), matched against each verifier's declared
capabilities. It cannot do that today for these four verifiers: `provision.sh` gives the capacity
host's verifiers the site's `caps.json` (4 cpus, 7,941 MiB; its digest is what they registered on
chain), so all four declare the same machine. Nothing measured here needs the split except geth-rlp.

**Not proven.** A mainnet qualification of any of these units (it happens after the deploy); a
proposal (unit setup) of a class other than Python calibrated by verifiers on both hosts, which also
needs the two hosts to prepare the same dependency layer digest; private canaries for the new units
(the mainnet directory is empty).

## Size and cost

DigitalOcean Basic droplet prices, read from https://www.digitalocean.com/pricing/droplets on 2026-10-08:

| Plan | vCPU | RAM | SSD | Transfer | Price |
|---|---|---|---|---|---|
| Basic | 2 | 4 GiB | 80 GiB | 4,000 GiB | $24.00/mo ($0.03571/h) |
| **Basic (recommended)** | **4** | **8 GiB** | **160 GiB** | **5,000 GiB** | **$48.00/mo ($0.07143/h)** |
| Basic | 8 | 16 GiB | 320 GiB | 6,000 GiB | $96.00/mo ($0.14286/h) |

Backups: 20% of the droplet price weekly, 30% daily (same page). Why 8 GiB: three workers can each hold
one sandbox at 2048 MB (the default recipes' limit) at the same time, next to Core, the dashboard, the
gate, Caddy and dockerd; the 4 GiB plan works with its swapfile but replays then queue and slow down.
Disk: the rust and python images are 1.35 GB and 0.42 GB (RUNBOOK), plus mirrors and dependency layers
(about 2 GB after every recipe had run on the Mac). DigitalOcean offers no arm64 droplets; the kit
defaults to amd64 and recalibrates there.

Devnet costs (test SOL, no money): each `post_epoch` locks 0.00148844 SOL of Epoch account rent
(measured on epoch 2's account, 165 bytes, 2026-10-08) plus the 5,000 lamport fee, once a day. Verifier
registration and bonds: three burns of 1 UNITS and two bonds of 5 UNITS, plus fees and rent. The model
spend of the optional runtime is real money and is capped by `runtime.json`.

## Tested

`scripts/deploy/dryrun.sh` runs the real deploy.sh over real ssh against a local systemd Ubuntu 24.04
container (`jrei/systemd-ubuntu`, pinned by digest, amd64, label `lineage=1`, removed afterwards). There is
no Docker in that container, so the sandbox units are skipped there and nothing is sent on chain (fund
and site-chain run as plans); Core runs in devnet chain mode read only and Caddy uses internal TLS. The
last result is `scripts/deploy/DRYRUN-LAST.json`. Gate unit tests: `bun test scripts/deploy`. The sandbox
units, the amd64 recalibration and the devnet registration run for the first time on the real server. The
service users, the Caddy admin socket, backups and the monitor (M4) were tested on the real site; the dry
run has not been rerun since.

**Second instance.** The dry run of 2026-10-11 at `254acd7` (106 of 108 checks; the two that fail,
"wallet page" and "deploy.sh status", failed the same way in the run recorded before this change)
deployed the devnet site, then staged, refused, activated, stopped, started and purged the mainnet
instance beside it: 51 of 51 checks in that section. What stood in for mainnet there: no units program
exists on mainnet yet, so the instance's RPC was `scripts/deploy/dryrun/stub-rpc.ts` inside the
container (mainnet's genesis hash, devnet's chain served under the mainnet program ids), and its chain
state and profile overlay were made from `scripts/devnet/devnet.json`. Not exercised anywhere: the
instance's sandbox units and hosted runtime (no Docker in the container), a real mainnet endpoint,
key copying, Let's Encrypt for the second host, two runtimes sharing one Docker daemon, and the two
running runtimes sharing the E2B budget (the budget code is unit-tested and was run in the container
as both accounts against the shared directory).

**Other front ends.** A front end on another domain that proxies to this site (the Vercel build in
`scripts/deploy/vercel/` rewrites `/chain`, `/api`, `/live` and `/souls` here) forwards the browser's
Origin, and the gate only accepts wallet writes (`/chain/rpc`, `/chain/faucet`) from listed origins. List
them at deploy time: `EXTRA_ORIGINS=https://lineage-sable.vercel.app,https://lineage-garage.vercel.app`.
