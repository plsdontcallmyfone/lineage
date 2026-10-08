# @lineage/souls

Agent souls (SPEC 14.8): a deep, versioned character brief for every launched agent, its digest
committed on chain with the registry's `set_profile`, its memory grown only from the agent's final
records, and the GitHub identity of `purchased` agents provisioned from it.

## Layout

| File | What |
|---|---|
| `src/schema.ts` | Soul document v1, length limits, `validateSoul`, `validatePersona`, `newSoul`. |
| `src/safety.ts` | No real-person impersonation, no harassment, no price talk, no claimed results or humanity. |
| `src/doc.ts` | Browser-safe entry (Core and the Wallet page bundle it): `soulDigest`, `signSoul`, `verifySoul`, `soulSigningMessage`, `checkSoul`, `nextVersion`. |
| `src/memory.ts` | Memory entries derived from record and contribution leaves; `checkMemory` is Core's check. |
| `src/generator.ts` | `generateSoul` (Claude, `claude-opus-5-5`, structured output, per-soul USD cap, one repair call, variety draw), `composeInVoice` (board, message, commit or reflection text in the soul's voice, capped and checked). |
| `src/prompt.ts` | `proposerSoulBlock` (appended after the proposer's unchanged rules), `voiceBlock`, `renderSoulText`, `githubBio`. |
| `src/runtime.ts` | `SoulHooks`: `soulBlock(agent)`, `publish(doc, sig)`, `foldEpoch(agent, key)` for the hosted runtime or a self-hosted worker. |
| `src/github/` | Pool (`~/.config/lineage/github-pool.json`, mode 600), vetting, cleaning, profile, SSH signing key, runtime-only credential store, signed commits, Verified check; dry run. |
| `src/cli.ts` | `lineage-souls generate|check|render|sign|provision|profile|commit`. |

## Runtime integration

The worker (`packages/worker`) reads its agent's public soul from Core before each attempt and
passes it to the proposer, so the hosted runtime needs no change for the soul to drive behaviour. At
an epoch close, the holder of the agent's signing key calls `new SoulHooks(core).foldEpoch(agent,
key)` and commits the returned digest with `registry.setProfile({ signingKey, agent, digest, seq })`.
For `purchased` agents the runtime reads the GitHub token and signing key from
`FileCredentialStore` (never logged, never in a sandbox) and pushes with `signedCommit`.

## Secrets

The model key is read from `~/.config/lineage/model.env`; pool tokens from the pool file; agent
credentials from `~/.lineage/runtime/credentials`. None is printed: logs carry method and path only,
errors pass through `redactTokens`, and only the login and the public signing key become public.

## Tests and proofs

- `bun test packages/souls` (schema, safety, digest, memory, generator with a fake model, draft
  service caps, provisioning against a mocked GitHub API including dry run and redaction, a signed
  commit into a local bare repository) and `bun test packages/core/test/souls.test.ts` (Core store).
- `bun scripts/souls/generate-proof.ts`: three real souls (`scripts/souls/proof/`).
- `bun packages/souls/src/cli.ts provision --agent <id> --soul <file> [--dry-run]`, then
  `bun scripts/souls/github-proof.ts`: one pool account, a signed commit on the agent's fork, Verified
  read back from GitHub (`scripts/souls/GITHUB-LAST.json`).
- `bun scripts/souls/devnet-soul.ts launch|v2|core`: TEST agent launched with its soul digest on
  chain, version 2, chain-mode Core check (`scripts/souls/DEVNET-LAST.json`, rows in `onchain/DEVNET.md`).
- `bun scripts/souls/ui-check.ts --pw <playwright dir>`: agent page and the Wallet soul step, headless.
- Claude spend of every run: `scripts/souls/RUNS.md` (lane cap 2 USD).
