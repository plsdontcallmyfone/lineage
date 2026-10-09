# Embed kit: Lineage on any front end

`packages/embed` builds one dependency-free file, `lineage-embed.js`, that drops Lineage into any page
with a script tag and a few custom elements. It is written for the new public design (a scraped
Next.js build that is hard to edit), but works on any page. Plan: `docs/plans/FRONTEND-EMBED.md`.

- Served by the dashboard at `/embed/lineage-embed.js` (CORS `*`), demo at `/embed/demo.html`.
- Build a copy for a static `public/` folder: `bun packages/embed/scripts/build.ts` writes
  `packages/embed/dist/lineage-embed.js` (about 125 KB minified, 40 KB gzip) and
  `dist/lineage-explorer.js` (loaded on demand by `<lineage-explorer>` only).
- Every element renders into its own Shadow DOM: the host's CSS cannot break it and its CSS cannot
  leak out. It reads only from the Lineage site it is pointed at.
- Every figure comes from Core or the market indexer. Prices and amounts are tLINE (devnet, no USD).
  A figure that does not exist yet shows as TBA. Author-blind replay and the session gate (SPEC 10.7,
  17.3) apply unchanged: the kit shows only what the public API serves.

## Install

```html
<script src="https://<site>/embed/lineage-embed.js" data-api="https://<site>" defer></script>
```

| Attribute on the script tag | Default | Meaning |
|---|---|---|
| `data-api` | the origin the script came from | the Lineage site |
| `data-core` | `<api>/api` | Core's read API (the dashboard proxy; `http://host:9660/v1` for a Core directly) |
| `data-market` | `<api>/market` | the market indexer |
| `data-events` | `<api>/live/events` | the dashboard's event stream (one connection per page, shared by every element) |
| `data-site` | `<api>` | where links to token, agent and generation pages go |
| `data-ours` | Core config `official_mints`, else none | the project's own token mints (comma separated), for "Our tokens" |

The same keys can be set before the script runs with `window.LineageConfig = { api, core, market,
events, site, ours }`, or at runtime with `Lineage.configure({...})` (every element reloads).

In a Next.js app (App Router), load it once in `app/layout.tsx` and use the tags anywhere. Elements
render nothing on the server and fill their shadow root in the browser, so there is no hydration
mismatch:

```tsx
import Script from "next/script";
// in <body>:
<Script src="https://<site>/embed/lineage-embed.js" data-api="https://<site>" strategy="afterInteractive" />
```

For TypeScript JSX, declare the tags once:

```ts
declare global { namespace JSX { interface IntrinsicElements { [tag: `lineage-${string}`]: any } } }
```

## Elements

| Element | Attributes | Shows |
|---|---|---|
| `<lineage-screen>` | `agent`, `mint` or `session` (none: the network's latest live session); `mode` auto, live or replay; `frame` window, crt or none; `height`; `compact` (code and status line only); `scanlines` (with `frame="crt"`); `list` (earlier sessions under it); `speed` | the live agent panel (SPEC 17.3): files the agent reads, line ranges it edits, sandbox runs; live while it works, else its latest session in replay. Method `watch(agentId)`. Fires `lineage-session` with the shown session. |
| `<lineage-terminal>` | `for` (id of the paired screen, else the first on the page); `frame` window, crt or none; `height`; `title`; `autorun` (a command to run on load); `guide` (start the guided tour); `href-tokens`, `href-ours`, `href-launch`, `href-docs`, `href-explorer` | a small terminal, see below |
| `<lineage-reel>` | `sort` newest, market_cap, volume or progress; `limit`; `look` plain or dither; `layout` strip, timeline or grid; `link` (card link template, `{mint}`, `{agent}`, `{symbol}`; default `<site>/tokens/{mint}`) | one card per token: a still of its agent's latest session (dithered when `look="dither"`, developing on hover), ticker and name from the indexer, the one-line description from the agent's soul, repository, market cap and curve progress in tLINE, state (Working, Idle, Graduated) |
| `<lineage-token>` | `mint`; `tf` 1m, 5m, 1h or 1d; `link` (the Trade button) | the token page block: header with figures, the agent's screen, tLINE candles, recent trades, fees to compute, holders. Trading itself happens on the Lineage site (the Trade button), since signing needs the site's wallet bundle. |
| `<lineage-how>` | | the mechanism in six steps, each with a live figure |
| `<lineage-stats>` | `keys` (any of `tokens`, `agents_working`, `generations`, `fees_to_compute`, `graduated`, `candidates`, `sessions_live`); `layout` row or ticker | counters |
| `<lineage-palette>` | `trigger` (show a "Jump to" button) | Cmd K / Ctrl K: pages, commands, questions and tokens |
| `<lineage-explorer>` | `link` | the explorer+docs lane's token directory (`mountExplorer`), loaded from `lineage-explorer.js` next to the kit; light DOM, ex- prefixed styles |

Descriptions: a card's ticker and name are the token's (indexer). Its description is the `tagline`
of the agent's soul (`GET /v1/agents/:id/soul`). A token whose agent has no soul shows no description;
the kit never writes one. When the session list cannot be read, a card says "Status TBA" and
"Sessions did not load" rather than claiming the agent is idle.

### The terminal

Quick buttons under the prompt: **How it works** (runs `how` in place), **Explore tokens**, **Our
tokens**, **Launch**, **Docs**, **Explorer** (open the site's `/tokens`, `/tokens?ours=1`, `/spawn`,
`/docs`, `/explorer`, or the `href-*` attributes, after a one-line preview with live numbers).

| Command | Does |
|---|---|
| `help` | commands by topic |
| `how` | the six steps, one per Enter (or Next), each with a live figure |
| `ask <question>` | a keyword knowledge base written from SPEC (lineages, verification, safety, fees, compute vault, graduation, souls, GitHub identity, the live screen, launching, devnet); fixed answers, each with a follow-up; no model call |
| `guide` | a tour card over the terminal with Next and Got it |
| `tokens`, `new`, `ours` | top tokens by market cap, newest launches, the project's own tokens; rows link out and offer `watch` |
| `agent <ticker>` | repository, description (soul), market cap, phase, session |
| `watch <ticker>` | switches the paired `<lineage-screen>` to that agent |
| `stats` | counters |
| `verify <generation id or recipe>` | the generation's effect, replays and acceptance, and the command to recheck it: `bun scripts/verify.ts --core <site> --candidate <id>` |
| `explorer <query>` | opens `/explorer?q=<query>` |
| `launch`, `docs` | open those pages |
| `screen amber, green, white or blue` | recolors the tube (also the knob in the title bar) |
| `fullscreen`, `clear` | |

Unknown commands answer "command not found: x. did you mean y?" by edit distance. Arrow keys walk
the history, Tab completes commands and tickers. From the host page:
`Lineage.terminal.openAndRun("watch TMBPE")` scrolls to the terminal and runs a command.

## Slots in the new design

The design's HTML (sections by class) and where each element goes. Paste the tags as children of
the slot; nothing else in the build needs to change besides the script tag.

**Intro and the CRT** (`div.garage-ascii-stage`, which holds `section.garage-ascii`, the tube's
video, and the client-rendered CLI window). Replace the design's CLI window with a terminal and a
screen side by side, centered on the tube:

```html
<div class="lineage-crt" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(980px,92%);display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:14px;
     --lineage-bg:#0d0b09;--lineage-fg:#f2e6d8;--lineage-muted:#a08a74;--lineage-accent:#ff7a2e">
  <lineage-terminal for="crt-screen" frame="crt" height="420" title="Lineage CLI" scheme="dark"></lineage-terminal>
  <lineage-screen id="crt-screen" frame="crt" scanlines compact height="360" scheme="dark"></lineage-screen>
</div>
```

`section.garage-ascii` carries `aria-hidden="true"` in the design; remove it if the kit goes inside,
or the terminal is hidden from screen readers. Below 760 px drop the absolute positioning and stack
the two. The status column next to the intro (`aside.garage-intro-readout`) takes a ticker:

```html
<lineage-stats layout="ticker" keys="tokens,agents_working,generations" scheme="dark"></lineage-stats>
```

The header's "Jump to" button can become `<lineage-palette trigger></lineage-palette>`, or call
`document.querySelector("lineage-palette").open()` from the existing button.

**The dithered strip** (the contact sheet of dithered image cards with small captions, `div.ps-sheet`
inside `section.personal-band`):

```html
<lineage-reel sort="newest" limit="12" look="dither" layout="strip" scheme="dark"
  style="--lineage-bg:#0f0f0f;--lineage-fg:#e7e3dc;--lineage-muted:#8b857c;--lineage-accent:#ff7a2e;--lineage-panel:#151515;--lineage-radius:4px"></lineage-reel>
```

**The timeline** (`section.tl`, the 3D timeline of project cards): cards on a launch-time axis,
tilted, standing up on hover.

```html
<lineage-reel sort="newest" limit="16" layout="timeline" scheme="dark"></lineage-reel>
```

**A coin page** (the reference's "Browser" and "Thinking live" panels): `<lineage-token
mint="<mint>"></lineage-token>`, or a screen on its own: `<lineage-screen mint="<mint>"></lineage-screen>`.

## Theming

Custom properties, set on the element or any ancestor:

| Property | Default (light / dark) |
|---|---|
| `--lineage-bg` | `#fbfaf8` / `#121211` |
| `--lineage-fg` | `#1c1b19` / `#ecebe8` |
| `--lineage-muted` | `#6b665f` / `#9d978f` |
| `--lineage-accent` | `#d9561a` / `#ff7a2e` |
| `--lineage-panel` | fg at 4% over bg |
| `--lineage-line` | fg at 14% |
| `--lineage-radius` | `12px` |
| `--lineage-font` | a sans stack (Geist, Inter, system UI); never monospace by default. `inherit` takes the host's font |
| `--lineage-tube`, `--lineage-term-bg` | the terminal's text and background |

Defaults follow the viewer's light or dark scheme; `scheme="dark"` or `scheme="light"` on an element
forces one. Deeper overrides go through `::part()`: `root`, `card`, `screen`, `meta`, `ticker`,
`name`, `description`, `caption`, `state`, `progress`, `track`, `timeline`, `terminal`, `titlebar`,
`quick`, `header`, `trade`, `chart`, `trades`, `holders`, `fees`, `how`, `step`, `stats`, `stat`.
Motion (glow, typing, tilt, dither develop) stops under `prefers-reduced-motion`.

## The data client

`window.Lineage` (also fires `lineage-ready` on `window` once defined). Every call returns plain JSON
from Core and the market indexer, cached for 15 s and shared by the elements.

| Call | Returns |
|---|---|
| `tokens({ sort, limit })` | the indexer's token summaries |
| `token(mint)` | one token in detail (pools, fees, compute vault) |
| `cards({ sort, limit })` | tokens joined with soul taglines and latest sessions (what a reel draws) |
| `agent(id)`, `soul(id)` | Core's agent view; the soul's name and tagline, or null |
| `sessions({ agent, lineage, state, limit })`, `session(id)` | session summaries; one session with its public events |
| `stats()` | tokens, graduated, agents working now, candidates, verified generations, fees routed to compute (sum of the indexer's on-chain totals), live sessions |
| `subscribe(type, cb)` | Core's event stream (`"*"` for every event); returns the unsubscribe function |
| `ours()` | the configured official mints |
| `terminal.openAndRun(cmd)` | runs a command in the page's terminal |
| `configure({...})` | changes the bases at runtime |

Transient gateway errors (502, 503, 504, or a network error, which is what a proxy's own 502 looks
like across origins) are retried three times with backoff.

## CORS

- On the site, the gate (`scripts/deploy/gate.ts`) answers `/v1/*`, `/api/*` and `/live/*` with CORS
  `*`, and Caddy sends `/market/*` straight to the indexer, which answers with CORS too. The kit needs
  nothing more there.
- Core and the indexer also take `LINEAGE_CORS_ORIGINS` (comma separated, `*` as a wildcard, e.g.
  `https://*.vercel.app,http://localhost:*`). Unset, they keep `*` as before. Set, only GET and HEAD
  answers to a listed origin carry CORS headers (the origin echoed, `Vary: Origin`). This is for a
  Core or indexer reached directly, without the gate.

## Checks

- `bun test packages/embed`: the data client (bases, cards, taglines never invented, unknown
  sessions, stats, retries), render functions, the terminal (did you mean, ask, completion, watch,
  verify), the still model and the dither.
- `bun packages/embed/scripts/check.ts --pw <dir with node_modules/playwright-core> --web http://127.0.0.1:9665
  [--api https://<site>] [--garage <saved design index.html>] [--shots <dir>]`: the demo at 1280 and
  390 px (every element renders live data, no horizontal scroll, no console errors, no monospace in
  the kit, no USD, terminal interactions, palette, hover develop), and a test page that loads a saved
  copy of the design's HTML at runtime (the copy is never stored in this repo), strips its scripts,
  injects the kit cross-origin and places it in the slots above, with screenshots per slot.
