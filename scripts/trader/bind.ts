#!/usr/bin/env bun
// Binds TEST agents to the site's hosted runtime (identity plan I1), so the runtime holds their
// signing keys and their trading treasuries: for each agent, the registry owner (a local TEST key)
// signs rotate_agent_key to the runtime's key for that agent (read from the runtime's bind request on
// the server), and the runtime co-signs and sends it (`lineage-runtime cosign`, which checks what it
// signs). Owner keys are passed explicitly; the global solana config is never read.
// Usage: bun scripts/trader/bind.ts --host 157.245.71.188 --agent <id>=<owner key file> [...]
import { spawnSync } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import { base58Encode } from "@lineage/protocol";
import { compileMessage, computeBudget, loadKeypair, registry, Rpc, signBytes } from "@lineage/chain";
import { devnetRpcUrl } from "../../packages/chain/src/endpoint.ts";
import { assertDevnet } from "../../packages/chain/src/browser/client.ts";
import { placeSignature, unsignedWire } from "../../packages/chain/src/browser/wire.ts";
import { logTx } from "./devnet-log.ts";

const argv = process.argv.slice(2);
const host = argv[argv.indexOf("--host") + 1]!;
const pairs = argv.flatMap((a, i) => (argv[i - 1] === "--agent" ? [a] : []));
const ssh = (cmd: string) => {
  const r = spawnSync(["ssh", "-i", join(homedir(), ".ssh/lineage_site"), "-o", "BatchMode=yes", `root@${host}`, `runuser -u lineage -- env HOME=/home/lineage bash -c 'cd /opt/lineage/current && ${cmd}'`]);
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
};
const rpc = Rpc.http(devnetRpcUrl(), "confirmed");
await assertDevnet(rpc);
for (const p of pairs) {
  const [agent, keyFile] = p.split("=");
  const owner = loadKeypair(keyFile!.startsWith("/") ? keyFile! : join(homedir(), ".config/lineage/devnet", keyFile!));
  const req = ssh(`bun packages/runtime/src/main.ts bind-request --config /var/lib/lineage/site/runtime.json --agent ${agent}`);
  if (!req.ok) throw new Error(`bind request for ${agent}: ${req.err}`);
  const newKey = JSON.parse(req.out).new_key as string;
  const { blockhash } = await rpc.getLatestBlockhash();
  const msg = compileMessage(owner.id, [computeBudget.limit(60_000), registry.rotateAgentKey({ owner: owner.id, agent: agent!, newKey })], blockhash);
  const wire = placeSignature(unsignedWire(msg), owner.id, signBytes(owner, msg.bytes));
  const b64 = Buffer.from(wire).toString("base64");
  const r = ssh(`bun packages/runtime/src/main.ts cosign --config /var/lib/lineage/site/runtime.json --agent ${agent} --tx ${b64}`);
  console.log(r.out.trim());
  if (!r.ok) throw new Error(`cosign ${agent}: ${r.err}`);
  const sig = /rotated: (\w+)/.exec(r.out)?.[1] ?? base58Encode(wire.subarray(1, 65));
  const tx = await rpc.getTransaction(sig).catch(() => null);
  logTx(`bind TEST agent ${agent} to the site runtime: rotate_agent_key by owner ${owner.id} to runtime key ${newKey}, co-signed on the server`, sig, tx?.meta?.fee);
}
