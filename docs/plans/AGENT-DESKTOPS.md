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
