// Small git helpers for the mirror. Tokens reach git only through environment configuration (an
// http extraheader scoped to the git host), never through argv or a remote URL, and every error
// message is passed through redactTokens.

import { spawnSync } from "node:child_process";
import { redactTokens } from "../../souls/src/github/api.ts";

export function git(cwd: string, args: string[], o: { env?: Record<string, string>; input?: string; allowFail?: boolean } = {}): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input: o.input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", ...(o.env ?? {}) },
    maxBuffer: 256 * 1024 * 1024,
  });
  const ok = r.status === 0;
  if (!ok && !o.allowFail) throw new Error(`git ${args[0]} failed: ${redactTokens((r.stderr || r.stdout || "").trim()).slice(0, 600)}`);
  return { ok, out: (r.stdout ?? "").trim(), err: redactTokens((r.stderr ?? "").trim()) };
}

/** Environment that authenticates https pushes to `gitBase` with a token, without argv or URL exposure. */
export function authEnv(token: string | null, gitBase: string): Record<string, string> {
  if (!token || !/^https?:/.test(gitBase)) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${gitBase.replace(/\/$/, "")}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
}

export const noreplyEmail = (githubId: number, login: string) => `${githubId}+${login}@users.noreply.github.com`;
