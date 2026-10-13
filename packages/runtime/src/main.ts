#!/usr/bin/env bun
// lineage-runtime CLI (SPEC 17.2).
//   run      --config <file> [--max-candidates <n>]   run every hosted agent until SIGINT or SIGTERM
//                                                     (devnet with bind_port: also the bind endpoint, bind.ts)
//   status   --config <file>                          print the persisted state summary (no keys) and the global cap: window and spend counter
//   bind     --config <file> [--port <n>]             the bind service (bind-service.ts): the bind surface as its own
//                                                     process, up while `run` drains or restarts. Port: --port, else
//                                                     the config's bind_service_port. Loads no authority or model key.
//   pool     --config <file> [--fill]                 the key pool (pool.ts): prints its status; --fill runs one pass
//                                                     now (makes keys up to the limits, closes finished nonce accounts)
//   bind-request --config <file> --agent <id>         what the owner needs to bind the agent to this runtime's key
//   cosign   --config <file> --agent <id> --tx <base64> [--dry-run]
//                                                     devnet: co-sign, as the agent's new runtime key, a
//                                                     rotate_agent_key the owner signed on the Wallet page, and send it
// One process per runtime state directory (a lock file). The model key is read from
// ~/.config/lineage/model.env and never printed.
import "../../protocol/src/env-alias.ts"; // first: UNITS_* and LINEAGE_* env names both readable (docs/plans/REBRAND-UNITS.md 3.3)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keyFromSolanaJson } from "@units/protocol";
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
import { anthropicPrices, reloadKeys, resolveRoute, routedProposers, RegistrySource, soulModel } from "./providers.ts";
import { OpenRouterBalance } from "./provider-balance.ts";
import { JupiterPrice } from "./price.ts";
import type { AgentRoute } from "./runtime.ts";
import { bindHandler, chainCosign, chainCosignOnly, serveBind, waitingOf } from "./bind.ts";
import { Reservations } from "./reserve.ts";
import { withGenesis } from "./genesis.ts";
import type { ModelClient } from "../../souls/src/generator.ts";
import { routedModelClient } from "../../souls/src/routed-client.ts";
import { desktopPool, startRecordingPublisher, withDesktops } from "./desktops.ts";
import { installAgentFirewall } from "./firewall.ts";
import { PoolKeeper, poolNonceOf, poolStatus, type PoolChain } from "./pool.ts";
import { guardKey, Rpc } from "@units/chain";

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

/** Devnet: hosted agents post their messages on chain (units_msg, SPEC 12.5), the runtime paying the fees. */
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
export function routeResolver(core: string, keys: Record<string, string>, registry: RegistrySource): (agent: string, seat?: number) => Promise<AgentRoute> {
  return async (agent, seat) => {
    const choice = await soulModel(core, agent, fetch, seat);
    if (seat !== undefined && !choice) return { via: null, model: null, why: `the soul names no model for seat ${seat}` };
    const r = resolveRoute(await registry.get(), choice, keys);
    if (!r.ok) return { via: null, model: r.choice, why: r.why };
    // the routed model's rate prices the minimum useful attempt (runtime.ts minUsefulUsd)
    const p = r.model.rate ? anthropicPrices(r.model) : null;
    return { via: r.via, model: { provider: r.chosen.provider, id: r.chosen.id }, why: null, rate: p ? { input: p.input, output: p.output, cache_write: p.cache_write, fee_factor: r.fee_factor } : null };
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

/**
 * The model client of agent posts and the follow step (plan S). It follows the registry's route rule
 * like authoring (owner 2026-10-12: every call through OpenRouter): OpenRouter with its key, else
 * Anthropic with its own, read from the live keys at every call. A provider that answers "no credit"
 * is not called again for 15 minutes, and for OpenRouter the balance gate is marked empty. None
 * without either key.
 */
export function postClient(keys: Record<string, string>, reg: RegistrySource, providerBalance: OpenRouterBalance | undefined, log: (m: string) => void): ModelClient | undefined {
  if (!keys.openrouter && !keys.anthropic) return undefined;
  return routedModelClient({
    registry: () => reg.get(),
    keys,
    providers: loadProviderSpecs(),
    log: (m) => log(`model calls: ${m}`),
    onNoCredits: (p) => void (p === "openrouter" && providerBalance?.markNoCredits()),
  });
}

/** The pool's chain access: the runtime authority pays and signs creations; a pool key signs only its own nonce account's close. */
function poolChain(rpc: Rpc, payer: ReturnType<typeof loadKey>, log: (m: string) => void): PoolChain {
  return {
    rent: async () => BigInt(await rpc.call<number>("getMinimumBalanceForRentExemption", [80])),
    balance: (a) => rpc.getBalance(a),
    accounts: async (list) => (list.length ? (await rpc.getMultipleAccounts(list)).map((a) => (a ? { data: a.data, lamports: BigInt(a.lamports), owner: a.owner } : null)) : []),
    send: async (ixs, extra) => {
      const { sendAndConfirm } = await import("@units/chain");
      return (await sendAndConfirm(rpc, payer, ixs, { signers: extra, log: (m) => log(`  ${m}`) })).signature;
    },
    signingKey: async (agent) => {
      const { ChainReader } = await import("@units/chain");
      return (await new ChainReader(rpc).agent(agent))?.signingKey ?? null;
    },
  };
}
/** Live reservations as the bind service wrote them (read only): their keys are in use and are never closed. */
function reservedKeys(stateDir: string): Record<string, { key_id: string }> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const list = JSON.parse(readFileSync(join(stateDir, "reservations.json"), "utf8")) as Record<string, { key_id: string; expires_at: number }>;
    return Object.fromEntries(Object.entries(list).filter(([, r]) => r.expires_at > now).map(([a, r]) => [a, { key_id: r.key_id }]));
  } catch {
    return {};
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  if (!a.config) throw new Error("--config <file> is required");
  const cfg = loadConfig(a.config, a["max-candidates"] ? { max_candidates_per_agent: Number(a["max-candidates"]) } : {});
  addSecret(cfg.rpc_url);
  // network profile (SPEC 14.10): a chain mode must be the profile's; mainnet sends price compute units from recent fees
  const profile = applyNetworkProfile();
  if (cfg.mode !== "sim" && cfg.mode !== profile.network) throw new Error(`runtime config mode ${cfg.mode} differs from the network profile ${profile.network} (config/profile.json, UNITS_NETWORK)`);
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
      // the transaction firewall (docs/plans/AGENT-WALLET-SAFETY.md 3): installed before any agent key is used
      // on chain; agent keys sign nothing it does not allow, and it allows no swap (agents do not trade)
      let fwAgents: () => Record<string, { key_id: string }> = () => ({});
      if (backend instanceof ChainBackend) installAgentFirewall({ rpc: backend.rpc, stateDir: cfg.state_dir, view: { agents: () => fwAgents(), nonceOf: (k) => poolNonceOf(cfg.state_dir, k) }, log });
      // agent desktops (SPEC 17.7): our server's slots first, then E2B within its day cap
      const desktops = desktopPool(cfg, log);
      // plan MODELS-AND-SELF-FUNDING: routes per agent, OpenRouter's balance, the quote price, the spend report
      const stopKeys = watchProviderKeys(cfg, keys, log);
      const reg = new RegistrySource({ core: cfg.core, log });
      const providerBalance = new OpenRouterBalance({ keys, floor_usd: cfg.openrouter_floor_usd ?? 5, check_s: cfg.openrouter_check_s, log });
      const quote = applyNetworkProfile().quote;
      if (cfg.mode === "mainnet" && (!quote.mint || quote.decimals === undefined)) throw new Error("mainnet runtime: the network profile's quote token needs mint and decimals for its USD price");
      const price = cfg.mode === "mainnet" && cfg.price?.source !== "config"
        ? new JupiterPrice({ mint: quote.mint!, decimals: quote.decimals!, api: cfg.price?.api, max_age_s: cfg.price?.max_age_s, min_usd: cfg.price?.min_usd ?? 0.95, max_usd: cfg.price?.max_usd ?? 1.05, refresh_s: cfg.price?.refresh_s })
        : undefined;
      const reporter = new CoreClient(cfg.core, loadKey(cfg.runtime_key));
      const rt = new Runtime(cfg, {
        backend, runtimeKey: loadKey(cfg.runtime_key), proposer: hostedProposers(cfg, keys), log, messenger: chainMessengers(cfg, backend, log), postClient: postClient(keys, reg, providerBalance, log), desktop: desktops ?? undefined,
        route: (cfg.rail ?? "anthropic") === "anthropic" ? routeResolver(cfg.core, keys, reg) : undefined,
        providerBalance, price,
        report: async (body) => {
          const r = await reporter.post("/v1/admin/runtime/spend", body);
          if (r.status >= 300) throw new Error(`HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        },
      });
      // keys reserved for launches that are not on chain yet (reserve.ts): guarded like every agent key, each for its own agent only
      // with the bind service (config bind_service_port) the reservations and the bind routes are that process's
      const ownBind = !cfg.bind_service_port;
      const reservations = backend instanceof ChainBackend && ownBind
        ? new Reservations({ dir: cfg.state_dir, keyFor: (a) => rt.store.keyFor(a), keyFile: (a) => rt.store.keyFile(a), adopted: (a) => !!rt.state.agents[a], adopt: async (a) => !!(await rt.bindTarget(a)), log })
        : null;
      fwAgents = () => (reservations ? { ...reservations.agents(), ...rt.state.agents } : rt.state.agents);
      for (const r of Object.values(reservations?.agents() ?? {})) guardKey(r.key_id);
      for (const st of Object.values(rt.state.agents)) guardKey(st.key_id);
      await rt.start();
      // hosted launches bind from the Wallet page (bind.ts): the owner signs the rotation, this runtime co-signs
      const bindServer = cfg.bind_port && backend instanceof ChainBackend && ownBind
        ? serveBind(cfg.bind_port, withGenesis(rt, withDesktops(desktops, bindHandler({ host: rt, send: chainCosign(cfg.rpc_url ?? chainRpc(), log, applyNetworkProfile().genesis), reserve: reservations ? { reservations, recordExists: async (a) => !!(await backend.reader.agent(a)), sign: chainCosignOnly } : undefined, waiting: waitingOf({ agents: () => rt.state.agents, launcherOf: async (a) => (await backend.hostedAgent(a))?.launcher ?? null }), log })), log), log)
        : cfg.bind_port && backend instanceof ChainBackend
          // the bind service answers /runtime/bind and /runtime/unbound; this port keeps the genesis proof and the desktops
          ? serveBind(cfg.bind_port, withGenesis(rt, withDesktops(desktops), log), log)
          : desktops && (cfg.desktop_port ?? cfg.bind_port)
            ? serveBind((cfg.desktop_port ?? cfg.bind_port)!, withDesktops(desktops), log)
            : null;
      const stopPublisher = desktops ? startRecordingPublisher(desktops, cfg.core, (a) => rt.keyOf(a), log) : () => {};
      // the key pool for backup bind signatures (pool.ts): filled and cleaned up here, where the payer is; a pass a minute
      const stopPool = cfg.bind_pool?.enabled && backend instanceof ChainBackend
        ? new PoolKeeper({ stateDir: cfg.state_dir, payer: loadKey(cfg.runtime_key).id, chain: poolChain(backend.rpc, loadKey(cfg.runtime_key), log), owners: { agents: () => rt.state.agents, reserved: () => reservedKeys(cfg.state_dir) }, config: cfg.bind_pool, log }).start()
        : () => {};
      let signals = 0;
      const onSignal = () => {
        if (++signals > 1) process.exit(130); // state is persisted after every step; a second signal leaves now
        log("signal: graceful stop (send again to leave at once)");
        stopMonitor();
        stopKeys();
        stopPublisher();
        stopPool();
        // the listener stays up while the attempts drain (up to TimeoutStopSec): a runtime that serves the
        // bind surface itself keeps answering reservations and co-signs until the process leaves
        void rt.stop().then(() => (bindServer?.stop(true), process.exit(0)));
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
      // the bind service's counters (bind-service.ts): reservations, co-signs, binds landed with the launch and after, launches seen unbound
      const bs = join(cfg.state_dir, "bind-service", "status.json");
      s.bind = existsSync(bs) ? JSON.parse(readFileSync(bs, "utf8")) : null;
      s.bind_pool = poolStatus(cfg.state_dir);
      console.log(JSON.stringify(s, null, 2));
      return;
    }
    case "bind": {
      if (cfg.mode === "sim") throw new Error("the bind service is for chain mode");
      const port = Number(a.port ?? cfg.bind_service_port);
      if (!(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error("bind: --port <n> or bind_service_port in the config");
      const { ChainReader } = await import("@units/chain");
      const { readerChain, startBindService } = await import("./bind-service.ts");
      const { Lock } = await import("./state.ts");
      const rpcUrl = cfg.rpc_url ?? chainRpc();
      const rpc = Rpc.http(rpcUrl, "confirmed");
      // one bind service per state directory; a restart waits out the old process's last moments
      const lock = new Lock(join(cfg.state_dir, "bind-service"), "bind.lock");
      for (let i = 0; ; i++) {
        try {
          lock.acquire();
          break;
        } catch (e) {
          if (i >= 50) throw e;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const blog = (m: string) => console.log(redact(`[${new Date().toISOString().slice(11, 19)} bind] ${m}`));
      const svc = startBindService({
        stateDir: cfg.state_dir, port, mode: cfg.mode, log: blog,
        chain: readerChain(new ChainReader(rpc) as any, rpc),
        send: chainCosign(rpcUrl, blog, profile.genesis), sign: chainCosignOnly,
        // the transaction firewall, as in `run`: every key this process reads is guarded, each for its own agent only
        guard: (view, nonceOf) => void installAgentFirewall({ rpc, stateDir: join(cfg.state_dir, "bind-service"), view: { agents: view, nonceOf }, log: blog }),
      });
      let leaving = false;
      const leave = () => {
        if (leaving) process.exit(130);
        leaving = true;
        void svc.stop().then(() => (lock.release(), process.exit(0)));
      };
      process.on("SIGINT", leave);
      process.on("SIGTERM", leave);
      await new Promise(() => {});
      return;
    }
    case "pool": {
      if (cfg.mode === "sim") throw new Error("the key pool is for chain mode");
      if (a.fill === "true") {
        // one pass by hand (for example while `run` drains): the same limits; the agents come from the persisted state
        const rpc = Rpc.http(cfg.rpc_url ?? chainRpc(), "confirmed");
        const payer = loadKey(cfg.runtime_key);
        const agents = (): Record<string, { key_id: string }> => {
          try {
            return (JSON.parse(readFileSync(join(cfg.state_dir, "state.json"), "utf8")) as { agents: Record<string, { key_id: string }> }).agents;
          } catch {
            return {};
          }
        };
        installAgentFirewall({ rpc, stateDir: cfg.state_dir, view: { agents, nonceOf: (k) => poolNonceOf(cfg.state_dir, k) }, log });
        await new PoolKeeper({ stateDir: cfg.state_dir, payer: payer.id, chain: poolChain(rpc, payer, log), owners: { agents, reserved: () => reservedKeys(cfg.state_dir) }, config: cfg.bind_pool, log }).pass();
      }
      console.log(JSON.stringify(poolStatus(cfg.state_dir), null, 2));
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
      // this key is an agent treasury: it co-signs through the firewall (only its own agent's bind)
      const cosignKey = loadKey(keyFile);
      guardKey(cosignKey.id);
      installAgentFirewall({ rpc: Rpc.http(cfg.rpc_url ?? chainRpc(), "confirmed"), stateDir: cfg.state_dir, view: { agents: () => ({ [a.agent!]: { key_id: cosignKey.id } }) }, log });
      await cosignCommand({ key: cosignKey, tx: a.tx!, rpcUrl: cfg.rpc_url ?? chainRpc(), dryRun: a["dry-run"] === "true", expectAgent: a.agent, genesis: applyNetworkProfile().genesis });
      return;
    }
    default:
      console.error("usage: lineage-runtime run|bind|pool|status|bind-request|cosign --config <file> (see the header of src/main.ts)");
      process.exit(2);
  }
}

if (import.meta.main)
  main().catch((e) => {
    console.error(redact(String(e instanceof Error ? e.message : e)));
    process.exit(1);
  });
