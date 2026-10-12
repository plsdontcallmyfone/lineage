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

This deployment is the repository's default: `config/profile.json` says `"network": "mainnet"` and
`"mainnet_deployment": "test"`, which lays `profile.json` of this directory over `profiles.mainnet`.
No environment variable and no untracked file is needed. Nothing here holds a key.

When the official programs are deployed and initialized, the default moves to them with one edit in
`config/profile.json`: `"mainnet_deployment": "official"` (then this overlay is no longer applied, and
`config/sites.json` `mainnet_site_url` names the official backend if it is another host). The official
quote follows the note in that file: `quote.mint` becomes the `$UNITS` mint once it exists.

## Front end

The static build proxies its API paths to the mainnet site by default, and the bundles start on this
deployment's profile before the site answers:

```
bun scripts/deploy/vercel/build.ts
```

On Vercel no variable is needed. `UNITS_SITE=<another backend>` (or `--site`) overrides it, for example
the devnet site `https://157-245-71-188.sslip.io`. Launches on mainnet spend real SOL.

## Local dashboard or scripts

```
bun apps/web/server.ts                                         # no RPC of your own: reads through the mainnet site
UNITS_MAINNET_RPC=<your mainnet RPC URL> <command>              # a service of your own (Core, indexer, runtime, scripts)
UNITS_NETWORK=devnet <command>                                  # devnet instead
```

`UNITS_MAINNET_RPC` may also sit in `~/.config/units/rpc.env`. It is a secret: never commit it.

`state.json` is the deployed chain state (public addresses and the fee split). Operator steps are in
`docs/MAINNET-RUNBOOK.md`, section "Mainnet test".
