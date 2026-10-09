// Record shapes of the identity service and the public view built from them. Only `publicView`
// leaves the service: it carries the login, the public signing key, scopes and status, never a token.

export type LaunchMode = "token" | "purchased" | "app";
export const MODES: LaunchMode[] = ["token", "purchased", "app"];

/**
 * Status of an agent's GitHub identity:
 *   waiting_soul    purchased; waiting (bounded) for the agent's soul so the profile can use it
 *   provisioning    purchased; a reserve account is being validated, cleaned and set up
 *   awaiting_token  token mode; the launcher has not submitted a token yet (the agent uses the app identity)
 *   ready           the agent commits and pushes as its own account (login is public)
 *   failed          provisioning or validation failed (reason); the agent uses the app identity
 *   revoked         the launcher revoked the token; the agent uses the app identity
 *   rejected        GitHub rejected the stored token on use; the agent uses the app identity
 *   app             launched with the app identity
 */
export type Status = "waiting_soul" | "provisioning" | "awaiting_token" | "ready" | "failed" | "revoked" | "rejected" | "app";

export interface AgentState {
  v: 1;
  agent: string;
  mint: string;
  launcher: string;
  repo: string;
  mode: LaunchMode;
  status: Status;
  reason: string | null;
  login: string | null;
  github_id: number | null;
  ssh_public_key: string | null;
  scopes: string[] | null;
  token_kind: string | null;
  expires_at: string | null;
  /** unix seconds of the launch (chain) */
  launched_at: number;
  first_seen_at: string;
  updated_at: string;
  attempts: number;
  /** created_at of the last accepted signed statement (replay guard) */
  last_statement_at: number;
  history: { at: string; status: Status; reason: string | null }[];
}

/** Credential record (kind "cred"). Never returned by any API. */
export interface CredRecord {
  v: 1;
  agent: string;
  mode: "purchased" | "token";
  login: string;
  github_id: number;
  token: string;
  ssh_private_key: string;
  ssh_public_key: string;
  ssh_signing_key_id: number | null;
  assigned_at: string;
}

/** Reserve account (kind "reserve"), the same fields as a pool file entry (souls Pool). */
export interface ReserveRecord {
  login: string;
  token: string;
  status: string;
  assigned_agent: string | null;
  pushed_at?: string;
  assigned_at?: string;
  note?: string;
  [k: string]: unknown;
}

export interface PublishedRecord {
  gen_id: string;
  lineage_id: string;
  recipe: string;
  height: number;
  fork: string | null;
  branch: string;
  sha: string | null;
  verified: boolean | null;
  verification_reason: string | null;
  html_url: string | null;
  at: string;
}

export interface PublicView {
  agent: string;
  mode: LaunchMode | null;
  /** who signs and pushes this agent's commits right now */
  identity: "account" | "app";
  status: Status | "untracked" | "unknown";
  reason: string | null;
  login: string | null;
  profile_url: string | null;
  ssh_signing_key: string | null;
  scopes: string[] | null;
  token_kind: string | null;
  expires_at: string | null;
  updated_at: string | null;
  history: { at: string; status: string; reason: string | null }[];
  published: PublishedRecord[];
}

export function publicView(agent: string, s: AgentState | null, published: PublishedRecord[] = [], launchMode: LaunchMode | null = null): PublicView {
  if (!s) {
    return {
      agent, mode: launchMode, identity: "app", status: launchMode === "app" ? "app" : launchMode ? "untracked" : "unknown",
      reason: launchMode && launchMode !== "app" ? "launched before the identity service started watching; no account is managed for it" : null,
      login: null, profile_url: null, ssh_signing_key: null, scopes: null, token_kind: null, expires_at: null, updated_at: null, history: [], published: [],
    };
  }
  const ready = s.status === "ready";
  return {
    agent, mode: s.mode, identity: ready ? "account" : "app", status: s.status, reason: s.reason,
    login: ready ? s.login : null, profile_url: ready && s.login ? `https://github.com/${s.login}` : null,
    ssh_signing_key: ready ? s.ssh_public_key : null, scopes: s.scopes, token_kind: s.token_kind, expires_at: s.expires_at,
    updated_at: s.updated_at, history: s.history.slice(-20), published,
  };
}

export function setStatus(s: AgentState, status: Status, reason: string | null, now = new Date()): AgentState {
  s.status = status;
  s.reason = reason;
  s.updated_at = now.toISOString();
  s.history.push({ at: s.updated_at, status, reason });
  if (s.history.length > 50) s.history.splice(0, s.history.length - 50);
  return s;
}
