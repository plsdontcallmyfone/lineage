// GitHub calls of the token flow (SPEC 13.9 `token` mode): validate a pasted token (login, scopes,
// expiry), register and remove the agent's SSH signing key. The token only lives in the GitHub
// client and request headers; errors are redacted by the client.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GitHub, GitHubError, type Fetch } from "../../souls/src/github/api.ts";

export interface TokenInfo {
  login: string;
  github_id: number;
  /** classic tokens: the scopes GitHub reports (X-OAuth-Scopes); fine-grained tokens: null (GitHub does not list them) */
  scopes: string[] | null;
  token_kind: "classic" | "fine-grained" | "oauth" | "other";
  /** GitHub's expiry for the token, when it reports one */
  expires_at: string | null;
}

export interface GitHubTarget {
  apiBase?: string;
  fetch?: Fetch;
}

export function tokenKind(token: string): TokenInfo["token_kind"] {
  if (token.startsWith("ghp_")) return "classic";
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("gho_")) return "oauth";
  return "other";
}

/** A pasted token's plausible shape (never logged; only checked). */
export function tokenShapeOk(token: unknown): token is string {
  return typeof token === "string" && token.length >= 20 && token.length <= 255 && /^[A-Za-z0-9_]+$/.test(token);
}

export class TokenRejected extends Error {}

export async function validateToken(token: string, t: GitHubTarget = {}): Promise<TokenInfo> {
  const gh = new GitHub({ token, base: t.apiBase, fetch: t.fetch });
  let r;
  try {
    r = await gh.request<{ login: string; id: number }>("GET", "/user");
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 401 || e.status === 403)) throw new TokenRejected(`GitHub rejected the token (${e.status})`);
    throw e;
  }
  const scopesHeader = r.headers.get("x-oauth-scopes");
  const exp = r.headers.get("github-authentication-token-expiration");
  let expires: string | null = null;
  if (exp) {
    // "2026-11-08 12:00:00 UTC" or "2026-11-08 12:00:00 +0000"
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/.exec(exp.trim());
    const tz = !m?.[3] || m[3] === "UTC" || m[3] === "Z" ? "Z" : m[3].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
    const d = m ? new Date(`${m[1]}T${m[2]}${tz}`) : new Date(NaN);
    expires = Number.isNaN(d.getTime()) ? exp.slice(0, 40) : d.toISOString();
  }
  return {
    login: String(r.data.login),
    github_id: Number(r.data.id),
    scopes: scopesHeader === null ? null : scopesHeader.split(",").map((s) => s.trim()).filter(Boolean),
    token_kind: tokenKind(token),
    expires_at: expires,
  };
}

export const signingKeyTitle = (agent: string) => `lineage agent ${agent.slice(0, 12)}`;

export async function registerSigningKey(token: string, agent: string, publicKey: string, t: GitHubTarget = {}): Promise<number | null> {
  const gh = new GitHub({ token, base: t.apiBase, fetch: t.fetch });
  // an earlier key of this agent (a rotation, or a retry after a crash) is replaced, other keys are left alone
  const keys = await gh.paged<{ id: number; title: string }>("/user/ssh_signing_keys", 5);
  for (const k of keys) if (k.title === signingKeyTitle(agent)) await gh.request("DELETE", `/user/ssh_signing_keys/${k.id}`, undefined, { okStatuses: [404] });
  const reg = await gh.request<{ id: number }>("POST", "/user/ssh_signing_keys", { title: signingKeyTitle(agent), key: publicKey });
  return reg.data?.id ?? null;
}

export async function removeSigningKey(token: string, id: number, t: GitHubTarget = {}): Promise<void> {
  const gh = new GitHub({ token, base: t.apiBase, fetch: t.fetch });
  await gh.request("DELETE", `/user/ssh_signing_keys/${id}`, undefined, { okStatuses: [404] });
}

export type Keygen = (dir: string, comment: string) => { privatePath: string; publicKey: string };

export const sshKeygen: Keygen = (dir, comment) => {
  const privatePath = join(dir, "git-signing-ed25519");
  rmSync(privatePath, { force: true });
  rmSync(`${privatePath}.pub`, { force: true });
  const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", privatePath], { encoding: "utf8" });
  if (r.status !== 0 || !existsSync(`${privatePath}.pub`)) throw new Error(`ssh-keygen failed: ${r.stderr}`);
  return { privatePath, publicKey: readFileSync(`${privatePath}.pub`, "utf8").trim() };
};
