# Agent desktops: self-hosted live desktops for hosted agents

Written 2026-10-10. The owner asked for agents to "directly operate in similar browsers as orgo, like
orgo desktops" and chose to self-host on our server rather than use Orgo or another vendor.

## What it is

A real Linux desktop per working hosted agent: a window manager, Chromium, a terminal and a code
editor. While the agent authors, its actions happen on that desktop and people watch the real screen on
the token page and the session page.

The agent's own tool loop stays the authority. Each tool call is carried out on the desktop through a
driver that performs the real actions:
- **read:** open the file in the editor and jump to the line range;
- **search:** run it in the terminal (ripgrep) and show the results;
- **edit or write:** apply the change in the editor buffer and save it;
- **evaluate:** run the sandbox command in the terminal so its real output scrolls by;
- **open repo pages:** open the GitHub file in Chromium.

The working tree the agent edits is the one on the desktop, mounted into its authoring sandbox. What
people see is what the agent actually did.

Verification does not change. Candidates are still judged only by independent sandbox replays
(SPEC 10). The desktop is the authoring workspace and the show, never the judge.

## Sealing (non-negotiable)

Edits must not be readable before the verdict (SPEC 17.3, 10.7): a visible patch can be copied and
committed first.

- The desktop uses a fixed tiled layout: editor left, terminal bottom right, browser top right. The
  editor's rectangle is therefore known.
- The live stream is encoded server side by ffmpeg capturing the X display. While the attempt's edits
  are sealed, the editor region is pixelated, and so is the terminal region whenever it shows a diff
  or test output that contains changed lines. Navigation, file names, line numbers, the cursor and the
  browser stay visible.
- A full-quality recording of the whole session is stored and published when the candidate is final,
  or when the attempt ends without one. The session panel links to it and plays it.
- Identity follows SPEC 10.7, as for sessions.

## Infrastructure

- **Image:** `lineage/desktop`, Ubuntu 24.04. Contents:
  - Xvfb at 1280x800;
  - a light window manager with a fixed tiling layout;
  - Chromium, a terminal (xterm or alacritty) and a lightweight editor (for example micro in a
    terminal, or a small GUI editor);
  - xdotool for the driver;
  - ffmpeg for the stream and the recording.
  It contains no secrets.
- **Isolation:**
  - one container per active agent session, non-root, no access to the host Docker socket;
  - outbound network only to github.com and the site, through an allowlist proxy;
  - the authoring sandbox stays separate, and the desktop runs its commands through the same sandbox
    API as before.
- **Capacity:** the site server has 4 vCPU and 8 GB, so at most 2 desktops run at once
  (`desktops_max`, TEST 2). Agents without a desktop slot keep the current reconstructed panel.
- **Streaming:** HLS (or MJPEG fallback) from ffmpeg, served through the gate at
  `/desktops/:session/live.m3u8`, with its own rate-limit class and a viewer cap. The recording is
  stored as MP4 in Core's blob store.
- **Cost:** CPU only. Model spend stays the same as now, because the agent still uses text tools; the
  desktop just carries them out visibly.

## Pages

The token page and the session page show the live desktop when the agent has one (the stream inside
the Chrome-style machine frame), otherwise the current panel. After the verdict they show the recording.

## Exit

- Locally: one agent session runs on a desktop. The stream shows navigation with the editor pixelated
  while sealed; the recording appears unredacted after the verdict.
- Unit tests for the sealing state machine.
- On the site: the standing TEST agent works on its desktop, watched through the gate. The CPU impact
  on the verifiers is measured and stays within the capacity limits.
- Headless checks only. Never use the owner's Chrome.

## Built (2026-10-10, agent desktops lane)

SPEC 17.7. `images/desktop` (Debian trixie: Ubuntu ships Chromium only as a snap), `packages/desktop`
(driver, sealing state machine, static redaction, local and E2B backends, recordings, stream handler),
Core `POST /v1/sessions/:id/recording`, worker and runtime wiring, gate route
`/desktops/<session>/{live.m3u8,init.mp4,seg-N.m4s}` (class `desktop`, 50 viewers per session, 300 in
all), the panel plays the stream and then the recording in the Chrome window, Vercel rewrite.

Deviations, each deliberate:
- **Edits show, they are not typed.** The toolbox writes the working tree (it stays the authority); the
  editor opens the file at the change with the changed lines selected. Typing the edit as keystrokes
  raced the toolbox's own write.
- **Redaction is static.** One ffmpeg filter pixelates the editor's text area and the whole run terminal
  for the stream's whole life (the gate never opens while a stream exists), so nothing at run time can
  turn it off. Instead of pixelating the terminal "when it shows a diff", there are two terminals: a
  navigation terminal that is never pixelated and only ever gets listings and `git grep HEAD` (the parent
  generation, never the working copy), and a run terminal that is always pixelated.
- **Line numbers.** micro's gutter grows with the file's digit count, so the redaction starts after the
  narrowest gutter (one digit): longer files' line numbers are pixelated past their first digit. The
  cursor line stays in the status line, and the browser shows the same lines numbered.
- **E2B** (owner decision, overflow): its default `desktop` template lacks openbox, xterm, micro and
  ripgrep, so they are installed at start (about 25 s) before egress is locked to the allowlist; a template
  with them preinstalled would skip that.

Measured:
- Local (Apple silicon, Docker): desktop up in 2.7 s; 18 % of one core steady, 100 % for a second while
  Chromium loads a page; 520 to 735 MiB.
- Site (4 vCPU amd64): up in 8.7 to 9.8 s; mean 38 % of a core over a session, 25 % steady, up to 136 %
  on page loads (capped at 1.5 CPUs); 505 to 635 MiB. Stream through the gate: 30 of 30 playlist and
  segment fetches answered 200, about 139 KB per 2 s segment (about 0.56 Mbit/s per viewer).
- Verifier impact: a single-core CPU benchmark (sha256 of 1.5 GB) took 9.53 s mean with two desktops
  running, against 8.78 s before and 7.56 s right after (6 runs each; the server's load average was 5 to
  7 from its own work before and 12 to 17 during and after a deploy), so up to about 25 % slower
  single-core work while two desktops run.
- E2B: up in 35 to 38 s (package install included); stream and recording proven; 0.0037 USD for two
  proof sessions.

## Amendment: desktop hosts, and a desktop for every working agent (2026-10-10, desktop hosts lane)

Owner decision 2026-10-10: every working agent has its own live desktop; no agent works without one.
Desktops run on dedicated desktop servers we self-host, with E2B as overflow.

### Spec

1. **Remote desktop host backend** (`packages/desktop/src/remote.ts`). A desktop host is a plain Linux
   server with Docker and the same `lineage/desktop` image. The site reaches it over ssh.
   - **Transport: ssh to a command gateway, not a Docker context and not a host agent.** Each Docker
     call is one ssh command over one multiplexed connection per host (ControlMaster, ControlPersist
     120 s), with the site's own key and the host's key pinned in a known_hosts file written at
     provision time. On the host the key's authorized_keys line is
     `command="/usr/local/bin/lineage-desk-gw",restrict`: the gateway (a short python3 script) parses the
     command and accepts only the invocations the backend sends: `docker run` of `lineage/desktop`
     with a fixed flag whitelist that must include non-root user, read-only root, `--cap-drop ALL`,
     no-new-privileges and the internal network, and never a mount, volume, device, port, host
     namespace or added capability; `docker exec` only into `lineage-desk-*` and never as root;
     `rm -f`, `inspect` and network calls on the desktop names only; `health` and `sweep`.
     Why: a Docker context over ssh gives the key the whole Docker API (root on the host), and the
     Docker CLI ignores a per-host key and known_hosts unless the global ssh config is changed. A
     small agent on the host would need its own listener, TLS, auth and lifecycle. sshd is already on
     every server, already hardened, and `restrict` turns off forwarding and ptys; the gateway keeps
     a leaked site key from becoming root on the host.
   - **Isolation exactly as now:** non-root (1000:1000), read-only root, every capability dropped,
     no-new-privileges, CPU (1.5), memory (1536m) and pid limits, no Docker socket, the internal
     network `lineage-desk` whose only way out is that host's own allowlist proxy (same
     `setupDeskNet` code as the site). Sealing and redaction are unchanged: they run inside the
     desktop (static ffmpeg filter, tile router, geometry guard).
   - **Tree:** the site's working tree is copied (tar) into a tmpfs at `/work/repo` in the desktop
     and kept current file by file, as for E2B. No bind mount of anything on the host.
   - **Stream: the site pulls.** The live HLS files stay in a tmpfs at `/stream` in the desktop. Each
     second (the guard tick) the site reads the playlist and copies new segments into its own stream
     directory (segment first, then the playlist), exactly like E2B's copy. The gate serves them from
     the site as before; viewers never reach a desktop host, and the host needs no inbound port but
     ssh from the site. Added latency: measured below.
2. **Pool across hosts** (`packages/desktop/src/pool.ts`, `placement.ts`). Order: desktop hosts, least
   loaded first (running over `desktops_max`, then running, then config order); then the site's own
   `desktops_max`; then E2B within `e2b_max` and `desktop_usd_per_day`. Capacity per host comes from
   `hostCapacity`: the measured desktop (38 % of a core mean, 635 MiB peak, site 2026-10-10) and a
   headroom policy (keep 1 vCPU and 1 GiB for the host, CPU at 70 % of the mean load, memory at 1.25
   times the peak). Health: `lineage-desk-gw health` every 15 s (reachable, Docker answers, image
   present); a check older than 45 s counts as down. A host that is down takes no new desktops. A
   desktop on it ends its live stream cleanly (session map `ended_at`, the gate answers 410, the
   driver stops) and its attempt continues without it; the slot frees when the attempt ends. Hosts
   come from `desktop_hosts_file`, re-read every minute (added, changed, removed); the first good check
   after a start removes desktops a crashed runtime left on the host.
3. **Desktop required** (`packages/runtime/src/desktop-gate.ts`, one hunk in the runtime's attempt
   callback, one in the worker). With `desktop_required` (default true when desktops are on) the
   runtime reserves a slot for the agent (held 120 s for its `begin`) before the attempt starts. With
   none free anywhere the attempt does not start: the agent's status (`waiting` in the spend report)
   reads `waiting for a desktop: <hosts, this server, E2B state>`, and the runtime tries again after
   `attempt_gap_s` (30 s on the site). If the reserved desktop then fails to start, the worker ends the
   attempt before the model runs. This sits after the self-funded lane's budget check (the vault
   decides whether an agent may work at all; the desktop gate only decides when).
4. **Provision and deploy** (`scripts/deploy/desktop-host/provision.sh <ip> [full|update]`): Docker,
   python3, ufw, the `lineage-desk` user and the gateway, the image built on the host from
   `images/desktop` (rebuilt only when that tree changed), the network and the proxy, keys-only sshd,
   ufw deny all but ssh from the site, then on the site the runtime's key, the host's key in
   known_hosts and the host in `hosts.json` (`register.ts`) with its measured capacity, and a check
   with the runtime's key. Idempotent; `update` redoes the gateway, image and proxy. Dry run:
   `scripts/deploy/desktop-host/dryrun.sh`.
5. **Until the owner creates a droplet**, E2B is the overflow for every agent beyond the site's 2: the
   site's config allows 2 local plus up to 6 E2B (6 hosted agents bound on 2026-10-10), on a template
   sized to the measured desktop, with the day cap computed below.

### E2B cost (rates read from e2b.dev/pricing on 2026-10-10)

0.000014 USD per vCPU second, 0.0000045 USD per GiB second, storage free; Hobby: at most 20 sandboxes at
once and 1 hour per sandbox. The stock `desktop` template is not 2 vCPU / 4 GiB as the code assumed: a
sandbox started from it on 2026-10-10 reported `nproc` 8 and MemTotal 8146768 kB, so it bills 8 x
0.000014 + 8 x 0.0000045 = 0.000148 USD/s, 0.5328 USD per desktop-hour (the spend record undercounted
it 3.2 times). `packages/desktop/scripts/e2b-template.ts` built `lineage-desktop` (template
4hhy2b0guzs55k4ginii) from it with the session's tools preinstalled at 2 vCPU and 4096 MiB (`nproc` 2,
MemTotal 4025412 kB on a check sandbox): 0.000046 USD/s, **0.1656 USD per desktop-hour**. A proof
attempt on it came up in 27.5 s and cost 0.0032 USD for 69 s.

Cap: with 6 bound hosted agents and the self-funded lane's attempt ceiling of 5 at once, at most 5
desktops are needed at once; 2 are on the site, so 3 to 4 on E2B. 4 E2B desktops all day: 4 x 24 x
0.1656 = 15.90 USD; 3: 11.92 USD. **Set `desktop_usd_per_day` 16 USD**, `e2b_max` 6 (the cap, not the
count, bounds spend; each running desktop is counted at its full hour until it ends). With one desktop
host of 5 slots the E2B need falls to 0 for today's agents.

### Built and measured (2026-10-10)

- `scripts/deploy/desktop-host/dryrun.sh`: 28/28 (`scripts/deploy/desktop-host/DRYRUN-LAST.json`). A
  privileged systemd Ubuntu 24.04 container with its own Docker played the droplet; this Mac played
  the site. `provision.sh full` on the fresh box exit 0 (1106 s, almost all of it the image build's
  Debian downloads; 133 s on an earlier run), again 5 s with no rebuild, `update` 3 s; the gateway refused
  `id`, `docker ps`, a privileged run, a root exec and a run with a bind mount (exit 126) and port
  forwarding; ufw let only the site in (a container on the same bridge could not reach port 22).
- A scripted attempt on a desktop on the host through the real gateway
  (`packages/desktop/scripts/proof.ts --backend host`, `scripts/deploy/desktop-host/PROOF-LAST.json`):
  desktop up in 3.3 s, 11 actions, 0 refused. **Added stream latency** (segment complete on the
  desktop, by its mtime there, to the site's copy, polled every 100 ms): 8 segments, mean 1139 ms, min
  298 ms, max 2377 ms. Each pull (playlist plus any new segment over the multiplexed connection) took
  mean 232 ms, min 79 ms, max 1723 ms over 38 pulls; the rest is the 1 s guard tick that drives the
  pull. Segments are 2 s long, so a viewer is about one segment further behind than on the site's own
  desktops. For comparison, E2B's copy from this Mac: 1105 to 1366 ms added (8 segments).
- Host failure (`dryrun-check.ts`): the host paused mid-attempt; health marked it down ("Connection
  timed out during banner exchange"), a new reserve waited with "desktop hosts: the only one is down",
  the running desktop's stream ended with 410 (`ended_why` "desktop host lost"), its slot freed when
  the attempt ended, and after unpausing the next desktop went to the host again; no desktop container
  was left on the host.
- Unit tests: `packages/desktop/test/hosts.test.ts` 9 (placement, capacity, pool across hosts with
  reserve and reasons, isolation flags, host loss with 410, hosts file reload, stream pull order, the
  gateway accepting every call the backend makes and refusing 19 escapes) and
  `packages/runtime/test/desktop-gate.test.ts` 2.

**Capacity per host** (hostCapacity; the desktop measured on the site 2026-10-10, headroom policy
above): 4 vCPU / 8 GiB: 5 desktops (CPU 5, memory 8); 8 vCPU / 16 GiB: 12 (CPU 12, memory 18). These
are planned from the site's measurement; the first real droplet should be measured under load (as on
the site: `docker stats` over a session) before raising `--max`.

**What the owner creates:** one Ubuntu 24.04 droplet in the site's region with the owner's ssh key
for root (an 8 vCPU / 16 GiB droplet carries 12 desktops by the numbers above; a 4 vCPU / 8 GiB one
carries 5, enough for today's 6 bound agents with the site's 2), then runs
`scripts/deploy/desktop-host/provision.sh <ip>`. Until then E2B covers every agent beyond the site's 2.

## Amendment: one E2B desktop per agent, 100 desktops (2026-10-12, agent desktops at scale lane)

Owner decision 2026-10-12: "every launch opens an agents new e2b sandbox and stuff, we want to have at
least enough runway for 100 launches which means 100 desktops". The owner is buying E2B's Pro plan (150
USD per month: 100 sandboxes running at once, 24 h session length, 20 GiB of storage; e2b.dev/pricing
read 2026-10-12).

### 1. What exists (before this amendment)

A desktop belongs to an ATTEMPT, not to an agent. `DesktopPool.begin` places a new desktop for each
attempt (desktop hosts, then this server, then E2B), `desktop_required` makes the attempt wait for a
slot, the attempt's end destroys it, a reaper removes what a killed runtime left. On E2B every attempt
pays the whole start (sandbox create, scripts, tree, session: 27.5 s measured 2026-10-10) and the
sandbox carries the metadata `lineage=1, attempt=<label>`. Limits: `e2b_max` 6 on the devnet site and
2 on the mainnet test instance, `desktop_usd_per_day` 16 shared by the two through
`desktop_shared` (each publishes its spend of the UTC day, the other subtracts it). Attempts at once
are limited by the server (2), whatever the desktops.

### 2. What E2B documents and what was measured (2026-10-12, installed SDK @e2b/desktop 2.4.0 on e2b 2.55.0)

Documented (docs.e2b.dev/sandbox, /sandbox/persistence, /docs/billing, /sandbox/rate-limits):
- `sandbox.pause()` saves the filesystem and the memory (running processes included);
  `Sandbox.connect(id, { timeoutMs })` resumes a paused sandbox. "Pausing a sandbox takes approximately
  4 seconds per 1 GiB of RAM", "Resuming a sandbox takes approximately 1 second".
- "A paused sandbox is kept indefinitely"; E2B never kills one by itself.
- Billing: "You pay per second for compute resources while your sandbox is running." "Once a sandbox is
  paused, killed or times out, billing stops immediately." Storage is free on every plan. Nothing is
  said about a charge for a paused sandbox's snapshot.
- Session length is "Time a sandbox can run without being paused" (1 h Hobby, 24 h Pro), "not a cap on
  how long a sandbox can exist"; "After a sandbox is paused and resumed, the continuous runtime limit
  is reset."
- Concurrency is "Number of sandboxes running at the same time" (20 Hobby, 100 Pro, add-ons to 1,100).
  The pages do not say in so many words whether a paused sandbox counts.
- `lifecycle: { onTimeout: "pause" }` at create: the sandbox is paused, not killed, when its timeout
  runs out, every time. `setTimeout(ms)` sets the timeout to that long from now.
- Create rate: 1 per second (Hobby), 5 per second (Pro).

Measured with the account's key (`packages/desktop/scripts/e2b-measure.ts`; the account is on Hobby
today):
- `lineage-desktop` sandbox (2 vCPU, 4096 MiB): create 6.4 s; pause 0.94 s and 1.02 s; resume
  (`connect`) 0.26 s and 0.36 s; first command after a resume 0.21 s. These were fresh desktops with
  little memory in use; a desktop after a session is measured in the proof below.
- A paused sandbox keeps its processes: a loop writing the clock every second and the X server were
  still there after the resume, and a file written before the pause too. A command sent to a paused
  sandbox fails with `SandboxNotRunningError` (it does not resume by itself with `autoResume` false).
- The sandbox's `startedAt` is the time of the last resume, so the session window does restart.
- Listing: a paused sandbox is listed with state `paused` and not among the running ones; the list
  filters by metadata.
- **Concurrency: a paused sandbox does not count.** On the Hobby plan (20 at once) the account held 22
  paused sandboxes and 1 running one, and one more was created without a refusal.
- `setTimeout` beyond the plan's session length is not refused: 2 h and 25 h both came back as 3,599 s
  from now (clamped to the plan's 1 h).
- **Billing of a paused sandbox was not measured**: the API has no per-sandbox cost call and the
  dashboard's usage is not readable from here. What stands is E2B's sentence above. The owner can
  check it on the dashboard's usage tab after the proof (section 6 lists the times).

### 3. What changes

A new mode, `desktop_mode: "per_agent"` (default `"per_attempt"`: nothing changes until it is set).
In it every bound hosted agent has its own E2B desktop for its whole life
(`packages/desktop/src/agent-desktops.ts`); desktop hosts and this server's slots are not used.

1. **One desktop per agent.** The sandbox carries the metadata `units_desktop=agent`,
   `agent=<agent id>`, `owner=<this runtime's label>` (`desktop_owner`; default a digest of the host
   name and the state directory, so two runtimes on one E2B account never touch each other's). At
   start the runtime lists the sandboxes with its own label and takes each agent's back (same sandbox
   id as before the restart); a second sandbox for one agent is killed; a sandbox whose agent is not
   bound to this runtime any more (unbound, or gone) is killed after `desktop_remove_after_s` (default
   300 s, so one bad read of the chain does not remove a hundred desktops). The per-attempt desktops of
   the live sites carry `lineage=1` and no `units_desktop`: this code never lists or touches them.
2. **Launch.** Binding an agent asks for its desktop in the background (at most
   `desktop_start_parallel` creates at once, default 4). The bind and the launch never wait on E2B and
   cannot fail because of it; a failed create is tried again with a growing wait and the state says
   why.
3. **Pause on idle.** A desktop is paused when its agent is asleep (vault empty), or is not in an
   attempt and has not been for `desktop_idle_s` (default 600), or when the day's budget is used up
   (idle ones at once). It is resumed inside the next attempt's start, before the session opens. When
   `e2b_max` desktops run and another agent needs to work, the longest-idle running desktop is paused
   to make room.
4. **Sessions.** The working tree is the runtime's (it stays the authority): each attempt clears the
   desktop's copy, uploads the tree and starts the desktop session; the attempt's end stops the
   session and the stream and leaves the sandbox. Sealing and redaction are unchanged.
5. **Session length and renewal.** `e2b.session_max_s` is the plan's session length (3,600 today,
   86,400 on Pro). The runtime keeps the time of the desktop's last create or resume; when less than
   `desktop_renew_before_s` (default 1,800) is left of the window and the agent is not in an attempt,
   it pauses and resumes the desktop, which restarts the window (documented and measured above; about
   1.3 s). The same check runs at the start of an attempt, before the session opens, so an attempt
   starts with at least `desktop_renew_before_s` ahead of it. A running attempt is never interrupted
   by the runtime. If E2B itself pauses the desktop under an attempt (the window ran out), the desktop
   is resumed at the next failed command; if that does not succeed within
   `desktop_resume_gap_max_s` (default 60) the live stream ends cleanly (410) and the attempt goes on
   without its desktop.
6. **A dead runtime does not leave 100 desktops running.** Every sandbox is created with
   `onTimeout: "pause"` and a short timeout (`desktop_keepalive_s`, default 900) that the runtime
   pushes forward while it lives. A runtime that dies leaves its desktops to be paused by E2B within
   that time; nothing is lost and the next start finds them.
7. **Limits (all config, admin-editable in site-config and the runtime config).** `e2b_max` is the
   most desktops RUNNING at once (what E2B counts; paused ones are free of the limit), target 100;
   `desktop_usd_per_day` as before, counted per second a desktop runs (also across a restart), and
   still shared through `desktop_shared`. At either limit a new agent launches and works as before:
   its desktop state reads why there is none (`E2B desktop limit reached: 100 of 100 running`,
   `day cap reached (...)`), and with `desktop_required` its attempt waits, as today.
8. **Pages.** The runtime's spend report carries each agent's desktop state
   (`running | paused | starting | none`, why, since); Core serves it with
   `GET /v1/agents/:id/spend`; the live panel's idle state says "Desktop paused" with the reason and
   that it resumes with the next session, or "No desktop: <why>". Text only, never a picture.

### 4. Cost (measured figures, stated assumptions)

One `lineage-desktop` sandbox (2 vCPU, 4 GiB, measured 2026-10-10 and again today) bills 0.000046
USD/s, 0.1656 USD per running hour, at E2B's listed rates. A paused one bills nothing according to
E2B (not measured, section 2). The plan fee is 150 USD per month (quoted by the owner; the same on
e2b.dev/pricing).

| Case | Desktops running on average | USD per day | USD per 30 days | With the plan fee |
|---|---|---|---|---|
| 100 desktops always running | 100 | 397.44 | 11,923.20 | 12,073.20 |
| Pause on idle, attempts at once as today (2), assumption A | 4 | 15.90 | 476.93 | 626.93 |
| Pause on idle, 10 attempts at once, assumption A | 20 | 79.49 | 2,384.64 | 2,534.64 |
| Pause on idle, 25 attempts at once, assumption A | 50 | 198.72 | 5,961.60 | 6,111.60 |
| Pause on idle, every one of 100 agents working all day | 100 | 397.44 | 11,923.20 | 12,073.20 |

Assumption A (an assumption, not a measurement): attempt slots are always full, an attempt lasts as
long as the idle time (10 minutes), and every agent that ends an attempt waits longer than the idle
time for its next one (true with 100 agents sharing a few slots). Then each slot keeps one desktop
working and one more in its idle tail: running desktops = 2 x attempts at once. A shorter
`desktop_idle_s` lowers the tail in proportion; 0 pauses a desktop the moment its attempt ends (one
desktop per slot: half the figures above) at the price of one resume per attempt (0.3 s measured).
What a desktop costs beyond its working time: its first idle time after the launch (10 minutes:
0.0276 USD per launched agent).

The arithmetic: 0.1656 x 24 = 3.9744 USD per desktop-day; x 100 = 397.44; x 30 = 11,923.20.

### 5. Built and measured (2026-10-12)

Code: `packages/desktop/src/agent-desktops.ts` (the per-agent desktops), `e2b.ts` (the account calls,
a sandbox that stays, a session opened and closed on it), `pool.ts` (the mode), runtime `config.ts`,
`desktops.ts`, `runtime.ts` (the bound agents synced every tick, the desktop state in the spend
report), Core `runtime-spend.ts` (serves it), `apps/web/src/live-panel/live-only.ts` (the words),
`scripts/deploy/site-config.ts` (the keys; both sites left on `per_attempt`). SPEC 17.7, 0.44.

Deviations from section 3, each deliberate:
- The state `starting` shows a moment after the bind, not at it: the first thing a new agent's
  desktop state reads is `none: not created yet`.
- A desktop whose agent is unbound is paused at once and killed after `desktop_remove_after_s`; it is
  removed only when the runtime has just read its agents without an error, never by the timer, so an
  RPC outage removes nothing.
- A runtime that stops leaves its desktops as they are; the ones running are paused by E2B within
  `desktop_keepalive_s` (15 minutes) unless the runtime is back before that, as in a deploy. Worst
  case for 100 running desktops: 100 x 0.25 h x 0.1656 = 4.14 USD per stop that is not followed by a
  start.
- The day budget counts each running desktop for one more idle time before it lets another start, and
  an attempt in progress is never cut short, so a day can end above the cap by at most the running
  attempts' remaining time.

Unit tests (a fake E2B account that pauses or kills at a timeout as the real one does):
`packages/desktop/test/agent-desktops.test.ts` 21 (created once; a launch never waits; found again
by the record and by the metadata alone, a second sandbox killed, other owners' and the live sites'
left alone; nothing created before the list was read; pause on idle and on sleep, resume, spend only
while running; a clean session per attempt; a refused pause; the timeout pushed and a dead runtime's
desktops paused by E2B and found again; renewal between attempts and never under one; a pause under an
attempt recovered, a kill given up; the limit with the reason and an idle desktop paused to make
room; the limit read live; the budget; no key; creates in parallel; removal after the grace time and
only on the runtime's word; the pool in this mode and unchanged in the other).
`packages/runtime/test/agent-desktops.test.ts` 7 (the bind does not wait and the report says the
state; E2B down at launch; asleep, unbound, gone, and a failed read; a restart; the config; the owner
labels; two instances sharing one budget). `packages/core/test/runtime-spend.test.ts` 1 and
`apps/web/test/live-only-desktop.test.ts` 2. `bun test packages/desktop packages/runtime`: 183 pass,
1 skip, 0 fail.

Real E2B proof, `bun scripts/desktops/proof.ts` (22/22, `scripts/desktops/PROOF-LAST.json`; a local
simulated Core, three hosted TEST agents, `units-runtime run` as its own process; no chain, no model
call; sandbox ids as prefixes):
- The three binds took 5 ms at Core and the runtime saw them 1.3 s later, with no desktop yet. The
  three desktops (i0qndx, itn7u2, i8mgm9) were created in 10.4, 11.8 and 13.4 s, all running 14.4 s
  after the binds; `GET /v1/agents/:id/spend` served `{"state":"running",...}` for each and no
  sandbox id.
- Runtime stopped and started: the same three ids, 0 creates. Stopped again and taken over by a third
  process on the same state directory: the same three ids.
- A session on one agent's desktop: ready 13.6 s after the reserve (the first one after a restart),
  first video segment on this host after 17.6 s; the sandbox still running after the session's end.
- That desktop paused after the session (browser, editor and terminals had run) in 0.5 s; E2B listed
  two running and one paused. Resumed for the next session in 0.3 s (`connect`); that session was
  ready 3.1 s after the reserve, resume included, first video after 7.1 s. A per-attempt E2B desktop
  took 27.5 s to come up (2026-10-10).
- Renewal: two desktops that had run 70 s were paused and resumed (away 0.7 and 0.9 s); E2B's
  `startedAt` moved from 17:35:15 to 17:36:26 on the same sandbox id.
- E2B pausing a desktop under an open session (its timeout set 15 s ahead and not pushed): the next
  command found it paused, the desktop was back 0.7 s later and the command answered after 1.4 s; the
  four windows were still there.
- Unbound agent: its desktop removed, the other two kept. Then all removed: the E2B list showed 0 of
  this run's sandboxes.
- Spend by the runtime's own count (seconds running x 0.000046 USD): 0.0125 USD; at most 0.0152 USD
  (three desktops for the run's 110 s). The first run of the proof: 0.0083 USD.

The page: a headless Chromium check at 1280 and 390 on a local dashboard and Core
(`work/agent-desktops-shots/`, not in the repository) showed "Desktop paused: agent idle" and "No
desktop: E2B desktop limit reached: 100 of 100 running" as text on the agent's screen, no video
element shown, no horizontal scroll; an agent of a runtime in the other mode read as before.

What was not measured: E2B's own bill for a paused sandbox (section 2), a real pause refused by E2B
(503), 100 desktops at once (the account allows 20 running today), and a desktop paused for days.

The session length itself, measured on the account's present plan (1 h; `e2b-measure.ts long`): one
small sandbox with `onTimeout: "pause"` had its timeout set to 10 minutes from now every 5 minutes.
Up to minute 45 E2B answered 600 s left each time; at minute 50 it answered 592 s and at minute 55
290 s: the timeout is clamped to the sandbox's start plus the session length. At minute 60 the
sandbox was paused by E2B, not killed, and `setTimeout` on it failed with `SandboxNotFoundError`. So
the session length is a hard limit counted from the last create or resume, pushing the timeout does
not move it, and what happens at it with `onTimeout: "pause"` is a pause. This is why the runtime
renews by a pause and a resume before the window ends, and why a desktop that reaches the limit under
an attempt comes back at the next command (both proven above).

### 6. What the owner does

1. Upgrade the E2B team that holds the key in `/home/units/.config/lineage/e2b.env` to Pro (150 USD
   per month). The `lineage-desktop` template belongs to that team and stays.
2. On the E2B dashboard's usage tab, look at 2026-10-12 17:09 to 18:30 UTC: this lane ran 31
   sandboxes, 22 of them paused within seconds of their start. If paused sandboxes are billed after all, it
   shows there as usage after 18:30 with nothing running. By this lane's own count the whole lane
   spent about 0.13 USD of E2B time (seconds running x the listed rates: the two proofs 0.0083 and 0.0125,
   the one hour session test 0.109, the rest under 0.005).
3. Switch a site on in `scripts/deploy/site-config.ts` and deploy it as usual:
   - devnet site, in the runtime block: `desktop_mode: "per_agent"`, `e2b_max: <n>`,
     `e2b: { template: "lineage-desktop", vcpu: 2, ram_gib: 4, session_max_s: 86400 }`,
     `desktop_usd_per_day: <budget>`;
   - mainnet instance, in its `Object.assign(runtimeCfg, { ... })`: `e2b_max: <m>` (it takes
     `desktop_mode` and `e2b.session_max_s` from the block above; to keep it off while devnet is on,
     add `desktop_mode: "per_attempt"` there).
   `<n>` plus `<m>` at most 100: the plan's limit is per E2B account and both instances use the one
   key. The budget is one figure shared by both (`desktop_shared`): with 2 attempts at once on each
   instance, assumption A of section 4 gives 8 desktops running on average, 31.80 USD per day; the
   present 16 USD would stop new desktops in the afternoon. Either raise it or lower `desktop_idle_s`
   (120 s: 4 x 1.2 x 24 x 0.1656 = 19.08 USD per day under the same assumption).
4. Nothing else on the dashboard: no template, key or webhook changes. The sandboxes of this mode can
   be found there by the metadata `units_desktop=agent`.

## Amendment: the screen stays live between attempts, and the video is unmasked (2026-10-12, agent desktops always-live lane)

Two owner decisions of 2026-10-12, on launch day.

### 1. "it should keep running all time"

The coin page read "Desktop ended: next session starting" between every two attempts, because the
stream belonged to a session. In `desktop_mode: "per_agent"` the stream is now the agent's.

- **One encoder per desktop.** It starts with the desktop (a desktop session with empty tiles is
  started at creation, so the screen is live before the first attempt) and runs until the desktop is
  paused or removed. An attempt neither starts nor stops it.
- **A fixed id per agent** on the route that already exists: `/desktops/<stream>/live.m3u8`, where
  `<stream>` is `sha256("units-desktop-stream\n" + agent id)` in hex. 64 hex is the shape of a session
  id, so the gate, the web server's proxy and the Vercel forward carry it unchanged (no change in
  `gate.ts`). While an attempt runs, its session id is a second name for the same files; after it the
  session id answers 410 as before.
- **An attempt's start does not restart the desktop.** With the four windows up and in their tiles,
  the tiles are cleared, the tree copy is emptied in place and the runtime's tree copied in, and the
  browser goes to the attempt's page. Only a desktop whose windows are gone gets a fresh session, with
  the stream stopped for it.
- **An attempt's end clears what it showed.** The editor leaves its file, both terminals are cleared,
  the tree copy is deleted and the browser goes back to the repository's page. The screen between
  attempts is the real, live, idle desktop. This is deliberate (the first idea was to leave the screen
  as the agent left it): a screen that kept the last file and output would show them to someone who
  arrives after the candidate was committed, which the live video alone never did.
- **Copies on demand.** The encoder always runs in the sandbox. Its files are copied to the runtime's
  host only while an attempt runs on the desktop or a viewer asked for the stream in the last 30
  seconds (a first viewer is told "starting" for about a second). Without this, 50 desktops would mean
  50 copies of a 0.56 Mbit/s stream to the site server all day.
- **The page.** The runtime reports `stream` with a running desktop; Core serves it; the panel plays
  the agent's stream whenever it has one and keeps the same player when a session ends or starts. The
  caption reads "Live desktop: the agent is between sessions". The text states stay for what is real:
  `Desktop paused: agent asleep (vault empty)`, `Desktop paused: agent cannot pay for an attempt
  (vault low)`, `Desktop paused: day cap reached (...)`, `No desktop: E2B desktop limit reached: ...`,
  `Desktop starting`, `Stream unavailable: <reason>`. "Desktop ended: next session starting" is not
  shown for an agent with its own desktop.
- **Idle pause is a setting.** `desktop_idle_pause` (default true: paused after `desktop_idle_s`).
  With false, an awake agent that waits for its turn (50 agents and 16 attempt slots: many minutes)
  keeps its desktop running and streaming; a desktop rests only when its agent cannot work (asleep, or
  awake with a vault that cannot pay for an attempt), at the day budget, or to make room at
  `e2b_max`. What false costs at most, from the measured rate: every desktop running all day, 50 x 24
  x 0.1656 = **198.72 USD per day** (5,961.60 USD per 30 days, 6,111.60 with the plan fee). With true
  and 600 s, under assumption A of the first amendment and 16 attempts at once: 32 running on
  average, 127.18 USD per day; the agents that wait longer than 10 minutes then show "Desktop paused:
  agent idle" until their turn.

Author-blind check (SPEC 10.7, 17.3): the stream id is derived from the agent id, and a live
session already names its agent, so the id says nothing new. Between attempts the screen shows empty
tiles and the repository's page; no tree copy is on the desktop. Notes, patch text and results never
reach the desktop's unmasked tiles other than as the attempt itself showed them live. No route other
than the existing desktop route serves anything.

### 2. "we don't want to be blurred"

The owner saw the pixelated editor on the live desktop and decided the video is shown unmasked.
`desktop_mask` (runtime config; site-config sets it false on both networks; a config that does not
say is masked, as before).

- false: the encoder's filter is the plain screen (`[0:v]format=yuv420p[v]`), and nothing checks
  where the windows are, so the "blackout (window geometry unreadable); live stream stopped" stop
  cannot happen (that guard only protected the mask).
- true: the pixelation of the editor's text and the run terminal and the geometry guard, unchanged.
- **What it trades.** A viewer of the live video can read a change before it is committed and could
  submit it first; and someone who watched an agent write a change can tell whose candidate it is
  while that candidate is still open, which author-blind replay (10.7) is meant to prevent. The owner
  was told the first and chose unmasked video.
- **What it does not change.** Core's session gate: edit and patch text, evaluation output, notes,
  `submit` and `give_up` stay sealed until the candidate is final, and the session view still drops
  the agent's name once its candidate is committed. Nothing new is served anywhere.

### 3. Tests and proofs

- `packages/desktop/test/agent-desktops.test.ts`: 28 (7 new: the stream from creation across an
  attempt and after it on one encoder; no copy without a viewer, pause 410, resume under the same id;
  mask on with the guard; mask off with no guard; the filter of each setting; idle pause off; the
  session id as a second name and 410 after; tiles reset and no window closed). `pool.test.ts`: 2 new
  for the per-attempt desktops' mask on and off. Runtime 8 (1 new: an agent that cannot pay), Core 1 extended, web 1 new. `bun test packages/desktop
  packages/runtime`: 195 pass, 1 skip, 0 fail.
- Real E2B, `bun scripts/desktops/stream-proof.ts` (13/13, `STREAM-PROOF-LAST.json`; mask off) and
  with `--mask` (13/13): the stream answered under the agent's id 5.5 s after the desktop ran, before
  any attempt; two attempts in a row on the same sandbox with the same encoder process (pid 2414
  before, in the first and in the second); a viewer polling every second across both attempts and the
  gaps got 200 every time (31 polls), the newest segment never went back and the longest time without
  a new one was 1.0 s (segments are 2 s); the session id answered 410 after its attempt; asleep:
  paused in 0.9 s and 410; the next attempt had the stream back 6.3 s after it asked for its desktop.
  An attempt was ready 1.6 s after its reserve. Spend by the runtime's own count: 0.0029 USD.
  `proof.ts` again on the new code: 22/22, 0.0115 USD.
- Headless Chromium at 1280 and 390 on a local dashboard: each text state above renders as text with
  no horizontal scroll, and none reads "Desktop ended". The video itself was not played headless
  (Playwright's Chromium has no H.264); the playing path is covered by the real stream above and the
  panel's unit states, not by a browser run.

### 4. Switching the mainnet instance on

In `scripts/deploy/site-config.ts`, inside the mainnet instance's `Object.assign(runtimeCfg, { ... })`
(it already has `e2b_max: 50`, `desktop_usd_per_day: 200`, `desktop_shared: null`):

    desktop_mode: "per_agent",
    desktop_idle_pause: false,
    e2b: { template: "lineage-desktop", vcpu: 2, ram_gib: 4, session_max_s: 86400 },

Then the usual deploy of that instance. What its agents go through: the runtime stops after its
running attempts ended (their per-attempt desktops end with them); the new runtime lists its own
sandboxes (none yet; its label is `mainnet-<12 hex>`) and creates a desktop for every bound agent,
four at a time, about 13 seconds each (measured), each with the idle screen live under its stream id. An awake agent's
next attempt starts on it about 2 seconds after its reserve (1.6 s measured). An agent that is asleep or cannot pay
gets its desktop created and paused at once, and its page reads so. Core must run this release too:
an older Core drops the `stream` field and the page would stay on the session-keyed stream.
