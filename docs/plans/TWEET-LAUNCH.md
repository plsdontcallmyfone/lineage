# Launch from a tweet

Owner, 2026-10-12: "Launch from a tweet: reply to any GitHub link with '@unitsdotgg launch' and an
agent is launched on that repository, with the reply showing its page."

Status: built, NOT enabled, nothing posted to X. Code: `packages/tweet-launch`, Core
`packages/core/src/tweet-launches.ts`, page `apps/web/wallet/tweet-ref.ts`. Section 8 says what is
proven and what is not.

## 1. Who signs and who pays

A launch creates a pump.fun coin, pays the credits and the initial buy, and needs the launcher's
wallet signature. The platform holds no user funds, never launches for someone with a key of its
own, and the dev wallet never creates a token. So the bot does not launch anything.

1. Someone posts a mention with the word `launch` (section 2).
2. The bot answers once with a link to the launch page, filled in for that repository:
   `<app_url>/launch?repo=<owner>/<name>&tl=<id>` plus `name`, `ticker`, `vibe` when the mention gave
   them.
3. The person (or anyone else who opens the link) connects a wallet on the launch page and approves
   the launch there. The page is the same wizard with fields filled; nothing is sent without that
   approval, and every field can still be changed.
4. When the launch has landed, the page hands the link's id to Core with the agent and coin it
   created. The bot sees it and checks it. A second post with the coin's page is a setting, off by
   default (section 3).

Considered and not built: a Solana Action (blink) link that wallets unfurl inside X. It is also
non-custodial, but the launch is three transactions under one approval with keys made in the page
(agent and coin), a soul draft and an image, which an Action cannot carry today. The link to the
wizard stays the design.

## 2. What a mention must contain

Trigger and wording approved by the owner on 2026-10-12.

- The account's tag and, anywhere after it, the word `launch` (any case): `@unitsdotgg launch`. A
  mention without that word gets no reply. The bot never answers anyone who did not tag it, never
  likes, follows, sends a DM or posts on its own. `@unitsdotgg stop` puts the author on the bot's
  do-not-answer list (the opt-out X's automation rules ask for), with no reply.
- A GitHub repository link, looked for in this order: the mention itself, the post it replies to,
  the post it quotes. In each, the expanded links X returns are read first, then the text. The first
  `github.com/<owner>/<name>` wins; GitHub's own pages (`/orgs`, `/topics`, `/features` and the like)
  are not repositories. A link to a file or a pull request gives its repository. The name is written
  as GitHub spells it.
- Optional, after `launch`: `name <Name>` and `ticker <TICKER>` (a colon is allowed), and
  `vibe: <text>`. They fill the wizard. Name: at most 32 bytes. Ticker: A to Z and 0 to 9, up to 10;
  it is never derived from the name: with no `ticker` the field stays empty and the person types it.
  A field that breaks the wizard's own rule or the `textSafety` check of
  `packages/souls/src/safety.ts` is left out of the link; the rest of the link is still given.

The texts, word for word (`src/replies.ts`):

| Case | Reply |
|---|---|
| a repository a unit can exist on | `@<asker> Launch an agent on <owner>/<repo>. Connect a wallet and approve:` then the link on its own line |
| no repository found | `I could not find a GitHub repository in this conversation. Reply to a tweet with a GitHub link.` |
| not public or does not exist (GitHub API 404, or `private`) | `That repository is not public, so an agent cannot work on it.` |
| no tests (the free reading of `packages/runtime/src/unit-setup.ts` `readRepo`) | `<owner>/<repo> has no tests, so changes to it cannot be verified. Try a repository with tests.` |
| the same person asking again for the same repository while their link is open | no reply |
| the reading says no unit can exist for another reason (no toolchain image for its language) | no reply: there is no approved sentence for it, and a link would send someone to pay for a launch that cannot work. Owner decision needed: a sentence, or the link anyway |
| after the launch landed (optional second post, off by default) | `<Name> is live on <owner>/<repo>. Watch it work:` then `<app_url>/tokens/<mint>` |

The free reading clones the repository at its head commit into a scratch directory that is emptied
after every reading. It is skipped above `read_max_kb` (GitHub's reported size); the link is then
given without it, and the wizard and the runtime do their own checks. A GitHub API failure or rate
limit also gives the link without the reading. Readings are cached per repository for
`read_cache_hours`.

Known limit of fixed wording: the "no repository" and "not public" sentences are the same text every
time, and X refuses a post whose text it has just posted. When X answers 403 with a duplicate
content message the mention stays unanswered and the service goes on (it does not stop). How often
that happens is unproven until live.

## 3. X API

Read on 2026-10-12 from docs.x.com (page text fetched directly) unless marked.

- Access: pay per use, no subscription. "The X API uses pay-per-usage pricing. No subscriptions"
  (https://docs.x.com/x-api/getting-started/pricing). Credits are bought in the Developer Console.
  Legacy Basic and Pro "remain available" to existing subscribers (changelog, 2026-02-06); their
  prices were not confirmed from an official page and they are not needed.
- Prices (same page): Owned Reads, which the changelog says include `/mentions`, 0.001 USD per
  resource; Posts: Read 0.005 USD per resource (the replied-to or quoted post that comes with a
  mention may bill at this rate: not confirmed); Post: Create 0.015 USD per request; Post: Create
  (with URL) 0.200 USD per request; Post: Create (summoned) 0.010 USD per request. Whether a summoned
  reply that contains a link bills 0.010 or 0.200 USD is not stated: plan on 0.200 until an invoice
  line shows it.
- Endpoints: `GET /2/users/me` (once, the account id), `GET /2/users/:id/mentions` with `since_id`,
  `max_results` 5 to 100, expansions for the author and the referenced posts and their links,
  `POST /2/tweets` with `reply.in_reply_to_tweet_id`
  (https://docs.x.com/x-api/posts/get-mentions, https://docs.x.com/x-api/posts/create-post).
  The reference page today names the fields `post.fields`, `referenced_posts`, `note_post` and
  `includes.posts`; the integration guides still say `tweet.fields`, `referenced_tweets.id`,
  `note_tweet`, `includes.tweets`. Which the live API accepts was not tried (no call was made): the
  client has a `dialect` setting, tries the other one once on HTTP 400, and reads both shapes.
- Authentication: mentions accept an app bearer token or a user token; `POST /2/tweets` needs user
  context. The console gave the owner an OAuth 2.0 user token, so that is the primary path
  (https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code and
  `.../user-access-token`, read 2026-10-12): the access token "will only stay valid for two hours";
  with the scope `offline.access` a refresh token is issued; a refresh is
  `POST https://api.x.com/2/oauth2/token`, form encoded, `grant_type=refresh_token` and
  `refresh_token=...`; a confidential client (Web App, Automated App or bot) authenticates it with
  `Authorization: Basic base64(client_id:client_secret)`, a public client puts `client_id` in the
  body. Those pages do not say whether the refresh token changes on a refresh; the service saves
  whatever new refresh token the answer carries and never sends a spent one again. OAuth 1.0a (four
  static values) stays supported.
- Tokens as built (`src/tokens.ts`): the pair in the owner's file is the seed; the live pair is in
  `tokens.json` in the state directory, mode 600, written with a rename before the new access token
  is used, never printed. The access token is refreshed `refresh_margin_s` before it runs out, or
  once after a 401 when its age is unknown (a seeded token). A refresh X refuses writes the `STOP`
  file with the reason and is not tried again until the owner puts new tokens in the file and deletes
  `STOP`. A dry run still saves a refreshed pair, because the old refresh token is spent.
- Rate limits (https://docs.x.com/x-api/fundamentals/rate-limits): mentions 300 per 15 min per user,
  `POST /2/tweets` 100 per 15 min per user and 10,000 per 24 h per app. No monthly write cap found.
- Reply rule (changelog, 2026-02-23): programmatic replies via `POST /2/tweets` "are now only
  permitted when the original Post's author has "summoned" the replier (by @mentioning that account
  or quoting one of its Posts)", self-serve tiers. The bot only ever answers the mention itself, so
  the first reply fits. It cannot answer the author of the GitHub post when that is someone else.
- Automation rules (https://help.x.com/en/rules-and-policies/x-automation, "Updated April 2026"; read
  through a fetch tool that summarises, so the wording below needs a second look by the owner):
  no automated replies from keyword searches alone; automated replies only to users who asked (a
  mention counts); "one automated reply or mention per user interaction"; an easy opt-out; no
  duplicate or substantially similar posts; no misleading links; an AI reply bot needs X's written
  approval; the developer policy says never to mislead about being a bot. The account's Automated
  label page (https://help.x.com/en/using-x/automated-account-labels) did not render its steps: the
  settings path is not confirmed.

What follows from that, as built:

- Replies are fixed sentences from `src/replies.ts`, never written by a model.
- One reply per mention. The second post after the launch is off by default (`follow_up: "off"`): it
  would be a second automated post for one interaction. `own_reply` posts it as a reply to the bot's
  own first reply (it continues its own thread), `mention` as a second reply to the mention. Whether
  X accepts and how it bills a reply to one's own reply is unproven.
- Kill switch: `enabled: false` in the config, or a file named `STOP` in the state directory
  (`touch` it to stop, delete it to resume). The service writes `STOP` itself when X answers 401 or
  403 (other than duplicate content) or refuses a token refresh, and ends the run on 429 until the
  reset time X gave. It posts nothing without
  `--send`: the default run is a dry run that prints what it would post.
- Limits, all settings (the defaults are a cautious start, not measurements): `per_author_per_day`
  2, `global_per_hour` 20, `global_per_day` 100, `min_seconds_between_posts` 20, `max_mention_age_hours`
  24 (older mentions are skipped, so a long stop does not end in a burst), `poll_max_results` 50. A
  mention over a limit gets no reply at all.

## 4. Linking the launch back to the tweet

- The link carries `tl=<id>`: 22 base64url characters, 128 random bits, made by the bot. No handle,
  tweet id or wallet is in the URL. The repository and the optional coin fields are in it because the
  page must fill them.
- The launch page keeps the id for the tab. After its launch landed it sends
  `POST /v1/tweet-launches { ref, agent, mint }` (through the web server's `/api/tweet-launches`),
  again every few seconds while Core answers 404 `launch_unknown` (Core reads a launch from the chain
  a little after it lands), for at most `10` minutes.
- Core stores the row only for a launched agent it has read from the chain with that coin. An id is
  used once (the first launch keeps it); a launch answers one id. Table `tweet_launches`, a `rows`
  table for the purge.
- The bot reads `GET /v1/tweet-launches/:id` for each open request and posts the follow-up only when
  the launch's repository equals the request's and Core registered the launch after the bot made the
  link. Then the request is closed, and with `follow_up` on the second post goes out: the coin's name
  as the market lists it (`GET <market_url>/tokens/<mint>`), the repository and the coin's page
  `<app_url>/tokens/<mint>`. A name the safety list refuses, or one with a tag or a link in it, is
  never posted: the request closes without the second post.
- An open request expires after `link_hours`; the page still works after that, only no follow-up is
  posted. If the person closes the tab before Core has read the launch, no follow-up is posted.

## 5. Abuse

- Anyone can ask for any repository; that is safe because asking launches nothing. The only thing
  the bot does for a stranger is post a link to the public launch page. Whoever opens it pays for and
  signs their own launch, as on the page without a tweet. A link opened by someone other than the
  asker is the same public page.
- The ids are public (they are in a public reply). Using someone's id needs a real launch on that
  same repository after the reply, which is exactly what the follow-up then reports. A row in Core
  costs a launch, so the table cannot be filled for free.
- Spam: the limits above, per author and global; one answer per mention id (kept in the state file,
  written before the post is sent, so a crash cannot answer twice); retweets and the bot's own posts
  are skipped; `stop` list.
- Offensive text: the first reply never repeats a name, ticker or vibe. They only travel in the
  link, after the wizard's own coin rules (name at most 32 bytes, ticker `A-Z0-9` up to 10) and
  `textSafety` (real people, price talk, harassment). A repository whose `owner/name` fails
  `textSafety` gets no reply. That check is a short conservative list, not a profanity filter:
  repository names it does not know still appear in a reply.
- The launch itself runs the wizard's and Core's checks unchanged (name, ticker, soul safety).

## 6. Service

`bun packages/tweet-launch/src/main.ts --config <file> [--send] [--mock <url>]`, one pass per run:
kill switch, mentions since the last id, replies, open requests against Core, follow-ups, state
saved. A systemd oneshot with a timer (`units-tweet-launch.{service,timer}`), installed and not
enabled, like the fee keeper.

- Credentials: a file the owner creates, `~/.config/units/x.env` on this machine and
  `/etc/units-tweet-launch/x.env` on the server, mode 600, never in the repository, never printed.
  OAuth 2.0: `X_ACCESS_TOKEN`, `X_REFRESH_TOKEN`, `X_CLIENT_ID`, `X_CLIENT_SECRET`. OAuth 1.0a, used
  when neither `X_CLIENT_ID` nor `X_REFRESH_TOKEN` is there: `X_API_KEY`, `X_API_SECRET`,
  `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`. `X_BEARER_TOKEN` may be there; it is not used. The file
  is refused when its mode lets others read it. Real credentials are only ever sent to
  `https://api.x.com`. With no credentials the service runs only against `--mock`.
- State: `state.json` in `state_dir` (since id, answered mention ids, requests, counters, readings,
  stop list; no secret) and `tokens.json`, both mode 600, written with a rename.
- Config: `config/tweet-launch.example.json`.

## 7. What the owner provides

- A developer app in console.x.com for @unitsdotgg with read and write access, its OAuth 2.0 user
  token for @unitsdotgg itself (scopes `tweet.read tweet.write users.read offline.access`) with the
  client id and secret, credits and a spending limit.
- The Automated label on the account, and a read of the automation rules page.
- Two decisions: `follow_up` (section 3), and what to say when a unit cannot exist for a reason
  other than missing tests (section 2).
- Then: the runbook section "Launch from a tweet" in `docs/MAINNET-RUNBOOK.md`.

## 8. Proven and unproven

Proven here, against a mock X API over HTTP (the real client code; the mock checks OAuth 1.0a
signatures, bearer tokens and their expiry, the refresh with Basic client authentication and a
refresh token that works once) and a real Core in tests: the parser, refusals, limits, kill switch,
dry run, token refresh and a refused refresh, and the link round trip.
`bun scripts/tweet-launch/proof.ts` (18/18, `scripts/tweet-launch/PROOF-LAST.json`) runs the real
CLI against the mock: mention in, reply with the link out, the free reading of a real repository,
headless Chromium at 1280 and 390 showing the launch page with repository, name and ticker filled
and sending nothing but chain reads, a launch registered on a local simulated Core, the page's
hand-in through the web server, and the second post in the thread.

Unproven: every call to the real X API (field naming, the summoned-reply rule as enforced, the price
of a reply with a link, duplicate-content refusals of the fixed sentences, a reply to the bot's own
reply, a real token refresh and whether the refresh token changes), the systemd unit on the server,
and the round trip with a real launch on mainnet (in the proof the page's hand-in was made by a
script from the page, not by a launch).

## 9. "Started from a tweet"

Owner, 2026-10-13: "add like a link to tweet as well, like mention it's from a tweet."

A launch opened from the bot's link says so and links the tweet, before and after the launch:

- Launch page, above the form on every step: `Started from a tweet by @<asker>, under a tweet by
  @<author above>.` with "a tweet by @<asker>" as the link (new tab). Review has the same as a row:
  `Started from` / `A tweet by @<asker>, under a tweet by @<author above>`.
- The agent's profile and the coin's page, beside the coin's links (Twitter (X), Telegram, Website):
  a link `Started from a tweet`.

The linked tweet is the one that asked (the `@unitsdotgg launch` post): `https://x.com/<asker>/status/<id>`.
The author of the post it replied to is named when that is another account; a quoted post is not named.

Where the fact comes from. Nothing is read from the address: the link still carries only the
repository, the optional coin fields and the id. When the bot makes a link it tells Core which tweet
the link answers, in a request signed with a key of its own, before the reply is posted:
`POST /v1/tweet-links { ref, repo, tweet_id, handle, under_handle, hours }` (table `tweet_links`). Core
accepts it only from a key it was started with (`UNITS_TWEET_LAUNCH_KEYS`, a comma separated list of
public keys) or the admin key; an id is written once, and an id a launch has already used cannot be
registered afterwards. Two public reads serve it and nothing more than the repository, the handle, the
tweet's address and the handle above it:

- `GET /v1/tweet-links/:id` for the launch page: `{ origin }`, null unless the link is open
  (registered, not past `link_hours`, not used by a launch). The page shows the line only when Core answers and the
  repository in the form is the link's; it leaves when another repository is typed.
- `GET /v1/agents/:id/tweet-origin` for the agent's pages: `{ origin }`, null unless that launch was
  handed in with a registered id (section 4), is on the link's repository, and was registered by Core
  after the link was made and before it ran out.

So a crafted address shows nothing (an id Core does not know), a real id pasted onto a link for
another repository shows nothing, and a launch cannot claim a tweet that did not ask for its
repository. What remains true by design (section 5): the id is public, so anyone who opens the link
and launches on that repository gets the line; that launch did start from that tweet's link.

The bot's side: `core_key_file` in the config names the key (a Solana keypair JSON, mode 600; make one
with `bun packages/worker/src/main.ts keygen --out <file>`, which prints the public key for
`UNITS_TWEET_LAUNCH_KEYS`). It is not a wallet and signs no transaction. The site's gate passes no such
write, so `core_url` must then be Core itself (`http://127.0.0.1:9660/v1` on the site's machine).
Without a key, or when Core refuses or is away, the link is given as before and no line is shown.
State per link now also holds the asker's handle, the handle above and whether Core took the
statement. Links made before this (none were posted) have no row in Core and show nothing.

## 10. The maintainer notice (off by default)

Owner, 2026-10-13: "Unclaimed fees waiting for you." When the fees waiting for a repository's owners
(docs/plans/GITHUB-FEE-CLAIMS.md 12) first cross a threshold, the account posts once and links the
repository's page. Code: `src/notices.ts`. Built, OFF, nothing posted, no call to the real X API.

The post, word for word:

`<amount> is waiting for the owners of <owner>/<repo>. Fees from agents working on it, claimable by
anyone with admin on the repository: <app_url>/claim/<owner>/<repo>`

with `@<handle> ` in front only when a handle is named (below). The amount is Core's dollar figure
(`GET <core_url>/fee-claims/waiting`, a public read that passes the site's gate); a repository Core
gives no dollar figure for is not posted about, and nothing is worked out in the bot.

**The risk, and why the defaults are what they are.** X lets this account reply only to people who
mentioned it (section 3), so the notice cannot be a reply: it is an original post. A post that names
an account which never asked is an unsolicited mention, which X's automation rules treat as spam
when automated ("automated replies only to users who asked", "no duplicate or substantially similar
posts"); the same sentence posted for many repositories is also close to "substantially similar".
A report or a spam flag can cost the account its API access, which would take the launch replies
down with it. That is why the notice is off, why it has a dry mode to read before it is ever
switched on, and why each limit below is small. Whether X accepts these posts at all is unproven.

Settings (all in the config; apart from `enabled` and from the reply limits of section 3):

| Setting | Default | Meaning |
|---|---|---|
| `notify_unclaimed` | `"off"` | `off`: nothing is read or posted. `dry`: what would be posted is written to the log and to the state file, nothing is posted. `on`: posts, and only in a run with `--send` |
| `notify_threshold_usd` | 50 | the dollars waiting at which a repository is first posted about |
| `notify_step_factor` | 10 | later posts only at this multiple of the last step: 50, 500, 5,000 |
| `notify_per_day` | 3 | most notices in 24 hours, over all repositories (largest amount first) |

Rules, as built:

- **One post per repository per step, for good.** A step is used once: a claim that empties the
  escrow and a second crossing of the same step posts nothing, and a repository that jumps past two
  steps gets one post that uses up both.
- **Naming someone.** Only the X username GitHub's own profile of the repository's owner lists
  (`GET /users/<owner>`, field `twitter_username`, for a user and for an organisation), checked as a
  handle, named once at the start. Nothing is read from a README, a bio, a website or a commit.
  Without that field the post names nobody.
- **A repository that asks to be left alone is skipped.** The README and CONTRIBUTING (root and
  `.github/`) are read through GitHub's API; a line that asks for no bots, no automated messages or
  no unsolicited contact means no post, a log line with the sentence found, and no second look for
  30 days. The list of phrasings is short and errs toward skipping. When GitHub cannot be read the
  repository waits for a later run. A repository whose name fails the safety list is never posted.
- **State before the post.** The step, the text, the handle and the amount are written to
  `state.json` (`notices`, by the repository's numeric id) before the post goes out, and X's id
  after: a crash or a restart gives no post, never two. A dry record is kept apart and never counts
  as a post, so switching from `dry` to `on` posts that step once.
- **Stops.** The `STOP` file stops notices too. X answering 401 or 403 writes it (a duplicate
  content refusal only skips that post); 429 waits for the reset time.
- The stop list of section 2 is kept by X account id; a notice names a handle from GitHub and has
  no id to compare, so someone who said `stop` can still be named once. Before `on`: resolve the
  handle to an id (one user read) and skip listed ids. Not built.

Tests (`test/notices.test.ts`, 11, the real client against the mock X API): the text and steps,
off by default, once per step across restarts and after a claim, the crash between record and
post, the daily cap, dry mode, where a handle may come from, the skip rule, no dollar figure, the
kill switch, the settings.

To try it: `notify_unclaimed: "dry"`, run the service as usual, read the log and `state.json`.

