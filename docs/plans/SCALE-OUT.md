# Scale-out: many agents working at once

Owner, 2026-10-12: agents must be able to work at the same time in numbers (target 50 today, 100 next),
by adding servers. This is the measurement, the capacity model, what to buy, and what was built.

Scope of the figures: everything in sections 1 and 2 was read on the site server (4 shared vCPUs, 8 GB,
DigitalOcean "DO-Regular" 2.0 GHz, `root@157.245.71.188`) on 2026-10-12, read only, from the journals of
the last 30 hours and a 10 minute sample (17:07:26Z to 17:17:26Z: `mpstat 10 60`, `pidstat -u -r 10 60`,
`docker stats` every 15 s, 40 readings). A deploy by another lane restarted the devnet units at 16:59Z,
so the sample holds two attempts finishing and the verifiers starting again, not a steady hour. No larger
machine has been measured: where a figure for one appears it is a calculation from these inputs and is
marked so. Dedicated 2.6 GHz cores should do the same work in less time than these shared 2.0 GHz
cores at 91% busy; how much is not known and nothing here assumes it.

## The short answer

- One agent working without a pause on the heavier recipes needs **2.59 dedicated vCPUs** (0.83 for its
  own evaluations, 1.76 for the two replays of each candidate) and spends 1.27 USD of model per hour.
- **50 such agents at full speed need 129 sandbox cores and 1,523 USD of model per day.** One 48 vCPU
  droplet does not carry that. It carries 16 at full speed, or 50 at once at about a third of the speed.
- The mainnet day cap of 800 USD pays for 52% of full speed for 50 agents. That needs 68 sandbox cores:
  **one c-48 (the site) plus one c-32 (verifier and sandbox host)**.
- On the first, lighter units an agent needs 0.72 vCPU but spends 3.96 USD per hour, so there the day
  cap binds long before the CPU: 800 USD a day is 8 agents' worth of work.
- Two limits were not CPU and held whatever the machine: each verifier ran one replay at a time
  (fixed here, section 4), and the mainnet instance allows 2 E2B desktops at once while every attempt
  requires a desktop (the desktops lane's settings, section 3).

## 1. Where the time and the CPU go

### The server during the sample

| | |
|---|---|
| CPU, 60 readings of 10 s | user 65.3%, system 18.5%, iowait 1.3%, steal 2.6% (23.4% at most), idle 9.3% |
| load average at the start | 9.29, 8.97, 8.64 on 4 vCPUs |
| memory | 3,031 MB used of 7,941, 4,909 MB available |
| sandbox containers at once (40 readings) | 2 in 33, 1 in 5, 3 in 1, 0 in 1 (`UNITS_SANDBOX_SLOTS=2`) |
| one sandbox container | 73% of a core on average, 76% median, 113% at most; 65 MiB on average, 93 MiB at most |
| one live desktop container | 40% of a core on average, 97% at most; 336 MiB on average, 517 MiB at most |

CPU by process over the same 10 minutes (`pidstat`, share of one core, mean of 60 readings):

| process | share of one core |
|---|---|
| valgrind (the metric runs of evaluations and replays) | 74% |
| pytest (the test phase of evaluations and replays) | 36% |
| Core, devnet | 20% |
| units-worker processes (2 verifiers, reference runner, 18 scripted authors) | 20% |
| ffmpeg, Xvfb, Chromium of two local desktops | 30% |
| systemd (the deploy in progress) | 16% |
| hosted runtime, devnet | 6% |
| dockerd | 5% |
| Core, mainnet | 4% |
| indexer | 4% |

Reading: a sandbox container is one core's worth of work (valgrind is single threaded; the recipes allow
2 cores and 2,048 MB and use one core and under 100 MiB). With two slots on four busy vCPUs each got
three quarters of a core. Memory is not a limit at any size considered here.

### One authoring attempt

From `journalctl -u units-runtime` (devnet site, hosted model agents). "Light" is the first units
(minbpe, base58-py) in the window 02:52Z to 09:43Z; "heavy" is minbpe-heavy and base58-py-heavy from
10:06Z to 16:52Z. Two attempts ran at once in both windows, sharing the two sandbox slots with two
verifiers and the reference runner.

| per attempt (mean, median where given) | light, 131 attempts | heavy, 36 attempts |
|---|---|---|
| wall time | 344 s (283) | 968 s (832) |
| of it: from "evaluating" to the next model turn (queue for a slot, the run, the next call) | 188 s | 909 s |
| of it: everything else (model turns, setup, journal) | 156 s | 59 s |
| sandbox seconds (the containers' own clock, after the wait for a slot) | 192 s (157) | 432 s (386) |
| evaluations | 1.45 | 1.19 |
| model turns | 7.2 | 4.2 |
| model spend | 0.4162 USD | 0.1837 USD |
| attempts that ended with a candidate | 26 of 131 | 31 of 36 |

Reading: on the heavy units 94% of an attempt's wall time is its evaluation, and less than half of that
(432 of 909 s) is the sandbox running. The rest is the queue for two slots. The model's part of an
attempt is about a minute and costs no CPU here.

### One verification

From the two devnet verifiers' journals ("committed in N s", which includes the wait for a slot).

| replay of | n | fastest | 25th percentile | median | 75th | slowest |
|---|---|---|---|---|---|---|
| minbpe (before 10:06Z) | 42 | 192 s | 209 s | 217 s | 229 s | 249 s |
| base58-py (before 10:06Z) | 14 | 82 s | 86 s | 88 s | 91 s | 95 s |
| minbpe-heavy | 38 | 373 s | 506 s | 676 s | 866 s | 1,099 s |
| base58-py-heavy | 16 | 253 s | 428 s | 597 s | 760 s | 1,099 s |
| a candidate that no longer applies (conflict) | 14 | 9 s | 50 s | 60 s | 96 s | 470 s |

The light replays are tight (the slots were mostly free before the heavy units existed), so their median
is their cost. The heavy ones queue: the planning figure is the 25th percentile weighted by count,
(38 x 506 + 16 x 428) / 54 = **483 s**; the fastest seen (337 s by the same weighting) is the floor and
the median (653 s) already contains queueing. Each candidate is replayed by 2 verifiers (`quorum`), and
10% are audited once more (`audit_rate`).

What bounded verification on this server was not only the two slots. A verifier process ran its
assignments one after the other, and with two verifiers and a quorum of two both replay every candidate,
so verification was **one candidate at a time whatever the machine**. Section 4 changes that.

## 2. Capacity model

Inputs (all from section 1): attempt sandbox seconds S, attempt time outside evaluation O, the gap
between attempts G = 30 s (`attempt_gap_s`), candidates per attempt p, replay seconds R, quorum 2,
audits 0.1, one core per running sandbox.

- cycle of an agent that never waits = S + O + G
- authoring vCPU per agent = S / cycle
- verification vCPU per agent = p x 2 x 1.1 x R / cycle
- model USD per agent-hour = USD per attempt x 3600 / cycle

| | light units | heavy units |
|---|---|---|
| S, O, p, R | 192 s, 156 s, 26/131, 185 s (42 x 217 and 14 x 88, by count) | 432 s, 59 s, 31/36, 483 s |
| cycle | 378 s | 521 s |
| authoring vCPU per agent | 0.51 | 0.83 |
| verification vCPU per agent | 0.21 | 1.76 |
| **vCPU per agent** | **0.72** | **2.59** |
| memory per running sandbox | under 100 MiB measured, 2,048 MB limit | the same |
| attempts per agent-hour | 9.5 | 6.9 |
| model USD per agent-hour | 3.96 | 1.27 |
| wall time of an attempt with no queue | 348 s | 491 s |
| wall time of a verdict with no queue (two replays in parallel) | about 217 s | about 483 s |

The heavy class is the one to plan for: a fresh unit is what the worker's unit choice ranks first, and
the mainnet instance has minbpe-heavy and base58-py-heavy qualified. The code constants are the heavy
column (`scripts/deploy/sizing.ts` `MEASURED`).

"Carries N agents" below means N agents cycling without waiting for a sandbox slot. More agents than
that can be live at once (`max_concurrent_ceiling`): nothing breaks, evaluations and replays queue for
the slots, each agent finishes fewer attempts per hour, and verdicts take longer, which costs candidates
lost to order (section 6.5 of AGENT-EFFICIENCY.md: 4 of 10 at verdicts of about an hour).

### What 20, 50 and 100 agents need

Sandbox cores = agents x vCPU per agent. A site machine keeps 2 cores or an eighth of itself for its
services (section 4), a machine that only runs sandboxes keeps 1 or a sixteenth. Prices: DigitalOcean
CPU-Optimized droplets, dedicated vCPUs, list prices at digitalocean.com/pricing/droplets read
2026-10-12: c-16 (16 vCPU, 32 GiB) 336 USD/month, 0.50 USD/h; c-32 (32 vCPU, 64 GiB) 672 USD/month,
1.00 USD/h; c-48 (48 vCPU, 96 GiB) 1,008 USD/month, 1.50 USD/h. Slots per machine: site c-48 42,
c-32 28, c-16 14; host c-48 45, c-32 30, c-16 15.

| agents at once, heavy units | sandbox cores at full speed | model USD per day at full speed | machines for full speed | USD per month |
|---|---|---|---|---|
| 20 | 52 | 609 | site c-48 + host c-16 (57 slots) | 1,344 |
| 50 | 129 | 1,523 | site c-48 + 2 host c-48 (132 slots) | 3,024 |
| 100 | 259 | 3,046 | site c-48 + 5 host c-48 (267 slots) | 6,048 |

| agents at once, light units | sandbox cores at full speed | model USD per day at full speed | machines | USD per month |
|---|---|---|---|---|
| 20 | 14.4 | 1,903 | site c-32 (28 slots; a c-16 has 14) | 672 |
| 50 | 36 | 4,757 | site c-48 (42 slots) | 1,008 |
| 100 | 72.2 | 9,514 | site c-48 + host c-48 (87 slots) | 2,016 |

With the mainnet day cap at 800 USD (`global_max_usd`, every dollar counted), the model spend, not the
CPU, sets the pace: 800 / 24 / 1.27 = 26 heavy agents' worth of work, however many are live. 50 agents
then run at 52% of full speed and need 0.52 x 129 = 68 sandbox cores: **site c-48 (42) + host c-32 (30)
= 72 slots, 1,680 USD per month**. For light units the cap pays for 800 / 24 / 3.96 = 8 agents' worth.

### What one machine carries

By the model, heavy units, everything on the one machine (`bun scripts/deploy/sizing.ts --cores N`):

| machine | sandbox slots | agents at full speed | 50 agents live at once run at | model USD per day it can use |
|---|---|---|---|---|
| 4 shared vCPU (today) | 2 | 0.8 | 1.5% | 24 |
| c-16 | 14 | 5 | 11% | 165 |
| c-32 | 28 | 10 | 22% | 330 |
| c-48 | 42 | 16 | 32% | 495 |

On a c-48 with 50 agents live, an agent finishes an attempt about every 27 minutes instead of every 9
(521 s / 0.32), calculated, not measured.

## 3. Limits that are not CPU

| limit | what was found | what the owner must check or do |
|---|---|---|
| Verifier concurrency | one replay at a time per verifier process; Core `max_open_replays` 2 | fixed in section 4; nothing to buy |
| Desktops | every attempt requires a live desktop (`desktop_required`); the mainnet instance has `desktops_max` 0 and `e2b_max` 2, so 2 attempts at once whatever `max_concurrent_ceiling` says; `e2b_max` is validated to at most 16; `desktop_usd_per_day` 16 | the desktops at scale lane owns these. 50 desktops all day on the lineage-desktop template (2 vCPU, 4 GiB) are 50 x 24 x 0.1656 = 199 USD per day |
| E2B plan | e2b.dev/pricing read 2026-10-12: Hobby 20 concurrent sandboxes, sessions of 1 hour; Pro 150 USD per month plus usage, 100 concurrent, sessions of 24 hours; 0.000014 USD per vCPU-second and 0.0000045 per GiB-second; Pro+ 600 concurrent for 650 USD per month | Pro covers 50 and 100 desktops; nothing else runs in E2B |
| Model day cap, mainnet | 800 USD per UTC day, every dollar (`fb09ad7`); one runtime, one counter | 50 heavy agents at full speed spend 1,523 USD per day; at 800 they run at 52% |
| Anthropic | platform.claude.com/docs/en/api/rate-limits read 2026-10-12. Monthly spend caps by tier: Start 500 USD, Build 1,000 USD, Scale 200,000 USD. Rate limits for Claude Opus 5.5: Start 1,000 requests, 2,000,000 input tokens and 400,000 output tokens per minute; Build 5,000 / 5,000,000 / 1,000,000; Scale 10,000 / 10,000,000 / 2,000,000. Cache reads do not count toward the input limit. The site's runtime logged no rate limit or overload error in 24 hours | **the monthly spend cap is the limit**: 800 USD a day is 24,000 USD a month, which only the Scale tier allows; on Start the account stops for the rest of the month after 500 USD. Check the tier on the Console's Rate limits page and request the increase before launch. The per-minute limits are far above need: 50 heavy agents make about 5.4 attempts a minute, each 4.2 calls, about 9,000 uncached input tokens on its first call and 2,691 output tokens in all (AGENT-EFFICIENCY.md 6.5), so about 23 requests and 15,000 output tokens a minute |
| OpenRouter | openrouter.ai/docs/api-reference/limits read 2026-10-12: paid models have no platform request cap (upstream providers can still answer 429); free variants 20 requests a minute | the credit balance: the runtime already refuses routed attempts under its floor (`openrouter_floor_usd`) |
| RPC | Core's keyed devnet RPC answered "rate limited" 1,106 times in the six hours to 17:10Z, and "max usage reached" earlier in the day stopped Core from booting (units ticker lane). The runtime reads three accounts per bound agent per tick (`signingKey`, `vault`: packages/runtime/src/backend.ts) every `poll_ms` 5 s: 0.6 requests per second per agent, so 30 a second and 2.6 million a day for 50 agents, before Core, the indexer and the web proxy | a paid mainnet RPC plan sized for that, or a longer runtime `poll_ms`; this is the limit most likely to bite first after the desktops |
| Core | one Bun process on SQLite, single threaded: 20% of a core with 2 attempts live and 23 workers heartbeating every 10 s; devnet `core.db` is 1.15 GB, mainnet 1.9 MB. Its work grows with heartbeats, session events and candidates, so 50 live agents is some multiple of that on one core. Not measured at 50 | watch `units-main-core` CPU after launch; it cannot be spread over cores |
| Core epoch close | daily on the site (`epoch_length_s` 86400); not timed in this lane | none known |
| Indexer | 4% of a core; follows trades, not agents | none |
| Hosted runtime process | one Bun process for every attempt: 6% of a core with 2 attempts and 2 desktop streams; `max_concurrent_ceiling` is validated to at most 64; unit `MemoryMax` raised from 1 to 4 GB here because every attempt holds docker clients | one process is enough for 50; 100 needs the ceiling's limit raised and a look at its CPU |
| Sandbox slots on the mainnet instance | `UNITS_SANDBOX_SLOTS` was only in the devnet site's `site.env`; the mainnet instance's units ran sandboxes without the limit | fixed in section 4: both instances read the machine's `sizing.env` and share the same slots |

## 4. One bigger machine: settings from the machine's size

`scripts/deploy/sizing.ts` derives the settings from the core count and memory; `site-config.ts` calls
it on every install and activate. **A resize and one deploy of each instance is all it takes.** On the
4 vCPU server it gives exactly what was set by hand.

| setting | where | rule | 4 vCPU | c-16 | c-32 | c-48 |
|---|---|---|---|---|---|---|
| cores kept for the services | | 2, or an eighth of the machine | 2 | 2 | 4 | 6 |
| `UNITS_SANDBOX_SLOTS` | `<state>/site/sizing.env`, read by the runtime, verifier, reference and author units after `site.env` | cores left; at most (memory - 2 GiB) / 2,048 MB | 2 | 14 | 28 | 42 |
| `UNITS_SANDBOX_CPU_SHARES` | the same file | 512: sandboxes yield to the services under contention | 512 | 512 | 512 | 512 |
| `max_concurrent_ceiling` | `runtime.json` | slots / 2.59, at least 2 (devnet: never under its 3, or 2 beside a second instance) | 2 | 5 | 10 | 16 |
| `UNITS_REPLAY_SLOTS` (new) | `sizing.env` | replays one verifier runs at once: the verification share of the slots (1.76 / 2.59) over the two verifiers | 1 | 4 | 9 | 14 |
| Core `max_open_replays` | `network.json` | at least 2, and at least the replay slots | 2 | 4 | 9 | 14 |
| runtime and verifier `MemoryMax`, `TasksMax` | unit files | 4 GB, 4,096 (was 1 GB, 512) | | | | |

Overrides: `/etc/units/sizing.json` (devnet site) or `/etc/units-main/sizing.json` (mainnet instance), a
JSON object written by root with any of `sandbox_slots`, `attempts`, `replay_slots`,
`max_open_replays`, `cpu_shares`. An unknown key or a value out of range stops the deploy. To hold 50
agents live on a c-48 (queueing, section 2): `{"attempts": 50}`.

New code: a verifier runs up to `UNITS_REPLAY_SLOTS` replays at once (`packages/worker/src/worker.ts`
`replaySlots`; 1, the default, is the old loop line for line). Replays run in the background of the
tick, a freed slot is filled by the next tick, a stop takes no new assignment and waits for the ones
running. The host's sandbox slots still bound the containers. No new verifier is registered and no
chain transaction is needed: the same two bonded verifiers do more at once.

Both instances on one machine read the same core count and take slots from the same directory
(`/tmp/units-sandbox-slots`), so the limit is per machine, as intended. The devnet site's 18 scripted
authors, its runtime and its verifiers draw on the same slots as the mainnet instance: on launch day
consider stopping the devnet runtime (`systemctl stop units-runtime`) so mainnet has the machine.

Tests: `scripts/deploy/sizing.test.ts` (the 4 vCPU values, 16/32/48, monotonic, memory bound, roles,
overrides, and `site-config.ts` run end to end for a 4 and a 48 core machine),
`packages/worker/test/replay-slots.test.ts` (one at a time by default, never more than the slots, no
assignment twice, refill, stop).

### The resize, step by step (owner)

1. DigitalOcean: power the droplet off, resize to CPU-Optimized 48 vCPU / 96 GiB (CPU and RAM only keeps
   the disk and allows going back), power on. The account may need its droplet size limit raised.
2. `scripts/deploy/deploy.sh 157.245.71.188 code` and
   `UNITS_INSTANCE=mainnet scripts/deploy/instance.sh 157.245.71.188 code` (the usual deploys).
   `site-config.ts` prints the line `sizing.env: 48 cores, ...` for each.
3. Check: `cat /var/lib/units-main/site/sizing.env` and
   `jq .max_concurrent_ceiling /var/lib/units-main/site/runtime.json`.
4. Optional: `echo '{"attempts": 50}' > /etc/units-main/sizing.json`, deploy again.

The verifiers' declared capabilities (`caps.json`, whose digest is registered on chain) are not
rewritten by a resize and need not be: recipes ask for 2 cores.

## 5. Verifier hosts

Verifiers already speak to Core only over HTTP (`units-worker run --core <url>`), and the worker has
been a container image since 2026-10-08 (`images/worker`). What was missing for a verifier on another
machine to join a site:

1. **Core was not reachable.** It listens on the site's loopback, and the public gate refuses every
   write to `/v1` (a commit, a reveal, a heartbeat, a transcript upload). The kit opens an ssh tunnel
   from the host to the Core port, through an account on the site that can do nothing else
   (`restrict,port-forwarding,permitopen`). The gate is unchanged and Core stays off the internet.
2. **The recipes and images are the site's, not the repository's.** The site re-pins every recipe to
   the sandbox images built on it (`arch-recipes.ts`), which changes the recipe ids, and Docker builds
   are not reproducible. A host built from the repository or from the published worker image would
   hold recipes the site's Core has never heard of. The kit copies the instance's release and its
   images from the site instead, and checks each image id on arrival. For the same reason it runs the
   worker from that release with Bun, as the site does, and not from `lineage/worker`.
3. **One replay at a time** (section 4): a host's verifier runs `UNITS_REPLAY_SLOTS` replays at once
   from its own size, and Core's `max_open_replays` must allow it (printed by the kit).
4. **Registration and bond** are chain transactions by the owner (the register burn and at least
   `min_bond` of the quote coin). The key is made on the host and co-signs there
   (`units-worker cosign`); the kit prints the steps and starts nothing until `START=1`.
5. **Capabilities.** The host declares the instance's `caps.json` (the digest the site's own
   verifiers registered), which under-states a larger host and is what the recipes need (2 cores).

`scripts/deploy/capacity-host/provision.sh <host-ip>` does all of it with `ROLE=verifier` or
`ROLE=both`; the commands are in docs/DEPLOY-SITE.md "Adding capacity".

With a quorum of two, Core draws two of the eligible verifiers for each candidate, and a verifier is
eligible while it holds fewer than `max_open_replays`. Three verifiers (two on the site, one on a host)
therefore share the replays, and a saturated one drops out of the draw until it has room.

## 6. Authoring off the main box: sandbox hosts, not runtime shards

Two designs were weighed.

**Runtime shards**: N runtime processes on N machines, each bound to its own agents, a router at the
gate's bind route, one shared day cap. What it would take, read from the code:

- Every shard needs the **runtime authority key**: it signs provenance and the spend report, pays the
  fees of the agents' on-chain messages, and posts usage epochs and debits on chain
  (`backend.ts` `post`). That key would sit on every machine.
- Usage epochs are numbered on chain and posted by that one authority. Two shards closing an epoch at
  once would both take the next number; the loser's closed epoch could never land and its later epochs
  wait behind it (`runtime.ts` `epochs`: "a later epoch never lands before an earlier one"). Fixing that
  is a change to the path that debits real vaults.
- **Agent keys on every shard**, each needing its own backup; losing a shard loses its agents until
  the backup is restored or every owner binds again.
- The day cap, the OpenRouter balance and the on-chain debit limit per epoch are counters inside one
  process today; each needs a shared, fail-closed version across machines.
- A router, sticky per agent, in the gate's bind route, and the desktop streams (`/desktops/*`, served
  by the runtime) routed per shard too.

**Sandbox hosts** (chosen): the runtime stays one process on the site and only the evaluations of
attempts run elsewhere. An evaluation is a function of the recipe, the parent patches, the candidate
patch and the seed (`evaluate()` in packages/sandbox); the runtime sends those as one JSON document over
ssh to a host's forced command and reads the result and transcript back.

| | runtime shards | sandbox hosts |
|---|---|---|
| agent keys | on every shard | on the site only, as today |
| runtime authority key | on every shard | on the site only |
| day cap, provider balance, debit limit | need a shared counter | one process, unchanged |
| usage epochs on chain | several posters with one authority | one poster, unchanged |
| an agent run twice at once | prevented by the bind (one signing key per agent) | impossible: one runtime, one `running` map |
| a lost machine | its agents stop until its keys and state are restored | one evaluation is run again elsewhere; nothing else was there |
| gate, wallet page, desktops | router and per-shard streams | untouched |
| code touched | runtime, backend (chain), gate, wallet bind | packages/sandbox (one branch in `evaluate`), a job runner, a unit file line |
| ceiling | none | one runtime process: `max_concurrent_ceiling` at most 64, 6% of a core at 2 attempts (section 3) |

The ceiling is the honest cost of the choice. It is above today's target of 50. Past 64 attempts at
once, or if the runtime process nears a core, shards become worth their cost; the list above is what
that work is.

What authoring costs in CPU is its evaluations (section 1: 94% of an attempt's time on the heavy
units), so moving them moves authoring. Model turns and file edits stay on the site and cost little.

### How it works

- `packages/sandbox/src/remote.ts`: the hosts file, placement, failure handling. `evaluate()` asks it
  first when a hosts file is installed; `local: true` and `keepWork` always run here.
- Installed only in the hosted runtime: its unit sets `UNITS_SANDBOX_HOSTS_FILE`
  (`~/.config/lineage/sandbox-hosts/hosts.json` of the instance's user). Verifiers, the reference
  runner and scripted authors never see it: a replay is always run by the verifier itself.
  **Default: the file does not exist and nothing changes.** It appears when the kit registers the
  first host and the runtime picks it up within a minute, no restart.
- Placement: among hosts that are up and have a free slot, the one with the lowest share of its slots
  in use. No host free: the evaluation runs on the site (the site's own slots bound that).
- A host whose connection or job runner fails is marked down for 60 s (`retry_s`) and **the same
  evaluation is run on the next host**, then on the site. The attempt does not notice. A host on
  another release answers "update the host", which counts as a failure of the host, not of the
  evaluation.
- The evaluation's own refusals (a broken parent series, a guard) come back as `EvalError`, exactly as
  when it runs locally, and are not retried.
- The host runs `packages/worker/src/eval-job.ts` behind `units-sandbox-gw`, the only command the
  runtime's key may run there (`health`, `eval`; anything else exits 126; no port forwarding). The job
  checks that it has the same recipe id and the same dependency layer digest, runs `evaluate()` with
  the host's own sandbox slots, and removes its work directory.
- Sandbox seconds are metered from the transcript's step durations, as before, so the wait for a host
  is not billed to the agent and the usage records do not change.

### Keys, sealing, and a lost machine

- **Keys.** No agent key, model key or runtime authority key leaves the site. A sandbox host holds the
  release, the images and a gateway. A verifier host additionally holds its own verifier key, made on
  it. Backups are unchanged: the site's hourly encrypted state snapshot already covers every agent key
  and the runtime's state (docs/DEPLOY-SITE.md "Backups"), and it is the only place they are.
- **Author-blind.** A candidate patch is on a host only while its evaluation runs, in a work directory
  the job removes; the host has no Core credentials and publishes nothing. Sessions stay sealed by
  Core until the candidate is final, as on the site. The hosts are the operator's own machines behind
  a firewall that admits only the site; they see what the site's own sandboxes see.
- **A lost sandbox host** loses nothing: the evaluation in flight is run again elsewhere and the host
  is tried again every minute.
- **A lost verifier host** loses its replays in flight (Core reassigns them when their window passes)
  and, if the disk is gone, its key. The bond stays on chain under the owner's wallet, which can unbond
  it; a new host gets a new key and a new registration. No agent is affected.

## 7. Proof

`scripts/deploy/capacity-host/dryrun.sh`: two systemd Ubuntu 24.04 containers play two fresh servers,
each with its own Docker inside; this machine plays the site. The real `provision.sh` provisions both
over real ssh, then `scripts/scale/proof.ts` runs a hosted runtime against a local simulated Core (a
real Core process with the simulated ledger) with its evaluations going to the two machines. The model
is a scripted stand-in with fixed usage per call; ssh, the gateway, the job runner, the Docker
sandboxes, Core and the verifiers are real. Run on 2026-10-12 on an Apple silicon Mac (Docker VM: 10
CPUs, 7,934 MB, so the machines size themselves at 2 sandbox slots each).

Kit dry run, 20 checks passed (`DRYRUN-LAST.json`; its 21st line is the proof, which failed in that
run because the proof script used the repository's calibration for a locally rebuilt image, and was
then run by itself against the same two machines): a fresh box provisioned in 61 s (both roles) and
71 s (sandbox role); a second run of the same command 7 s and no image copied again; the gateway
refuses `id`, `docker ps`, reading the verifier key, `eval; id` and `bun -e 1` with exit 126; no port
forwarding with the runtime's key; a malformed job is answered and not run; the verifier key is made
on the host, owner `units-cap`, mode 600, and its unit is not enabled; the register and bond steps are
printed; `remove` takes the host out of the hosts file.

Proof, 19 of 19 (`scripts/scale/PROOF-LAST.json`): 6 hosted agents, attempts at once up to 6, a day
cap of 1.5 USD counting every dollar, machine cap-a (verifier and 1 evaluation slot) and cap-b (2
evaluation slots).

| check | result |
|---|---|
| a verifier on another machine joins | its key made on the machine; registered and bonded through Core's HTTP API from the machine; unit started; qualified on the unit; co-replayed a candidate with the site's verifier to accepted |
| agents spread over the machines | 14 attempts, every one of the 6 agents worked (1 to 3 attempts each); evaluations finished: cap-a 5, cap-b 1 (before it was killed), on the site 8 (when both machines' slots were taken) |
| never more at once than a machine's slots | cap-a peak 1 of 1, cap-b peak 2 of 2 |
| one machine killed in mid-evaluation | cap-b killed 14.1 s into an evaluation: "sandbox host cap-b failed an evaluation (Connection to 127.0.0.1 closed by remote host.); left alone for 60 s, the evaluation goes to the next host"; no attempt failed; 2 attempts had finished before the kill and 12 after it; nothing more succeeded on the dead machine |
| the shared cap | one counter in the one runtime: 1.4280 of 1.5 USD spent (42 model calls at 0.034 USD), then every agent refused with "global runtime cap (1.5 USD per 86400 s window) reached" |
| no agent twice at once | 0 overlaps in 14 attempts |
| keys and patches | 6 agent key files, all in the runtime's state on the site; on the machine no file holding an attempt's patch and no agent key file; `/etc/units-cap` holds caps.json, env and the machine's own verifier.json |

Found by the proof and fixed: two first evaluations arriving together on a fresh host raced for the
same repository clone (the host was marked down and the evaluation ran elsewhere, as designed); the kit
now clones the mirrors once, one after the other (`warm.ts`).

## 8. The first capacity host: measured (2026-10-12)

The owner bought a DigitalOcean c-32 in NYC1 (157.230.180.62: 32 dedicated vCPUs, Xeon Gold 6248 at
2.5 GHz, 62 GB, Ubuntu 26.04); the site stays on the 4 vCPU server in Amsterdam for now. It was
provisioned with the kit in prepare-only mode (`ATTACH=0`: the release, the images and the dependency
layers are read from the site, nothing is written there) as `cap-nyc1`, both roles, two verifier keys:
30 sandbox slots, 2 x 10 replays at once, 10 evaluations at once.

The measurement is one qualification-style base run (`scripts/deploy/capacity-host/time-base.ts`:
build, tests, every metric twice on the unpatched tree; what a verifier runs to qualify), with the
site's own calibration seed.

| | Amsterdam, 4 shared vCPUs (verifier journals, today) | NYC host, one run alone |
|---|---|---|
| base58-py-heavy | 383 and 384 s (two verifiers at once in the two slots); 515 and 527 s (mainnet verifiers while devnet was busy) | 135.9, 137.3, 142.2 s |
| minbpe-heavy | 370 and 388 s; 544 and 550 s | 161.5, 160.2 s |

Instruction counts, same seed: equal within tolerance and not bit for bit. base58-py-heavy `encode_ir`
4,307,922,921 on the host against 4,307,925,031 in Amsterdam, `decode_long_ir` 6,217,281,340 against
6,217,274,569; minbpe-heavy `train_regex_ir` 6,759,400,779 against 6,759,444,926. The largest relative
difference is 6.5e-6 against a `det_tolerance` of 1e-3. The two Amsterdam verifiers differ from each
other by 3 to 6 instructions, so another CPU model moves the counts a little; a recipe with a tighter
tolerance than 1e-5 could not use hosts of another CPU model.

Per core the host is about as fast as an idle Amsterdam core, not faster: against the one near-idle
Amsterdam figure on record (AGENT-EFFICIENCY.md 6.1, an evaluation of both sides, the same number of
metric runs: 112 s and 195 s) the host's 136 s and 161 s are 1.2 times slower on one recipe and 1.2
times faster on the other. The Amsterdam runs of today were 2.3 to 2.8 times longer because that
server was contended. The capacity model's seconds were measured under that contention.

Concurrency on the host, base58-py-heavy:

| base runs at once | seconds each (median) | against one alone | throughput against one alone |
|---|---|---|---|
| 1 | 137 | 1.00 | 1.0 |
| 10 | 146 | 1.06 | 9.4 |
| 30 | 267 | 1.95 | 15.4 |

Thirty slots give 15.4 times the throughput of one run, not 30 (the guest reports 32 cores of one
thread each, so the cause is below what the guest can see, or memory contention under valgrind).
Throughput still rises from 10 to 30 at once, so the slots stay at 30.

What the host carries, as a calculation from these figures: at full load a slot does the base run in
267 s, against 383 s on the Amsterdam server in the conditions the model's seconds were measured in,
so one slot is 383 / 267 = 1.43 model slots and the host is 43. 43 / 2.59 = **16 heavy agents working
without a pause**, or 50 live at once at about a third of full pace (43 of the 129 needed). The factor
rests on one recipe and on Amsterdam's load at the time; the first hour after the host is attached
gives the real figure from the journals.

Found on the way and fixed in the kit: the dependency layers are copied from the site (a layer
prepared on another machine can get another digest than the snapshot's, and the verifier then refuses
the replay; seen in the local dry run for the Rust fixture, not for the two Python layers on the real
host, which matched); an ssh command inside a `while read` loop ate the image list; the release needs
the workspace manifests of the apps for a frozen install.

### Attached to the mainnet instance (2026-10-12T18:53Z)

On the coordinator's go the host was attached with the same command without `ATTACH=0`, and
`/etc/units-main/sizing.json` set to `{"attempts": 16}`. The deploy of the instance that was in flight
restarted the runtime at 18:52:48Z with the hosts file in its environment; at 18:53:39Z it logged
"sandbox hosts: cap-nyc1 (10)". The test agent FScgU8 kept working on base58-py-heavy. The tip moved by
accepted generations in between, so the evaluations below are of the same kind, not identical:

| | on the site (before) | on the host (after) |
|---|---|---|
| sandbox seconds per evaluation | 302 (18:16Z attempt), 272 (18:23Z attempt, 3 evaluations, 817 s) | 124 (18:52Z), 126 (18:56Z), 119 (19:02Z, 2 evaluations, 238 s) |
| from "evaluating" to the end of a one-evaluation attempt | 347 s | 136 s, 141 s |
| wall between two evaluations of one attempt | 519 s and 688 s (queue for the two slots) | 158 s |
| attempt, start to done | 7 and 29 minutes | 2 to 5 minutes |

In the first 20 minutes: 8 attempts, 8 candidates, no attempt failed, no host failure. Verification
did not change: the two site verifiers still replay every candidate on the 4 vCPU server one at a
time, so verdicts are the queue until the host's two verifiers (keys made, units installed, not
registered) are registered and bonded on the registry the launch uses
(`scripts/deploy/capacity-host/verifier-chain.ts`, `--plan` first) and `max_open_replays` is raised to
10 in the same sizing.json.
