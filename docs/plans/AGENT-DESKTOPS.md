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
