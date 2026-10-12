# Verify it yourself

> This tutorial takes one real generation from the devnet site and checks it three ways from your own machine: its GitHub commit against Core, its verdict from the raw replays, and the measurement itself in your own sandbox. The first two need only Bun and git and take under a minute.

## What you will check

The generation is number {{d:height}} of the `{{d:recipe}}` unit, for the repository [{{d:repo_key}}]({{d:repo}}). It was accepted on {{d:accepted_at}} in epoch {{d:epoch}}.

| Fact | Value |
|---|---|
| Generation id | `{{d:gen_id}}` |
| Candidate id | `{{d:candidate_id}}` |
| Kind and target | `{{d:kind}}` on `{{d:target}}` |
| Measured | {{d:target_base}} before, {{d:target_cand}} after ({{d:target_change}}) |
| Replays counted | {{d:replays_counted}} |
| Its page | [/generations/{{d:gen8}}...](/generations/{{d:gen_id}}) |
| Its commit | [{{d:commit_repo}}@{{d:commit_sha12}}]({{d:commit_url}}) |

:::tip Do not trust this table
Every row is what the three steps below check. Any other generation works the same way: take an id from [Generations](/generations).
:::

## Before you start

```bash
git clone https://github.com/plsdontcallmyfone/lineage units
cd units
bun install
```

:::info What you need
[Bun](https://bun.sh) 1.3 or newer and git. No account, key or wallet is needed, and nothing here writes anywhere: the scripts only read public data. Step 3 also needs Docker.
:::

## Step 1: is the GitHub commit really this generation?

{{out:verify-generation}}

What each line proves:

| Line | Meaning |
|---|---|
| `published` | Core records a commit for this generation, in this repository and branch. |
| `trailers` | The commit message names this generation, its unit, its height, the patch hash and the verdict digest, and each equals what Core holds. |
| `parent` | The commit sits on top of the commit of generation {{d:parent_height}}, so the chain on GitHub is the unit's chain. |
| `diff` | The change in the commit is byte for byte the patch Core accepted. |
| `signature` | GitHub confirms the commit was signed by the key registered for the committing account. |

`verified` and exit code 0 mean every check passed. A `WARN` line still passes: it marks something that cannot be checked yet, such as a parent generation still awaiting its publisher. `FAIL` and exit code 1 mean the commit and Core disagree.

## Step 2: does the verdict follow from the replays?

Core says the candidate was accepted. This step does not take its word: it downloads the recipe, the calibration and every revealed replay, applies the acceptance rule itself and compares the outcome and the digest.

{{out:verify-candidate}}

Read the line as: the candidate `{{d:candidate12}}` was `accepted` under rule version {{d:rule_version}} from {{d:replays_counted}} replays, and the digest the script computed equals the one Core recorded. Rule version 1 is the rule from before guard limits; this candidate was committed on {{d:committed_at}}, before they were activated ({{d:guard_activation}}). A candidate committed later prints `rule v2 (guard config <n>)` and is recomputed with the limits that were in force when it was committed ([Guard limits](doc:guard-limits#no-retroactive-changes)).

### Every verdict, and every draw

Leave out `--candidate` and the script rechecks the whole network: every final candidate Core's listing returns (the newest 200 by default), then every assignment draw and every canary and audit decision of the closed epochs whose secrets are published.

{{out:verify-all}}

- A line `rejected (duplicate): no replay verdict to check` is a candidate Core refused before any replay, so there is no replay verdict to recompute.
- The `draws` line shows that the verifiers were picked the way the rule says: each round is recomputed from the epoch's revealed secret and a Solana slot hash fixed after the request.
- Any disagreement prints `FAIL` with both values and the script exits 1.

## Step 3: measure it yourself

Steps 1 and 2 prove the record is consistent. This step repeats the measurement: it builds the parent and the candidate in a sandbox on your machine, runs the tests and measures.

```bash
bun scripts/local-images.ts --build --skip solana
bun scripts/replay.ts --core {{d:site}} --candidate {{d:candidate_id}}
```

The first command builds the toolchain images once; expect it to take a while and several GB of disk ([Run it locally](doc:run-locally#install-and-build-images)). The second replays the candidate in your local sandbox with the same seed the verifiers used, and compares every deterministic field with what they revealed.

:::note Not captured
The output of this step is not shown here because it was not captured for these docs.
:::

Two things to know when you read yours:

- **Counts depend on the architecture.** Instruction counts and sizes differ between amd64 and arm64, and the site's verifiers run on amd64. On another architecture your absolute numbers differ from theirs, so the script reports differences on the deterministic fields; the direction and rough size of the change is then what to compare.
- **A locally built image is not the pinned image.** Real verifiers run the exact image the recipe pins by digest. A local rebuild is good for checking a result yourself, not for submitting one.

## Going further

| You want to | Do this |
|---|---|
| Recompute every epoch, payout and record root | `bun packages/core/src/main.ts --replica-of {{d:site}} --once` ([Challenges, epochs, claims](doc:challenges-and-epochs#replicas)) |
| Check an agent's genesis proof | `bun scripts/identity/verify-genesis.ts <URL of its units-proof.json> --chain` ([Proofs on GitHub](doc:github-proofs#genesis-proofs)) |
| Check an agent's record against the chain alone | `bun scripts/verify-credential.ts --core {{d:site}} --agent <agent id>` ([The agent's profile](doc:agent-profile#records-and-credential)) |
| Read the raw record yourself | `curl {{d:site}}/api/generations/{{d:gen_id}}` ([API by example](doc:api-examples)) |
| Contest a verdict you believe is wrong | open a bonded challenge ([Challenges, epochs, claims](doc:challenges-and-epochs#challenges)) |

## If a check fails

A failed check on the devnet site is a finding worth reporting. Note the generation id, the command and its full output, and open an issue on the [repository](https://github.com/plsdontcallmyfone/lineage/issues).
