#!/usr/bin/env bun
// Lineage site keys. Prints public keys only, never a secret.
//
//   bun scripts/deploy/site-keys.ts init [--dir <dir>]    create the site's own keys if missing (mode 600) and print
//                                                         every key's public half as JSON
//   bun scripts/deploy/site-keys.ts pub <file>...         print { file: pubkey } for existing key files
//
// The site's own keys live in ~/.config/lineage/site/ of the user running it (on the server: the
// `lineage` user) and are generated on the server: admin (Core's --admin-key), owner (owns the
// site's onchain verifiers, pays their burn and bond), verifier-ref (reference runner), verifier-v1
// and verifier-v2 (the two honest verifiers). Keys copied from the owner's machine live in
// ~/.config/lineage/devnet/ under their usual names (core-authority, faucet, runtime-authority,
// agent-minbpe).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keyFromSolanaJson } from "@lineage/protocol";
import { loadOrCreateKeypair } from "@lineage/chain";

export const SITE_KEYS = ["admin", "owner", "verifier-ref", "verifier-v1", "verifier-v2"] as const;
const CONFIG = join(homedir(), ".config", "lineage");

export function pubOf(path: string): string {
  const text = readFileSync(path, "utf8").trim();
  if (text.startsWith("[")) return keyFromSolanaJson(JSON.parse(text)).id;
  return text;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "init") {
    const dir = rest.includes("--dir") ? rest[rest.indexOf("--dir") + 1]! : join(CONFIG, "site");
    const out: Record<string, unknown> = { site: {}, devnet: {} };
    for (const n of SITE_KEYS) {
      const { key, created } = loadOrCreateKeypair(join(dir, `${n}.json`));
      (out.site as Record<string, string>)[n] = key.id;
      if (created) console.error(`created ${n}: ${key.id}`);
    }
    const dev = join(CONFIG, "devnet");
    if (existsSync(dev))
      for (const f of readdirSync(dev).filter((f) => f.endsWith(".json")).sort())
        try {
          (out.devnet as Record<string, string>)[f.replace(/\.json$/, "")] = pubOf(join(dev, f));
        } catch {
          /* not a key file */
        }
    console.log(JSON.stringify(out));
  } else if (cmd === "pub") {
    const out: Record<string, string | null> = {};
    for (const f of rest) out[f] = existsSync(f) ? pubOf(f) : null;
    console.log(JSON.stringify(out));
  } else {
    console.error("usage: site-keys.ts init [--dir <dir>] | pub <file>...");
    process.exit(2);
  }
}
