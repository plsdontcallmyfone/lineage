import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { devnetRpcUrl, fromEnvFile } from "./endpoint.ts";
import { quoteOfState, selectProfile, type NetworkProfile } from "./profile.ts";
import { useProfilePrograms } from "./programs.ts";
import { setDefaultFeePolicy } from "./sender.ts";

// Node side of the network profile (M3, SPEC 14.10): reads config/profile.json once, applies the
// UNITS_NETWORK override, resolves the RPC and the deployed state. Keyed RPC URLs are secrets:
// callers log redactRpc(url) only and never hand the URL to a browser.

export const REPO_ROOT = join(import.meta.dir, "../../..");
export const PROFILE_FILE = join(REPO_ROOT, "config/profile.json");

let cached: { key: string; p: NetworkProfile } | null = null;

/**
 * A local overlay for one deployment (the mainnet test, docs/MAINNET-RUNBOOK.md "Mainnet test"): a
 * JSON file outside git, named by UNITS_PROFILE_LOCAL, shaped { "profiles": { "<network>": { ... } } }.
 * Each key it gives replaces the same key of that network's block in config/profile.json (the quote
 * block is replaced whole) before the block is parsed, so every guard of parseProfile still applies:
 * program ids stay the build's, mainnet keeps no faucet and no TEST labels. It cannot change `network`.
 * Absent variable: no overlay. A named file that is missing or malformed is refused (a service must
 * not start on the stand-in quote by accident).
 */
export function applyProfileOverlay(raw: unknown, overlay: unknown): unknown {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(overlay) || !isObj(overlay.profiles)) throw new Error("profile overlay: profiles is required");
  if (!isObj(raw) || !isObj(raw.profiles)) throw new Error("profile config: profiles is required");
  const profiles: Record<string, unknown> = { ...raw.profiles };
  for (const [name, block] of Object.entries(overlay.profiles)) {
    if (!isObj(block)) throw new Error(`profile overlay: profiles.${name} must be an object`);
    if (!isObj(profiles[name])) throw new Error(`profile overlay: there is no ${name} profile to overlay`);
    profiles[name] = { ...(profiles[name] as Record<string, unknown>), ...block };
  }
  return { ...raw, profiles };
}

/** The active profile. `file` and `env` are for tests; services call it with no arguments. */
export function loadNetworkProfile(o: { file?: string; env?: Record<string, string | undefined> } = {}): NetworkProfile {
  const file = o.file ?? PROFILE_FILE;
  const env = o.env ?? process.env;
  const local = env.UNITS_PROFILE_LOCAL ?? "";
  const key = `${file}\n${(env.UNITS_NETWORK ?? env.LINEAGE_NETWORK) ?? ""}\n${local}\n${env.UNITS_FEATURE_AGENT_POOLS ?? ""}${env.UNITS_FEATURE_GITHUB_FEE_CLAIMS ?? ""}`;
  if (!o.env && cached?.key === key) return cached.p;
  let raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (local) {
    if (!existsSync(local)) throw new Error(`UNITS_PROFILE_LOCAL names ${local}, which does not exist`);
    raw = applyProfileOverlay(raw, JSON.parse(readFileSync(local, "utf8")));
  }
  const p = selectProfile(raw, (env.UNITS_NETWORK ?? env.LINEAGE_NETWORK) ?? null);
  // one process may switch a feature on or off (a staging server): UNITS_FEATURE_AGENT_POOLS, UNITS_FEATURE_GITHUB_FEE_CLAIMS = 1 | 0
  for (const k of ["agent_pools", "github_fee_claims"] as const) {
    const v = env[`UNITS_FEATURE_${k.toUpperCase()}`];
    if (v === "1" || v === "0") p.features = { agent_pools: false, github_fee_claims: false, ...p.features, [k]: v === "1" };
  }
  if (!o.env) cached = { key, p };
  return p;
}

export class MissingRpcError extends Error {}

/**
 * The RPC for a profile. devnet: packages/chain devnetRpcUrl() exactly as before. mainnet: a keyed
 * endpoint from UNITS_MAINNET_RPC or HELIUS_MAINNET_RPC in ~/.config/lineage/rpc.env; there is no
 * public fallback (a service on mainnet refuses to start without its own endpoint).
 */
export function rpcUrlFor(p: NetworkProfile, env: Record<string, string | undefined> = process.env, home = homedir()): string {
  if (p.network === "devnet") return devnetRpcUrl();
  const f = [join(home, ".config/units/rpc.env"), join(home, ".config/lineage/rpc.env")];
  const fromFiles = (k: string) => f.map((x) => fromEnvFile(x, k)).find((x) => !!x) ?? null;
  const u = (env.UNITS_MAINNET_RPC ?? env.LINEAGE_MAINNET_RPC) || fromFiles("UNITS_MAINNET_RPC") || fromFiles("HELIUS_MAINNET_RPC");
  if (!u) throw new MissingRpcError("mainnet profile: set UNITS_MAINNET_RPC (in the environment or in ~/.config/units/rpc.env; HELIUS_MAINNET_RPC there is read too); there is no public fallback");
  return u;
}

/** Env names whose values are secrets under any profile (runtime redaction lists include them). */
export const RPC_SECRET_ENV = ["UNITS_DEVNET_RPC", "HELIUS_DEVNET_RPC", "UNITS_MAINNET_RPC", "HELIUS_MAINNET_RPC"];

/** The deployed state for the profile (devnet.json, or mainnet.json once it exists) with the quote applied. */
export function stateFor(p: NetworkProfile): Record<string, unknown> | null {
  const f = isAbsolute(p.state_file) ? p.state_file : join(REPO_ROOT, p.state_file);
  const raw = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>) : null;
  return quoteOfState(p, raw);
}

/**
 * Process start for a service: loads the profile, makes its program ids the ones every builder, PDA
 * and reader uses (programs.ts), and, on mainnet, makes every server-side sendAndConfirm price its
 * compute units from recent prioritization fees (capped by config). Devnet leaves the sender and
 * the ids as they were.
 */
export function applyNetworkProfile(o: { file?: string; env?: Record<string, string | undefined> } = {}): NetworkProfile {
  const p = loadNetworkProfile(o);
  useProfilePrograms(p);
  setDefaultFeePolicy(p.fees.mode === "recent" ? p.fees : null, p.confirm);
  return p;
}
