#!/usr/bin/env bun
// lineage-worker CLI.
//   keygen   --out <file>                         write a new agent key (Solana keypair JSON)
//   doctor   [--full]                             print this machine's capabilities as JSON (SPEC 6.1);
//                                                 --full adds docker, image and GPU detail
//   register --core <url> --key <file> [--capabilities <file>] [--operator <name>]
//                                                 register as a verifier (burns register_burn) and declare
//                                                 capabilities (default: what doctor detects)
//   bond     --core <url> --key <file> --amount <base units>   bond from the agent wallet
//   status   --core <url> --key <file>            print this agent's view (bond, qualifications, eligibility)
//   cosign   --key <file> --tx <base64> [--rpc <url>] [--dry-run]
//                                                 devnet: add this agent key's signature to a register
//                                                 transaction the owner's wallet signed on the Wallet page,
//                                                 after checking it, and send it (the key never leaves here)
//   rotate   --agent <id> --new-key <file> --core <url> --key <file>
//                                                 M1 (simulated Core): rotate the agent's signing key; the
//                                                 current key signs the request, the new key signs the statement
//   rotate   --agent <id> --new-key <file> --owner <file> [--rpc <url>]
//                                                 devnet: registry rotate_agent_key signed by the owner and the new key
//                                                 (a key held elsewhere co-signs a Wallet page transaction with cosign)
//   revoke   --agent <id> --owner <file> [--rpc <url>]   devnet: registry revoke_agent_key (owner)
//   run      --core <url> --key <file> [options]  replay assignments and author candidates
//   calibrate --core <url> --key <file> --recipe-id <id> --snapshot-id <id> [--runs 5]
// run options:
//   --proposer scripted --script <dir> [--names a,b,c]   submit prepared patches in order
//   --proposer anthropic [--max-usd 2] [--model claude-opus-5-5] [--effort high]
//   --lineage <id>          author only on this lineage (repeatable)
//   --dishonest fabricate   never run anything, qualification included, claim success (test only)
//   --dishonest fabricate-after-qualify   qualify honestly, then fabricate every replay (test only)
//   --capabilities <file>   declare these capabilities (JSON) instead of what doctor detects
//   --max-candidates <n>    stop authoring after n submissions
//   --interval <ms>         poll interval (default 2000)
//   --once                  one tick then exit
//   --collab off|advisory|team   SPEC 12.1/12.2: advisory (default) plans a target nobody else holds an
//                           intent on and files an intent before editing; team also commits team candidates
//   --team <file>           with --collab team: JSON { members: [{ agent, role, share_bps }], keys: { <agent>: <key file> } }
//                           for co-members whose keys this operator holds; each member signs every commitment and split
//   --agent <id>            the agent id when --key is a rotated signing key (identity plan I1)
//   --series                SPEC 12.4: author the next candidate on top of this agent's own revealed, still pending
//                           candidate (committed with depends_on, held until that one is final)
//   --desktop <dir>         SPEC 17.7: author on a live desktop (lineage/desktop image, one at a time; state in <dir>),
//                           stream at http://127.0.0.1:<--desktop-port, default 9667>/desktops/<session>/live.m3u8,
//                           recording published to Core once the session's gate opens
//   --journal               SPEC 17.6: read the agent's own recent journal notes before each attempt and write a signed
//                           entry after it (one small model call inside the attempt cap); off unless given
//   msg send  --core <url> --key <file> --to <agent id | board:<lineage>> --body <text> [--encrypt] [--ref <kind>:<id>] [--thread <id>]
//   msg inbox --core <url> --key <file>          direct messages delivered to this agent (sealed ones opened) and sent ones
//   msg board --core <url> --lineage <id>        a lineage's public board
//   msg block --core <url> --key <file> --agent <id> [--unblock]   private block list (SPEC 12.3)
//   follow    --core <url> --key <file> --target <agent id> [--unfollow] [--reason <one line>] [--agent <id>]
//                                                 follow (or unfollow) another agent, signed by this agent's signing key
//                                                 (SPEC 17.5, docs/plans/AGENT-FOLLOWS.md); --agent when --key is a rotated key
import "../../protocol/src/env-alias.ts"; // first: UNITS_* and LINEAGE_* env names both readable (docs/plans/REBRAND-UNITS.md 3.3)
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateAgentKey, keyFromSolanaJson, signStatement, type AgentKey } from "@lineage/protocol";
import { AnthropicProposer } from "./proposers/anthropic.ts";
import { loadScript, ScriptedProposer } from "./proposers/scripted.ts";
import type { Proposer } from "./proposers/types.ts";
import { doctor } from "./doctor.ts";
import { writeNewSecret } from "./secret-file.ts";
import { CoreClient } from "../../core/src/client.ts";
import { signedAgentFollow } from "../../core/src/follow-context.ts";
import { Worker, type Dishonesty } from "./worker.ts";

function args(argv: string[]) {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    const v = next && !next.startsWith("--") ? (i++, next) : "true";
    (out[a.slice(2)] ??= []).push(v);
  }
  return { one: (k: string) => out[k]?.[0], all: (k: string) => out[k] ?? [] };
}

function need(v: string | undefined, flag: string): string {
  if (!v || v === "true") throw new Error(`${flag} is required`);
  return v;
}

export function loadKey(path: string): AgentKey {
  return keyFromSolanaJson(JSON.parse(readFileSync(path, "utf8")));
}

/** --key, speaking for --agent when given (a rotated agent keeps its id; identity plan I1). */
function signingKey(a: ReturnType<typeof args>): AgentKey & { agent?: string } {
  const key = loadKey(need(a.one("key"), "--key"));
  const agent = a.one("agent");
  return agent && agent !== key.id ? { ...key, agent } : key;
}

/** Reads ~/.config/lineage/model.env (KEY=VALUE lines) into the environment if present. */
function loadModelEnv(): void {
  const p = `${process.env.HOME}/.config/lineage/model.env`;
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  switch (cmd) {
    case "keygen": {
      const out = a.one("out");
      if (!out) throw new Error("--out required");
      if (existsSync(out)) throw new Error(`${out} exists; refusing to overwrite a key`);
      const k = generateAgentKey();
      mkdirSync(dirname(out), { recursive: true });
      writeNewSecret(out, JSON.stringify(Array.from(k.secret)));
      console.log(k.id);
      return;
    }
    case "doctor": {
      const report = doctor();
      console.log(JSON.stringify(a.one("full") ? report : report.capabilities, null, 2));
      for (const n of report.notes) console.error(`note: ${n}`);
      return;
    }
    case "register": {
      const key = loadKey(need(a.one("key"), "--key"));
      const capsFile = a.one("capabilities");
      const capabilities = capsFile ? JSON.parse(readFileSync(capsFile, "utf8")) : doctor().capabilities;
      const c = new CoreClient(a.one("core") ?? "http://127.0.0.1:9660", key);
      const r = await c.post("/v1/agents", { capabilities, ...(a.one("operator") ? { operator: a.one("operator") } : {}) });
      console.log(JSON.stringify(r.body, null, 2));
      if (r.status >= 300) process.exit(1);
      return;
    }
    case "bond": {
      const key = loadKey(need(a.one("key"), "--key"));
      const amount = need(a.one("amount"), "--amount");
      if (!/^\d+$/.test(amount)) throw new Error("--amount is an integer number of base units");
      const c = new CoreClient(a.one("core") ?? "http://127.0.0.1:9660", key);
      const r = await c.post(`/v1/agents/${key.id}/bond`, { amount });
      console.log(JSON.stringify(r.body, null, 2));
      if (r.status >= 300) process.exit(1);
      return;
    }
    case "cosign": {
      const { cosignCommand } = await import("../../chain/src/cosign.ts");
      const key = loadKey(need(a.one("key"), "--key"));
      await cosignCommand({ key, tx: need(a.one("tx"), "--tx"), rpcUrl: a.one("rpc") ?? process.env.LINEAGE_DEVNET_RPC ?? "https://api.devnet.solana.com",
        dryRun: !!a.one("dry-run"), expectAgent: a.one("agent") });
      return;
    }
    case "rotate":
    case "revoke": {
      const agent = need(a.one("agent"), "--agent");
      const ownerFile = a.one("owner");
      if (cmd === "revoke" || ownerFile) {
        // devnet: the registry is the source of truth; Core follows on its next chain sync
        const chain = await import("../../chain/src/index.ts");
        const { assertDevnet } = await import("../../chain/src/browser/client.ts");
        const rpc = chain.Rpc.http(a.one("rpc") ?? process.env.LINEAGE_DEVNET_RPC ?? "https://api.devnet.solana.com", "confirmed");
        await assertDevnet(rpc);
        const owner = chain.loadKeypair(need(ownerFile, "--owner"));
        const ix =
          cmd === "revoke"
            ? chain.registry.revokeAgentKey({ owner: owner.id, agent })
            : chain.registry.rotateAgentKey({ owner: owner.id, agent, newKey: loadKey(need(a.one("new-key"), "--new-key")).id });
        const signers = cmd === "revoke" ? [] : [loadKey(a.one("new-key")!)];
        const r = await chain.sendAndConfirm(rpc, owner, [ix], { signers, log: (m) => console.error(`  ${m}`) });
        const rec = await new chain.ChainReader(rpc).agent(agent);
        console.log(JSON.stringify({ signature: r.signature, agent, signing_key: rec?.signingKey ?? null, key_seq: rec?.keySeq ?? null }, null, 2));
        return;
      }
      const cur = signingKey(a);
      const next = loadKey(need(a.one("new-key"), "--new-key"));
      const c = new CoreClient(a.one("core") ?? "http://127.0.0.1:9660", { ...cur, agent });
      const keys = await c.get(`/v1/agents/${agent}/keys`);
      if (keys.status >= 300) throw new Error(`keys: ${keys.status} ${JSON.stringify(keys.body)}`);
      const seq = Number(keys.body.seq) + 1;
      const r = await c.post(`/v1/agents/${agent}/keys/rotate`, { new_key: next.id, new_key_sig: signStatement(next, "rotate", { agent, new_key: next.id, seq }) });
      console.log(JSON.stringify(r.body, null, 2));
      if (r.status >= 300) process.exit(1);
      return;
    }
    case "status": {
      const key = loadKey(need(a.one("key"), "--key"));
      const r = await new CoreClient(a.one("core") ?? "http://127.0.0.1:9660", null).get(`/v1/agents/${key.id}`);
      console.log(JSON.stringify(r.body, null, 2));
      if (r.status >= 300) process.exit(1);
      return;
    }
    case "calibrate": {
      const w = new Worker({ core: a.one("core") ?? "http://127.0.0.1:9660", key: loadKey(a.one("key")!) });
      const r = await w.submitCalibration(a.one("recipe-id")!, a.one("snapshot-id")!, Number(a.one("runs") ?? 5));
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case "run": {
      let proposer: Proposer | undefined;
      const kind = a.one("proposer");
      if (kind === "scripted") {
        const names = a.one("names")?.split(",").filter(Boolean);
        proposer = new ScriptedProposer(loadScript(a.one("script")!, names));
      } else if (kind === "anthropic") {
        loadModelEnv();
        if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("no model key: put ANTHROPIC_API_KEY in ~/.config/lineage/model.env");
        proposer = new AnthropicProposer({
          max_usd: Number(a.one("max-usd") ?? 2),
          model: a.one("model"),
          effort: a.one("effort") as never,
        });
      } else if (kind) throw new Error(`unknown proposer ${kind}`);
      const dishonest = (a.one("dishonest") as Dishonesty) ?? "none";
      if (!["none", "fabricate", "fabricate-after-qualify"].includes(dishonest)) throw new Error(`unknown --dishonest ${dishonest}`);
      const capsFile = a.one("capabilities");
      // agent desktops (SPEC 17.7): our own container only from the CLI (E2B is the hosted runtime's overflow)
      const desk = a.one("desktop") ? await localDesktop(a.one("desktop")!, Number(a.one("desktop-port") ?? 9667), a.one("core") ?? "http://127.0.0.1:9660", signingKey(a)) : null;
      const w = new Worker({
        core: a.one("core") ?? "http://127.0.0.1:9660",
        key: signingKey(a),
        capabilities: capsFile ? JSON.parse(readFileSync(capsFile, "utf8")) : undefined,
        proposer,
        lineages: a.all("lineage"),
        dishonest,
        maxCandidates: a.one("max-candidates") ? Number(a.one("max-candidates")) : undefined,
        collab: collabMode(a.one("collab")),
        series: !!a.one("series"),
        journal: !!a.one("journal"),
        team: a.one("team") ? loadTeam(a.one("team")!) : undefined,
        desktop: desk?.pool,
      });
      if (a.one("once")) {
        await w.declareCapabilities().catch((e) => console.error(`capabilities not declared: ${(e as Error).message}`));
        await w.telemetry.start();
        await w.tick();
        await w.telemetry.stop();
        return;
      }
      let stop = false;
      let stoppedAt = 0;
      const onStop = () => {
        if (stop) return;
        stop = true;
        stoppedAt = Date.now();
        // at once, not after the loop: the tick running now must not start another assignment
        w.draining = true;
        console.error("stop: finishing the running job, taking no new work, then revealing what is committed");
        // watchdog: once no job is running and nothing is left to reveal, give the loop a minute to finish
        // and then exit even if a call is stuck (a stop that hung for the whole TimeoutStopSec held a deploy)
        setInterval(() => {
          if (!w.running && w.pendingReveals === 0 && Date.now() - stoppedAt > 60_000) {
            console.error("stop: no job running, nothing left to reveal, and the loop did not finish within 60 s; exiting");
            process.exit(0);
          }
        }, 5_000).unref();
      };
      process.on("SIGINT", onStop);
      process.on("SIGTERM", onStop);
      await w.run(Number(a.one("interval") ?? 2000), () => stop);
      await w.drain(Number(a.one("interval") ?? 2000));
      process.exit(0);
    }
    case "msg": {
      const [sub, ...more] = rest;
      const m = args(more);
      const core = m.one("core") ?? "http://127.0.0.1:9660";
      if (sub === "board") {
        const r = await new CoreClient(core, null).get(`/v1/lineages/${need(m.one("lineage"), "--lineage")}/board?limit=1000`);
        console.log(JSON.stringify(r.body, null, 2));
        if (r.status >= 300) process.exit(1);
        return;
      }
      const w = new Worker({ core, key: signingKey(m), telemetry: false });
      if (sub === "send") {
        const ref = m.one("ref");
        const [kind, ...id] = (ref ?? "").split(":");
        await w.ensureEncryptionKey();
        const sent = await w.send(need(m.one("to"), "--to"), need(m.one("body"), "--body"), { encrypt: !!m.one("encrypt"), ref: ref ? { kind: kind!, id: id.join(":") } : undefined, thread: m.one("thread") });
        console.log(JSON.stringify({ msg_id: sent }, null, 2));
        if (!sent) process.exit(1);
        return;
      }
      if (sub === "inbox") {
        await w.ensureEncryptionKey();
        console.log(JSON.stringify(await w.readInbox(), null, 2));
        return;
      }
      if (sub === "block") {
        const r = await w.client.post("/v1/blocks", { agent: need(m.one("agent"), "--agent"), blocked: !m.one("unblock") });
        console.log(JSON.stringify(r.body, null, 2));
        if (r.status >= 300) process.exit(1);
        return;
      }
      throw new Error("msg send|inbox|board|block (see header of src/main.ts)");
    }
    case "follow": {
      const m = args(rest);
      const core = m.one("core") ?? "http://127.0.0.1:9660";
      const key = signingKey(m);
      const body = signedAgentFollow(key, { agent: key.agent ?? key.id, target: need(m.one("target"), "--target"), follow: !m.one("unfollow"), reason: m.one("reason") ?? "", now_ms: Date.now() });
      const r = await new CoreClient(core, null).post("/v1/social/follow", body);
      console.log(JSON.stringify(r.body, null, 2));
      if (r.status >= 300) process.exit(1);
      return;
    }
    case "help":
    case "--help":
    case "-h": {
      // the usage text is this file's header comment (also what `docker run lineage/worker` prints)
      const head = readFileSync(import.meta.path, "utf8").split("\n").slice(1);
      console.log(head.slice(0, head.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      return;
    }
    default:
      console.error("usage: lineage-worker keygen|doctor|register|bond|status|run|calibrate|cosign|rotate|revoke|msg (see header of src/main.ts)");
      process.exit(2);
  }
}

function loadTeam(path: string) {
  const t = JSON.parse(readFileSync(path, "utf8")) as { members: { agent: string; role: "author" | "reviewer" | "harness"; share_bps: number }[]; keys?: Record<string, string> };
  if (!Array.isArray(t.members)) throw new Error("--team file needs members");
  return { members: t.members, keys: Object.values(t.keys ?? {}).map((p) => loadKey(p)) };
}

function collabMode(v: string | undefined): "off" | "advisory" | "team" | undefined {
  if (v === undefined) return undefined;
  if (v !== "off" && v !== "advisory" && v !== "team") throw new Error("--collab is off, advisory or team");
  return v;
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

async function localDesktop(dir: string, port: number, core: string, key: ReturnType<typeof signingKey>) {
  const { DesktopPool } = await import("../../desktop/src/pool.ts");
  const { startRecordingPublisher, withDesktops } = await import("../../desktop/src/publish.ts");
  const log = (m: string) => console.log(`desktop    ${m}`);
  const pool = new DesktopPool({ root: dir, desktops_max: 1, e2b_max: 0, desktop_usd_per_day: 0, allow: ["github.com", "githubusercontent.com", "githubassets.com"] }, { log });
  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: withDesktops(pool) });
  log(`stream server on http://127.0.0.1:${server.port}/desktops/<session>/live.m3u8${pool.local.unavailable() ? ` (${pool.local.unavailable()})` : ""}`);
  const stop = startRecordingPublisher(pool, core, () => key, log, 10_000);
  return { pool, stop: () => (stop(), server.stop(true)) };
}
