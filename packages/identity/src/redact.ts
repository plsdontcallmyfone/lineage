// Log redaction for the identity service. Every log line goes through `redact`, which removes
// anything token-shaped (classic, fine-grained, OAuth, app and refresh tokens, 40-hex secrets) and
// any OpenSSH private key block, as a safety net behind the rule that tokens are never logged.

import { redactTokens } from "../../souls/src/github/api.ts";

const SSH_PRIVATE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;

export function redact(s: string): string {
  return redactTokens(s.replace(SSH_PRIVATE, "<redacted private key>"));
}

export type Log = (m: string) => void;

/** A logger that redacts before writing (stdout by default; the journal on the site). */
export function safeLog(prefix: string, out: (line: string) => void = (l) => console.log(l)): Log {
  return (m: string) => out(redact(`[${prefix}] ${m}`));
}

/** Error message, redacted and capped, for status records and API answers. */
export function errText(e: unknown, max = 300): string {
  const m = e instanceof Error ? e.message : String(e);
  return redact(m).slice(0, max);
}
