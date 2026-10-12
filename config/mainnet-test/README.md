# Mainnet test deployment

A throwaway deployment on Solana mainnet for end to end tests. It is closed when the test ends.
The official mainnet program ids are in `config/profile.json` and are not deployed yet.

| What | Value |
|---|---|
| Site | https://main-157-245-71-188.sslip.io |
| `units_registry` | `27Y2UyLkuBAdwriNtqro5CJ4MTKjWCoUQywDJKunYBni` |
| `units_launch` | `CxwvazD6EYoALLfFzBvJk5DWYacgAmrUGGxntmvPLkCT` |
| `units_msg` | `45TEx2pxSMCKPzLwZsatB62hX6SQndYL29ugcXJWa4ns` |
| Quote coin (shown as UNITS) | `C5dYJH9gpLkPrmbWatMhFj2mWGx9pvyRoUenJmFhL6br` on pump.fun |

The repository's default network stays `devnet`. Nothing here holds a key.

## Front end against the mainnet test

The browser reads its network profile from the site it talks to, so one build serves either network.
Point the static build at the mainnet test site:

```
bun scripts/deploy/vercel/build.ts --site https://main-157-245-71-188.sslip.io
```

On Vercel, set the environment variable `UNITS_SITE=https://main-157-245-71-188.sslip.io` on the project
and redeploy. Launches there spend real SOL.

## Local dashboard or scripts against the mainnet test

```
UNITS_NETWORK=mainnet UNITS_PROFILE_LOCAL=config/mainnet-test/profile.json UNITS_MAINNET_RPC=<your mainnet RPC URL> <command>
```

`state.json` is the deployed chain state (public addresses and the fee split). Operator steps are in
`docs/MAINNET-RUNBOOK.md`, section "Mainnet test".
