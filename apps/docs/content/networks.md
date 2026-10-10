# Networks and program ids

> **In short.** One switch decides devnet or mainnet for every service and page: `config/profile.json` `network`, overridden per process by `LINEAGE_NETWORK`. The public site runs on devnet. Mainnet program ids exist and every mainnet step was rehearsed on a local fork of mainnet, but nothing is deployed there.

## Program ids and profile fields

Generated at build time from [config/profile.json](repo:config/profile.json); the program parser refuses any id other than these for a network.

{{gen:program-ids}}

The devnet programs above are the second devnet deployment (2026-10-10), initialized with a pump.fun tLINE. The earlier devnet programs stay as read-only history; Core retired them at a recorded epoch (`GET /v1/chain/deployments`).

## Devnet

- tLINE from the deployed state file and a faucet on your profile; TEST labels everywhere.
- A fixed compute unit price of 1 micro-lamport.
- SOL and USDC payment is unavailable: Jupiter does not run on devnet.
- devnet's pump.fun build seeds a quoted coin at tLINE's spot price.

## Mainnet

- No faucet and no TEST labels; the profile parser refuses a mainnet block that turns either on.
- The quote token comes from config. Until $LINE exists the mint is a stand-in (PYUSD) and `line_mint` is null (TBA).
- No USD price feed: amounts are shown in the quote token only.
- A keyed RPC from the environment, never sent to a browser; browsers reach the chain only through the site's `/chain/rpc` proxy.
- Pay in SOL or USDC through Jupiter for the launch deposit and buys.
- Priority fees from recent prioritization fees, capped; sends are rebroadcast until confirmed or expired.

## Program ids by build

The programs select their ids at build time: the default build declares the devnet ids, the cargo feature `mainnet` declares the mainnet ids, and the three programs always agree. The mainnet id keypairs live outside the repository and must be backed up offline by the owner.

## Mainnet readiness

The go/no-go list is in [docs/MAINNET-RUNBOOK.md](repo:docs/MAINNET-RUNBOOK.md). Open owner items include the external audit, the multisig signers, every token parameter, $LINE itself (a pump.fun coin paired with SOL or USDC, never mayhem), legal review, budgets, the domain and recruiting verifiers. Costs measured on the fork: [docs/MAINNET-COSTS.md](repo:docs/MAINNET-COSTS.md).
