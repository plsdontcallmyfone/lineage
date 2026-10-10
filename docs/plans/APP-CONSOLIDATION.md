# App consolidation: Explorer, Launch, Profile, an Eco sidebar, Connect

Written 2026-10-10 from the owner's direction:
- "we need to consolidate and remove a lot of these, wallets and stuff aren't necessary, network + live
  aren't necessary";
- "we need an EXPLORER PAGE (which is what it is currently) A LAUNCH PAGE, A PROFILE PAGE (just for the
  user), and then eco button that once it clicks it has a side bar added to it";
- "docs will be separate";
- "there should be a connect button";
- "the launch page needs to have the similar flow to stags but modified to ours".

Keep the current visual style: the restyle on main with serif titles, hairline cards and the orange
accent. No new design language. No em dashes, no invented numbers. Every figure comes from Core, the
indexer or chain.

## Header (one bar on every page)

- **Left:** the Lineage wordmark, linking to `/`.
- **Primary nav:** Explorer (`/`), Launch (`/launch`), Profile (`/profile`).
- **Right:** an **Eco** button that opens the Eco sidebar, a **Connect** button, and the theme toggle.
  - Connect uses Wallet Standard (Phantom, Solflare, Backpack) through the existing wallet bundle.
  - Once connected it shows the short address and a menu: Profile, Copy address, Disconnect.
  - The connection persists across pages and reloads.
- **Removed from the header:** Network, Live, Machines, Agents, Leaderboard, Feed, Tokens, Epochs,
  Spawn, Wallet, Docs, Manual.

## Explorer (`/`)

The current explorer page becomes the home page, unchanged apart from the new header. Token pages
(`/tokens/:mint`), session pages (`/sessions/:id`) and agent profiles (`/agents/:id`) stay as deep links
from it.

## Eco sidebar

A right-hand drawer opened by the Eco button. It closes on Esc, on an outside click, or with its close
button. It is a full-height sheet on phones.

**Sections:**
- **Agents:** Leaderboard, Feed, Agents.
- **Network:** Machines, Epochs, Trading.
- **Resources:** Docs, which opens the separate docs site.

Each entry shows one live figure where one exists: number of agents, the current epoch, trades in the
last 24 hours.

**Removed entirely**, from the UI and from routing (`/network` and `/live` redirect to `/`): the
Network overview, the Live wall, the Wallet page, the Spawn page and the Manual.

**Moved:** the functions that lived only on the Wallet page.
- To Profile: faucet, bounties, claims, rotate or revoke a token, image upload, trading allocation.
- To token pages: the trade box. They must keep working.

## Launch (`/launch`)

A stepped wizard in the Stags pattern (`~/bankroll/web/app/create`, read only):
- a step nav where each step can be clicked up to the furthest valid step;
- one card per step with its title, Back and Next buttons, and validation before Next;
- a final Review step.

Its steps are adapted to Lineage:
1. **The coin:** name, ticker, description, image and optional links.
2. **The work:** the GitHub repository URL. Show what it can improve, read from Core: the classes and
   measurable targets for recipes on that repository. If the repository has no recipe yet, say so
   plainly.
3. **The agent:**
   - the soul: a seed that Claude expands, editable afterwards;
   - an avatar;
   - the model: a provider-grouped model table with prices from the registry, Stags style, with
     unavailable providers shown disabled;
   - the trading temperament.
4. **Identity:** the GitHub account. Purchased from the pool, your own token (checked, with scopes
   shown), or app identity.
5. **Funding:** prepaid credits (default 10 USD, from Core's `prepay` config) and an optional trading
   allocation. Show the fee split exactly as configured on chain, and the first-run budget from the
   runtime prices.
6. **Review:** every choice as review rows.
   - **Launch** signs the single transaction (or v0, or two signatures, as the prepay planner picks)
     with the connected wallet, then the hosted-runtime bind signature.
   - Afterwards a live status list follows: confirmed, vault funded and awake, GitHub provisioning,
     runtime bound, first session (with a link), first verdict.

The wizard requires Connect. It reuses the existing launch transaction code in `apps/web/wallet`.
It must never double-send a transaction.

## Profile (`/profile`, the connected user only)

- **Header:** the address, SOL and tLINE balances, and a faucet button (devnet).
- **My agents:** each agent launched by this wallet, with its token, status (awake or asleep, bound),
  GitHub identity status, vault balance and latest session. Management actions: rotate or revoke a
  token, upload an avatar or banner, fund trading, open the agent's public page.
- **My holdings:** agent tokens held, with value in tLINE and links to trade.
- **Following:** the agents this wallet follows, with a short feed.
- **Claims and bounties:** for this wallet, when any exist.

Not connected: a single prompt to Connect.

## Docs, separate

The `/docs` pages move to their own static site: `apps/docs`, built by `scripts/docs/build.ts` into
static HTML with the same fonts and colours. It is deployable on its own (a Vercel project or a docs
subdomain) and served on the devnet site at `/docs` as static files, outside the app shell. The app links
to it from the Eco sidebar.

## Exit

- Headless checks only, at 1280 and 390 px, light and dark, of the header, Eco sidebar, Explorer,
  Launch (every step), Profile (connected through a mock Wallet Standard wallet, and disconnected) and
  docs. No console errors, no horizontal scroll.
- A real devnet launch through `/launch` with a headless test wallet. Use the existing wallet-e2e
  harness pattern, never the owner's Chrome.
- Every removed route redirects or 404s cleanly.
- tsc and tests pass.

## Amendment 2026-10-10 (2): owner review of the consolidated app

Owner feedback: "where's the agents stuff", "those aren't the parameters for tokens", "what are all the
fees and demo stuff we need to remove", "we want the profile to be clickable when you click on the
connect button after you connect (there will be a profile icon)... then it redirects to your tokens /
agents and what they're currently building", and "we're still missing the ecosystem place".

- **Header:** Explorer (`/`), Agents (`/agents`), Launch (`/launch`) on the left. Eco (the ecosystem
  page) and Connect on the right. There is no Profile link in the nav.
  - After connecting, the Connect button becomes a **profile icon**: the wallet's identicon, or the
    avatar of the first agent it owns.
  - Clicking the icon opens a small menu (My profile, Copy address, Disconnect). My profile goes to
    `/profile`.
- **Profile (`/profile`):** leads with the user's tokens and agents, and what each agent is building
  right now: the live session if one is running (the panel or desktop), otherwise the latest session,
  last verified improvement and repo.
  - Holdings and management follow below.
  - Fee rows and fee cranks are removed from the user-facing UI.
- **Token parameters:** cards and the token page show only:
  - price;
  - market cap;
  - 24 h volume;
  - 24 h change;
  - **what the agent is building**: the repo, the live status ("working on <file> in <repo>" while a
    session runs, otherwise "last improvement: <metric> <effect>, <time>"), and a link to the live
    session.

  Remove every fee display: "fees to compute", the fee history tab, fee cranks and fee splits in UI
  text. Remove "model TBA", "scripted/routed" and verified-count rows from cards. Amounts are in the
  quote token (tLINE on devnet); no USD is invented.
- **Demo:** hide test launches. A `hidden_mints` list (with reasons, admin-editable through an admin
  route, no redeploy) in the indexer or Core config. Seed it with every current TEST, ui-check,
  graduation-test and scripted-author launch. Hidden tokens leave the Explorer, Agents and search.
  Their pages still resolve by direct link, marked "hidden from listings".
- **Agents (`/agents`):** a directory of agents, each with:
  - avatar, name and tagline;
  - what it is building right now (live badge when a session runs);
  - repo;
  - its token's price and 24 h change;
  - links to its profile and live session.
  Hidden test agents are excluded like their tokens.
- **Eco (`/eco`):** the ecosystem page, combining the feed, agents, projects (the repos being improved,
  each with its agents and recent verified improvements), and the leaderboard. The owner's developer
  will restyle it, so build it clean and componentized. The Eco button opens this page; the drawer is
  removed.
