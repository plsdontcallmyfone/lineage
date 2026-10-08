# Agent collaboration and payments: prior art for Lineage

Research lane notes, 2026-10-07. Every claim carries the URL it was read at (numbered in the
Sources list at the end). Where a source could not be found or did not say, the text says
"not verified". Secondary press is marked as such. No figure here is modelled or estimated.

Lineage context assumed by the "Implication" bullets: Solana network; agents author code
improvements; independent bonded replayers verify them; each agent has a compute vault funded by
its token's trading fees; settlement asset $LINE.

---

## 1. Google Agent2Agent (A2A)

### Status (as of 2026-10-07)

- Latest release on GitHub is **v1.0.1 (28 May 2026)**; **v1.0.0 shipped 12 Mar 2026** with
  breaking spec changes; prior line was v0.3.0 (30 Jul 2025) [3].
  - Note: Roster's DESIGN.md says "A2A 1.0 ... released January 2026"; the GitHub releases page
    says 12 Mar 2026 [3]. Trust the releases page.
  - A trade article claims an "A2A 1.2" in production at Cloud Next (Apr 2026) [5]; this does
    not appear on the releases page [3]. Not verified, likely wrong.
- Governance: Linux Foundation project (LF press release on the one-year mark, Apr 2026, 150+
  organisations) [4]. Moved into the **Agentic AI Foundation (AAIF)**, an LF umbrella that also
  hosts MCP, on 17 Aug 2026 per the AAIF blog [6]; the spec page itself carries an
  "A2A joins the Agentic AI Foundation" banner [1]. Secondary coverage says the move was
  governance only, no spec change [6].

### Mechanics that matter

- **Transports (protocol bindings):** JSON-RPC (spec section 9), gRPC (10), HTTP+JSON/REST (11),
  custom bindings (12) [1].
- **Agent Card:** served at `https://{server_domain}/.well-known/agent-card.json` (section 8.2)
  [2]. Fields seen: `capabilities` (`streaming`, `pushNotifications`, `extendedAgentCard`),
  `securitySchemes`, `security`, `AgentInterface` list, `AgentSkill`, `AgentExtension`,
  `signatures` [1][2].
- **Signed Agent Cards (section 8.4):** card is canonicalised with JCS (RFC 8785), `signatures`
  field excluded, unset optional fields omitted; each entry is a JWS (RFC 7515) with
  `protected` (base64url header, MUST carry `alg` and `kid`, SHOULD `typ: "JOSE"`, MAY `jku`),
  `signature`, optional unprotected `header` [2]. There is no message-level signing in the parts
  of the spec read; auth is transport level. (Not verified that no message signing exists
  anywhere in the remaining 55k chars of the spec page.)
- **Task lifecycle (`TaskState`)** [1]:
  `TASK_STATE_SUBMITTED`, `TASK_STATE_WORKING`; interrupted: `TASK_STATE_INPUT_REQUIRED`,
  `TASK_STATE_AUTH_REQUIRED`; terminal: `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`,
  `TASK_STATE_CANCELED`, `TASK_STATE_REJECTED` (plus `TASK_STATE_UNSPECIFIED`).
  The 0.3 dialect used lowercase strings (`working`, `input-required`) (Roster DESIGN.md, local).
- **Message / Part / Artifact** [1][2]:
  - `Message`: `messageId`, `contextId`, `taskId`, `role` (`ROLE_USER` / `ROLE_AGENT`), `parts`,
    `metadata`, `extensions`, `referenceTaskIds`.
  - `Part`: exactly one of `text`, `raw` (bytes, base64 in JSON), `url`, `data` (any JSON);
    optional `metadata`, `filename`, `mediaType`.
  - `Artifact`: `artifactId` (unique in task), `parts` (1+), optional `name`, `description`,
    `metadata`, `extensions`.
- **Auth schemes** (OpenAPI-style, declared on the card): `APIKeySecurityScheme`,
  `HTTPAuthSecurityScheme`, `OAuth2SecurityScheme` (authorization code, client credentials,
  device code flows), `OpenIdConnectSecurityScheme`, `MutualTlsSecurityScheme` [1].
- **Streaming:** SSE (`text/event-stream`); HTTP `POST /message:stream`, JSON-RPC
  `SendStreamingMessage`, re-attach via `SubscribeToTask` (errors with `UnsupportedOperationError`
  on terminal tasks). `TaskArtifactUpdateEvent` carries `append` and `lastChunk` for chunked
  artifacts [2].
- **Push notifications:** agent POSTs `StreamResponse` payloads to a client webhook with
  `Authorization: {scheme} {credentials}` from `AuthenticationInfo`, `Content-Type:
  application/a2a+json`; client must 2xx. CRUD on configs:
  `Create/Get/List/DeleteTaskPushNotificationConfig`. Requires `capabilities.pushNotifications`
  [1][2].
- **Extensions:** declared on the card (`AgentExtension`, can be `required: true`), activated
  with the `A2A-Extensions` header / service parameter, carried in `Message.extensions`;
  `ExtensionSupportRequiredError` if a required one is missing [1].
- **Discovery:** well-known card URL only; A2A names curated registries but defines no registry
  API (Roster DESIGN.md, local, citing third-party registries a2aregistry.org and
  a2a-registry.org).

### Limitations

- No payment, escrow, reputation or registry in the core spec; these come from extensions
  (x402, below) or other standards (ERC-8004 points at A2A cards from an on-chain identity) [26].
- Card signing is JWS/JOSE, which does not natively name Ed25519 Solana keys as identities; an
  `EdDSA` JWS with a `kid` that resolves to a Solana pubkey would be a Lineage convention, not
  something A2A specifies (not verified that any registry does this today).
- Two live wire dialects (1.0 and 0.3); clients in the wild speak both (Roster DESIGN.md, local).

### Implication for Lineage

- Use A2A as the **off-chain wire** for agent-to-agent task negotiation (brief, clarifications,
  artifact delivery), and keep everything that moves money or decides a verdict on chain.
- Map Lineage's improvement lifecycle onto A2A states rather than inventing new ones:
  proposal sent = `SUBMITTED`; awaiting stake/payment = `INPUT_REQUIRED` (as the x402 extension
  does); replay running = `WORKING`; verified = `COMPLETED`; replay failed = `FAILED`;
  refused = `REJECTED`.
- Patches and replay reports travel as `Artifact`s with `data` parts (JSON manifests with content
  hashes) and `url`/`raw` parts for the diff; the on-chain record holds only the hash.
- Sign every agent card (JCS + JWS) with a key bound on chain to the agent's Lineage identity, so
  a card fetched from any mirror or registry can be checked against chain state.

---

## 2. Model Context Protocol (MCP)

### Status

- Current spec revision is **2026-07-28** (schema at `schema/2026-07-28/schema.ts`) [7].
- Hosted under the AAIF alongside A2A (secondary coverage of the A2A move) [6].

### Mechanics

- Purpose: connect an LLM application (host -> client) to **servers** that expose
  **Resources**, **Prompts** and **Tools**; clients may offer **Elicitation**. JSON-RPC 2.0 [7].
- Extensions include **Tasks** (async long-running operations with polling, mid-flight input,
  durable handles), Skills over MCP, MCP Apps [7].
- **Authorization** (HTTP transports only; optional; STDIO SHOULD NOT use it) [8]:
  OAuth 2.1 resource-server model; servers MUST publish Protected Resource Metadata (RFC 9728,
  `/.well-known/oauth-protected-resource`); clients MUST send RFC 8707 `resource` indicators and
  servers MUST check token audience; client registration via Client ID Metadata Documents
  (SHOULD), pre-registration, or Dynamic Client Registration (now deprecated); RFC 9207 `iss`
  validation; step-up scopes via `403 insufficient_scope`.

### Relation to A2A

- MCP standardises agent-to-tool; A2A standardises agent-to-agent. Google framed them as
  complementary when A2A joined AAIF [6]. ERC-8004 registration files can list both an A2A and an
  MCP endpoint for one agent [26].

### Limitations

- No notion of peer agents, payments or verifiable work. Auth is human-consent centric
  (OAuth, browser redirects), which fits poorly with headless agent wallets.

### Implication for Lineage

- Expose Lineage's own read surfaces (repo state, open bounties, replay results, vault balances)
  as an **MCP server** so any agent runtime can use them as tools. Do not use MCP for
  agent-to-agent collaboration; that is A2A plus on-chain escrow.

---

## 3. x402

### Status

- Linux Foundation announced the **x402 Foundation** with Coinbase contributing the protocol on
  2 Apr 2026 [12]; secondary press reports operations began 14 Jul 2026 with 40 members, premier
  members including Cloudflare, Coinbase, Google, Stripe, Visa (secondary) [12b].
- **x402 v2** is current; launch post last updated 2026-06-24 [10]. Reference SDKs stay
  backward-compatible with v1 [10].

### Mechanics

- **HTTP flow (v2)** [9]: client requests -> server `402` with `PAYMENT-REQUIRED` header
  (base64 `PaymentRequired`) -> client retries with `PAYMENT-SIGNATURE` (base64
  `PaymentPayload`) -> server settles and returns `PAYMENT-RESPONSE` (base64
  `SettlementResponse`). v1 used `X-PAYMENT` / `X-PAYMENT-RESPONSE` and a body-borne requirement
  (migration guides) [11].
- **Objects (v2 spec)** [13]:
  - `PaymentRequired`: `x402Version`, `error`, `resource`, `accepts[]`, `extensions`.
  - `PaymentRequirements`: `scheme`, `network` (CAIP-2), `amount`, `asset`, `payTo`,
    `maxTimeoutSeconds`, `extra`.
  - `PaymentPayload`: `x402Version`, `resource`, `accepted`, `payload`, `extensions`.
  - `SettlementResponse`: `success`, `errorReason`, `payer`, `transaction`, `network`, `amount`,
    `extensions`. `VerifyResponse`: `isValid`, `invalidReason`, `payer`.
  - Facilitator: `POST /verify`, `POST /settle`, `GET /supported`; discovery API
    `GET /discovery/resources` [13].
- **Schemes:** `exact`, `upto`, `batch-settlement` exist in `specs/schemes/` [14]. `upto`
  authorises a maximum, settles actual usage (single use, time-bound, recipient-bound,
  `amount <= max`, `amount` may be 0) [15]. The repo only has an EVM binding for `upto`
  (`scheme_upto_evm.md`) [14]; a Solana Compass news piece says Coinbase shipped `upto` on Solana
  via a payment-channels program with escrowed deposits and signed vouchers [16]. SVM `upto`
  spec: not verified.
- **Solana (`exact` on SVM)** [17]:
  - `payload.transaction` = base64 serialized, **partially signed** versioned transaction; client
    signs, facilitator co-signs as fee payer (`extra.feePayer`).
  - 3 to 6 instructions in order: ComputeBudget SetComputeUnitLimit, SetComputeUnitPrice,
    SPL Token / Token-2022 `TransferChecked`, then up to three optional Lighthouse or Memo
    instructions (Memo used for uniqueness).
  - Facilitator MUST check: fee payer not in any instruction accounts, not the transfer authority,
    not the source; CU price capped (5 lamports/CU in the reference implementation); destination is
    the ATA of (`payTo`, `asset`); amount exactly equals `amount`; memo matches `extra.memo` if set.
  - CAIP-2 ids: mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, devnet
    `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, testnet `solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z`
    [18].
- **v2 changes** [10][11]: CAIP-2 network ids; header renames; formal Extensions (Discovery
  extension so facilitators index endpoints); wallet-based identity with a Sign-In-With-X header
  (CAIP-122) announced as fast follow; session-style reuse for repeat access; plugin-driven SDK
  (`@x402/*` packages) with multi-facilitator support. Session wire format: not verified.

### A2A x402 extension

- Repo `google-agentic-commerce/a2a-x402`, Apache-2.0, spec **v0.1** [19]. Extension URI
  `https://github.com/google-a2a/a2a-x402/v0.1` [20].
- Flow [20]: merchant agent puts the task in `input-required` with metadata
  `x402.payment.status = "payment-required"` and `x402.payment.required` (the x402 requirements);
  client returns `x402.payment.payload` on the same task (`payment-submitted`); merchant verifies
  and settles, appends to `x402.payment.receipts`, status `payment-verified` /
  `payment-completed`, task goes `working` -> `completed`. Failure: `payment-rejected` /
  `payment-failed` with `x402.payment.error` codes `INSUFFICIENT_FUNDS`, `INVALID_SIGNATURE`,
  `EXPIRED_PAYMENT`, `DUPLICATE_NONCE`, `NETWORK_MISMATCH`, `INVALID_AMOUNT`,
  `SETTLEMENT_FAILED`.
- The v0.1 spec examples use x402 v1 shapes (`network: "base"`, 0x addresses) and do not mention
  Solana [20]. Roster passes v2 requirements through verbatim and flags the divergence via
  `x402Version` (Roster DESIGN.md, local).

### Limitations

- `exact` is pay-then-serve with no escrow, no refund and no quality check; the payee is trusted
  to deliver. `upto` bounds price, not quality.
- Facilitator is a trusted co-signer for liveness (fee payer, settlement), though it cannot redirect
  funds under `exact` SVM rules [17].
- The extension's money model is merchant-takes-payment; nothing about bonded verifiers.

### Implication for Lineage

- x402 is the right **edge protocol for paying for compute or data** (e.g. a vault paying a
  replayer's sandbox, or an outside client buying a Lineage agent's service). Set `payTo` to a
  Lineage escrow PDA rather than a wallet, as Roster does (`payTo` = job escrow address, job
  opened on arrival of the signed payment; Roster how-it-works.md, local). That turns a
  pay-then-serve rail into an escrowed one without changing the wire.
- Support the SVM `exact` scheme with `asset` = the $LINE mint (Token-2022 is allowed [17]); the
  Lineage program or a Lineage-run facilitator can be fee payer.
- Use the Memo instruction slot to carry a job/proposal id so settlements can be matched to tasks
  on chain [17][21].

---

## 4. Virtuals Protocol Agent Commerce Protocol (ACP)

### Status

- Current docs live at os.virtuals.io ("EconomyOS"), read 2026-10-07 [22]. ACP is described as
  the **reference implementation of ERC-8183** ("Agentic Commerce"), proposed on Ethereum
  Magicians 4 Mar 2026 [22][23].
- Live on Base mainnet (8453) and Robinhood Chain (4663); agent wallets optionally have a Solana
  key; ACP Core contract on Base `0x238E541BfefD82238730D00a2208E5497F1832E0`, FundTransferHook
  `0x90717828D78731313CB350D6a58b0f91668Ea702` [22]. SDK `@virtuals-protocol/acp-node-v2`,
  CLI `@virtuals-protocol/acp-cli` [22].
- Virtuals says it onboarded "over 2,000 agents" over 18 months in production [22]. Roster's local
  scan (2026-09-20) recorded the ACP explorer reporting 481.79M USDC of "agent GDP" over 2.51M
  jobs (Roster DESIGN.md, local, citing app.virtuals.io/acp; not re-verified here).

### Mechanics

- Whitepaper framing: four phases **Request, Negotiation, Transaction, Evaluation**; roles
  Client, Provider, Evaluator; funds held in escrow until an Evaluator checks work against a
  signed Proof of Agreement [21b].
- Current on-chain job state machine [22]:
  `open -> budget_set -> funded -> submitted -> completed | rejected`, and `open -> expired`.
  Calls: `createJob`, `setBudget` (provider proposes price), `fund` (client locks USDC),
  `submit` (deliverable), `complete` (escrow to provider) or `reject` (escrow to client).
  Events `job.created`, `budget.set`, `job.funded`, `job.submitted`, `job.completed`,
  `job.rejected`, streamed over SSE or WebSocket.
- **Evaluator** is optional; if absent the client evaluates [22]. In ERC-8183 the evaluator is a
  single address (EOA or contract) that attests `complete(jobId, attestationHash)` or
  `reject(jobId, reason)` [23].
- **Hooks** (`beforeAction` / `afterAction`) replace the earlier "memos" (signed on-chain
  messages) as the extension primitive; used for fund-transfer jobs, subscriptions, reputation
  gating [22][23].
- **Fees** enforced in the job contract: 95/5 provider/protocol without evaluator; 90/5/5
  provider/evaluator/protocol with one [22].
- Typed in-job messages: `requirement`, `text`, `proposal`, `deliverable`, `structured`; phase
  changes happen only through on-chain calls, never messages [22].
- Agent identity: wallet + "Agent Card" (a virtual payment card, not an A2A card) + email +
  optional token; tokenising routes trading fees to the agent wallet and registers the agent for
  ERC-8004 reputation [22].

### Limitations

- Single evaluator is a point of failure and a bribery target; raised in the ERC-8183 thread [23].
- Rejection refunds the client with no dispute or bond in the documented flow [22]; a client who
  is also evaluator can take delivery and reject.
- Settlement is USDC; deliverable correctness is whatever the evaluator says.

### Implication for Lineage

- ACP's state machine is close to what Lineage needs; reuse the shape and swap the single
  evaluator for **a quorum of bonded replayers** whose verdict is objective (replay passes or not).
  That removes the subjective-evaluator weakness ACP inherits.
- Copy the fee-split-in-contract idea: a fixed share of each job to verifiers is the replayers'
  revenue, analogous to ACP's 5% evaluator share [22].
- Keep negotiation off chain (A2A messages) and only the agreed terms hash on chain, as ACP and
  Roster both do.

---

## 5. Olas (Autonolas)

### Status

- Contracts active and maintained on GitHub (valory-xyz) [24]. Mech Marketplace launched Feb
  2025 (secondary press) [25b]. Docs index last updated 2026-09-17 [25c].

### Mechanics

- **Registries** [24]: `components` and canonical `agents` are minted as **ERC-721** in
  ComponentRegistry / AgentRegistry; `services` are composed of agent ids with a number of
  instances each; operators register agent instances; once all slots fill, the service is
  deployed as a **multisig** governed by the agent instances. Services can be secured with ETH or
  an ERC-20 bond.
- **Service FSM** [24b]: non-existent -> pre-registration -> active-registration ->
  finished-registration -> deployed; terminate -> terminated-bonded; unbond.
- **Staking / proof of active agent** [24c]: `StakingBase` has `minStakingDeposit`,
  `livenessPeriod`, `maxNumInactivityPeriods` (evicted after accumulated inactivity), and an
  external `activityChecker` contract with `isRatioPass(...)` deciding whether the service's
  multisig did enough work per period. PoAA whitepaper linked from the registries README [24].
- **Mech Marketplace** (agents hiring agents) [24d]: requester calls `request` / `requestBatch`
  naming a **priority mech**, `maxDeliveryRate`, `paymentType`, `responseTimeout` (bounded by
  marketplace min/max). Within the timeout only the priority mech may deliver; after it, **any
  mech** may deliver and the priority mech's **karma is decremented** by 1. Delivery increments
  mech and requester-mech karma. Payments flow through a BalanceTracker (native, OLAS, USDC);
  marketplace fees are drained to a BuyBackBurner that buys and burns OLAS [24d].

### Limitations

- Delivery is not verified for correctness by the contract; karma counts deliveries, not quality
  (from the contract code read [24d]).
- Multi-agent services rely on a consensus engine (Tendermint in their tooling [24e]) among the
  service's own agents; trust is per-service, not network-wide.

### Implication for Lineage

- **Priority-then-open delivery** is directly reusable: a bounty names a preferred agent with an
  exclusive window, then opens to all, with a reputation hit for the agent that let it lapse.
- Composition-as-NFT (component -> agent -> service) maps to Lineage lineage: an improvement
  NFT/record citing the parent records it builds on, which is the basis for upstream royalty
  splits.
- An activity checker reading on-chain counters is a cheap liveness test for agents whose vaults
  are still drawing from fees.

---

## 6. Fetch.ai / ASI Alliance uAgents, Almanac, Agentverse

### Mechanics (from source code, `fetchai/uAgents` main)

- **Identity:** secp256k1 ECDSA key; address = bech32 with prefix `agent` over the compressed
  public key (`agent1...`) [27].
- **Envelope** fields: `version`, `sender`, `target`, `session` (UUID4 for a dialogue),
  `schema_digest`, `protocol_digest`, `payload` (base64 JSON), `expires`, `nonce`, `signature`
  [28]. Signature is over SHA-256 of `sender`, `target`, `session`, `schema_digest`, `payload`,
  `expires` (u64 BE), `nonce` (u64 BE). Note: `version` and `protocol_digest` are **not** in the
  signed digest [28].
- **Almanac:** a CosmWasm contract on Fetch's ledger (via cosmpy) plus an Almanac HTTP API;
  agents register endpoints and protocol digests with an expiry height, re-register on an interval
  (`REGISTRATION_UPDATE_INTERVAL_SECONDS = 3600`), contract version `2.2.0`, testnet registration
  fee `500000000000000000` (0.5 in 18-decimal units) [29]. Registration attestations are signed
  `VerifiableModel`s with a timestamp [29b].
- **Agentverse:** hosted, mailbox and proxy agent modes; mailbox buffers messages for offline
  agents [30].

### Limitations

- Payload is not encrypted by the envelope; confidentiality depends on transport. Signed digest
  omits some fields (above). Discovery depends on a chain + a hosted API.

### Implication for Lineage

- The envelope design is a good template for Lineage's signed agent messages, with fixes: sign
  **every** field including version and protocol/schema digest, use Ed25519 Solana keys, add a
  chain-specific domain separator, and make `nonce` + `expires` mandatory.
- A Lineage "almanac" can be a PDA per agent holding endpoint URL, A2A card hash and an X25519
  encryption key, with expiry; cheaper than a separate contract chain.

---

## 7. Bittensor

### Status and reward mechanics (docs read 2026-10-07)

- Each subnet runs an epoch every **tempo** (default 360 blocks, about 72 minutes; owner-settable
  360 to 50,400) [31].
- **Per-tempo split:** 18% subnet owner (`SubnetOwnerCut` 11796/65535), 41% miners, 41%
  validators and their stakers [31].
- **Yuma Consensus** [31]: validators set weight vectors over miners; self-weights removed; for each
  miner, consensus = stake-weighted median at `kappa` (default 32767/65535, about 0.5) of active
  stake; weights above consensus are **clipped** to it; miner rank/incentive from clipped weights.
  Validators earn dividends via **bonds** (EMA of weight x stake, `bonds_moving_average` default
  900,000 -> alpha 0.1), so early correct validators earn more. **Yuma3** is a per-subnet toggle
  with fixed-point bonds and optional liquid alpha [31].
- **Null consensus** (newer per-subnet mode): a single top-stake validator sets weights, no
  consensus or bonds; half to validator dividends, half to miners [32].

### Weight copying and commit-reveal

- Docs: "Commit-reveal exists to defeat **weight copying**." A lazy validator could submit the
  stake-weighted median of others' revealed weights; under Yuma such copiers "historically earned
  *better* vtrust and dividends per TAO than the honest validators they copied" [33].
- Current scheme (CRv3): weights are **timelock-encrypted to a future drand round**; reveal round
  set from `commit_reveal_period` (in tempos, default 1); the chain decrypts automatically, so no
  manual reveal and no selective-reveal exploit (earlier versions had manual reveals that copiers
  gamed) [33]. `commit_reveal_weights_enabled` is on by default for new subnets [33b].
- Stated caveats: only works if rankings change within the concealment window; owners must keep
  `immunity_period > commit_reveal_period x tempo`; on-chain weights are stale views [33].
- Same timelock used on the data plane: "copy-proof responses" where a miner timelocks its answer
  so a colluding validator cannot leak it to another miner before scoring; and synchronized
  challenges [34].
- Docs also mention registration collateral that stays frozen on misbehaviour [31b].

### Code-improvement subnets

- **Ridges (SN62)**: miners submit coding agents (`agent.py`), validators run them on software
  engineering benchmark problems; uploading burns alpha (or uses a team-granted credit) [35].
  - Incentive mechanism (docs.ridges.ai) [36]: a new agent earns only if it beats the current
    leader by **at least 3% score** or is **at least 6% cheaper at equal or better score**;
    otherwise "rejected for incentives ... and earns nothing". Improvement units
    `ln(1+dPerf)/ln(1.03)` plus cost units `ln(1-dCost)/ln(0.94)` (cost capped at about 16.7);
    multiplied by a time factor `1 + sqrt(t/6)` (t = hours since leader approved); decays with a
    14-day half-life; emissions split pro rata over live scores. Docs: "Copying the leading agent
    and adjusting is not incentivized." Unallocated competition share is burned [36b].
  - History (IQ.wiki, secondary): after a late-September 2025 spam attack, miner code is
    open-sourced only **after** it has been evaluated, to stop copy-and-resubmit; the team reported
    a mixed-benchmark drop from 88% to about 17-18% and recovery to about 41% in early Oct 2025
    [37]. Not independently verified.
- **Gen42**: decentralized code generation (code Q&A chat and continue.dev-compatible
  completion API) per a 2024 profile listing it as SN42 [38]; a newer secondary page ties it to
  SN45 [38]. Subnet number and mechanics not verified.
- **Affine (SN120)**: models evaluated on RL environments; reward to models on the Pareto
  frontier; a third-party page says a challenger must beat the champion in all environments by a
  margin; project claims "copy-proof" [39]. Mechanism details not verified from primary source.
- Cooperative-miner subnets (miners explicitly building on each other's work with shared
  credit): none found with a documented credit-sharing mechanism. Ridges' public post-evaluation
  open-sourcing lets agents "build on each other's advances" (secondary) [37] but rewards only
  the improver. Not verified that any subnet pays upstream contributors.

### Limitations

- Yuma rewards agreement with other validators, not truth; commit-reveal only blunts copying.
- Winner-take-most code subnets reward forking the leader plus a small delta unless a margin is
  enforced; Ridges' 3% bar is the documented countermeasure [36].
- Benchmark overfitting and hardcoding are recurring problems (why Ridges hides problems and
  delays open-sourcing) [37].

### Implication for Lineage

- **Commit-reveal for replayer verdicts**: replayers should commit `hash(verdict, salt)` (or
  timelock-encrypt the verdict) before any verdict is visible, so a lazy replayer cannot copy the
  majority. Bittensor's own history shows copiers out-earn honest scorers without this [33].
- **Commit-reveal for patches**: an agent commits the patch hash on chain before revealing the
  patch, so priority is set by commit time, and another agent cannot copy a pending patch. Roster's
  Race module does the same with `sha256(race, entrant, solution, salt)` and lowest commit index
  wins (local).
- **Minimum-improvement margin** like Ridges' 3% / 6% cost bar, so a fork-and-tweak of the
  current best earns nothing.
- **Decay** of reward claims over time (14-day half-life in Ridges) so old wins do not earn
  forever, unless Lineage deliberately wants upstream royalties; decide explicitly.
- Replayer reward should not depend on agreeing with other replayers (Yuma's flaw); it should
  depend on matching the deterministic replay result, with slashing for provably wrong verdicts.

---

## 8. Signed and encrypted agent messaging

### Options

- **XMTP**: E2E messaging on the IETF **MLS** standard; decentralizing to a network of 7
  permissioned nodes selected by a Security Council; fees in USDC, "approximately $5 per 100,000
  messages during Phase 1"; page said mainnet transition expected complete March 2026 [40].
  A Jan 2026 blog listed testnet validation still in progress [40b]. Mainnet cutover date: not
  verified. Identity types: Ethereum EOAs, smart contract wallets, passkeys; **Solana identity
  not supported** per current protocol docs (a roadmap item) [41].
- **Waku** (now the messaging layer of Logos; implementation repo renamed `logos-delivery`):
  gossipsub-based relay with **RLN** rate limiting (public network: 1 message per 1-second epoch
  per publisher), light push (RFC still draft), filter, store (store does not guarantee
  availability) [42].
- **libp2p gossipsub**: signature policy `StrictSign` (publisher signs; receivers reject unsigned)
  or `StrictNoSign`; signature over the protobuf without `signature`, prefixed
  `libp2p-pubsub:`; fields `from`, `seqno`, `signature`, `key` [43]. v1.1 adds peer scoring
  (P1 to P7), outbound quotas, flood publishing, adaptive gossip, opportunistic grafting against
  sybil/eclipse [44].
- **Solana Memo program** (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`): validates UTF-8,
  requires every passed account to sign, logs memo and signers; up to 566 bytes for an unsigned
  instruction as of v1.5.1, fewer with more signers [21]. Good for anchoring a hash, not for
  bulk messages.
- **ZK Compression (Light Protocol)**: compressed token accounts and PDAs claimed 99% cheaper
  (100-byte PDA about 0.000015 SOL vs about 0.0016 SOL) [45]. Storage/indexer mechanics not read
  (not verified here).
- **Roster's Agent Messaging program** (local): typed off-chain messages with on-chain
  `ThreadProof` anchors; the escrow accepts a thread-proof hash as dispute evidence, checking
  program owner, discriminator and hash (Roster docs/programs.md, local).

### Ed25519 -> X25519 and sealed boxes (libsodium)

- `crypto_sign_ed25519_pk_to_curve25519()` / `crypto_sign_ed25519_sk_to_curve25519()` convert a
  signing key pair to an X25519 key pair; the sk conversion reads only the first 32 bytes (seed)
  [46]. libsodium: "using distinct keys for signing and for encryption is still highly
  recommended" [46].
- **Sealed box** (`crypto_box_seal` / `crypto_box_seal_open`): fresh ephemeral key pair per
  message, nonce = BLAKE2b(ephemeral_pk || recipient_pk), ciphertext = `crypto_box_SEALBYTES +
  mlen`; sender cannot decrypt afterwards and **recipient cannot authenticate the sender** [47].
  So sealed boxes must be wrapped in an outer signature (sign-then-seal, or seal-then-sign over
  the ciphertext) when sender identity matters.

### Implication for Lineage

- Solana identities are Ed25519, so any agent can be encrypted to from its on-chain pubkey via
  pk_to_curve25519 with no extra registration. But follow libsodium's advice: publish a
  **separate X25519 key** in the agent's identity PDA, signed by the Ed25519 key, and fall back to
  conversion only when none is published.
- Message format sketch: envelope (all fields signed, Ed25519, domain-separated, nonce + expiry),
  body optionally sealed-box encrypted to the recipient's X25519 key (or to each replayer's key
  for embargoed patches). Anchor only `hash(envelope)` on chain via Memo or a Lineage instruction
  when it needs to be evidence.
- Embargoed patches for replayers: encrypt the patch to the selected replayers' X25519 keys, or
  timelock-encrypt to a drand round (Bittensor pattern [34]) so no replayer can leak it early.
- XMTP is a poor fit today (no Solana identity type [41]); libp2p gossipsub with `StrictSign`
  [43] or plain HTTPS A2A endpoints with signed envelopes are the practical transports.

---

## 9. ERC-8004 (cross-cutting identity/reputation)

- Draft ERC created 2025-08-13 [26]. Three registries: **Identity** (ERC-721 whose URI points to a
  registration JSON listing endpoints: A2A card, MCP, ENS, DID, email, x402 support, supported
  trust models), **Reputation** (signed feedback values), **Validation** (validators post 0 to 100
  responses; methods include stake-secured **re-execution**, zkML, TEE) [26]. "Validator incentives
  and slashing are managed by specific validation protocols" [26].
- Virtuals registers tokenised agents for ERC-8004 reputation [22]; ERC-8183 hooks are meant to
  compose with it [23].

### Implication for Lineage

- ERC-8004's Validation Registry with stake-secured re-execution is the closest named analogue to
  Lineage's bonded replayers, and it explicitly leaves incentives and slashing unspecified [26].
  That gap is Lineage's core mechanism. A Solana port of the identity registration JSON (pointing
  at the A2A card) costs little and helps cross-ecosystem discovery.

---

## Ideas from Roster (local project)

Read from `/Users/achi/roster/DESIGN.md`, `/Users/achi/roster/docs/how-it-works.md`,
`/Users/achi/roster/docs/programs.md`, `/Users/achi/roster/docs/risks.md`. Roster is a sibling
Solana/Anchor project (one program `roster_escrow`, Anchor 0.31.1, 132 instructions, devnet only).

1. **Escrow PDA as x402 `payTo`.** The job account address `["job", agent_id, task_id_hash]` is
   derivable before payment, so it is the x402 `payTo`; the hall opens the job when the signed
   payment arrives and anyone can `mark_funded` once the vault holds the budget.
2. **Terms snapshot at open.** Payee, submit key, fee rate, four windows, bond and panel share are
   copied into the job at open, so later rebinding or fee changes cannot redirect or reprice it.
3. **Permissionless liveness.** `refund_expired`, `auto_accept`, `finalize_reject`,
   `resolve_default`, `dispute_timeout` can be called by anyone, are never paused, and touch only
   that job's accounts; no party can trap funds by going silent. No fee on refunds.
4. **Bonded dispute ladder.** Reject -> provider disputes with a bond inside a window -> buyer must
   match the bond or lose by default -> panel rules; loser's bond pays the panel fee. Below a
   dispute floor, rejection is final. Settlement proposals let parties split without a ruling.
5. **Deliverables by hash only.** `submit` posts a deliverable hash; nothing stored on chain.
   Evidence is a hash, optionally backed by an on-chain `ThreadProof` from an Agent Messaging
   program (checked for owner, discriminator and hash). Known gap: proves the message exists, not
   that it is about this job.
6. **Job shapes** worth reusing: milestones (1 to 8 tranches), metered capture under a cap, paid
   independent evaluator with a bond (or a checker program instead), **subcontract** child jobs
   funded from the parent vault and paid only after the parent completes, bounties (splittable),
   request-for-bids where the accepted bid's terms hash becomes the spec hash, standing orders.
7. **Race module**: commit `sha256(race, entrant, solution, salt)`, then reveal; winner is the
   valid entry with the lowest commit index regardless of reveal order; verifier can be an answer
   hash, a checker program, a keeper-attested test suite with bonded challenges, or a panel.
   Directly applicable to Lineage patch priority.
8. **Vouch pools**: backers stake to cover an agent's jobs; claims only on facts read from job
   accounts (expired without delivery, final rejection, lost dispute). An insurance layer for
   hiring an agent you do not know.
9. **Throughput counters per epoch**, with floors and per-buyer caps excluding wash jobs; a basis
   for reputation that is hard to inflate.
10. **Payment-first, failures free.** Nothing runs before payment; follow-up turns and retries after
    the provider's own failure are free; budget ceiling on the card; unpaid hires expire (900 s).
11. **A2A interop lessons**: serve both 1.0 and 0.3 dialects from one card; the official JS SDK
    joins `/.well-known/agent-card.json` onto the given URL, so nested per-agent cards need care;
    per-call auth tokens must be declared as an `apiKey` security scheme because `GetTask` has no
    metadata field.
12. **Non-custodial routing over custodial payouts**: Roster explicitly avoids collecting and paying
    out on behalf of third parties (money-transmitter risk); payee should be the seller's own
    address or escrow.

How these map to Lineage: items 1 to 5 and 7 give most of the on-chain skeleton for
"agent A hires agent B to improve repo X, replayers verify, escrow releases"; replace Roster's
human/team panel with the bonded replayer quorum, and replace USDC with $LINE.

---

## Cross-cutting implications for Lineage (summary)

- Wire: A2A 1.0 (signed cards, tasks, artifacts) for collaboration; MCP only for tool access.
- Money: x402 SVM `exact` (and `upto` if an SVM binding is confirmed) with `payTo` = a Lineage
  escrow PDA; settlement asset $LINE.
- Escrow state machine: ACP/ERC-8183 shape (`open, budget_set, funded, submitted, completed,
  rejected, expired`), with the single evaluator replaced by bonded replayers and Roster's
  permissionless liveness and dispute ladder.
- Anti-copying: commit-reveal (or drand timelock) for both patches and replayer verdicts; a
  minimum-improvement margin; deterministic replay as ground truth rather than inter-validator
  agreement.
- Messaging: Ed25519-signed envelopes covering every field, separate published X25519 key,
  sealed boxes wrapped in a signature, hashes anchored on chain only when they are evidence.

---

## Sources (all accessed 2026-10-07)

1. https://a2a-protocol.org/latest/specification/ (chars 0 to 100k)
2. https://a2a-protocol.org/latest/specification/ (chars 100k to 200k: sections 4.1.6, 4.1.7, 4.3, 8.2, 8.4, SSE)
3. https://github.com/a2aproject/A2A/releases
4. https://linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year
5. https://www.cloudmagazin.com/en/2026/04/25/a2a-protocol-1-2-in-production-what-dach-cloud-architects-need-to-change-in-their-istio-setup-now/ (secondary; claim not corroborated)
6. https://aaif.io/blog/a2a-joins-aaif ; secondary: https://www.techzine.eu/news/devops/143659/google-transfers-a2a-to-the-agentic-ai-foundation/ , https://aimagazine.com/news/why-did-googles-a2a-join-the-agentic-ai-foundation
7. https://modelcontextprotocol.io/specification/latest
8. https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
9. https://docs.x402.org/core-concepts/http-402
10. https://www.x402.org/writing/x402-v2-launch
11. https://docs.cdp.coinbase.com/x402/migration-guide ; https://docs.polygon.technology/payment-services/agentic-payments/x402/guides/migration-v1-to-v2
12. https://www.linuxfoundation.org/press/linux-foundation-is-launching-the-x402-foundation-and-welcoming-the-contribution-of-the-x402-protocol
12b. https://cfotech.news/story/linux-foundation-launches-x402-foundation-with-40-members (secondary)
13. https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md
14. https://github.com/coinbase/x402/tree/main/specs/schemes (directory listing via GitHub API)
15. https://github.com/coinbase/x402/blob/main/specs/schemes/upto/scheme_upto.md
16. https://solanacompass.com/news/coinbase-upgrades-x402-facilitator-on-solana-upto-scheme-live-verify-latency-cut-66 (secondary)
17. https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md
18. https://namespaces.chainagnostic.org/solana/caip2
19. https://github.com/google-agentic-commerce/a2a-x402
20. https://raw.githubusercontent.com/google-agentic-commerce/a2a-x402/main/spec/v0.1/spec.md
21. https://www.solana-program.com/docs/memo
21b. https://whitepaper.virtuals.io/about-virtuals/agent-commerce-protocol-acp
22. https://os.virtuals.io/llms-full.txt (ACP overview, core concepts, architecture, contracts, agent token sections) ; index https://os.virtuals.io/llms.txt
23. https://ethereum-magicians.org/t/erc-8183-agentic-commerce/27902
24. https://github.com/valory-xyz/autonolas-registries (README)
24b. https://github.com/valory-xyz/autonolas-registries/blob/main/docs/FSM.md
24c. https://github.com/valory-xyz/autonolas-registries/blob/main/contracts/staking/StakingBase.sol
24d. https://github.com/valory-xyz/ai-registry-mech (README and contracts/MechMarketplace.sol)
24e. https://github.com/valory-xyz/mech-interact
25b. https://siliconangle.com/2025/02/27/olas-launches-decentralized-ai-marketplace-ai-agents-can-hire/ (secondary)
25c. https://docs.olas.network/llms.txt
26. https://eips.ethereum.org/EIPS/eip-8004
27. https://github.com/fetchai/uAgents/blob/main/python/uagents-core/uagents_core/identity.py
28. https://github.com/fetchai/uAgents/blob/main/python/uagents-core/uagents_core/envelope.py
29. https://github.com/fetchai/uAgents/blob/main/python/src/uagents/config.py ; https://github.com/fetchai/uAgents/blob/main/python/src/uagents/network.py ; https://github.com/fetchai/uAgents/blob/main/python/src/uagents/registration.py
29b. https://github.com/fetchai/uAgents/blob/main/python/uagents-core/uagents_core/registration.py
30. https://uagents.fetch.ai/docs/guides/types
31. https://www.bittensor.com/llms.mdx/docs/concepts/emissions/content.md
31b. https://bittensor.com/llms.txt (registration collateral entry)
32. https://bittensor.com/llms-full.txt (Null consensus section)
33. https://bittensor.com/llms-full.txt (Validating guide, "Commit-reveal" section)
33b. https://bittensor.com/llms-full.txt (hyperparameter `commit_reveal_weights_enabled`)
34. https://bittensor.com/llms-full.txt (Timelock guide: synchronized challenges, copy-proof responses)
35. https://github.com/ridgesai/ridges
36. https://docs.ridges.ai/incentive-mechanism
36b. https://docs.ridges.ai/competitions/overview
37. https://iq.wiki/wiki/ridges-ai.md (secondary)
38. https://subnetalpha.ai/?p=1486 ; https://www.techflowpost.com/en-US/article/19561 (secondary, conflicting subnet numbers)
39. https://hub.docker.com/r/affinefoundation/affine ; https://cryptocurrencyjobs.co/startups/affine/ (self-reported/secondary)
40. https://xmtp.org/decentralization
40b. https://blog.xmtp.org/xmtps-decentralization-update-jan-2026/
41. https://docs.xmtp.org/protocol/identity ; https://docs.xmtp.org/chat-apps/core-messaging/extend-id-model
42. https://rfc.vac.dev/waku/standards/core/17/rln-relay ; https://github.com/logos-messaging/logos-delivery/releases ; https://docs.waku.org/learn/concepts/protocols
43. https://github.com/libp2p/specs/blob/master/pubsub/README.md
44. https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.1.md
45. https://www.zkcompression.com/
46. https://doc.libsodium.org/advanced/ed25519-curve25519
47. https://doc.libsodium.org/public-key_cryptography/sealed_boxes

Local (read, not edited): /Users/achi/roster/DESIGN.md, /Users/achi/roster/docs/how-it-works.md,
/Users/achi/roster/docs/programs.md, /Users/achi/roster/docs/risks.md.
