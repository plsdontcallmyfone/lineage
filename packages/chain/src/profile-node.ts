import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { devnetRpcUrl, fromEnvFile } from "./endpoint.ts";
import { applyProfileOverlay, quoteOfState, resolveProfileConfig, selectProfile, type NetworkProfile } from "./profile.ts";
import { useProfilePrograms } from "./programs.ts";
import { setDefaultFeePolicy } from "./sender.ts";

// Node side of the network profile (M3, SPEC 14.10): reads config/profile.json once, applies the
// UNITS_NETWORK override, resolves the RPC and the deployed state. Keyed RPC URLs are secrets:
// callers log redactRpc(url) only and never hand the URL to a browser.

export const REPO_ROOT = join(import.meta.dir, "../../..");
export const PROFILE_FILE = join(REPO_ROOT, "config/profile.json");

let cached: { key: string; p: NetworkProfile } | null = null;

// A local overlay for one deployment (an instance on a server, a fork test): a JSON file named by
// UNITS_PROFILE_LOCAL, applied over config/profile.json with applyProfileOverlay (profile.ts). When it
// is set it is the only overlay: the config's own mainnet_deployment overlay is not applied under it.
// A named file that is missing or malformed is refused (a service must not start on another
// deployment by accident).
export { applyProfileOverlay };

/** The active profile. `file` and `env` are for tests; services call it with no arguments. */
export function loadNetworkProfile(o: { file?: string; env?: Record<string, string | undefined> } = {}): NetworkProfile {
  const file = o.file ?? PROFILE_FILE;
  const env = o.env ?? process.env;
  const local = env.UNITS_PROFILE_LOCAL ?? "";
  const network = (env.UNITS_NETWORK ?? env.LINEAGE_NETWORK) ?? null;
  const deployment = env.UNITS_MAINNET_DEPLOYMENT ?? "";
  const key = `${file}\n${network ?? ""}\n${local}\n${deployment}\n${env.UNITS_FEATURE_AGENT_POOLS ?? ""}${env.UNITS_FEATURE_GITHUB_FEE_CLAIMS ?? ""}`;
  if (!o.env && cached?.key === key) return cached.p;
  let raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (local) {
    if (!existsSync(local)) throw new Error(`UNITS_PROFILE_LOCAL names ${local}, which does not exist`);
    raw = applyProfileOverlay(raw, JSON.parse(readFileSync(local, "utf8")));
  } else {
    // the deployed mainnet deployment (config `mainnet_deployment`, UNITS_MAINNET_DEPLOYMENT): overlay paths are relative to the repository
    const root = join(dirname(file), "..");
    raw = resolveProfileConfig(raw, { network, deployment: deployment || null, readOverlay: (f) => {
      const abs = isAbsolute(f) ? f : join(root, f);
      if (!existsSync(abs)) throw new Error(`mainnet_deployments names ${f}, which does not exist`);
      return JSON.parse(readFileSync(abs, "utf8"));
    } });
  }
  const p = selectProfile(raw, network);
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
 * endpoint from UNITS_MAINNET_RPC in the environment or in ~/.config/units/rpc.env (HELIUS_MAINNET_RPC
 * there is read too); there is no public fallback and never a fall back to devnet: a service on mainnet
 * refuses to start without its own endpoint (MissingRpcError). The dashboard server alone may read
 * through the mainnet site's /chain/rpc proxy instead (apps/web/server.ts).
 */
export function rpcUrlFor(p: NetworkProfile, env: Record<string, string | undefined> = process.env, home = homedir()): string {
  if (p.network === "devnet") return devnetRpcUrl();
  const f = [join(home, ".config/units/rpc.env"), join(home, ".config/lineage/rpc.env")];
  const fromFiles = (k: string) => f.map((x) => fromEnvFile(x, k)).find((x) => !!x) ?? null;
  const u = (env.UNITS_MAINNET_RPC ?? env.LINEAGE_MAINNET_RPC) || fromFiles("UNITS_MAINNET_RPC") || fromFiles("HELIUS_MAINNET_RPC");
  if (!u) throw new MissingRpcError("mainnet profile (the repository's default network): no RPC endpoint. Set UNITS_MAINNET_RPC to your mainnet RPC URL, in the environment or in ~/.config/units/rpc.env (HELIUS_MAINNET_RPC there is read too). There is no public fallback and no fall back to devnet; for devnet run with UNITS_NETWORK=devnet.");
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
