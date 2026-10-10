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
