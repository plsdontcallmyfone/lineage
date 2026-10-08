#!/usr/bin/env bun
// lineage-souls: generate, check, sign and provision agent souls (SPEC 14.8).
//   generate  --seed <seed.json> --agent <id> [--repo <url>] [--max-usd 0.40] [--effort high] [--avoid "A,B"] [--out <soul.json>] [--spend-log <file>]
//   check     --file <soul.json>
//   render    --file <soul.json>
//   sign      --file <soul.json> --key <keypair.json>          prints { digest, sig, seq }
//   provision --agent <id> --soul <soul.json> [--profile-url <url>] [--dry-run] [--pool <file>] [--store <dir>]
//   commit    --agent <id> --upstream <owner/repo> --branch <name> [--base <sha>] [--soul <soul.json>] [--lineage <id>] [--store <dir>]
// Secrets: the model key comes from ~/.config/lineage/model.env, GitHub tokens from the pool and the
// credential store; none is ever printed.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { keyFromSolanaJson } from "@lineage/protocol";
import { checkSoul, signSoul, soulDigest } from "./doc.ts";
import { anthropicClient, generateSoul, loadModelKey } from "./generator.ts";
import { FileCredentialStore, lineageTrailers, Pool, provisionAccount, signedCommit, DEFAULT_POOL, DEFAULT_STORE } from "./github/index.ts";
import { renderSoulText } from "./prompt.ts";
import type { SoulDoc, SoulSeed } from "./schema.ts";

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (n: string) => argv.includes(`--${n}`);
const need = (n: string) => {
  const v = arg(n);
  if (!v) throw new Error(`--${n} is required`);
  return v;
};
const readJson = <T,>(p: string) => JSON.parse(readFileSync(p, "utf8")) as T;
const log = (m: string) => console.error(m);

async function main() {
  switch (cmd) {
    case "generate": {
      const seed = readJson<SoulSeed>(need("seed"));
      const r = await generateSoul({
        seed, agent: need("agent"), repo: arg("repo") ?? null, client: anthropicClient(await loadModelKey()),
        maxUsd: Number(arg("max-usd", "0.40")), effort: (arg("effort", "high") as any), avoidNames: (arg("avoid") ?? "").split(",").map((s) => s.trim()).filter(Boolean), log,
      });
      const spendLog = arg("spend-log");
      if (spendLog) appendFileSync(spendLog, JSON.stringify({ at: new Date().toISOString(), agent: arg("agent"), usd: r.usage.usd, calls: r.usage.calls, models: r.usage.models, input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens, ok: !!r.doc }) + "\n");
      log(`souls: ${r.usage.calls} calls, ${r.usage.input_tokens} input and ${r.usage.output_tokens} output tokens, ${r.usage.usd.toFixed(4)} USD`);
      if (!r.doc) throw new Error(`no soul: ${r.problems.join("; ")}`);
      const out = arg("out");
      if (out) writeFileSync(out, JSON.stringify(r.doc, null, 2) + "\n");
      else console.log(JSON.stringify(r.doc, null, 2));
      return;
    }
    case "check": {
      const errs = checkSoul(readJson(need("file")));
      if (errs.length) {
        console.log(errs.join("\n"));
        process.exit(1);
      }
      console.log(`ok ${soulDigest(readJson(need("file")))}`);
      return;
    }
    case "render":
      console.log(renderSoulText(readJson<SoulDoc>(need("file"))));
      return;
    case "sign": {
      const doc = readJson<SoulDoc>(need("file"));
      const errs = checkSoul(doc);
      if (errs.length) throw new Error(errs.join("; "));
      const key = keyFromSolanaJson(readJson<number[]>(need("key")));
      console.log(JSON.stringify({ digest: soulDigest(doc), sig: signSoul(key, doc), seq: doc.seq }));
      return;
    }
    case "provision": {
      const r = await provisionAccount({
        agent: need("agent"), soul: readJson<SoulDoc>(need("soul")), pool: new Pool(arg("pool", DEFAULT_POOL)), store: new FileCredentialStore(arg("store", DEFAULT_STORE)),
        profileUrl: arg("profile-url") ?? null, dryRun: flag("dry-run"), log,
      });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case "commit": {
      const store = new FileCredentialStore(arg("store", DEFAULT_STORE));
      const agent = need("agent");
      const cred = store.get(agent);
      if (!cred) throw new Error(`no credential for ${agent} in ${store.dir}`);
      const soul = arg("soul") && existsSync(arg("soul")!) ? readJson<SoulDoc>(arg("soul")!) : null;
      const msg = arg("message") ?? `Record ${agent.slice(0, 8)} on its lineage branch`;
      const r = await signedCommit({
        cred, upstream: need("upstream"), branch: need("branch"), baseCommit: arg("base"),
        files: { ".lineage/agent.json": JSON.stringify({ agent, soul: soul ? soulDigest(soul) : null, lineage: arg("lineage") ?? null }, null, 2) + "\n" },
        message: `${msg}\n\n${lineageTrailers({ agent, lineage: arg("lineage") ?? null, soul: soul ? soulDigest(soul) : null })}\n`, log,
      });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    default:
      console.error("usage: lineage-souls generate|check|render|sign|provision|commit (see the header of src/cli.ts)");
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(`lineage-souls: ${(e as Error).message}`);
  process.exit(1);
});
