#!/usr/bin/env bun
// Verifies a Lineage reputation credential (identity plan I2) from chain alone: reads each epoch's
// `Epoch.record_root` from the registry over RPC, recomputes every leaf from its record, checks every
// Merkle proof against the onchain root, and recomputes the totals. Core's signature on the bundle is
// reported but never needed.
//
// Usage:
//   bun scripts/verify-credential.ts --file <credential.json> [--rpc <url>] [--tamper]
//   bun scripts/verify-credential.ts --core <url> --agent <id> [--rpc <url>] [--tamper] [--out <file>]
// --tamper alters one record (a counter +1) and expects the check to fail: exit 0 only if it does.
// The RPC defaults to the devnet resolver (LINEAGE_DEVNET_RPC, ~/.config/lineage/rpc.env, public).
import { readFileSync, writeFileSync } from "node:fs";
import { ChainReader, Rpc } from "@lineage/chain";
import { devnetRpcUrl, redactRpc } from "../packages/chain/src/endpoint.ts";
import { verifyCredential } from "../packages/core/src/records.ts";
import { verifyStatement } from "../packages/protocol/src/index.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const TAMPER = argv.includes("--tamper");

async function load(): Promise<any> {
  const file = opt("file");
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  const core = opt("core");
  const agent = opt("agent");
  if (!core || !agent) throw new Error("--file <credential.json> or --core <url> --agent <id> is required");
  const r = await fetch(`${core}/v1/agents/${agent}/credential`);
  if (!r.ok) throw new Error(`credential: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      // the public devnet RPC rate limits (HTTP 429): back off and retry
      if (i >= 6 || !/429|Too Many|rate/i.test(String((e as Error).message))) throw e;
      await Bun.sleep(1000 * 2 ** i);
    }
  }
}

async function main() {
  const cred = await load();
  const out = opt("out");
  if (out) writeFileSync(out, JSON.stringify(cred, null, 2) + "\n");
  const rpcUrl = opt("rpc") ?? devnetRpcUrl();
  const reader = new ChainReader(Rpc.http(rpcUrl, "confirmed"));
  const roots = new Map<number, string | null>();
  for (const e of cred.epochs as { epoch: number }[]) {
    const ep = await retry(() => reader.epoch(e.epoch));
    roots.set(e.epoch, ep?.recordRoot ?? null);
  }
  const target = TAMPER ? structuredClone(cred) : cred;
  if (TAMPER) {
    const leaf = target.epochs.flatMap((e: any) => e.leaves).find((l: any) => l.kind === "record");
    if (!leaf) throw new Error("the credential has no record to tamper with");
    if (leaf.record.role === "author") leaf.record.candidates.accepted += 1;
    else leaf.record.replays.assigned = (leaf.record.replays.assigned ?? 0) + 1;
  }
  const v = verifyCredential(target, roots);
  const { sig, ...body } = cred;
  const sigOk = cred.issuer && sig ? verifyStatement(cred.issuer, sig, "credential", body) : null;
  const report = {
    agent: cred.agent,
    rpc: redactRpc(rpcUrl),
    epochs: [...roots].map(([epoch, root]) => ({ epoch, onchain_record_root: root })),
    leaves_verified: v.checked,
    totals: v.totals,
    controller_since: cred.controller_since ?? null,
    issuer: cred.issuer ?? null,
    issuer_signature: sigOk === null ? "absent (not needed)" : sigOk ? "valid" : "INVALID",
    tampered: TAMPER,
    ok: v.ok,
    errors: v.errors,
  };
  console.log(JSON.stringify(report, null, 2));
  if (TAMPER) process.exit(v.ok ? 1 : 0);
  process.exit(v.ok && v.checked > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(2);
});
