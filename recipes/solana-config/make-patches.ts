// Generates the solana-config canaries (known-bad, SPEC 10.5) and candidate patches by editing a
// real checkout of the recipe snapshot and diffing it (same method as scripts/make-canaries.ts).
// Output: recipes/solana-config/{canaries,candidates}/<patch>.diff + index.json.
// Verify with: bun scripts/check-canaries.ts recipes/solana-config [canaries|candidates]
// Usage: bun recipes/solana-config/make-patches.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeDiff, guard } from "@lineage/protocol";
import { diffWorkingTree, loadRecipe, materialize, newWorkDir, removeTree } from "@lineage/sandbox";

type Edit = [file: string, from: string, to: string];
interface PatchDef {
  name: string;
  kind: "perf" | "fix" | "slim";
  target: string | string[];
  expect: string;
  note: string;
  edits: Edit[];
}

const P = "program/src/processor.rs";
const SETS: Record<"canaries" | "candidates", PatchDef[]> = {
  canaries: [
    {
      name: "trust_loader_signers",
      kind: "perf",
      target: "store_cu",
      expect: "tests_fail",
      note: "Presented as dropping a check the runtime already enforces; it is not enforced for accounts merely listed in the instruction, so an unsigned additional signer is accepted.",
      edits: [[P, `            if !signer_account.is_signer {
                msg!("account {:?} signer_key().is_none()", signer);
                return Err(ProgramError::MissingRequiredSignature);
            }
`, ``]],
    },
    {
      name: "cap_copy",
      kind: "perf",
      target: "init_cu",
      expect: "equivalence_changed",
      note: "Caps the final account write at 1024 bytes as if nothing useful lived past the key region; large key lists lose their tail. Upstream tests never read back the data of a store that large.",
      edits: [[P, `    config_account.try_borrow_mut_data()?[..input.len()].copy_from_slice(input);`, `    let n = input.len().min(1024);
    config_account.try_borrow_mut_data()?[..n].copy_from_slice(&input[..n]);`]],
    },
    {
      name: "owned_signers",
      kind: "perf",
      target: "store_cu",
      expect: "no_improvement",
      note: "Dressed up as avoiding borrows of the stored key list; it clones the whole list before filtering, so every instruction does more work.",
      edits: [[P, `    let current_signer_keys: Vec<Pubkey> = current_data
        .keys
        .iter()
        .filter(|(_, is_signer)| *is_signer)
        .map(|(pubkey, _)| *pubkey)
        .collect();`, `    let current_signer_keys: Vec<Pubkey> = current_data
        .keys
        .clone()
        .into_iter()
        .filter(|(_, is_signer)| *is_signer)
        .map(|(pubkey, _)| pubkey)
        .collect();`]],
    },
  ],
  candidates: [
    {
      name: "dedupe_sort",
      kind: "perf",
      target: "init_cu",
      expect: "accepted",
      note: "Duplicate (pubkey, is_signer) entries are found by sorting references to the new key list and comparing neighbours, instead of moving every entry into a BTreeSet (an allocation and a tree insert per key on SBF). Same set semantics: entries are compared as whole tuples.",
      edits: [
        [P, `    let total_new_keys = key_list.keys.len();
    let unique_new_keys = key_list.keys.into_iter().collect::<BTreeSet<_>>();
    if unique_new_keys.len() != total_new_keys {`, `    let mut sorted_new_keys: Vec<&(Pubkey, bool)> = key_list.keys.iter().collect();
    sorted_new_keys.sort_unstable();
    if sorted_new_keys.windows(2).any(|w| w[0] == w[1]) {`],
        [P, `    std::collections::BTreeSet,\n`, ``],
      ],
    },
  ],
};

const dir = import.meta.dir;
const loaded = loadRecipe(dir);
for (const [set, defs] of Object.entries(SETS)) {
  const out = join(dir, set);
  mkdirSync(out, { recursive: true });
  const index: Record<string, unknown> = {};
  for (const def of defs) {
    const work = newWorkDir("mkpatch");
    try {
      const tree = join(work, "src");
      materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, tree);
      for (const [file, from, to] of def.edits) {
        const path = join(tree, file);
        const src = readFileSync(path, "utf8");
        if (!src.includes(from)) throw new Error(`${def.name}: anchor not found in ${file}`);
        writeFileSync(path, src.replace(from, to));
      }
      const diff = canonicalizeDiff(diffWorkingTree(tree));
      writeFileSync(join(out, `${def.name}.diff`), diff);
      const g = guard(diff, loaded.recipe.patch);
      const { edits: _e, name: _n, ...meta } = def;
      index[def.name] = { ...meta, lines: g.lines, guard: g.ok ? "ok" : g.violation };
      console.log(`${set}/${def.name.padEnd(22)} guard=${g.ok ? "ok" : g.violation} lines=${g.lines}`);
    } finally {
      removeTree(work);
    }
  }
  writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
}
