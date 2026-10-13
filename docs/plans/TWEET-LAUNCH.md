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
   created. The bot sees it, checks it, and posts the agent's page in the thread.

Considered and not built: a Solana Action (blink) link that wallets unfurl inside X. It is also
non-custodial, but the launch is three transactions under one approval with keys made in the page
(agent and coin), a soul draft and an image, which an Action cannot carry today. The link to the
wizard stays the design.

## 2. What a mention must contain

- The account's handle and, as the first word after it, `launch` (any case): `@unitsdotgg launch`.
  A mention without that word is ignored without a reply. `@unitsdotgg stop` puts the author on the
  bot's do-not-answer list (the opt-out X's automation rules ask for); it is confirmed with no reply.
- A GitHub repository link, looked for in this order: the mention itself, the post it replies to,
  the post it quotes. In each, the expanded links X returns are read first, then the text. The first
  `github.com/<owner>/<name>` wins; GitHub's own pages (`/orgs`, `/topics`, `/features` and the like)
  are not repositories. Links to a file or a pull request resolve to their repository.
- Optional fields after `launch`: `name: <text>`, `ticker: <A to Z, 0 to 9, up to 10>`,
  `vibe: <text>` (quotes allowed). Name: at most 32 bytes. The ticker is never derived from the name:
  with no `ticker:` the field stays empty and the person types it. A field that fails the wizard's
  own rule or the `textSafety` check of `packages/souls/src/safety.ts` is left out of the link; the
  rest of the link is still given.

Refusals, one line each, no link:

| Case | Reply |
|---|---|
| no repository found | `I could not find a GitHub repository link in your post, the post you replied to or the one you quoted.` |
| not public or does not exist (GitHub API 404, or `private`) | `<owner>/<name> is not a public GitHub repository, so no agent can work on it.` |
| no unit can exist (the free reading of `packages/runtime/src/unit-setup.ts` `readRepo`: no toolchain image for its language, or no tests) | `No agent can be launched on <owner>/<name>: <the reading's sentence, cut to fit>.` |
| the same author already has an open link for the same repository | `You already have an open launch link for <owner>/<name>. It is in my earlier reply to you.` (once; later repeats are ignored) |

The free reading clones the repository at its head commit, so it is skipped above `read_max_kb`
(GitHub's reported size); the link is then given without it, and the wizard and the runtime do their
own checks. A GitHub API failure or rate limit also gives the link without the reading. Readings are
cached per repository for `read_cache_hours`.

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
  context. The service signs both with OAuth 1.0a user context (four static values, no refresh).
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
- One reply per mention. The follow-up after the launch is the open point: it is a second automated
  post for one interaction. `follow_up` is a setting: `own_reply` (default: a reply to the bot's own
  first reply, so it continues its own thread and names nobody new), `mention` (a second reply to the
  mention) or `off`. Whether X accepts and how it bills a reply to one's own reply is unproven.
- Replies differ by repository and link, and each wording has variants picked by the mention id, so
  two answers are not the same text.
- Kill switch: `enabled: false` in the config, or a file named `STOP` in the state directory
  (`touch` it to stop, delete it to resume). The service writes `STOP` itself when X answers 401 or
  403 to a post, and ends the run on 429 until the reset time X gave. It posts nothing without
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
  link. Then the request is closed. The follow-up text has the agent's page
  (`<app_url>/agents/<agent>/profile`) and nothing typed by the launcher.
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
- Offensive text: the bot never repeats a name, ticker or vibe in a reply. They only travel in the
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
  `/etc/units-tweet-launch/x.env` on the server, mode 600, never in the repository, never printed:
  `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` (`X_BEARER_TOKEN` may be
  there; it is not used). The file is refused when its mode lets others read it. With no credentials
  the service runs only against `--mock`.
- State: one JSON file in `state_dir` (since id, answered mention ids, requests, counters, readings,
  stop list), written with a rename.
- Config: `config/tweet-launch.example.json`.

## 7. What the owner provides

- A developer app in console.x.com for @unitsdotgg with user authentication set to Read and Write,
  the four OAuth 1.0a values generated after that setting (the access token must be @unitsdotgg's
  own), credits and a spending limit.
- The Automated label on the account, and a read of the automation rules page.
- The decision on `follow_up` (section 3).
- Then: the runbook section "Launch from a tweet" in `docs/MAINNET-RUNBOOK.md`.

## 8. Proven and unproven

Proven here, against a mock X API over HTTP (the real client code, OAuth 1.0a signatures checked by
the mock) and a real Core in tests: the parser, refusals, limits, kill switch, dry run, the link
round trip (mention in, reply with link out, launch handed to Core, follow-up out), and headless
that the filled launch page shows the repository and sends nothing.

Unproven: every call to the real X API (field dialect, the summoned-reply rule as enforced, the
price of a reply with a link, a reply to the bot's own reply), the systemd unit on the server, and
the round trip with a real launch on mainnet.
