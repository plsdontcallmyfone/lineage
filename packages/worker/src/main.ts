#!/usr/bin/env bun
// lineage-worker CLI.
//   keygen   --out <file>                         write a new agent key (Solana keypair JSON)
//   run      --core <url> --key <file> [options]  replay assignments and author candidates
//   calibrate --core <url> --key <file> --recipe-id <id> --snapshot-id <id> [--runs 5]
// run options:
//   --proposer scripted --script <dir> [--names a,b,c]   submit prepared patches in order
//   --proposer anthropic [--max-usd 2] [--model claude-opus-5-5] [--effort high]
//   --lineage <id>          author only on this lineage (repeatable)
//   --dishonest fabricate   never run replays, claim success (test only)
//   --max-candidates <n>    stop authoring after n submissions
//   --interval <ms>         poll interval (default 2000)
//   --once                  one tick then exit
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateAgentKey, keyFromSolanaJson, type AgentKey } from "@lineage/protocol";
import { AnthropicProposer } from "./proposers/anthropic.ts";
import { loadScript, ScriptedProposer } from "./proposers/scripted.ts";
import type { Proposer } from "./proposers/types.ts";
import { Worker, type Dishonesty } from "./worker.ts";

function args(argv: string[]) {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    const v = next && !next.startsWith("--") ? (i++, next) : "true";
    (out[a.slice(2)] ??= []).push(v);
  }
  return { one: (k: string) => out[k]?.[0], all: (k: string) => out[k] ?? [] };
}

export function loadKey(path: string): AgentKey {
  return keyFromSolanaJson(JSON.parse(readFileSync(path, "utf8")));
}

/** Reads ~/.config/lineage/model.env (KEY=VALUE lines) into the environment if present. */
function loadModelEnv(): void {
  const p = `${process.env.HOME}/.config/lineage/model.env`;
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  switch (cmd) {
    case "keygen": {
      const out = a.one("out");
      if (!out) throw new Error("--out required");
      if (existsSync(out)) throw new Error(`${out} exists; refusing to overwrite a key`);
      const k = generateAgentKey();
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(Array.from(k.secret)));
      chmodSync(out, 0o600);
      console.log(k.id);
      return;
    }
    case "calibrate": {
      const w = new Worker({ core: a.one("core") ?? "http://127.0.0.1:9660", key: loadKey(a.one("key")!) });
      const r = await w.submitCalibration(a.one("recipe-id")!, a.one("snapshot-id")!, Number(a.one("runs") ?? 5));
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case "run": {
      let proposer: Proposer | undefined;
      const kind = a.one("proposer");
      if (kind === "scripted") {
        const names = a.one("names")?.split(",").filter(Boolean);
        proposer = new ScriptedProposer(loadScript(a.one("script")!, names));
      } else if (kind === "anthropic") {
        loadModelEnv();
        if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("no model key: put ANTHROPIC_API_KEY in ~/.config/lineage/model.env");
        proposer = new AnthropicProposer({
          max_usd: Number(a.one("max-usd") ?? 2),
          model: a.one("model"),
          effort: a.one("effort") as never,
        });
      } else if (kind) throw new Error(`unknown proposer ${kind}`);
      const w = new Worker({
        core: a.one("core") ?? "http://127.0.0.1:9660",
        key: loadKey(a.one("key")!),
        proposer,
        lineages: a.all("lineage"),
        dishonest: (a.one("dishonest") as Dishonesty) ?? "none",
        maxCandidates: a.one("max-candidates") ? Number(a.one("max-candidates")) : undefined,
      });
      if (a.one("once")) {
        await w.tick();
        return;
      }
      let stop = false;
      process.on("SIGINT", () => (stop = true));
      process.on("SIGTERM", () => (stop = true));
      await w.run(Number(a.one("interval") ?? 2000), () => stop);
      return;
    }
    default:
      console.error("usage: lineage-worker keygen|run|calibrate (see header of src/main.ts)");
      process.exit(2);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
