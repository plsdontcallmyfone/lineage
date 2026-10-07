// Generates canary patches (known-bad, SPEC 10.5) and hand-written candidate patches for the
// real recipes, by editing a real checkout of the recipe snapshot and diffing it (same method as
// fixtures/make-patches.ts). Output: recipes/<name>/{canaries,candidates}/<patch>.diff + index.json.
// Usage: bun scripts/make-canaries.ts [recipe names...]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeDiff, guard } from "@lineage/protocol";
import { diffWorkingTree, loadRecipe, materialize, newWorkDir, removeTree } from "@lineage/sandbox";

const ROOT = join(import.meta.dir, "..");

type Edit = [file: string, from: string, to: string];

export interface PatchDef {
  name: string;
  kind: "perf" | "fix" | "slim";
  target: string | string[];
  /** the verdict reason a single honest replay must produce (or "accepted") */
  expect: string;
  /** what the patch pretends to be and what it really does */
  note: string;
  edits: Edit[];
}

const SETS: Record<string, { canaries: PatchDef[]; candidates: PatchDef[] }> = {
  "base58-py": {
    canaries: [
      {
        name: "zero_shortcut",
        kind: "perf",
        target: "encode_ir",
        expect: "tests_fail",
        note: "Looks like a branch simplification in b58encode_int; drops the default_one guard, so b58encode(b'') returns b'1' and leading-zero inputs gain a digit.",
        edits: [["base58/__init__.py", "    if not i and default_one:\n        return alphabet[0:1]", "    if not i:\n        return alphabet[0:1]"]],
      },
      {
        name: "latin1_scrub",
        kind: "perf",
        target: "decode_ir",
        expect: "equivalence_changed",
        note: "Claims latin-1 is a cheaper codec than ascii for str input; non-ASCII str input is now silently accepted instead of raising UnicodeEncodeError. Upstream tests only pass ASCII strings.",
        edits: [["base58/__init__.py", "        v = v.encode('ascii')", "        v = v.encode('latin-1')"]],
      },
      {
        name: "no_map_cache",
        kind: "perf",
        target: "decode_ir",
        expect: "no_improvement",
        note: "Presented as removing lru_cache hashing overhead; actually rebuilds the decode map on every call, so decode does more work.",
        edits: [["base58/__init__.py", "@lru_cache()\ndef _get_base58_decode_map(", "def _get_base58_decode_map("]],
      },
    ],
    candidates: [
      {
        name: "encode_chunked",
        kind: "perf",
        target: "encode_ir",
        expect: "accepted",
        note: "b58encode_int peels five digits per big-integer divmod (base**5 fits one internal int digit, so each division costs the same as a division by base) and builds the output in a bytearray instead of prepending to bytes.",
        edits: [
          [
            "base58/__init__.py",
            '    if not i and default_one:\n        return alphabet[0:1]\n    string = b""\n    base = len(alphabet)\n    while i:\n        i, idx = divmod(i, base)\n        string = alphabet[idx:idx+1] + string\n    return string',
            '    if not i and default_one:\n        return alphabet[0:1]\n    base = len(alphabet)\n    # Peel off five digits per big-integer division: base**5 still fits in\n    # one internal int digit, so each divmod costs the same as one by base.\n    big = base ** 5\n    out = bytearray()\n    while i >= big:\n        i, rem = divmod(i, big)\n        for _ in range(5):\n            rem, idx = divmod(rem, base)\n            out.append(alphabet[idx])\n    while i:\n        i, idx = divmod(i, base)\n        out.append(alphabet[idx])\n    out.reverse()\n    return bytes(out)',
          ],
        ],
      },
      {
        name: "decode_chunked",
        kind: "perf",
        target: "decode_ir",
        expect: "accepted",
        note: "b58decode_int accumulates five digits in a small int and folds them into the big integer with one multiply-add, so the number of big-integer operations drops five-fold.",
        edits: [
          [
            "base58/__init__.py",
            "    try:\n        for char in v:\n            decimal = decimal * base + map[char]\n    except KeyError as e:",
            "    try:\n        # Accumulate five digits in a small int, then fold them into the\n        # big integer with a single multiply-add.\n        n = len(v)\n        head = n % 5\n        for char in v[:head]:\n            decimal = decimal * base + map[char]\n        big = base ** 5\n        for j in range(head, n, 5):\n            a, b, c, d, e = v[j:j + 5]\n            decimal = decimal * big + (\n                (((map[a] * base + map[b]) * base + map[c]) * base + map[d])\n                * base + map[e])\n    except KeyError as e:",
          ],
        ],
      },
    ],
  },
  minbpe: {
    canaries: [
      {
        name: "ascii_fast_path",
        kind: "perf",
        target: "encode_ir",
        expect: "tests_fail",
        note: "Adds an 'ASCII fast path' that skips GPT4Tokenizer's byte permutation for ASCII chunks, as if the shuffle were the identity there. It is not, so GPT-4 encodings stop matching tiktoken. (An earlier draft that tightened merge()'s loop bound made encode loop forever; canaries must fail fast, so it was replaced.)",
        edits: [["minbpe/gpt4.py", "        text_bytes = bytes(self.byte_shuffle[b] for b in text_bytes)\n        ids = super()._encode_chunk(text_bytes)", "        if not text_bytes.isascii():\n            text_bytes = bytes(self.byte_shuffle[b] for b in text_bytes)\n        ids = super()._encode_chunk(text_bytes)"]],
      },
      {
        name: "sorted_chunks",
        kind: "perf",
        target: "train_ir",
        expect: "equivalence_changed",
        note: "Sorts regex chunks to 'group identical chunks'; changes the first-seen order of pairs, so max() breaks count ties differently and some merges change. Upstream tests never train on tie-heavy text with the RegexTokenizer.",
        edits: [["minbpe/regex.py", '        ids = [list(ch.encode("utf-8")) for ch in text_chunks]', '        ids = sorted(list(ch.encode("utf-8")) for ch in text_chunks)']],
      },
      {
        name: "rank_table",
        kind: "perf",
        target: "encode_ir",
        expect: "no_improvement",
        note: "Presented as precomputing a rank table to avoid the lambda; builds an extra dict per merge step, which costs more than it saves.",
        edits: [
          [
            "minbpe/regex.py",
            '            stats = get_stats(ids)\n            pair = min(stats, key=lambda p: self.merges.get(p, float("inf")))\n            # subtle: if there are no more merges available, the key will\n            # result in an inf for every single pair, and the min will be\n            # just the first pair in the list, arbitrarily\n            # we can detect this terminating case by a membership check\n            if pair not in self.merges:\n                break # nothing else can be merged anymore\n            # otherwise let\'s merge the best pair (lowest merge index)\n            idx = self.merges[pair]\n            ids = merge(ids, pair, idx)\n        return ids\n\n    def encode_ordinary',
            '            stats = get_stats(ids)\n            ranks = {p: self.merges.get(p, float("inf")) for p in stats}\n            pair = min(ranks, key=ranks.get)\n            # subtle: if there are no more merges available, the key will\n            # result in an inf for every single pair, and the min will be\n            # just the first pair in the list, arbitrarily\n            # we can detect this terminating case by a membership check\n            if pair not in self.merges:\n                break # nothing else can be merged anymore\n            # otherwise let\'s merge the best pair (lowest merge index)\n            idx = self.merges[pair]\n            ids = merge(ids, pair, idx)\n        return ids\n\n    def encode_ordinary',
          ],
        ],
      },
    ],
    candidates: [
      {
        name: "train_dedupe_chunks",
        kind: "perf",
        target: "train_ir",
        expect: "accepted",
        note: "RegexTokenizer.train keeps each distinct regex chunk once (first-seen order) with its multiplicity and counts pairs weighted. Pair counts and their first-seen order are unchanged, so max() picks the same merges, ties included.",
        edits: [
          [
            "minbpe/regex.py",
            '        # input text preprocessing\n        ids = [list(ch.encode("utf-8")) for ch in text_chunks]\n',
            '        # input text preprocessing: identical chunks always merge identically, so\n        # keep each distinct chunk once (in first-seen order) with its multiplicity.\n        # Pair counts and their first-seen order are the same as over all chunks,\n        # so max() picks the same pair, ties included.\n        chunk_counts = {}\n        for ch in text_chunks:\n            chunk_counts[ch] = chunk_counts.get(ch, 0) + 1\n        ids = [list(ch.encode("utf-8")) for ch in chunk_counts]\n        weights = list(chunk_counts.values())\n',
          ],
          [
            "minbpe/regex.py",
            "            stats = {}\n            for chunk_ids in ids:\n                # passing in stats will update it in place, adding up counts\n                get_stats(chunk_ids, stats)\n",
            "            stats = {}\n            for chunk_ids, w in zip(ids, weights):\n                for p in zip(chunk_ids, chunk_ids[1:]):\n                    stats[p] = stats.get(p, 0) + w\n",
          ],
        ],
      },
      {
        name: "encode_chunk_cache",
        kind: "perf",
        target: "encode_ir",
        expect: "accepted",
        note: "encode_ordinary encodes each distinct regex chunk once per call (a call-local dict), since chunks such as ' the' or ',' repeat; the cache never outlives the call, so later changes to merges cannot make it stale.",
        edits: [
          [
            "minbpe/regex.py",
            '        ids = []\n        for chunk in text_chunks:\n            chunk_bytes = chunk.encode("utf-8") # raw bytes\n            chunk_ids = self._encode_chunk(chunk_bytes)\n            ids.extend(chunk_ids)\n        return ids',
            '        ids = []\n        # chunks repeat a lot in natural text (" the", ","): encode each distinct\n        # chunk once per call\n        cache = {}\n        for chunk in text_chunks:\n            chunk_ids = cache.get(chunk)\n            if chunk_ids is None:\n                chunk_bytes = chunk.encode("utf-8") # raw bytes\n                chunk_ids = cache[chunk] = self._encode_chunk(chunk_bytes)\n            ids.extend(chunk_ids)\n        return ids',
          ],
        ],
      },
    ],
  },
};

function build(recipeName: string, defs: PatchDef[], sub: "canaries" | "candidates"): void {
  if (!defs.length) return;
  const loaded = loadRecipe(join(ROOT, "recipes", recipeName));
  const out = join(ROOT, "recipes", recipeName, sub);
  mkdirSync(out, { recursive: true });
  const index: Record<string, Omit<PatchDef, "edits" | "name"> & { lines: number; guard: string }> = {};
  for (const def of defs) {
    const work = newWorkDir("mkcanary");
    try {
      const tree = join(work, "src");
      materialize(loaded.recipe.repo, loaded.recipe.commit, loaded.overlayDir, tree);
      for (const [file, from, to] of def.edits) {
        const path = join(tree, file);
        const src = readFileSync(path, "utf8");
        if (!src.includes(from)) throw new Error(`${recipeName}/${def.name}: anchor not found in ${file}`);
        if (src.indexOf(from) !== src.lastIndexOf(from)) throw new Error(`${recipeName}/${def.name}: anchor not unique in ${file}`);
        writeFileSync(path, src.replace(from, to));
      }
      const diff = canonicalizeDiff(diffWorkingTree(tree));
      writeFileSync(join(out, `${def.name}.diff`), diff);
      const g = guard(diff, loaded.recipe.patch);
      const { edits: _e, name: _n, ...meta } = def;
      index[def.name] = { ...meta, lines: g.lines, guard: g.ok ? "ok" : g.violation! };
      console.log(`${recipeName}/${sub}/${def.name.padEnd(18)} guard=${g.ok ? "ok" : g.violation} lines=${g.lines}`);
    } finally {
      removeTree(work);
    }
  }
  writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
}

// Recipes whose definitions are long (whole replaced functions) keep them as data next to the
// recipe: recipes/<name>/patch-defs.json with the same { canaries, candidates } shape.
for (const name of readdirSync(join(ROOT, "recipes"))) {
  const file = join(ROOT, "recipes", name, "patch-defs.json");
  if (existsSync(file)) SETS[name] = JSON.parse(readFileSync(file, "utf8"));
}

const only = process.argv.slice(2);
for (const [name, set] of Object.entries(SETS)) {
  if (only.length && !only.includes(name)) continue;
  build(name, set.canaries, "canaries");
  build(name, set.candidates, "candidates");
}
