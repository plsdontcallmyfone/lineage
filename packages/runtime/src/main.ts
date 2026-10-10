#!/usr/bin/env bun
// lineage-runtime CLI (SPEC 17.2).
//   run      --config <file> [--max-candidates <n>]   run every hosted agent until SIGINT or SIGTERM
//   status   --config <file>                          print the persisted state summary (no keys) and the global cap: window and spend counter
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
import { loadConfig, loadModelEnv, windowStart, type RuntimeConfig } from "./config.ts";
import { Runtime, type RuntimeDeps } from "./runtime.ts";
import { addSecret, redact } from "./state.ts";
import { checkCorePrices, CreditMonitor, monitorStatePath, railClient, railModel, railPrices } from "./rail.ts";
import { ChainMessenger } from "../../core/src/msgchain.ts";
import { CoreClient } from "../../core/src/client.ts";
import { availabilityOf, loadProviderKeys, loadProviderSpecs } from "../../worker/src/proposers/providers.ts";
import { routedProposers } from "./providers.ts";
import { anthropicClient } from "../../souls/src/generator.ts";
import { chainTrading, type TradingRuntimeConfig } from "../../trader/src/glue.ts";

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

/**
 * The proposer per agent. Rail anthropic (default): each agent runs the model its signed profile
 * picked (plan M, providers.ts), with keys from providers.env and model.env. Rail openrouter: every
 * agent runs the configured OpenRouter model (plan C).
 */
export function hostedProposers(cfg: RuntimeConfig, keys: Record<string, string>) {
  if ((cfg.rail ?? "anthropic") === "openrouter") return claudeProposer(cfg);
  return routedProposers({ core: cfg.core, keys, providers: loadProviderSpecs(), attempt_max_usd: cfg.attempt_max_usd, effort: cfg.effort, max_turns: cfg.max_turns, max_evals: cfg.max_evals });
}

/** Tells Core which providers have a key on this host (never the keys); the launch form offers only those. */
export async function reportAvailability(cfg: RuntimeConfig, keys: Record<string, string>, log: (m: string) => void) {
  const providers = availabilityOf(keys);
  const r = await new CoreClient(cfg.core, loadKey(cfg.runtime_key)).post("/v1/admin/models/availability", { providers }).catch((e) => ({ status: 0, body: String(e) }));
  log(`providers with a key: ${Object.entries(providers).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}${r.status === 200 ? " (reported to Core)" : ` (not reported to Core: ${r.status})`}`);
}

export function claudeProposer(cfg: RuntimeConfig) {
  // the credit rail picks the model endpoint (plan C): Anthropic by default, OpenRouter only when enabled
  const r = { rail: cfg.rail ?? "anthropic", openrouter: cfg.openrouter ?? null } as const;
  return () => new AnthropicProposer({ max_usd: cfg.attempt_max_usd, model: railModel(r, cfg.model), effort: cfg.effort, max_turns: cfg.max_turns, max_evals: cfg.max_evals,
    prices: railPrices(r) }, railClient(r));
}

/** Agent posts (plan S): written with our Anthropic key (the global daily cap covers them); none without a key. */
function postClient() {
  const k = process.env.ANTHROPIC_API_KEY;
  return k ? anthropicClient(k) : undefined;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  if (!a.config) throw new Error("--config <file> is required");
  const cfg = loadConfig(a.config, a["max-candidates"] ? { max_candidates_per_agent: Number(a["max-candidates"]) } : {});
  addSecret(cfg.rpc_url);
  // every line through redact, including the backend's and the messengers' (audit A2, OFF-R5)
  const log = (m: string) => console.log(redact(`[${new Date().toISOString().slice(11, 19)} runtime] ${m}`));
  switch (cmd) {
    case "run": {
      loadModelEnv();
      // provider keys (plan M): providers.env (created empty, mode 600, when missing) plus model.env; never printed
      const keys = loadProviderKeys();
      if ((cfg.rail ?? "anthropic") === "anthropic" && Object.keys(keys).length === 0)
        throw new Error("no model key: put ANTHROPIC_API_KEY in ~/.config/lineage/model.env or a provider key in ~/.config/lineage/providers.env");
      await reportAvailability(cfg, keys, log);
      await checkCorePrices(cfg.core, cfg, log);
      const stopMonitor = cfg.rail === "openrouter" && cfg.openrouter?.enabled ? new CreditMonitor(cfg.openrouter, { statePath: monitorStatePath(cfg.state_dir), log }).start() : () => {};
      const backend = backendFor(cfg, log, (w, s, f) => log(`tx ${w}: ${s} (fee ${f ?? "?"})`));
      // agents as traders (plan T): runtime.json "trading": { "enabled": true } on devnet
      const tcfg = (cfg as { trading?: TradingRuntimeConfig }).trading;
      const trading = tcfg?.enabled && backend instanceof ChainBackend
        ? chainTrading({ core: cfg.core, stateDir: cfg.state_dir, runtimeKey: loadKey(cfg.runtime_key), rpcUrl: cfg.rpc_url ?? devnetRpcUrl(), rpc: backend.rpc, cfg: tcfg, log, onTx: (w, s, f) => log(`tx ${w}: ${s} (fee ${f ?? "?"})`) })
        : null;
      const rt = new Runtime(cfg, { backend, runtimeKey: loadKey(cfg.runtime_key), proposer: hostedProposers(cfg, keys), log, messenger: chainMessengers(cfg, backend, log), postClient: postClient(), trading: trading?.hooks });
      trading?.attach(rt);
      const stopTrading = trading?.start() ?? (() => {});
      await rt.start();
      let signals = 0;
      const onSignal = () => {
        if (++signals > 1) process.exit(130); // state is persisted after every step; a second signal leaves now
        log("signal: graceful stop (send again to leave at once)");
        stopMonitor();
        stopTrading();
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
      // the global cap as configured and the counter it is checked against (a window not yet rolled over by the running process reads as 0)
      const ws = cfg.global_window_s ?? null;
      const start = ws ? windowStart(Date.now(), ws) : null;
      const spent = ws ? (s.window?.start === start && s.window?.window_s === ws ? s.window.usd : 0) : s.spent_usd_total;
      s.cap = { max_usd: cfg.global_max_usd, window_s: ws, window_start: start && new Date(start).toISOString(), window_end: start && new Date(start + ws! * 1000).toISOString(), spent_usd: spent, left_usd: Math.max(0, cfg.global_max_usd - spent), lifetime_usd: s.spent_usd_total };
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
      await cosignCommand({ key: loadKey(keyFile), tx: a.tx!, rpcUrl: cfg.rpc_url ?? devnetRpcUrl(), dryRun: a["dry-run"] === "true", expectAgent: a.agent });
      return;
    }
    default:
      console.error("usage: lineage-runtime run|status|bind-request|cosign --config <file> (see the header of src/main.ts)");
      process.exit(2);
  }
}

if (import.meta.main)
  main().catch((e) => {
    console.error(redact(String(e instanceof Error ? e.message : e)));
    process.exit(1);
  });
