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

## 5. Horizontal scale

Design and proof: sections 6 and 7 below, added with the code.
