# Mainnet preparation (nothing is deployed to mainnet)

Written 2026-10-10. Owner: start mainnet prep now and prepare an external audit package. No mainnet
transaction is sent, no real key signs anything, and no SOL is spent. Every figure is measured, never
estimated without saying so.

## M1. Deploy rehearsal on a mainnet fork, with exact costs

- Run a local validator that clones mainnet state: the real Meteora DBC and DAMM v2 programs and
  their configs, the Token-2022 program, and a stand-in quote mint until $LINE exists. Use
  `solana-test-validator --clone-upgradeable-program` and `--url mainnet-beta`, or surfpool.
- Deploy all three programs exactly as the mainnet runbook will. Then initialize every config with
  mainnet-shaped values, marked TBA where the owner decides.
- Measure every cost and write it to `docs/MAINNET-COSTS.md` with the method used:
  - program account and buffer rent per program at its real size, including headroom for upgrades;
  - every config and PDA initialization;
  - the cost of one launch on the real Meteora programs;
  - the cost of one epoch post, one claim and one challenge.
- Run the launch, trade, graduation and claim flows against the fork end to end.
- Repeat the graduation flow against mainnet DBC behaviour, since Meteora redeployed DBC on devnet.

## M2. Key safety: Squads multisig plumbing

- Code and docs to move the upgrade authority and every admin or authority role to a Squads v4
  multisig vault with a timelock. Read Squads' current official docs and program ids; do not guess.
- Every admin action the app or scripts perform (config edits, hidden_mints, trading config, fee and
  limit edits) needs a proposal path: build the instruction, wrap it in a multisig transaction, then
  approve and execute.
- Prove it on the fork with a 2-of-3 test multisig and a timelock.
- The Core authority (which posts epochs) stays a hot key with tightly scoped powers. Document exactly
  what it can do, using the A1 powers table.

## M3. Mainnet mode in the app and services

- A network profile switch: `devnet` or `mainnet`. On mainnet:
  - no faucet, no TEST labels;
  - quote mint and decimals from config;
  - real price feeds only where a figure needs USD, otherwise quote-token amounts;
  - the RPC is a keyed mainnet endpoint, never printed.
- Wire the Jupiter SOL and USDC to $LINE swap send path (packages/chain/src/swap.ts) into the launch
  deposit, the trading allocation and trade-box buys behind the mainnet profile. Prove it by
  simulation only.
- Use priority fees and confirmation strategies suited to mainnet congestion.

## M4. Server hardening for mainnet

- Separate service users per unit, completing audit finding OFF-D10. The internet-facing gate, web and
  indexer must not be in the docker group. Only the sandbox and verifier user runs containers.
- Protect the Caddy admin socket.
- Off-machine backups of Core's database, with a tested restore.
- Monitoring and alerting: Core health, epoch posts, verifier liveness, spend caps, disk.
- A recommended multi-server layout for mainnet: Core and gate apart from the verifiers and runtime,
  plus the minimum independent-verifier count.
- Test everything on the devnet site first, drain-safe.

## M5. Runbook and go/no-go

`docs/MAINNET-RUNBOOK.md`: every step in order, with exact commands, and a go/no-go checklist. Owner
items stay unchecked until the owner checks them:
- audit done;
- multisig signers set;
- token parameters set;
- legal review done;
- budgets set;
- domain set;
- verifiers recruited.

## M6. External audit package

`docs/audit/`:
- scope, with the exact program commit hashes and lines of code;
- the architecture and trust model;
- the threat model (SPEC 15) and docs/AUDIT.md findings with their fixes;
- how to build and run the LiteSVM suites and devnet e2e;
- the admin powers table;
- the areas we most want reviewed, from A1 and A2;
- a shortlist of established Solana audit firms. For each, record what it typically asks for and
  publicly known lead times. Read their own sites and note the date read. No prices unless published.
