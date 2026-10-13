# Seamless bind: a hosted launch binds in the launch's own approval

Owner, 2026-10-13: "we want the binding of the agent to be seamless, there's always an issue with it",
and the same day: "add a popup on a button above the navbar that shows up if you launched a token but
didn't bind them".

Status: sections 1 to 8 built and live. Section 9 (required bind) and section 10 (the backup signature
on a durable nonce, with the runtime key pool) are built and proven on devnet (section 11). No mainnet
transaction was sent for either.

## 1. The problem

A hosted agent works only after its owner rotated its signing key to the key the hosted runtime made
for it (`units_registry::rotate_agent_key`, identity plan I1). Until this change that was a second
thing to sign after the launch: the launched screen asked the runtime for its key, the wallet signed
the rotation, the runtime co-signed and sent it. Launchers missed it or it failed (a wallet adding its
own guard instructions, a blockhash the runtime's node had not seen, a wallet session that was no
longer authorized, a closed tab). One mainnet agent, `CpziNQ4NgF4SExt45cLVcBnratWzew6v4mVugA5HhSW1`,
has been waiting since its launch: the runtime answers `awaiting_owner` for it (read 2026-10-13).

## 2. What the chain allows (read from `onchain/programs/units-registry`, nothing changed there)

- `rotate_agent_key` accounts: config, `owner` (signer), `new_key` (signer), the agent record
  (writable, `has_one = owner`). The old agent key does not sign. Nothing about the record is known
  to the transaction until it runs, so it can be signed before the agent exists and runs once the
  launch has landed.
- The launch itself (`create_v2` + `register_pump_launch`) is signed by the launcher, the agent key
  and the mint key, and `register_launched` writes `signing_key = agent`. So "no rotation at all"
  would mean launching with the runtime's key AS the agent id, and then the runtime would have to
  co-sign the launch transaction (pump.fun's create with writable accounts), the soul's `set_profile`,
  the coin image and links the agent key signs before the launch, and later the move of the launch
  holding. That is far outside what the runtime's key may sign (section 5), and the launcher would
  hold no key for the agent. Rejected. The rotation stays; it moves into the launch's approval.
- Only instructions the deployed mainnet programs already have are used (`rotate_agent_key` is what
  every bound mainnet agent used). No program change, no upgrade.

## 3. The design

1. **Reserve.** While the launch is built (Review step), the page asks the runtime for the key it
   will use for this agent id: `POST /runtime/bind/<agent> { reserve: true }`. The runtime makes the
   key it would make at discovery anyway (same file, `packages/runtime/src/reserve.ts`) and answers
   `{ new_key, status: "reserved" }`. No key, a full runtime or an older runtime: the launch is built
   without the bind and everything in step 4 applies.
2. **One approval.** The wizard adds one more transaction after the launch's own: compute budget plus
   `rotate_agent_key(owner = launcher, new_key = the reserved key)`, the launcher as fee payer. It is
   a legacy message, or a v0 message with no lookup table when the launch's transactions are v0 (one
   approval never mixes the two). Its fee is a row of the review's transaction table and part of the
   total. The wallet approves all of them in the one request the launch already makes
   (`signAndSendAll`, so the same handling of a wallet's guard instructions and of a wallet that
   wants them one by one).
3. **Co-sign before sending, send with the launch.** After the wallet signed and before anything is
   sent, the page hands the wallet-signed rotation to the runtime:
   `POST /runtime/bind/<agent> { tx, sign_only: true }`. The runtime checks it exactly as it checks a
   bind it sends itself, adds its key's signature and hands the wire back. The page sends it last, with
   the launch: inside the same Jito bundle on mainnet (it lands in the launch's own block or not at
   all), in order after the launch transactions on devnet. Why this rather than posting the rotation
   after the launch landed: the rotation then never outlives the launch's blockhash. Posting after
   landing spends the blockhash's lifetime on the wallet prompt, the landing and the runtime's read of
   the new launch before the rotation is even sent, and an expired rotation is exactly the "second
   thing to sign" this removes.
4. **When that did not happen** the launch is never held up or failed by it. The bind is `optional`
   in the bundle: if the runtime did not answer, refused, or the bundle is already full (a mainnet
   bundle holds five transactions; the bind is then signed with the others but held back), the launch
   goes out alone and the page keeps the rotation the wallet already signed. The launched screen then
   finishes by itself: it posts that kept rotation for the runtime to co-sign and send (no second
   approval while its blockhash lives), and only when that is too late does it ask the wallet for the
   one signature, saying so first. It retries what can pass by itself; a refusal in the wallet is not
   retried. If the bind was in the bundle and failed on chain, the launch transactions are sent in
   order as before and the bind is reported as left, not as a failed launch.
5. **Never a step to find.** The same routine (`apps/web/wallet/bind.ts finishBind`) is behind:
   the launched screen, Profile > Manage, "Finish setup: bind" at the top of the agent's own page
   (shown to its owner while the runtime waits), and a slim bar above the navigation on every page
   for a wallet that launched a hosted agent which is not bound ("Finish setting up <name>", or
   "2 agents need setup"), whose popup binds with one press and closes itself. Agents launched before
   this work, like the one in section 1, are fixed from the same bar and the same button.

## 4. What the runtime answers

| Request | Answer |
|---|---|
| `GET /runtime/bind/<agent>` | unchanged: key and status of a hosted launch on chain, 404 otherwise |
| `POST /runtime/bind/<agent> { tx }` | unchanged: checks, co-signs, simulates, sends (agent on chain only) |
| `POST /runtime/bind/<agent> { reserve: true }` | the reserved key; the same as GET for an agent already a hosted launch; 404 for an id with any other record on chain; 429 when full |
| `POST /runtime/bind/<agent> { tx, sign_only: true }` | the checked wire with the runtime key's signature, unsent; for a reserved agent or one that waits for its owner |
| `GET /runtime/unbound/<wallet>` | `{ agents: [{ agent, new_key, mint }] }`: the waiting agents this wallet launched, at most 20, from the runtime's own state (the launcher of each read from chain once) |

All of them sit in the gate's existing `bind` class (30 a minute per address, burst 15); the gate
forwards `/runtime/unbound/<wallet>` as it forwards `/runtime/bind/<agent>`.

## 5. What the runtime co-signs, and the abuse analysis

The runtime's key for an agent signs one thing: a transaction whose only instructions are compute
budget (within the co-signer's limit and price caps), a wallet's own guard (Lighthouse, passed over),
and exactly one `rotate_agent_key` of THIS agent's record to THIS key, in which every other signer
has already signed, the key is not the fee payer and is not writable. That is `inspectForCosign` +
`checkBindTx`, unchanged, then the transaction firewall for the guarded key (its second, independent
check of the same rule). The one extension: a v0 message is accepted when it reads no lookup table
(it then names every account itself, like a legacy message); a v0 message that reads a table is
still refused.

What a reservation adds for an attacker, and the bound on each:

- **Spam.** A reservation is one small key file and a list entry. At most 200 live at once, at most
  6 per caller address (the gate's forwarded address), each expiring 15 minutes after it was last
  asked for, behind the gate's rate limit. Asking again for the same id takes no second slot. A full
  runtime answers 429 and launches fall back to binding after they land.
- **A key that outlives its use.** At expiry the runtime reads the chain: an agent that became a
  hosted launch is adopted with that same key; any other reservation loses its key (deleted when the
  runtime never signed with it, set aside under `expired-keys/` when it did, where nothing loads it).
- **Signing something else with a reserved key.** Not possible: the checks above name the agent id
  the key was reserved for; `register` (which would make the key an agent of the caller's) and every
  other registry instruction are refused; the firewall refuses a guarded key whose agent it does not
  know. A reservation is co-signed at most 8 times.
- **Reserving for an id that is already something else.** Refused: an id with a registry record that
  is not a hosted launch (self-hosted, a verifier, a launch removed from the network) gets no
  reservation.
- **A co-signed rotation in the caller's hands.** It runs only if the caller's signature is the
  record owner's, so the most a caller gains is a hosted agent THEY own bound to this runtime, which
  is what a hosted launch is. Pointed at a record of theirs that is not a hosted launch, they hand
  their own agent's key to a runtime that never works for it and then drops the key: self-inflicted,
  and undone by their own next rotation. It expires with its blockhash.
- **Someone else's reservation.** The answer holds no secret (a public key); a second caller asking
  for the same id gets the same key and can do nothing with it without the owner's signature.
- **Runtime spend.** Unchanged: the runtime works only for agents that are hosted launches on chain,
  under its global cap, per-agent caps and the agent's vault. A reservation starts no work.

## 6. Wallet behaviour

Phantom adds Lighthouse instructions to what it signs and may refuse a batch: the bind goes through
the launch's `walletMessage` check (the built instructions unchanged and in order, only Lighthouse
added) and through the per-transaction fallback, where declining only the bind leaves only the bind
out. A wallet that alters the bind in any other way: the bind is dropped, the launch goes on, nothing
of the altered transaction is kept. Real Phantom was not run for this work (section 8).

## 7. Proof

- `bun test packages/runtime/test/bind-reserve.test.ts packages/runtime/test/bind.test.ts`
  (reservations, every refusal, the firewall as second lock, the waiting list),
  `packages/chain/test/cosign-bind.test.ts` (v0 without a table, sign-only),
  `apps/web/test/bind-plan.test.ts` and `bind-bundle.test.ts` (the wizard's transaction, and the
  bundle signer with the bind in it, the wallet and chain stood in), `scripts/deploy/gate.test.ts`.
- `UI_PORT=9663 bunx playwright test tests/ui/setup-bar.spec.ts` (headless, 1280 and 390 px): the bar
  for the launcher of an unbound agent, hidden for everyone else with no layout and no wallet code,
  the popup binding with a wallet that signs, dismissal, and Finish setup on a real agent's page. The
  runtime and one account are stood in; the write guard still refuses every send.
- `bun scripts/launch-e2e/bind-devnet.ts --port <9663, 9666..9669>`: real devnet transactions, the
  page's own signer and finish routine, the runtime's own bind code on 127.0.0.1. Last run
  (`scripts/launch-e2e/BIND-DEVNET-LAST.json`, 2026-10-13, 12 of 12): one wallet request carried the
  launch and the bind, both landed, the registry shows the reserved key after one rotation; from
  asking the wallet to the bind confirmed took 3.9 s and 22 of the blockhash's 150 block heights (the
  test wallet approves at once: a person's reading time adds to both, and counts against the launch
  itself just the same). With the co-signature withheld before the send, the kept rotation bound the
  agent 5.2 s after the approval, 21 block heights, still one wallet request. An agent launched with
  no bind was listed for its launcher and bound with one signature.

## 8. Not proven

- A real wallet extension (Phantom, Solflare): how it shows a batch whose last transaction cannot be
  simulated before the launch exists, and whether it adds guard instructions to it.
- The Jito bundle with the bind in it on mainnet (devnet sends in order). If Jito refuses the bundle
  the existing ordered sends take over, and the bind is optional there.
- The full hosted runtime loop picking up an agent bound this way (only its bind surface ran in the
  devnet proof; `refreshAgents` marks an agent bound from the chain's signing key, as before).

## 9. Required bind: a hosted launch can never end up unbound (owner, 2026-10-13)

"we need bindings to be better and fixed ... so that launches aren't always fucked sometimes."

What went wrong after section 3 shipped: the bind was optional. The hosted runtime closed its bind
listener at SIGTERM and then drained for up to 25 minutes at every deploy (seen live on the mainnet
instance, 2026-10-13: `units-main-runtime` in `deactivating (stop-sigterm)`, nothing listening on its
bind port). A launch built in that window had no reservation, went out without the bind, and needed a
second signature its launcher did not come back for.

Status of this section: built. Proofs in section 11.

### 9.1 The bind service: the bind surface outlives the runtime

The bind surface is a process of its own: `lineage-runtime bind --config <runtime.json> --port <n>`
(`packages/runtime/src/bind-service.ts`), the deploy kit's `units-bind` unit. Chosen over keeping the
runtime's own listener open while it drains, because that still leaves the gap between the old process
leaving and the new one listening (the runtime's start reads Core, prices, providers and the chain
first), and leaves no bind surface at all when the runtime is off or in a restart loop. The runtime
keeps its listener up while draining anyway, for an instance that runs without the service.

- It serves exactly the routes of section 4 with the same handler (`bind.ts`), the same co-signer
  checks and its own installed transaction firewall, plus `GET /runtime/bind/health`.
- Same user, same state directory. The key store is shared (`keystore.ts`): one file per agent in
  `<state_dir>/keys`, mode 600 in a mode 700 directory, created by writing a private temporary file and
  linking it to its name, so of two processes asking at the same moment one wins and the other reads
  the winner's key. Nothing is overwritten. The runtime's `keyFor` goes through the same function.
- It reads a key only for the agent a request names. It never loads the runtime authority key, a model
  key or a provider key (the unit is given none of them), never takes the runtime's lock and never
  writes `state.json` (it reads it for the waiting list). Its own files: `<state_dir>/bind-service/`
  (lock, `status.json`, `pending.json`, its firewall log). `reservations.json` is this process's alone
  while it runs; a runtime with `bind_service_port` in its config keeps no reservations and serves no
  bind route (its port keeps the desktops and the genesis proof).
- A hosted launch the service reads on chain gets the key file the runtime will use at discovery
  (`keys/<agent>.json`), so the runtime adopts it with that key whenever it is back.
- Not covered: Core's purge list. A purged launch that is still a hosted launch on chain can be bound
  here; the runtime never works for it and removes its key as before.

Measured on this machine (`bun scripts/launch-e2e/bind-restart.ts`, record in
`scripts/launch-e2e/BIND-RESTART-LAST.json`; the real service and the real gate, the chain and the
agent loop stood in): a launcher every 25 ms reserving a key and getting its co-signature. Across a
restart of the agent loop (SIGTERM, 3 s drain, start): 153 of 153 answered directly and 77 of 77
through the gate, longest answer 36 ms. Across the service's own restart: 4 ms to leave, 106 ms to
start, 137 ms between its last answer before and its first after; directly 4 requests were refused,
through the gate none (the gate retries a refused dial), longest answer 261 ms.

### 9.2 The launch form: the bind is required

- Building a hosted launch asks for the reservation and keeps asking for 20 s (the whole build has 25)
  with the line "Getting the agent's runtime key…". Still none: the launch is not built. One sentence,
  "The hosted runtime did not give this agent its key, so the launch was not built. Nothing was signed
  or sent.", and a Try again button.
- Right before the wallet is asked, the reservation is asked for once more, for 12 s (it expires 15
  minutes after it was last asked for). No answer: "The hosted runtime is not answering, so nothing was
  signed. Try again." Another key than the one the review was built with: the launch is built again by
  itself and says so.
- After the wallet signed, the co-signature is asked for up to 20 s. Still none: nothing is sent,
  "bind: The hosted runtime did not co-sign the agent's binding, so nothing was sent. Try again."
  The runtime refusing the transaction itself is not retried: "The hosted runtime refused the agent's
  binding (<its reason>), so nothing was sent."
- A launch on the launcher's own worker is untouched.
- Escape hatch, off by default: `UNITS_BIND_OPTIONAL=1` in the web server's environment (it reaches
  the page in `/chain/config`, which answers when the bind service does not). The form then behaves as
  section 3.4: the bind is optional and follows the launch.
- When the form opens, the page reads `/runtime/bind/health` once and shows one quiet line under the
  Runtime choice only when it is down: "Hosted launches are paused for a moment: the hosted runtime is
  not handing out keys. You can fill in the form; Launch works again once it is back."

### 9.3 On chain: together, or finished without the launcher

- Mainnet bundle with room: the bind is in the bundle. Launch and bind land together or not at all.
- Bundle already full (five transactions): the bind cannot be merged into a launch transaction (the
  co-signer signs nothing that holds any instruction but the rotation, section 5, and that stays). It
  is co-signed before anything is sent, sent by the page the moment the launch lands, and sent by the
  bind service as well (9.4). The launched screen shows "binding" until the chain shows it.
- Bundle refused, ordered sends: the bind is the last of them; if the page stops before it, 9.4.
- A wallet that wants the transactions one by one: declining the bind sends nothing.
- A wallet that changes the bind in any way but its own guard instructions: nothing is sent.
- The launched screen's Runtime row ends at the hosted runtime's signing key by itself. While a backup
  signature is held (section 10) it reads "Your agent will start as soon as the runtime is back.
  Nothing more to sign." and the wallet is never asked again. With no backup and nothing more the page
  can do, it shows the reason and "Finish setup: bind" as the primary button.
- In code: `apps/web/wallet/chain.ts` `signAndSendAll` parts carry `mustSign` (signatures before any
  send, or the call throws), `hold` (co-signed, out of the bundle, sent right after) and `keep`
  (co-signed, never sent by the page); `bind-plan.ts` builds them.

### 9.4 The safety net: the service finishes what the wallet approved

Every rotation the service co-signs for a launcher to send is kept (the wallet-signed wire, never a
key): the co-sign request the page already makes IS the hand-over, before the launch is sent. The
service then reads that agent's record every 1.5 s:

| What the chain shows | What the service does |
|---|---|
| no record, blockhash alive | waits |
| no record, blockhash gone | drops it: the launch never landed and cannot any more |
| bound to the runtime's key | drops it; counted as bound with the launch, or after it when it had been seen unbound |
| a hosted launch, not bound, for 2.5 s | co-signs (the same checks and firewall as section 5) and sends it; again on every pass until it lands |
| a hosted launch, not bound, blockhash gone | counts it as launched unbound, logs it, lists it for its launcher (`/runtime/unbound/<wallet>`): only the owner's signature can bind it now |
| a record that is not a hosted launch | drops it |

So a tab closed after the approval, a full bundle and an ordered send that stopped all end bound
without the launcher, as long as the launch landed within the rotation's blockhash. The kept wires
survive a restart of the service (`pending.json`, mode 600). At most 1,000 are kept, each at most 5
minutes.

### 9.5 Health and counters

`GET /runtime/bind/health`: 200 `{ ok: true, reserve, key_store, cosigner, chain, kept, counters }`
when a launch can be bound now, 503 with the same body when not. `key_store`: a file can be created in
the key directory. `cosigner`: a rotation of a throwaway agent to a throwaway key that exist only in
memory passed the checks and the firewall and was signed (once a minute at most). `chain`: a chain read
answered in the last minute. `reserve.full`: the reservation list is full. Counters (kept across
restarts in `bind-service/status.json`, printed by `lineage-runtime status` under `bind`):
`reservations`, `cosigns`, `bound_with_launch`, `bound_after`, `sent_by_service`, `launches_unbound`.

The site monitor reads it for every service named in `MONITOR_BIND` (`scripts/deploy/monitor.ts`):
not answering or not ready is a failure that names the part; each further unbound launch is a warning
of its own.

### 9.6 Abuse, now that a full list refuses launches

While the bind was optional a full reservation list cost nothing. Required, it refuses hosted launches,
so the list holds 1,000 (was 200) with the same 6 per caller address and 15 minute expiry: filling it
takes 167 addresses asking continuously. It is still a way to hold hosted launches up; the monitor
shows it (`reserve.full`) and the escape hatch of 9.2 is the answer while it lasts.

### 9.7 Deploy kit

- `scripts/deploy/systemd/units-bind.service` (an instance: `units-main-bind`, port 9766): the runtime's
  user and state, no Docker, no model or provider key, `TimeoutStopSec=10`, `Restart=always` after 1 s,
  conditioned on the instance having a runtime authority key (the file is not read).
- It is a PUBLIC unit in both kits: restarted with the others, one by one and health-checked, right
  before the gate; never in the background set that drains. Up but not ready (503) never fails a
  deploy.
- The gate forwards `/runtime/bind/*`, `/runtime/unbound/*` and `/runtime/bind/health` to it
  (`--bind`, port 9666 / 9766). `site-config.ts` writes `bind_service_port` into `runtime.json`.
- No extra step in the deploy command. The first deploy that carries it, on the first instance only:
  the old runtime closes its listener when it is told to stop, before the gate has been restarted onto
  the service, so the bind surface is away for the length of the public restart, once. The second
  instance's activation stops the runtime after the gate restarted: no window there.
- After a rollback to a release without it: `systemctl disable --now units-bind` (or
  `units-main-bind`); the older gate and runtime do not use it.

## 10. The backup signature: a bind that does not expire (owner, 2026-10-13)

"the bind must work regardless ... a just in case bind signature taken at launch that the server sends
later if there was an issue."

Status: built. Proofs in section 11.

### 10.1 What the chain allows (run on devnet, `scripts/launch-e2e/nonce-devnet.ts`, 9 of 9)

- A nonce account's stored value is set when `InitializeNonceAccount` runs:
  sha256("DURABLE_NONCE" + the blockhash before the block it landed in), recomputed from the landing
  block (check 1b). It does not exist when the wallet signs.
- So a rotation signed in the same approval as the account's creation can only carry the blockhash
  known then: an ordinary transaction, refused with "Blockhash not found" once that blockhash aged out
  (check 2). **A nonce account made in the launch transactions cannot back a signature of the same
  approval.** The account has to exist before the launch.
- A transaction signed over the stored value of an account that already exists landed 90 s after its
  signing (3a), advanced the nonce (3b), was refused when sent again (3c), and is not a nonce
  transaction when anything stands before `AdvanceNonceAccount` (3d). The authority withdrew the whole
  balance and the account was gone (4).
- Solana's own documentation says the same of the order ("Build the transaction with
  `AdvanceNonceAccount` as the first instruction and the nonce value as the `recent_blockhash`",
  solana.com/docs/core/transactions/durable-nonces, read 2026-10-13) and adds: "Durable nonces may be
  deprecated in a future release." If they are, this section falls back to section 9 alone.

### 10.2 The design as built

1. **The key pool** (`packages/runtime/src/pool.ts`). The runtime side makes runtime keys ahead of
   time, each with its own nonce account: address derived from the payer and the key
   (`CreateAccountWithSeed`, the payer as base, so the payer is the creation's only signer), 80 bytes,
   the KEY as nonce authority. Payer and signer: the runtime authority key. Files in
   `<state_dir>/pool-keys` (mode 700, keys 600) beside `keys/`.
2. **Bounds** (runtime config `bind_pool`, written by `site-config.ts`): 20 ready keys, refilled when
   fewer than 8 are ready, never more than 40 nonce accounts alive at once (ready, handed out and
   waiting to be closed together), 4 creations a minute, and never a refill that takes the payer under
   0.05 SOL. Rent for 80 bytes read on mainnet 2026-10-13: 1,056,640 lamports. **Locked at the target:
   0.0211328 SOL; at the cap: 0.0422656 SOL**; each creation and each close also pays a 5,000 lamport
   fee. All rent returns when the accounts close.
3. **Hand-out.** A new reservation takes a ready pool key as the agent's own key file (a hard link,
   then the pool file is removed: one key, one agent) and its answer carries
   `nonce: { account, value }` read from chain at that moment. No ready key: an ordinary key and no
   `nonce`, and the launch still binds in its bundle (section 9), never unbound.
4. **In the launch's approval** the wallet also signs `bind backup`:
   `AdvanceNonceAccount(account, authority = reserved key)`, compute limit, compute price,
   `rotate_agent_key(owner, agent, reserved key)`, over the nonce's value, the launcher as fee payer.
   The reserved key already signs the rotation as the new key, so being the nonce authority adds no
   signer; it stays read-only and never pays. The page never sends it and it is no cost row: it costs
   the launcher a network fee only if it is ever used (the review says "no fee unless used"), and the
   launcher's wallet must hold that fee then.
5. **Co-signer and firewall** (`packages/chain/src/cosign.ts`, `firewall.ts`), each on its own: one more
   instruction is accepted, only as instruction 0, only the System program's `AdvanceNonceAccount`
   with exactly three accounts and four bytes of data, on the nonce account of THIS key with THIS key
   as authority. After it: compute budget and exactly one `rotate_agent_key` of this agent's record to
   this key (a wallet's Lighthouse guard after it is still passed over). Refused: a System instruction
   anywhere else, any other System instruction, another nonce account, another authority, a second
   rotation, another agent, a key with no nonce account.
6. **Kept and sent** (`bind-service.ts`). The co-sign request is the hand-over: the service keeps the
   wallet-signed backup (with the nonce value it read from chain; one signed over anything else is not
   kept) before it answers. It sends it only when the agent is a hosted launch on chain without its
   bind AND the ordinary bind can no longer land, then again with growing gaps (2 s doubling to 60 s)
   until the chain shows the bind. Dropped: bound; the record is not a hosted launch; no launch 15
   minutes after signing; the nonce moved or the account is gone (counted as launched unbound and
   listed for the owner); 7 days.
7. **Cleanup, without the launcher** (the pool pass, once a minute in the runtime, or
   `lineage-runtime pool --config <file> --fill`). The key is the nonce authority, so it signs the
   withdrawal of the whole balance to the payer, the payer paying the fee: when its agent is bound (by
   either path: the backup is void once the account is gone), and for a key set aside after its
   reservation expired. A reservation that expires with the key never having signed: the key goes back
   to the pool with its account untouched (no transaction carries its signature, so there is nothing to
   void; no advance is sent). A key that ever co-signed is never given to another agent (it is set
   aside as before, and closed). The firewall lets a key sign that withdrawal only when it is the whole
   transaction, of its own account, to the payer that funded it, the key read-only and not paying; a key
   still in the pool or set aside can sign nothing else at all.
8. **When the pool cannot be filled** (the payer under its floor, the cap reached, creations failing):
   `GET /runtime/bind/health` says so under `backup` (`ok`, `ready`, `alive`, `cap`, `locked_lamports`,
   `payer_lamports`, `why`), `lineage-runtime status` prints it under `bind_pool`, and launches go on
   with the bind in the bundle alone. `backup` never makes the health answer not ok.

Counters added: `backups_kept`, `bound_by_backup`.

### 10.3 What it covers, and what it does not

The backup covers everything after the approval: the bind left out of or failing in the send, a
closed tab, and the hosted runtime AND the bind service being away for minutes or hours afterwards.
At the approval itself the bind service must answer (the reservation and the two co-signatures): it
is a process of its own that restarts in about a tenth of a second behind a gate that waits 15 s for
it, and the hosted runtime's restarts and drains do not touch it. A design in which no server process
answers at launch time needs the keys' public halves and their allocation to agent ids somewhere that
is itself always on, which is the same requirement moved; not built.

### 10.4 Wallets (read 2026-10-13; no real wallet was run)

- **Phantom** documents that it may add Lighthouse instructions: "When you submit a transaction to
  Phantom, it may be augmented with Lighthouse assertion instructions before being submitted to the
  network." (docs.phantom.com/developer-powertools/lighthouse). The page gives no conditions and does
  not say where they are placed. **Phantom's documentation says nothing about durable nonce
  transactions** (the whole docs dump was searched; no statement that it leaves them unmodified).
- Phantom adds priority fees only when "The transaction(s) do not already have signature(s) present",
  "do not have existing priority fee instructions" and stay under the size limit
  (docs.phantom.com/developer-powertools/solana-priority-fees). The backup carries its own compute
  budget instructions, so by that page none is added.
- A user thread on Phantom's forum reports the warning "This transaction could steal your funds in the
  future" whenever a `nonceAdvance` instruction is present (github.com/orgs/phantom/discussions/205,
  2024; Phantom did not confirm it as intended). A launcher may see that warning on the batch.
- One third-party project states that Phantom inserts Lighthouse instructions ahead of the advance,
  which would make it an ordinary expired transaction (github.com/McRitchie-Studio/solana-studio
  README; unverified, no transaction given).
- **Solflare**: docs.solflare.com says nothing on added instructions or on durable nonces. A user on
  Solana StackExchange reports that it adds an assertion at signing (question 21473, unanswered).
- **What the page does with any of that.** The backup is the one part of the approval that may be
  left out. A wallet that will not sign it, or that hands it back with anything but its own guard
  instructions AFTER the advance: the page's check or the runtime's co-signer refuses it (anything
  before the advance is refused by the co-signer and the firewall), only the backup is dropped, and
  the launch goes out bound in its bundle as section 9 requires. A wallet that refuses the whole batch
  is asked one by one: declining the backup leaves only the backup out; declining the bind sends
  nothing. So the worst a wallet does to the backup is remove the second net, never the first.

### 10.5 What a kept, never-expiring rotation can and cannot do

- It can do one thing: set THIS agent's signing key to THIS reserved runtime key, and only if its
  signer is the record's owner at that time. That is the choice the launcher made by launching hosted.
- It cannot be used for another agent (the rotation names the record, and the co-signer and firewall
  check the record against the reservation's agent id), with another key (it names the key, and only
  that key's own nonce account is accepted), or twice (landing advances the nonce; shown on devnet).
- The owner voids it at any time: by any transaction that advances that nonce, or simply by the agent
  being bound, after which the nonce account is closed. An owner who later rotates the key away (to run
  the agent themselves) is not pulled back: by then the agent was bound, the kept backup was deleted,
  and its nonce account is gone.
- It is deleted from the service once the agent is bound, and at the limits of 10.2 item 6. It is kept
  in `<state_dir>/bind-service/pending.json`, mode 600, in the runtime user's state directory, beside
  the keys. It holds no key: a transaction with two public signatures.
- Stolen from the server it is still only that one rotation to that one key, which is what would be
  sent anyway.
- This is not off-chain delegation. Nothing acts for the agent until the owner-signed rotation has
  landed on chain, and the registry then shows exactly what the owner signed.

## 11. Proof of sections 9 and 10

Unit tests (all stand-ins named in the files):

- `packages/runtime/test/bind-service.test.ts` (19), `bind-pool.test.ts` (19), with `bind.test.ts` and
  `bind-reserve.test.ts`: the service with no runtime process, the shared key store under a 6-process
  race, the kept rotations in every outcome, health, the pool's bounds, one key one agent, closing,
  the backup's every outcome and refusal.
- `packages/chain/test/nonce-bind.test.ts` (11): the co-signer and the firewall, each refusal twice.
- `apps/web/test/bind-required.test.ts` (21) with `bind-plan.test.ts` and `bind-bundle.test.ts`: every
  refusal of the launch form sends nothing; full bundle; one-by-one signing; the backup in the approval;
  the mainnet bundle holding one fewer than the approval.
- `scripts/deploy/bind-service.test.ts` (16): the unit, the deploy order, the gate, the monitor.

Headless, mock wallet (`UI_PORT=9663 bunx playwright test tests/ui/launch-bind.spec.ts`, 1280 and 390
px, the wizard walked against the live site's reads, every send answered by the spec and none reaching a
node): normal (one wallet request; the bind and the backup co-signed before the first send; the review's
`bind backup` row "no fee unless used"; the Runtime row ends bound); reservation slow then answering
(the line "Getting the agent's runtime key…"), then unavailable (the refusal sentence, Try again, the
wallet never asked); the runtime gone at signing (nothing signed); tab closed after the launch was sent
(both rotations were with the runtime before the first send); delayed (the launch lands without its
bind, the runtime away: "Your agent will start as soon as the runtime is back. Nothing more to sign.",
no button, no second wallet request, then bound by itself).

Devnet, real transactions (`bun scripts/launch-e2e/bind-service-devnet.ts --required --backup`, record
`scripts/launch-e2e/BIND-SERVICE-DEVNET-LAST.json`; the bind service as its own process, the page's own
signer, the agent loop a stand-in that holds the runtime's lock, the real `Runtime` class adopting each
agent afterwards from the same directory):

Last run 2026-10-13, 24 of 24 checks, 0.0478 devnet SOL in all:

- **A1, the agent loop restarts while the wallet approves.** SIGTERM as the wallet was asked, a 3 s
  drain, a new process; the bind service stayed up. One wallet request, launch and bind landed, the
  registry shows the reserved key after one rotation; 3589 ms from asking the wallet to bound. The
  service sent nothing itself. The real `Runtime` adopted agent `9bTmCC26kZaaCMrQD1VfJZkuyGEgHd1qfdJq2oMQtxdR`
  with the key the service had reserved. (The same case and A2 also ran 9 of 9 on the code that was on
  origin/main at 6f16612, before the pool existed.)
- **A2, the co-signature never reaches the page and the tab is closed.** The service co-signed and
  kept the rotation; its answer was dropped; the page sent the launch alone and did nothing more. The
  service sent the kept rotation: bound 11295 ms after the wallet was asked, one wallet request in all
  (agent `6NygzZRBgmkVEisruaRPah7pDAZrSBjEDvbgeRdmBFpc`).
- **C, no reservation to be had.** Refused after the time it was given with the sentence of 9.2, the
  waiting line said once, the wallet never asked, nothing on chain for that agent; a reservation that
  answered after 3 s was waited for.
- **B, the backup across a long stop.** A pool of 2 keys made by a throwaway payer standing in for the
  runtime authority (rent 1056640 lamports each). The reservation handed out pool key
  `8sSXjRokT9mjvr9Z4TTH6a4k86gLsavSZz2XsCRS6th6` with nonce account
  `AFNvx5LCqLKWkpMBhoQkDo3qPE8ZSyxNPY5NwKL45vSE`. The live service refused, with HTTP 400 each, a backup
  with a transfer beside it, over another key's nonce account, for another agent, with the advance not
  first, and a withdrawal dressed as a bind. One approval carried the launch, the bind and the backup
  (3 transactions); the bind's co-signature was dropped on the way back, and the bind service and the
  agent loop were killed as the launch was being sent. The launch landed without its bind. Everything
  stayed down 300 s; the launch's own blockhash was gone by then. The service was started again and
  bound the agent from the kept backup with no further wallet request: about 10 s after it started,
  323 s after the wallet had signed (transaction
  `27X7z9w6Jy7kXBf33EoxKvGyxMZe3CVU6TCnHctjYZsEyUV7pcPd1Ap35rqahaSATx45jt2vKwpbBWPe7byi6MFo`).
  The nonce advanced; the same signed bytes sent again were refused ("Blockhash not found"). Then the
  real `Runtime` adopted the agent with the pool key and one pool pass closed its nonce account, the
  1056640 lamports back with the payer, and refilled the pool.
- The record was written from the working tree before these commits were made; the code is the same.

Restarts, measured locally: section 9.1.

Not proven: a real wallet extension (section 10.4 is documentation only); the Jito bundle on mainnet
with the bind in it and the backup beside it (the bundle path ran against a stand-in block engine in
the unit and headless tests); the full hosted runtime loop and the `units-bind` unit on a server; the
pool's refill and close on mainnet.
