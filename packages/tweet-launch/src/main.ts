#!/usr/bin/env bun
// Launch from a tweet (docs/plans/TWEET-LAUNCH.md): one pass of the reply bot.
//
//   bun packages/tweet-launch/src/main.ts --config <file> [--send] [--mock <url>] [--json]
//
// Without --send it is a dry run: it reads the mentions and prints what it would post; nothing is
// posted and the state file is not written (an OAuth 2.0 token refresh is still saved, since the old
// refresh token is spent by it). --send also needs "enabled": true in the config and no STOP file in
// the state directory. --mock <url> talks to a mock X API on this machine with the mock's own
// credentials and never reads the credentials file. Without credentials and without --mock it does
// not run. Exit status: 0 done, 2 stopped or refused (kill switch, STOP file, no credentials), 1 any
// other error.
import { join } from "node:path";
import { loadConfig, loadCredentials, publicConfig, X_BASE, type Creds } from "./config.ts";
import { readRepoFree } from "./github.ts";
import { runOnce } from "./service.ts";
import { Store } from "./state.ts";
import { TokenStore } from "./tokens.ts";
import { XClient } from "./x.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n: string) => argv.includes(n);

async function main(): Promise<number> {
  const file = flag("--config");
  if (!file || has("--help")) {
    console.error("usage: bun packages/tweet-launch/src/main.ts --config <file> [--send] [--mock <url>] [--json]");
    return file ? 0 : 1;
  }
  const cfg = loadConfig(file);
  const send = has("--send");
  const mock = flag("--mock");
  const say = (m: string) => { if (!has("--json")) console.log(`[tweet-launch] ${m}`); };
  let creds: Creds | null;
  let base = cfg.x_base;
  if (mock) {
    const u = new URL(mock);
    if (u.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(u.hostname)) throw new Error("--mock is an http address on this machine");
    base = mock.replace(/\/+$/, "");
    const { MOCK_CLIENT } = await import("./mock-x.ts");
    creds = { kind: "oauth2", access_token: "mock-access-0", refresh_token: "mock-refresh-0", ...MOCK_CLIENT };
  } else {
    // the owner's credentials go to X and nowhere else
    if (base !== X_BASE) throw new Error(`x_base is ${base}: real credentials are only ever sent to ${X_BASE} (use --mock for a mock)`);
    creds = loadCredentials(cfg.credentials_file);
    if (!creds) {
      console.error(`[tweet-launch] no X credentials in ${cfg.credentials_file}: this service runs only against --mock until the owner fills it in`);
      return 2;
    }
  }
  const store = new Store(cfg.state_dir);
  const tokens = creds.kind === "oauth2" ? new TokenStore(store.tokensFile, creds, { base, fetch, now: Date.now, margin_s: cfg.refresh_margin_s }) : null;
  const x = new XClient({ base, creds, tokens, fetch, dialect: cfg.dialect, max_results: cfg.poll_max_results, max_pages: cfg.poll_max_pages });
  say(send ? "SEND" : "dry run (nothing is posted; pass --send to post)");
  say(`${mock ? "mock X API" : "X API"}, ${creds.kind === "oauth2" ? "OAuth 2.0 user context" : "OAuth 1.0a user context"}; config ${JSON.stringify(publicConfig(cfg))}`);
  const report = await runOnce(cfg, { x, store, fetch, readRepo: readRepoFree(join(cfg.state_dir, "read")), now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: say }, { send });
  if (has("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    if (report.halted) say(`NOT RUN: ${report.halted}`);
    else say(`@${report.account}: ${report.mentions} new mention${report.mentions === 1 ? "" : "s"}, ${report.open_requests} open link${report.open_requests === 1 ? "" : "s"}`);
    for (const a of report.actions) {
      if (a.text) say(`${a.kind} (${a.why}) to ${a.in_reply_to}: ${send ? (a.posted ? `posted ${a.post_id}` : "NOT posted") : "would post"}\n${a.text.replace(/^/gm, "    ")}`);
      else say(`${a.kind} ${a.mention_id}: ${a.why}`);
    }
  }
  return report.halted ? 2 : 0;
}

main().then((c) => process.exit(c), (e) => {
  console.error(`[tweet-launch] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
