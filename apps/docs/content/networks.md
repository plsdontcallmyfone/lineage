# Networks and program ids

> One switch decides devnet or mainnet for every service and page: `config/profile.json` `network`, overridden per process by `UNITS_NETWORK`. The public site runs on devnet, and nothing is deployed on mainnet.

## Program ids and profile fields

Generated at build time from [config/profile.json](repo:config/profile.json); the program parser refuses any id other than these for a network.

{{gen:program-ids}}

The devnet programs above are the second devnet deployment (2026-10-10), initialized with a pump.fun tUNITS. The earlier devnet programs stay as read-only history; Core retired them at a recorded epoch (`GET /v1/chain/deployments`).

## Devnet and mainnet

::::tabs
:::tab Devnet
Live: the public site runs here.

- tUNITS from the deployed state file and a faucet on your profile; TEST labels everywhere. The app shows it as "tUNITS (devnet test)" (`config/profile.json` `quote.display`). It is a pump.fun coin created before the rename, so its on-chain metadata still reads name "Lineage devnet TEST LINE" and symbol tLINE (`quote.onchain_symbol`); pump.fun metadata cannot be changed after creation.
- A fixed compute unit price of 1 micro-lamport.
- SOL and USDC payment is unavailable: Jupiter does not run on devnet.
- devnet's pump.fun build seeds a quoted coin at tUNITS's spot price.
:::
:::tab Mainnet
Not deployed. This is how the mainnet profile is set up.

- No faucet and no TEST labels; the profile parser refuses a mainnet block that turns either on.
- The quote token comes from config. Until $UNITS exists the mint is a stand-in (PYUSD) and `units_mint` is null (TBA); the owner provides the mainnet $UNITS mint later.
- No USD price feed: amounts are shown in the quote token only.
- A keyed RPC from the environment, never sent to a browser; browsers reach the chain only through the site's `/chain/rpc` proxy.
- Pay in SOL or USDC through Jupiter for the launch deposit and buys.
- Priority fees from recent prioritization fees, capped; sends are rebroadcast until confirmed or expired.
:::
::::

## Program ids by build

The programs select their ids at build time: the default build declares the devnet ids, the cargo feature `mainnet` declares the mainnet ids, and the three programs always agree. The mainnet id keypairs live outside the repository and must be backed up offline by the owner.

## The mainnet test

:::warning Not live yet
A single-key test on mainnet, with a throwaway quote coin and a second instance of the site, is in preparation. Nothing has been sent to mainnet; [What is live](doc:status#in-preparation) will say when that changes.
:::

## Mainnet readiness

The go/no-go list is in [docs/MAINNET-RUNBOOK.md](repo:docs/MAINNET-RUNBOOK.md). Open owner items include the external audit, the multisig signers, every token parameter, $UNITS itself (a pump.fun coin paired with SOL or USDC, never mayhem), legal review, budgets, the domain and recruiting verifiers. Costs measured on the fork: [docs/MAINNET-COSTS.md](repo:docs/MAINNET-COSTS.md).
