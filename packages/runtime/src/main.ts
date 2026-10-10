#!/usr/bin/env bun
// lineage-runtime CLI (SPEC 17.2).
//   run      --config <file> [--max-candidates <n>]   run every hosted agent until SIGINT or SIGTERM
//                                                     (devnet with bind_port: also the bind endpoint, bind.ts)
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
import { applyNetworkProfile, rpcUrlFor } from "../../chain/src/profile-node.ts";
import { AnthropicProposer } from "../../worker/src/proposers/anthropic.ts";
import { ChainBackend, SimBackend, type Backend } from "./backend.ts";
import { loadConfig, loadModelEnv, windowStart, type RuntimeConfig } from "./config.ts";
import { Runtime, type RuntimeDeps } from "./runtime.ts";
import { addSecret, redact } from "./state.ts";
import { checkCorePrices, CreditMonitor, monitorStatePath, railClient, railModel, railPrices } from "./rail.ts";
import { ChainMessenger } from "../../core/src/msgchain.ts";
import { CoreClient } from "../../core/src/client.ts";
import { availabilityOf, loadProviderKeys, loadProviderSpecs } from "../../worker/src/proposers/providers.ts";
import { reloadKeys, resolveRoute, routedProposers, RegistrySource, soulModel } from "./providers.ts";
import { OpenRouterBalance } from "./provider-balance.ts";
import { JupiterPrice } from "./price.ts";
import type { AgentRoute } from "./runtime.ts";
import { bindHandler, chainCosign, serveBind } from "./bind.ts";
import { withGenesis } from "./genesis.ts";
import { anthropicClient } from "../../souls/src/generator.ts";
import { chainTrading, type TradingRuntimeConfig } from "../../trader/src/glue.ts";
import { desktopPool, startRecordingPublisher, withDesktops } from "./desktops.ts";

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

/** The network profile's RPC (devnet: devnetRpcUrl() as before; mainnet: the keyed env endpoint). */
const chainRpc = () => rpcUrlFor(applyNetworkProfile());
const loadKey = (p: string) => keyFromSolanaJson(JSON.parse(readFileSync(p, "utf8")));

export function backendFor(cfg: RuntimeConfig, log: (m: string) => void, onTx?: (what: string, sig: string, fee?: number) => void): Backend {
  const key = loadKey(cfg.runtime_key);
  return cfg.mode === "sim"
    ? new SimBackend(cfg.core, key)
    : new ChainBackend(key, { rpcUrl: cfg.rpc_url ?? chainRpc(), log: (m) => log(`  ${m}`), onTx: (w, r) => onTx?.(w, r.signature, r.fee) });
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
  return routedProposers({ core: cfg.core, keys, providers: loadProviderSpecs(), attempt_max_usd: cfg.attempt_max_usd, effort: cfg.effort, max_turns: cfg.max_turns, max_evals: cfg.max_evals, efficiency: cfg.efficiency });
}

/** The model and route an agent runs on now (plan MODELS-AND-SELF-FUNDING), for the runtime's gates and spend report. */
export function routeResolver(core: string, keys: Record<string, string>, registry: RegistrySource): (agent: string) => Promise<AgentRoute> {
  return async (agent) => {
    const r = resolveRoute(await registry.get(), await soulModel(core, agent), keys);
    return r.ok ? { via: r.via, model: { provider: r.chosen.provider, id: r.chosen.id }, why: null } : { via: null, model: r.choice, why: r.why };
  };
}

/**
 * Re-reads providers.env every minute: a key the owner adds (or removes) is used from the next
 * attempt and Core is told, so the launch form offers its models with no restart or code change.
 */
export function watchProviderKeys(cfg: RuntimeConfig, keys: Record<string, string>, log: (m: string) => void, every_ms = 60_000): () => void {
  const t = setInterval(() => {
    try {
      if (reloadKeys(keys, loadProviderKeys({ create: false }))) void reportAvailability(cfg, keys, log);
    } catch (e) {
      log(`providers.env not re-read: ${(e as Error).message}`);
    }
  }, every_ms);
  return () => clearInterval(t);
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
    prices: railPrices(r), efficiency: cfg.efficiency }, railClient(r));
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
  // network profile (SPEC 14.10): a chain mode must be the profile's; mainnet sends price compute units from recent fees
  const profile = applyNetworkProfile();
  if (cfg.mode !== "sim" && cfg.mode !== profile.network) throw new Error(`runtime config mode ${cfg.mode} differs from the network profile ${profile.network} (config/profile.json, LINEAGE_NETWORK)`);
  if (cfg.mode !== "sim" && !cfg.rpc_url) addSecret(chainRpc());
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
        ? chainTrading({ core: cfg.core, stateDir: cfg.state_dir, runtimeKey: loadKey(cfg.runtime_key), rpcUrl: cfg.rpc_url ?? chainRpc(), rpc: backend.rpc, cfg: tcfg, keys, log, onTx: (w, s, f) => log(`tx ${w}: ${s} (fee ${f ?? "?"})`) })
        : null;
      // agent desktops (SPEC 17.7): our server's slots first, then E2B within its day cap
      const desktops = desktopPool(cfg, log);
      // plan MODELS-AND-SELF-FUNDING: routes per agent, OpenRouter's balance, the quote price, the spend report
      const stopKeys = watchProviderKeys(cfg, keys, log);
      const reg = new RegistrySource({ core: cfg.core, log });
      const providerBalance = new OpenRouterBalance({ keys, floor_usd: cfg.openrouter_floor_usd ?? 5, check_s: cfg.openrouter_check_s, log });
      const quote = applyNetworkProfile().quote;
      if (cfg.mode === "mainnet" && (!quote.mint || quote.decimals === undefined)) throw new Error("mainnet runtime: the network profile's quote token needs mint and decimals for its USD price");
      const price = cfg.mode === "mainnet"
        ? new JupiterPrice({ mint: quote.mint!, decimals: quote.decimals!, api: cfg.price?.api, max_age_s: cfg.price?.max_age_s, min_usd: cfg.price?.min_usd ?? 0.95, max_usd: cfg.price?.max_usd ?? 1.05, refresh_s: cfg.price?.refresh_s })
        : undefined;
      const reporter = new CoreClient(cfg.core, loadKey(cfg.runtime_key));
      const rt = new Runtime(cfg, {
        backend, runtimeKey: loadKey(cfg.runtime_key), proposer: hostedProposers(cfg, keys), log, messenger: chainMessengers(cfg, backend, log), postClient: postClient(), trading: trading?.hooks, desktop: desktops ?? undefined,
        route: (cfg.rail ?? "anthropic") === "anthropic" ? routeResolver(cfg.core, keys, reg) : undefined,
        providerBalance, price,
        report: async (body) => {
          const r = await reporter.post("/v1/admin/runtime/spend", body);
          if (r.status >= 300) throw new Error(`HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        },
      });
      trading?.attach(rt);
      const stopTrading = trading?.start() ?? (() => {});
      await rt.start();
      // hosted launches bind from the Wallet page (bind.ts): the owner signs the rotation, this runtime co-signs
      const bindServer = cfg.bind_port && backend instanceof ChainBackend
        ? serveBind(cfg.bind_port, withGenesis(rt, withDesktops(desktops, bindHandler({ host: rt, send: chainCosign(cfg.rpc_url ?? chainRpc(), log, applyNetworkProfile().genesis), log })), log), log)
        : desktops && (cfg.desktop_port ?? cfg.bind_port)
          ? serveBind((cfg.desktop_port ?? cfg.bind_port)!, withDesktops(desktops), log)
          : null;
      const stopPublisher = desktops ? startRecordingPublisher(desktops, cfg.core, (a) => rt.keyOf(a), log) : () => {};
      let signals = 0;
      const onSignal = () => {
        if (++signals > 1) process.exit(130); // state is persisted after every step; a second signal leaves now
        log("signal: graceful stop (send again to leave at once)");
        stopMonitor();
        stopKeys();
        stopTrading();
        stopPublisher();
        bindServer?.stop(true);
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
      if (cfg.mode === "sim") throw new Error("cosign is for chain mode; in sim mode the owner posts the bind request with the agent's key");
      const keyFile = join(cfg.state_dir, "keys", `${a.agent}.json`);
      if (!existsSync(keyFile)) throw new Error(`this runtime holds no key for ${a.agent}`);
      const { cosignCommand } = await import("../../chain/src/cosign.ts");
      await cosignCommand({ key: loadKey(keyFile), tx: a.tx!, rpcUrl: cfg.rpc_url ?? chainRpc(), dryRun: a["dry-run"] === "true", expectAgent: a.agent, genesis: applyNetworkProfile().genesis });
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
