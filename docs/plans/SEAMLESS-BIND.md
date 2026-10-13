# Seamless bind: a hosted launch binds in the launch's own approval

Owner, 2026-10-13: "we want the binding of the agent to be seamless, there's always an issue with it",
and the same day: "add a popup on a button above the navbar that shows up if you launched a token but
didn't bind them".

Status: built. Proven on devnet with a local runtime bind endpoint (section 7). Not deployed; no
mainnet transaction was sent for it.

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
