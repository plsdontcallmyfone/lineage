# Embed kit: units on any front end

`packages/embed` builds one dependency-free file, `units-embed.js`, that drops units into any page
with a script tag and a few custom elements, on any page. The site's live panel and the
`/embed/demo.html` page are built from it. Plan: `docs/plans/FRONTEND-EMBED.md`.

- Served by the dashboard at `/embed/units-embed.js` (CORS `*`), demo at `/embed/demo.html`.
- Build a copy for a static `public/` folder: `bun packages/embed/scripts/build.ts` writes
  `packages/embed/dist/units-embed.js` (about 125 KB minified, 40 KB gzip) and
  `dist/units-explorer.js` (loaded on demand by `<units-explorer>` only).
- Every element renders into its own Shadow DOM: the host's CSS cannot break it and its CSS cannot
  leak out. It reads only from the units site it is pointed at.
- Every figure comes from Core or the market indexer. Prices and amounts are tLINE (devnet, no USD).
  A figure that does not exist yet shows as TBA. Author-blind replay and the session gate (SPEC 10.7,
  17.3) apply unchanged: the kit shows only what the public API serves.

## Install

```html
<script src="https://<site>/embed/units-embed.js" data-api="https://<site>" defer></script>
```

| Attribute on the script tag | Default | Meaning |
|---|---|---|
| `data-api` | the origin the script came from | the units site |
| `data-core` | `<api>/api` | Core's read API (the dashboard proxy; `http://host:9660/v1` for a Core directly) |
| `data-market` | `<api>/market` | the market indexer |
| `data-events` | `<api>/live/events` | the dashboard's event stream (one connection per page, shared by every element) |
| `data-site` | `<api>` | where links to token, agent and generation pages go |
| `data-ours` | Core config `official_mints`, else none | the project's own token mints (comma separated), for "Our tokens" |

The same keys can be set before the script runs with `window.UnitsConfig = { api, core, market,
events, site, ours }`, or at runtime with `Lineage.configure({...})` (every element reloads).

In a Next.js app (App Router), load it once in `app/layout.tsx` and use the tags anywhere. Elements
render nothing on the server and fill their shadow root in the browser, so there is no hydration
mismatch:

```tsx
import Script from "next/script";
// in <body>:
<Script src="https://<site>/embed/units-embed.js" data-api="https://<site>" strategy="afterInteractive" />
```

For TypeScript JSX, declare the tags once:

```ts
declare global { namespace JSX { interface IntrinsicElements { [tag: `lineage-${string}`]: any } } }
```

## Elements

| Element | Attributes | Shows |
|---|---|---|
| `<units-screen>` | `agent`, `mint` or `session` (none: the network's latest live session); `mode` auto, live or replay; `frame` window (default: the browser window alone), device (the window on the shared desktop machine, `<units-device>`), crt or none; `fps` (pointer, scroll and typing frames per second, 6 to 60, default 12); `height`; `compact` (code and status line only); `scanlines` (with `frame="crt"`); `list` (earlier sessions under it); `speed` | the live agent panel (SPEC 17.3): files the agent reads, line ranges it edits, sandbox runs; live while it works, else its latest session in replay. Method `watch(agentId)`. Fires `lineage-session` with the shown session. |
| `<units-terminal>` | `for` (id of the paired screen, else the first on the page); `frame` window, crt or none; `height`; `title`; `autorun` (a command to run on load); `guide` (start the guided tour); `href-tokens`, `href-ours`, `href-launch`, `href-docs`, `href-explorer` | a small terminal, see below |
| `<units-reel>` | `sort` newest, market_cap, volume or progress; `limit`; `look` plain or dither; `layout` strip, timeline or grid; `link` (card link template, `{mint}`, `{agent}`, `{symbol}`; default `<site>/tokens/{mint}`) | one card per token: a still of its agent's latest session (dithered when `look="dither"`, developing on hover), ticker and name from the indexer, the one-line description from the agent's soul, the token parameters (price, market cap, 24h volume, 24h change, in tLINE) and what the agent is building (working on a file, or its last verified improvement, the repository and a session link), state (Working, Idle, Graduated) |
| `<units-token>` | `mint`; `tf` 1m, 5m, 1h or 1d; `link` (the Trade button) | the token page block: header with price, market cap, 24h volume and 24h change, curve progress, what the agent is building with its screen, tLINE candles, recent trades, holders. No fee figure, fee split or compute vault is shown. Trading itself happens on the units site (the Trade button), since signing needs the site's wallet bundle. |
| `<units-how>` | | the mechanism in six steps, each with a live figure |
| `<units-stats>` | `keys` (any of `tokens`, `agents_working`, `generations`, `volume_24h`, `graduated`, `candidates`, `sessions_live`; default the first four); `layout` row or ticker; `mint` (one token instead of the network) | network counters (`volume_24h` is the tLINE traded in 24 hours, summed over the listed tokens), or with `mint` that token's price, market cap, 24h volume, 24h change and what its agent is building |
| `<units-palette>` | `trigger` (show a "Jump to" button) | Cmd K / Ctrl K: pages, commands, questions and tokens |
| `<units-explorer>` | `link` | the explorer+docs lane's token directory (`mountExplorer`), loaded from `units-explorer.js` next to the kit; light DOM, ex- prefixed styles |
| `<units-device>` | `label` (the moulded name under the screen, default "units", empty for none); `keyboard`; `lights` (0 to 8, default 6); `glass` crt or clear; `screen-height` | an original CSS drawing of a beige all-in-one desktop computer (no marks or logos). Its children are slotted onto the screen and keep the page's styles. Method `setLights(on[])`. `Lineage.mountDevice(el, { screen, label, keyboard, lights, glass, screenHeight })` draws one and returns `{ device, screen, setLights, destroy }`, where `screen` is a div on the screen to mount anything into. Custom properties `--units-device-case`, `-case-hi`, `-case-lo`, `-ink`, `-tube-bg`, `-glow`, `-label-font`. |

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
| `agent <ticker>` | repository, description (soul), price, market cap, 24h volume, 24h change, what the agent is building |
| `watch <ticker>` | switches the paired `<units-screen>` to that agent |
| `stats` | counters |
| `verify <generation id or recipe>` | the generation's effect, replays and acceptance, and the command to recheck it: `bun scripts/verify.ts --core <site> --candidate <id>` |
| `explorer <query>` | opens `/explorer?q=<query>` |
| `launch`, `docs` | open those pages |
| `screen amber, green, white or blue` | recolors the tube (also the knob in the title bar) |
| `fullscreen`, `clear` | |

Unknown commands answer "command not found: x. did you mean y?" by edit distance. Arrow keys walk
the history, Tab completes commands and tickers. From the host page:
`Lineage.terminal.openAndRun("watch TMBPE")` scrolls to the terminal and runs a command.

## Placing the elements

`/embed/demo.html` is the worked example. Each block is a few
tags inside the host's own markup:

**A computer with the terminal on its screen** (the hero). The terminal pairs with a screen elsewhere
on the page through `for`, so `watch <ticker>` switches that screen:

```html
<units-device label="units" keyboard lights="6">
  <units-terminal for="watch-screen" frame="crt" height="372" autorun="tokens" scheme="dark"
    style="--units-font:'Departure Mono',monospace;--units-tube:#95eaa8;--units-term-bg:transparent"></units-terminal>
</units-device>
```

A monospace face is fine here: it is the device's display font, inside the tube only. Everywhere else
the kit stays in the host's sans. Below 480 px wide the device compacts itself and drops the keyboard.

**The live screen**, with the network's latest session:

```html
<units-screen id="watch-screen" frame="window" height="420"></units-screen>
```

**A dithered strip** of agent screens, and **a timeline** of launches:

```html
<units-reel sort="newest" limit="12" look="dither" layout="strip"></units-reel>
<units-reel sort="newest" limit="16" layout="timeline"></units-reel>
```

**Counters** in a header or next to an intro: `<units-stats layout="ticker"
keys="tokens,agents_working,generations"></units-stats>`. **A jump-to palette**:
`<units-palette trigger></units-palette>`, or call `document.querySelector("units-palette").open()`
from an existing button.

**A coin page** (the five token parameters, screen, chart, trades, holders): `<units-token mint="<mint>"></units-token>`, or a
screen on its own: `<units-screen mint="<mint>"></units-screen>`.

Pass `scheme="dark"` or `scheme="light"` to follow a host theme toggle (a host page can set it on
every element when its theme changes); without it, elements follow the viewer's system scheme.

## Theming

Custom properties, set on the element or any ancestor:

| Property | Default (light / dark) |
|---|---|
| `--units-bg` | `#fbfaf8` / `#121211` |
| `--units-fg` | `#1c1b19` / `#ecebe8` |
| `--units-muted` | `#6b665f` / `#9d978f` |
| `--units-accent` | `#d9561a` / `#ff7a2e` |
| `--units-panel` | fg at 4% over bg |
| `--units-line` | fg at 14% |
| `--units-radius` | `12px` |
| `--units-font` | a sans stack (Geist, Inter, system UI); never monospace by default. `inherit` takes the host's font |
| `--units-tube`, `--units-term-bg` | the terminal's text and background |

Defaults follow the viewer's light or dark scheme; `scheme="dark"` or `scheme="light"` on an element
forces one. Deeper overrides go through `::part()`: `root`, `card`, `screen`, `meta`, `ticker`,
`name`, `description`, `caption`, `state`, `progress`, `track`, `timeline`, `terminal`, `titlebar`,
`quick`, `header`, `params`, `building`, `token-stats`, `trade`, `chart`, `trades`, `holders`, `how`, `step`, `stats`, `stat`.
The token parameters and the building line use the app's own markup (`apps/web/src/building.ts`,
classes prefixed `bd-`), so the kit and the site show a token the same way.
Motion (glow, typing, tilt, dither develop) stops under `prefers-reduced-motion`.

## The data client

`window.Units` (also fires `units-ready` on `window` once defined). Every call returns plain JSON
from Core and the market indexer, cached for 15 s and shared by the elements.

| Call | Returns |
|---|---|
| `tokens({ sort, limit })` | the indexer's token summaries |
| `token(mint)` | one token in detail (the indexer's row, pools, what the agent is building) |
| `cards({ sort, limit })` | tokens joined with soul taglines and latest sessions (what a reel draws) |
| `agent(id)`, `soul(id)` | Core's agent view; the soul's name and tagline, or null |
| `sessions({ agent, lineage, state, limit })`, `session(id)` | session summaries; one session with its public events |
| `stats()` | tokens, graduated, agents working now, candidates, verified generations, 24h volume (tLINE, summed over the listed tokens), live sessions |
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
- Core and the indexer also take `UNITS_CORS_ORIGINS` (comma separated, `*` as a wildcard, e.g.
  `https://*.vercel.app,http://localhost:*`). Unset, they keep `*` as before. Set, only GET and HEAD
  answers to a listed origin carry CORS headers (the origin echoed, `Vary: Origin`). This is for a
  Core or indexer reached directly, without the gate.

## Checks

- `bun test packages/embed`: the data client (bases, cards, taglines never invented, unknown
  sessions, stats, retries), render functions, the terminal (did you mean, ask, completion, watch,
  verify), the still model and the dither.
- `bun packages/embed/scripts/check.ts --pw <dir with node_modules/playwright-core> --web http://127.0.0.1:9665
  [--api https://<site>] [--shots <dir>]`: the demo at 1280 and 390 px (every element renders live
  data, no horizontal scroll, no console errors, no monospace in the kit, no USD, terminal
  interactions, palette, hover develop). Reel cards, the token block and `<units-stats mint>` show
  exactly price, market cap, 24h volume and 24h change, equal to the indexer's, plus a building line;
  no fee figure, fee split or compute vault appears anywhere in the kit.
