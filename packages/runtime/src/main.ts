#!/usr/bin/env bun
// lineage-runtime CLI (SPEC 17.2).
//   run      --config <file> [--max-candidates <n>]   run every hosted agent until SIGINT or SIGTERM
//   status   --config <file>                          print the persisted state summary (no keys)
//   bind-request --config <file> --agent <id>         what the owner needs to bind the agent to this runtime's key
//   cosign   --config <file> --agent <id> --tx <base64> [--dry-run]
//                                                     devnet: co-sign, as the agent's new runtime key, a
//                                                     rotate_agent_key the owner signed on the Wallet page, and send it
// One process per runtime state directory (a lock file). The model key is read from
// ~/.config/lineage/model.env and never printed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keyFromSolanaJson } from "@lineage/protocol";
import { devnetRpcUrl } from "../../chain/src/endpoint.ts";
import { AnthropicProposer } from "../../worker/src/proposers/anthropic.ts";
import { ChainBackend, SimBackend, type Backend } from "./backend.ts";
import { loadConfig, loadModelEnv, type RuntimeConfig } from "./config.ts";
import { Runtime, type RuntimeDeps } from "./runtime.ts";
import { ChainMessenger } from "../../core/src/msgchain.ts";

function args(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    out[a.slice(2)] = next && !next.startsWith("--") ? (i++, next) : "true";
  }
  return out;
}

const loadKey = (p: string) => keyFromSolanaJson(JSON.parse(readFileSync(p, "utf8")));

export function backendFor(cfg: RuntimeConfig, log: (m: string) => void, onTx?: (what: string, sig: string, fee?: number) => void): Backend {
  const key = loadKey(cfg.runtime_key);
  return cfg.mode === "sim"
    ? new SimBackend(cfg.core, key)
    : new ChainBackend(key, { rpcUrl: cfg.rpc_url ?? devnetRpcUrl(), log: (m) => log(`  ${m}`), onTx: (w, r) => onTx?.(w, r.signature, r.fee) });
}

/** Devnet: hosted agents post their messages on chain (lineage_msg, SPEC 12.5), the runtime paying the fees. */
export function chainMessengers(cfg: RuntimeConfig, backend: Backend, log: (m: string) => void): RuntimeDeps["messenger"] {
  if (!(backend instanceof ChainBackend)) return undefined;
  const payer = loadKey(cfg.runtime_key);
  return (agent, key, onFee) => new ChainMessenger({ rpc: backend.rpc, payer, key, agent, core: cfg.core, onFee, log: (m) => log(`${agent.slice(0, 6)} ${m}`) });
}

export function claudeProposer(cfg: RuntimeConfig) {
  return () => new AnthropicProposer({ max_usd: cfg.attempt_max_usd, model: cfg.model, effort: cfg.effort, max_turns: cfg.max_turns, max_evals: cfg.max_evals });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  if (!a.config) throw new Error("--config <file> is required");
  const cfg = loadConfig(a.config, a["max-candidates"] ? { max_candidates_per_agent: Number(a["max-candidates"]) } : {});
  const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)} runtime] ${m}`);
  switch (cmd) {
    case "run": {
      if (!loadModelEnv()) throw new Error("no model key: put ANTHROPIC_API_KEY in ~/.config/lineage/model.env");
      const backend = backendFor(cfg, log, (w, s, f) => log(`tx ${w}: ${s} (fee ${f ?? "?"})`));
      const rt = new Runtime(cfg, { backend, runtimeKey: loadKey(cfg.runtime_key), proposer: claudeProposer(cfg), log, messenger: chainMessengers(cfg, backend, log) });
      await rt.start();
      let signals = 0;
      const onSignal = () => {
        if (++signals > 1) process.exit(130); // state is persisted after every step; a second signal leaves now
        log("signal: graceful stop (send again to leave at once)");
        void rt.stop().then(() => process.exit(0));
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      await rt.run();
      return;
    }
    case "status": {
      const f = join(cfg.state_dir, "state.json");
      if (!existsSync(f)) throw new Error(`no state at ${f}`);
      const s = JSON.parse(readFileSync(f, "utf8"));
      for (const v of Object.values(s.agents) as { key_file?: string }[]) delete v.key_file;
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    case "bind-request": {
      const f = join(cfg.state_dir, "bind-requests", `${a.agent}.json`);
      if (!existsSync(f)) throw new Error(`no bind request for ${a.agent}: run the runtime once so it discovers the agent`);
      console.log(readFileSync(f, "utf8"));
      return;
    }
    case "cosign": {
      if (cfg.mode !== "devnet") throw new Error("cosign is for devnet; in sim mode the owner posts the bind request with the agent's key");
      const keyFile = join(cfg.state_dir, "keys", `${a.agent}.json`);
      if (!existsSync(keyFile)) throw new Error(`this runtime holds no key for ${a.agent}`);
      const { cosignCommand } = await import("../../chain/src/cosign.ts");
      await cosignCommand({ key: loadKey(keyFile), tx: a.tx!, rpcUrl: cfg.rpc_url ?? devnetRpcUrl(), dryRun: a["dry-run"] === "true" });
      return;
    }
    default:
      console.error("usage: lineage-runtime run|status|bind-request|cosign --config <file> (see the header of src/main.ts)");
      process.exit(2);
  }
}

if (import.meta.main)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
