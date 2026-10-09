# Public devnet site: deploy

One public Linux server runs Core in devnet chain mode, the dashboard and the Wallet page, so anyone
can browse lineages, watch the live wall, recompute verdicts (`scripts/verify.ts --core https://<site>`)
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
| Optional: `WITH_AUTHOR=1` and `AUTHORS=<recipes>` (default `minbpe`) | one TEST author agent per listed recipe submits its prepared candidates (`recipes/<name>/candidates`) on the site (real verdicts, no model spend); launch the agents first with `bun scripts/deploy/site-authors.ts --recipes <same list>` (see "The full lineage set") |
| `WITH_RUNTIME=1` and `~/.config/lineage/model.env` | the hosted runtime authors with Claude; spends real money, at most 10 USD of model usage per UTC day across all hosted agents (owner decision 2026-10-09; see "Hosted runtime") |

No DigitalOcean token is needed: create the droplet in the console (Ubuntu 24.04, add the public half
of `~/.ssh/lineage_site`), then run deploy.sh with its address.

## What the kit does

`deploy.sh <host>` (mode `full`) runs, in order:

1. **provision** (`provision.sh`, idempotent, as root): base packages; user `lineage` (no password, no
   sudo, root's authorized key); ufw deny incoming except 22, 80, 443; fail2ban for sshd; unattended
   upgrades; sshd keys only; journald capped at 500 MB; a 4 GiB swapfile when RAM is under 8 GiB;
   Docker (`docker.io` from Ubuntu, `lineage` in the docker group); Bun 1.3.13 checked against the
   release's SHASUMS256.txt; Caddy from the Caddy project's apt repository (memory cap 256 MB).
2. **ship**: `git bundle` of HEAD (the repo has no remote; the working tree never ships; `DEPLOY_REF=<commit>`
   ships an ancestor), cloned on the server into `/opt/lineage/releases/<sha>` as `lineage`, then
   `bun install --frozen-lockfile`.
3. **sandbox images and amd64 calibration**: builds the images the served recipes use
   (`lineage/rust:m1`, `lineage/python:m1` for the default set) from `images/<class>` on the server, then
   `arch-recipes.ts` re-pins `fixture-b58`, `base58-py`, `minbpe` (or `LINEAGE_RECIPES`) in that release
   only: `requires.arch` to the server's arch and the image pin to the image id built there. Why: the
   committed recipes pin arm64 image ids measured on an Apple M4; cachegrind counts and image ids differ
   on amd64, so an amd64 reference runner and amd64 verifiers can only serve recipes calibrated on amd64.
   The re-pinned recipe has a new recipe id, so the site has its own lineages, calibrated on the server
   by its reference runner (step 6). Images are never rebuilt with `--pull`, so their ids, the recipe ids
   and the lineages stay the same across deploys. An arm64 server (not offered by DigitalOcean; Hetzner
   CAX, AWS Graviton) whose images match the committed ids keeps the recipes as committed.
4. **keys** (see "Secrets"): makes the site's own keys on the server and copies only the keys the
   server needs from this machine, checked by public key first.
5. **fund and chain**: `fund-site.ts` runs here (the deployer key stays here): SOL and tLINE to the
   site's verifier owner, SOL to the Core authority. Then `site-chain.ts` on the server registers the
   site's reference runner and two verifiers on devnet (`register` with the server's capabilities digest,
   `bond` min_bond for the two verifiers), owner = the site's owner key. Every transaction is appended
   to `scripts/deploy/SITE-DEVNET.md`.
6. **activate**: backs up Core's database (when the release changes), switches `/opt/lineage/current`,
   writes `/var/lib/lineage/site/network.json` (config/network.json plus the devnet `chain` block, daily
   epochs), installs the units and the Caddyfile, restarts, waits for health, then starts
   `lineage-bootstrap` (recipes, snapshots, reference flag, calibrations: minutes per recipe) and the
   workers.

| Unit | What | Listens | Memory cap |
|---|---|---|---|
| `lineage-core` | Core, chain mode devnet, data `/var/lib/lineage/core` | 127.0.0.1:9660 | 1 GB |
| `lineage-web` | dashboard, Wallet page, `/chain` RPC proxy and faucet | 127.0.0.1:9661 | 768 MB |
| `lineage-gate` | rate limits, CORS, method and path allowlists, body cap and read deadline, stream cap (`gate.ts`) | 127.0.0.1:9662 | 1 GB (256 MB was OOM-killed on an event-stream backlog) |
| `lineage-indexer` | market indexer (`packages/indexer`): agent tokens, DBC and DAMM v2 trades, fee cranks, holders; read API `/market/*`; data `/var/lib/lineage/indexer/market.db` | 127.0.0.1:9668 | 256 MB |
| `caddy` | HTTPS for `<ip-dashes>.sslip.io` and `DOMAIN`, gzip, security headers (CSP, HSTS, nosniff, frame DENY, Permissions-Policy, COOP); everything to the gate | 80, 443 | 256 MB |
| `lineage-bootstrap` | one shot per deploy: lineages for the served recipes | | 1 GB |
| `lineage-reference` | reference runner (calibrations, reference replays, audits) | | 1 GB |
| `lineage-verifier@v1`, `@v2` | two honest verifiers, bonded on devnet | | 1 GB each |
| `lineage-author@<name>` (optional, one per name in `AUTHORS`) | TEST author agent of recipe `<name>`, scripted candidates | | 1 GB each |
| `lineage-runtime` (optional, disabled) | hosted runtime (`packages/runtime`) | | 1 GB |

`lineage-gate`, `lineage-web` and `lineage-indexer` need no Docker and run with systemd sandboxing on top of `NoNewPrivileges` and `ProtectSystem=full`: private devices, kernel and cgroup protection, no namespaces, no capabilities, `AF_INET`/`AF_INET6`/`AF_UNIX`/`AF_NETLINK` only and the `@system-service` syscall set (the gate also `ProtectHome=yes`). All units still run as the one `lineage` user, which is in the docker group (accepted for this devnet site; see docs/AUDIT.md, Offchain). Check a unit with `systemd-analyze security <unit>`.

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
| `/market/*` (gate to `lineage-indexer`) | GET, HEAD, OPTIONS (the indexer answers its own preflight) | 240 per minute, burst 120 | the indexer's (`*` unless `LINEAGE_CORS_ORIGINS`) |
| `/souls/*` | refused (405): drafts spend the model key, and opening them on the site is an owner decision | | |

"Per client address" means per IPv4 address or per IPv6 /64 (an IPv4-mapped address counts as its IPv4); the gate holds at most 50,000 buckets (least recently used evicted). A stream slot is reserved before the upstream answers. Upstreams see one `X-Forwarded-For` and no `Forwarded`, `X-Real-IP`, `Cookie` or `Authorization` from the client. Bodies over 64 KB are refused by the gate as soon as they pass the cap (256 KB by Caddy), and a body must arrive within 10 s (408). Core's write API is not public on this
site: outside workers cannot join through it (open `POST /v1/*` in `gate.ts` when they should).

### Market indexer (launchpad L2)

`lineage-indexer` runs `bun packages/indexer/src/main.ts --port 9668 --host 127.0.0.1 --db
/var/lib/lineage/indexer/market.db --interval 15` (systemd `StateDirectory` makes the data directory).
It is one of the core units in `remote.sh` (enabled, restarted and stopped with Core, the dashboard and
the gate), sends nothing on chain and holds no key. RPC: the chain resolver
(`packages/chain/src/endpoint.ts`): `LINEAGE_DEVNET_RPC` in `/etc/lineage/site.env` if set, else
`HELIUS_DEVNET_RPC` in `~lineage/.config/lineage/rpc.env` (copied only when it exists on this machine),
else public devnet. It never prints the URL (`/market/status` shows the host only). Sources per token:
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

Never printed by any script; keys are compared and reported by public key only. All key files on the
server are owned by `lineage`, mode 600, in mode 700 directories.

| File on the server | Public key | Origin | Used by |
|---|---|---|---|
| `~lineage/.config/lineage/site/admin.json` | made on the server | `site-keys.ts` | Core `--admin-key` (only its public half is read), bootstrap |
| `~lineage/.config/lineage/site/owner.json` | made on the server | `site-keys.ts` | owns the site's verifiers on chain (pays their burn and bond) |
| `~lineage/.config/lineage/site/verifier-{ref,v1,v2}.json` | made on the server | `site-keys.ts` | reference runner and verifiers |
| `~lineage/.config/lineage/devnet/core-authority.json` | `CjNUnQ3v2FRQJiMr16CfaFWCdzJ3nqq1VvY2zAgsc4j9` | copied from this machine | Core's chain bridge: `post_epoch`, `slash`, `migrate_agent` |
| `~lineage/.config/lineage/devnet/faucet.json` | `FX4UjRbmbLHJ6K6RTvYcV4bFA9Yai2qntnPNex31GiH6` | copied | the Wallet page's tLINE faucet |
| `~lineage/.config/lineage/devnet/agent-<name>.json` (WITH_AUTHOR=1, each name in `AUTHORS`) | minbpe `BFPxdave7NVSXztGEZA5iZ7FiBDKRsuZmS9wZn2J1WBV`; the others as `site-authors.ts` printed them | copied | `lineage-author@<name>` |
| `~lineage/.config/lineage/devnet/runtime-authority.json` (WITH_RUNTIME=1) | `DCmdy5MoAfnN6fn3nVW27db62ZwtjoksqSqdjAc8VPk4` | copied | `lineage-runtime` (Core only gets the public key file `runtime-authority.pub`) |
| `~lineage/.config/lineage/model.env` (WITH_RUNTIME=1) | | copied | `lineage-runtime` |
| `~lineage/.config/lineage/rpc.env` (only if it exists here) | | copied | the dashboard's RPC proxy, status |

The devnet deployer key (`CVEZW...`, registry and launch admin, upgrade authority) never leaves this
machine. A key already on the server with a different public key is never replaced (deploy stops).
Core's chain bridge uses the keyed RPC from `rpc.env` when it is on the server, and the public devnet RPC
otherwise. Core publishes `chain.rpc_url` at `GET /v1/chain` redacted to its host.

**One Core authority at a time.** The site's Core holds the registry's Core authority key and posts
every epoch it closes (daily), oldest first, never at or before the chain's last epoch. While the site
runs, `scripts/devnet/e2e-devnet.ts` on this machine (which posts epochs with the same key) races it:
whichever posts epoch N first wins and the other's epoch N is refused. Stop the site's Core
(`deploy.sh <host> stop`) for the duration of a devnet e2e run, or run the site read only (delete
`devnet/core-authority.json` on the server; its Core then only reads). The same holds for the runtime
authority: run `lineage-runtime` on the site or on this machine, not both.

## The full lineage set (FINISH W3)

Deployed 2026-10-08 with:

```sh
bun scripts/deploy/site-authors.ts --recipes base58-py,base58-rs,bitcoin-base58,geth-rlp,lc-text-splitters,ollama-tokenizer,solana-config,zig-clap
LINEAGE_RECIPES=fixture-b58,base58-py,minbpe,base58-rs,bitcoin-base58,zig-clap,fixture-zigsize,fixture-cu-tally,solana-config,lc-text-splitters,ollama-tokenizer,geth-rlp \
WITH_AUTHOR=1 AUTHORS=minbpe,base58-py,base58-rs,bitcoin-base58,zig-clap,solana-config,lc-text-splitters,ollama-tokenizer,geth-rlp \
  scripts/deploy/deploy.sh 157.245.71.188 code
```

Keep geth-rlp last in `LINEAGE_RECIPES`: lineage-bootstrap calibrates in list order, and geth-rlp alone takes
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

**Authors.** Chain mode only lets a launched agent author on lineages of the repository named at launch
(`target_repo`), so each repository has its own TEST author agent. `site-authors.ts` launched them on
devnet, funded each compute vault above Core's wake threshold (2,500 tLINE, TEST), and called
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
printed (public key and byte count only); the runtime redacts the key from every log line. `lineage`
is the user every site unit runs as (docs/AUDIT.md OFF-D10), so the other units could read the file too.

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
ssh ... journalctl -u lineage-runtime | grep -E 'started|attempt|spend window|global runtime cap'
```

Run the runtime authority on the site only: a local `scripts/runtime/devnet-run.ts` with the same key
races its usage epochs.

## GitHub identity service

`lineage-identity` (packages/identity, SPEC 13.9 "Identity service") runs as the dedicated user
`lineage-identity`, not in the docker, sudo or lineage groups. It listens on 127.0.0.1:9665, and Caddy routes
`/identity/*` to it directly, so a pasted token never passes the gate or Core. `remote.sh activate`
sets it up idempotently:

- makes the user;
- gives `/var/lib/lineage` traverse-only permission for others (`o+x`; every directory under it keeps its own mode);
- makes `/var/lib/lineage/identity` and `/etc/lineage-identity` (both mode 700);
- makes the 32-byte key `master.key` once on the server (it is never copied anywhere);
- writes `identity.env` with the keyed RPC from lineage's `rpc.env`;
- copies the site admin key to `core-key.json` (Core accepts PR records from it).

`lineage-identity-cycle.timer` runs the mirror and PR bot cycle every 5 minutes as the same user.

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
ssh -i ~/.ssh/lineage_site root@<host> journalctl -u lineage-core -f
```

`status` prints the Core authority's and the site owner's SOL, the faucet's SOL and tLINE, and the
registry vaults as Core last read them. Top-ups: `fund` (site owner, Core authority from the deployer),
`apps/web/scripts/fund-faucet.ts` (faucet). Private canaries go in `/var/lib/lineage/canaries/<recipe name>/`
(Core rereads it every 60 s); without them the site injects none.

## Roll back

```sh
scripts/deploy/deploy.sh <host> rollback              # previous release, data kept
scripts/deploy/deploy.sh <host> rollback --with-data  # also restores the Core database backed up when the current release was activated
scripts/deploy/deploy.sh <host> code                  # forward again (or DEPLOY_REF=<commit>)
```

Each activation of a new release backs up `core.db` (`sqlite3 .backup`) to `/var/lib/lineage/backups/`
(last five kept). Core's migrations only go forward, so roll back with `--with-data` when the newer
release added a migration; the data replaced by the restore is kept next to the backups.

## Stop

```sh
scripts/deploy/deploy.sh <host> stop        # every lineage unit and Caddy stopped and disabled (site offline, data kept)
scripts/deploy/deploy.sh <host> start
scripts/deploy/deploy.sh <host> wipe-keys   # remove the keys copied from this machine and the keyed RPC URL in network.json
```

To retire the server: `stop`, `wipe-keys`, then destroy the droplet. The site's verifiers keep their
devnet bonds until their owner key (on the server) requests an unbond; back up
`~lineage/.config/lineage/site/` first if those bonds should be recovered.

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
registration and bonds: three burns of 1 tLINE and two bonds of 5 tLINE, plus fees and rent. The model
spend of the optional runtime is real money and is capped by `runtime.json`.

## Tested

`scripts/deploy/dryrun.sh` runs the real deploy.sh over real ssh against a local systemd Ubuntu 24.04
container (`jrei/systemd-ubuntu`, pinned by digest, amd64, label `lineage=1`, removed afterwards). There is
no Docker in that container, so the sandbox units are skipped there and nothing is sent on chain (fund
and site-chain run as plans); Core runs in devnet chain mode read only and Caddy uses internal TLS. The
last result is `scripts/deploy/DRYRUN-LAST.json`. Gate unit tests: `bun test scripts/deploy`. The sandbox
units, the amd64 recalibration and the devnet registration run for the first time on the real server.

**Other front ends.** A front end on another domain that proxies to this site (the Vercel build in
`scripts/deploy/vercel/` rewrites `/chain`, `/api`, `/live` and `/souls` here) forwards the browser's
Origin, and the gate only accepts wallet writes (`/chain/rpc`, `/chain/faucet`) from listed origins. List
them at deploy time: `EXTRA_ORIGINS=https://lineage-sable.vercel.app,https://lineage-garage.vercel.app`.
