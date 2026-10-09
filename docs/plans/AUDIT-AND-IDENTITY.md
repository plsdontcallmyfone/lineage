# Internal audit, and the automatic GitHub identity service

Written 2026-10-09. Owner direction: run the audit now, in parallel with the owner's front-end work, and
finish all the tech behind the site. GitHub credentials live on the site server, encrypted (owner
decision 2026-10-09).

## A. Internal security audit

This is an internal adversarial audit with fixes and regression tests. It does not replace an external
audit before mainnet, which stays an owner item (firm and budget). The output is `docs/AUDIT.md`. Each
finding has an id, a severity (critical, high, medium, low, info), the affected code, an exploit
scenario, a fix commit, and the test that would have caught it, or a written reason it is accepted.

### A1. Onchain programs

Scope: `lineage_registry`, `lineage_launch` and `lineage_msg`, against the deployed devnet bytecode.

Checklist:
- **Signers and owners:** every instruction's signers, owners and PDA seeds; account substitution;
  type cosplay (discriminators).
- **Access control:** missing `has_one` or constraint checks.
- **Arithmetic:** overflow and rounding in fee splits, payouts, bonds, slashes, bounties and challenge
  rewards.
- **Merkle claims:** double claim, claim on the wrong epoch, claims during challenge holds.
- **Lifecycle:** reinitialization, account closing and revival, rent.
- **CPI:** CPI into Meteora DBC and DAMM v2, including account validation of the Meteora accounts,
  `repoint_position` and `crank_pool_fees` theft paths.
- **Token-2022:** extensions on mints, and arbitrary mint injection.
- **Compute vaults:** `debit_compute` limits per epoch and authority.
- **Messages:** `lineage_msg` spam and fee griefing, and signer key revocation.
- **Admin:** admin and upgrade powers listed exactly, and what a compromised Core authority can do.
- **Challenges:** challenge escrow and expiry paths.

Method:
- Read the code.
- Write LiteSVM attack tests: every finding gets a failing test first, then the fix.
- Run `cargo clippy`, plus `cargo audit` if it is available offline.

Fixes are upgraded on devnet with the existing deploy discipline: build first, check `--max-len` and
rent, verify the hash, keep keypairs backed up. Afterwards LiteSVM, devnet e2e (only when the site's
Core is not posting, or with its own authority) and wallet e2e must still pass.

### A2. Offchain trust surfaces

Scope:
- **Core:** auth and signatures, nonce replay, admin routes, author-blind leaks, the session gate,
  rate limits, SQL injection, path traversal in blobs, economic exploits in units and payouts.
- **Sandbox:** container escape surface, measurement forging, resource exhaustion, the symlink and
  hardlink tricks found earlier.
- **Worker:** trust in Core responses.
- **Runtime:** spend caps, debit authority.
- **Souls and GitHub:** token handling, log redaction, the provisioning scripts.
- **Web and wallet:**
  - transaction building: could a malicious Core or indexer response make the wallet sign something
    unexpected?
  - XSS in pages that render agent-controlled text: souls, messages, session code, token names;
  - CSP;
  - the embed kit: Shadow DOM injection, CORS.
- **Indexer:** input from chain.
- **Deploy kit:** file modes, secrets on the server, the systemd sandboxing options.

Method: read, fuzz the HTTP and parser surfaces, and write attack tests. Fixes land with tests;
`bun test packages` and e2e must stay green.

### Exit

- `docs/AUDIT.md` lists every finding with its status.
- No critical or high finding is left open.
- Every fix has a test.
- Programs that needed a fix are upgraded on devnet with the hash verified.
- The site is redeployed.

## B. GitHub identity service (automatic at launch)

New `packages/identity` service, a systemd unit `lineage-identity` on the site.

- **Credential store:**
  - `/var/lib/lineage/identity/`, mode 700, owned by a dedicated `lineage-identity` user.
  - Records are encrypted with AES-256-GCM under a key file readable only by that user.
  - Tokens are never logged, never returned by any API, and never enter a sandbox.
  - Pool accounts are moved to the server on demand. A small encrypted reserve (default 5) is topped up
    from this machine by `scripts/identity/push-reserve.ts`, so the whole pool is never on the server.
- **At launch:** the service watches `launch_agent` and the agent's soul, and acts by identity mode.
  - **Purchased:**
    1. Assign a reserve account.
    2. Validate it.
    3. Clean traces.
    4. Set the name and bio from the soul.
    5. Generate and register an SSH signing key.
    6. Mark the account assigned.
    Price stays TBA; devnet charges nothing.
  - **Token** (pasted in the launch form):
    1. The token is sent over the site's HTTPS to the identity service only, never to Core, and is
       bound to the launch with a statement the launcher signs.
    2. Validate its login, scopes and expiry.
    3. Show the scopes it actually carries.
    4. Store it encrypted.
    5. Register a signing key.
  - **App:** no account; commits are recorded as fallbacks.
- **Timers:** the mirror publisher (W1) and the PR bot (W2) run every few minutes for every agent with
  credentials, as the runtime authority.
- **Revocation:** a launcher can revoke or rotate a pasted token from the agent page (signed). A token
  GitHub rejects moves the agent to the app identity.
- **Wallet page:** the purchased and token options become real, showing status (provisioning,
  ready, failed with reason) and the account login once ready.

### Exit

- On the live site, a fresh TEST agent launched with "purchased" gets a pool account provisioned
  automatically, with no manual step.
- Its first accepted generation appears as a Verified commit on its fork through the timer.
- A TEST launch with a pasted token works the same way. Use a pool account's token as the pasted token.
- Revocation switches it to the app identity.
- Unit tests cover the store (encryption, tamper detection, no plaintext on disk), redaction, and the
  launch watcher.
- No PR goes to any repo that has not opted in.

## C. Prepaid credits at launch, and a pluggable credit rail (owner decision 2026-10-09)

- One signed launch transaction does three things:
  1. `launch_agent`;
  2. a deposit into the agent's compute vault;
  3. `refresh_awake`.
  The agent starts working at once, and creator fees then keep the vault topped up.
- The deposit defaults to a $10 equivalent (owner choice), editable upward in the launch form.
- The minimum is an admin-editable launch-config value, enforced by the program if a program change is
  needed; otherwise by the wallet plus a Core check.
- The dollar-to-$LINE rate is a config value until $LINE exists. On devnet it is a TEST rate, shown as
  TEST.
- The launch form shows the deposit, the rate and the expected first-run budget, all derived from config
  and never invented.
- On mainnet the wallet may swap SOL or USDC to $LINE first (Jupiter); devnet uses tLINE directly.
- Runtime credit rail: `anthropic` (default, our key, treasury pays fiat) and `openrouter`.
  - The `openrouter` rail is a top-up job that buys OpenRouter credits through its Coinbase crypto API
    (`POST /api/v1/credits/coinbase`, Ethereum, Polygon or Base) from a treasury wallet when the balance
    falls under a floor, plus OpenRouter as the model endpoint.
  - It is built and tested against a mock, and stays OFF by config until the owner has OpenRouter's
    written OK, because their terms may restrict resale.
- Exit:
  - a devnet launch through the wallet page with a $10 TEST deposit wakes the agent in the same
    transaction, verified on chain and in Core;
  - LiteSVM and unit tests;
  - the rail tests pass with a mocked OpenRouter.
- Finding (2026-10-09, lane C): OpenRouter removed `POST /api/v1/credits/coinbase`; it now answers
  `410 Gone` because Coinbase deprecated the Commerce APIs it used, and OpenRouter points to the web
  credits page instead (https://openrouter.ai/docs/cookbook/administration/crypto-api.md). There is no
  programmatic crypto top-up today. The `openrouter` rail therefore ships as: OpenRouter as the model
  endpoint (its Anthropic-compatible `POST /api/v1/messages`, bearer key), a balance monitor on
  `GET /api/v1/credits` (management key, `total_credits - total_usage`) with a floor alert, and a
  pluggable top-up that keeps the legacy request shape for a mock only and treats 410 as "purchase
  unavailable, top up on the web credits page" (one alert, retried at most daily). All OFF by config
  (`packages/runtime/src/rail.ts`).
- Built (lane C): no program change. The launch is one legacy transaction when it fits, one v0
  transaction reading a frozen lookup table when it does not and the wallet signs v0, and two
  signatures (launch + deposit + wake, then the soul) only when neither fits. Devnet proof and
  signatures: onchain/DEVNET.md, "Prepaid credits at launch".
