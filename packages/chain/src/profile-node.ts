import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { devnetRpcUrl, fromEnvFile } from "./endpoint.ts";
import { quoteOfState, selectProfile, type NetworkProfile } from "./profile.ts";
import { setDefaultFeePolicy } from "./sender.ts";

// Node side of the network profile (M3, SPEC 14.10): reads config/profile.json once, applies the
// LINEAGE_NETWORK override, resolves the RPC and the deployed state. Keyed RPC URLs are secrets:
// callers log redactRpc(url) only and never hand the URL to a browser.

export const REPO_ROOT = join(import.meta.dir, "../../..");
export const PROFILE_FILE = join(REPO_ROOT, "config/profile.json");

let cached: { key: string; p: NetworkProfile } | null = null;

/** The active profile. `file` and `env` are for tests; services call it with no arguments. */
export function loadNetworkProfile(o: { file?: string; env?: Record<string, string | undefined> } = {}): NetworkProfile {
  const file = o.file ?? PROFILE_FILE;
  const env = o.env ?? process.env;
  const key = `${file}\n${env.LINEAGE_NETWORK ?? ""}`;
  if (!o.env && cached?.key === key) return cached.p;
  const p = selectProfile(JSON.parse(readFileSync(file, "utf8")), env.LINEAGE_NETWORK ?? null);
  if (!o.env) cached = { key, p };
  return p;
}

export class MissingRpcError extends Error {}

/**
 * The RPC for a profile. devnet: packages/chain devnetRpcUrl() exactly as before. mainnet: a keyed
 * endpoint from LINEAGE_MAINNET_RPC or HELIUS_MAINNET_RPC in ~/.config/lineage/rpc.env; there is no
 * public fallback (a service on mainnet refuses to start without its own endpoint).
 */
export function rpcUrlFor(p: NetworkProfile, env: Record<string, string | undefined> = process.env, home = homedir()): string {
  if (p.network === "devnet") return devnetRpcUrl();
  const u = env.LINEAGE_MAINNET_RPC || fromEnvFile(join(home, ".config/lineage/rpc.env"), "HELIUS_MAINNET_RPC");
  if (!u) throw new MissingRpcError("mainnet profile: set LINEAGE_MAINNET_RPC (or HELIUS_MAINNET_RPC in ~/.config/lineage/rpc.env); there is no public fallback");
  return u;
}

/** Env names whose values are secrets under any profile (runtime redaction lists include them). */
export const RPC_SECRET_ENV = ["LINEAGE_DEVNET_RPC", "HELIUS_DEVNET_RPC", "LINEAGE_MAINNET_RPC", "HELIUS_MAINNET_RPC"];

/** The deployed state for the profile (devnet.json, or mainnet.json once it exists) with the quote applied. */
export function stateFor(p: NetworkProfile): Record<string, unknown> | null {
  const f = isAbsolute(p.state_file) ? p.state_file : join(REPO_ROOT, p.state_file);
  const raw = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>) : null;
  return quoteOfState(p, raw);
}

/**
 * Process start for a service: loads the profile and, on mainnet, makes every server-side
 * sendAndConfirm price its compute units from recent prioritization fees (capped by config).
 * Devnet leaves the sender as it was.
 */
export function applyNetworkProfile(o: { file?: string; env?: Record<string, string | undefined> } = {}): NetworkProfile {
  const p = loadNetworkProfile(o);
  setDefaultFeePolicy(p.fees.mode === "recent" ? p.fees : null, p.confirm);
  return p;
}
