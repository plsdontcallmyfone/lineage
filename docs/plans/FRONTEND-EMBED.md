# Embed kit: Lineage on any front end

Written 2026-10-09. Owner direction: the public site moves to a design (lineage-garage.vercel.app, a
scraped Next.js build that is hard to edit). The Lineage front end must drop into it with as little
editing of that build as possible: a script tag and a few tags where the design has slots. The
reference for a coin page with an agent screen is agencypad.fun/coin/... ("Browser", "Thinking live").

## Shape

`packages/embed` builds one dependency-free file, `lineage-embed.js` (ES module and classic script),
served by the site at `/embed/lineage-embed.js` and also copyable into any static `public/` folder.

```html
<script src="https://<site>/embed/lineage-embed.js" data-api="https://<site>" defer></script>
<lineage-reel sort="newest" limit="12" look="dither"></lineage-reel>
```

Every component is a custom element with Shadow DOM, so the host page's CSS cannot break it and its
CSS cannot leak out. Theming is by CSS custom properties on the host (`--lineage-accent`,
`--lineage-bg`, `--lineage-fg`, `--lineage-muted`, `--lineage-font`, `--lineage-radius`) and `part`
attributes for deeper overrides. Fonts are inherited from the host unless set. No monospace by
default (owner rule); a host that wants a retro face sets `--lineage-font`.

`window.Lineage` exposes the data client for hosts that prefer their own markup:
`tokens({sort, limit})`, `token(mint)`, `agent(id)`, `soul(id)`, `sessions({agent, lineage})`,
`session(id)`, `stats()`, `subscribe(type, cb)` (live event stream), each returning plain JSON from
Core and the market indexer.

## Components (one per slot in the new design)

| Element | Slot in the design | What it shows |
|---|---|---|
| `<lineage-screen agent= \| mint= \| session= mode=auto frame=window\|crt\|none>` | the CRT monitor screen; the coin page's main element | the live agent panel (L4): live session or latest in replay; `frame=crt` fits inside the monitor graphic (no window chrome, scanline-friendly) |
| `<lineage-terminal>` | the "Garage CLI" window inside the CRT | a small terminal: `help`, `how` (the launch mechanism step by step), `tokens`, `new`, `agent <ticker>`, `watch <ticker>` (switches the paired `lineage-screen` to that agent), `stats`, `verify <gen>`; every answer from live data |
| `<lineage-reel sort= limit= look=plain\|dither layout=strip\|timeline\|grid>` | the horizontal strip of dithered images; the 3D timeline of cards | one card per token: a live screen thumbnail of what its agent is doing (mini render of its latest session, dithered when `look=dither`, developing to full on hover), name, ticker, one-line description from its soul, repo it works on, market cap and curve progress in tLINE, state (working, idle, graduated); `layout=timeline` places cards on a launch-time axis |
| `<lineage-token mint=>` | a coin page | the L3 token page block (screen, chart, trade box, trades, holders, fees, graduation) |
| `<lineage-how>` | an explainer section | the mechanism in six steps with live figures from the network (tokens launched, verified generations, fees routed to compute) |
| `<lineage-stats>` | any header or ticker | counters: tokens, agents working now, verified generations, fees to compute |

## Rules

- Every figure from Core or the indexer; nothing shown before it exists; tLINE only (no USD).
- Works at 390 px; respects `prefers-reduced-motion` and the host's dark or light scheme.
- No dependencies, one file, under 150 KB minified; no network calls except to `data-api`.
- CORS: Core's public GET routes and `/market/*` answer for configured origins
  (`LINEAGE_CORS_ORIGINS`, the Vercel domains plus localhost), read-only.
- Author-blind and session gates (SPEC 10.7, 17.3) apply unchanged: the kit only shows what the public
  API serves.

## Deliverables

1. `packages/embed` with the six elements, the data client, a build script, unit tests for the data
   client and render functions.
2. `/embed/lineage-embed.js` and `/embed/demo.html` served by `apps/web/server.ts`; the demo shows
   every element with two themes (a dark one matching the dithered strip and a warm one matching the
   timeline).
3. `docs/EMBED.md`: integration guide with copy-paste snippets for each slot of the new design
   (by its section: intro/CRT terminal, ascii strip, timeline), theming variables, and the data client.
4. Exit: headless check of the demo at 1280 and 390 px (no horizontal scroll, no console errors, no
   monospace by default), against the live site's data once deployed; a test page that loads the
   scraped design's HTML with the kit injected into its slots, screenshots looked at.

## Amendment 2026-10-09: the terminal, as studied from the design

The design's terminal ("Garage CLI", built client side) works like this:
- a header button `>_` and a "Jump to (Cmd K)" palette open it;
- a CRT window has a title bar (a knob that recolors the tube, the title with a version, a fullscreen
  control), quick-action buttons under the prompt (Help, Ask), and a typed prompt;
- commands have short blurbs grouped by topic; an unknown command answers "command not found: x. did
  you mean y?" by edit distance;
- `ask` mode matches typed questions against a keyword knowledge base, and each answer offers a
  suggested follow-up question;
- a "duo" desktop mode shows app icons that run commands, plus a desk pet that walks through tips
  with Next, Got it and Nap time;
- a global store `openAndRun(cmd)` lets any element on the page open the terminal and run a command
  (the palette uses it).

`<lineage-terminal>` follows the same interaction model, with Lineage content:

- Quick-action buttons under the prompt: **How it works**, **Explore tokens**, **Our tokens**,
  **Launch**, **Docs**, **Explorer**. The first runs `how` in place. The others navigate to the
  configured URLs (attributes `href-tokens`, `href-ours`, `href-launch`, `href-docs`, `href-explorer`,
  defaulting to the site's `/tokens`, `/tokens?ours=1`, `/spawn`, `/docs`, `/explorer`) after printing
  a one-line preview with live numbers.
- Commands, each with a blurb and a topic:
  - `how`: the six launch steps, one per Enter or Next, each with a live figure;
  - `ask <question>`: a keyword knowledge base about Lineage covering lineages, verification, fees,
    compute vault, graduation, souls, GitHub identity, safety and devnet. Answers are fixed text with
    a suggested follow-up; there is no model call;
  - `tokens`, `new`, `ours`: top and new tokens, and the project's own tokens, as clickable rows;
  - `watch <ticker>`: switches a paired `<lineage-screen>` to that agent;
  - `agent <ticker>`, `stats`, `explorer <query>`, `launch`, `docs`, `screen` (tube color),
    `fullscreen`, `clear`, `help`.
- "Did you mean" by edit distance; command history on the arrow keys; tab completion.
- A guide mode equivalent to the desk-pet tips, walking through the six steps with Next and Got it.
- `Lineage.terminal.openAndRun(cmd)` for the host page, and an optional `<lineage-palette>` (Cmd K)
  listing pages, commands and tokens.
- "Our tokens" come from a configured list (`data-ours` on the script tag, or `GET /v1/config`
  `official_mints`): on devnet, tLINE and the project's own agents; on mainnet, the owner's list.

## Amendment 2026-10-09: explorer and docs pages

- `/explorer`, a simple explorer. A search box takes a token mint, agent id, wallet, transaction
  signature, candidate or generation id, or ticker, and resolves it to:
  - **token**: market summary, trades, its agent;
  - **agent**: soul, sessions, generations, vault;
  - **wallet**: tLINE and agent-token balances, recent trades;
  - **transaction**: decoded as a launch, trade, fee crank, graduation, epoch post or claim, with the
    accounts involved;
  - **candidate or generation**: links to the existing pages.
  The home of the page is a live activity feed with filters: launches, trades, fee cranks,
  graduations, accepted generations, verdicts and epoch posts. Every row links out to Solscan
  (devnet). Data comes from new indexer routes (`/market/activity`, `/market/search`,
  `/market/wallet/:addr`, `/market/tx/:sig`) plus Core. There is also `<lineage-explorer>` for embedding.
- `/docs`, simple docs rendered from markdown in `docs/site/`. Pages: Overview, How it works, Launch
  an agent, Verification, Fees and compute, Graduation, Souls and identity, API and embed kit, FAQ.
  The text is written from SPEC, with no new claims and no invented numbers.
