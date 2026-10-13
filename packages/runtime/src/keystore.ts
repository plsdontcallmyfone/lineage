// The runtime's key store, shared by two processes (docs/plans/SEAMLESS-BIND.md section 9): the hosted
// runtime (state.ts StateStore.keyFor) and the bind service (bind-service.ts), which reserves and
// co-signs while the runtime drains or restarts. One file per agent, <state_dir>/keys/<agent>.json,
// mode 600 in a mode 700 directory, the same file whichever process asks first.
//
// The lock is the file's own creation: a new key is written whole to a private temporary file and then
// LINKED to its name. link(2) fails when the name exists, so exactly one writer wins and a reader never
// sees a half-written key; the loser reads the winner's key. Nothing is ever overwritten.
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateAgentKey, keyFromSolanaJson, type AgentKey } from "@units/protocol";
import { guardKey } from "../../chain/src/guard.ts";

const AGENT_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** <state_dir>/keys/<agent>.json; throws on anything that is not an agent id (ids become file names). */
export function keyFileIn(stateDir: string, agent: string): string {
  if (typeof agent !== "string" || !AGENT_ID.test(agent)) throw new Error(`not an agent id: ${JSON.stringify(String(agent).slice(0, 60))}`);
  return join(stateDir, "keys", `${agent}.json`);
}

const read = (file: string): AgentKey => keyFromSolanaJson(JSON.parse(readFileSync(file, "utf8")));

/**
 * The key in `file`, made once. Guarded from the moment it is in memory: it signs transactions only
 * through the transaction firewall (docs/plans/AGENT-WALLET-SAFETY.md section 3).
 */
export function keyOnce(file: string): AgentKey {
  if (existsSync(file)) {
    const k = read(file);
    guardKey(k.id);
    return k;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fresh = generateAgentKey();
  const tmp = `${file}.new-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(Array.from(fresh.secret)), { mode: 0o600, flag: "wx" });
  let k = fresh;
  try {
    linkSync(tmp, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // the other process made it first: its key is the agent's
    k = read(file);
  } finally {
    unlinkSync(tmp);
  }
  guardKey(k.id);
  return k;
}

/** The key in `file` when there is one (never makes one). */
export function keyIfAny(file: string): AgentKey | null {
  if (!existsSync(file)) return null;
  const k = read(file);
  guardKey(k.id);
  return k;
}

/** True when a key file can be created and removed in the store's directory (the bind service's health). */
export function keyStoreWritable(stateDir: string): boolean {
  const dir = join(stateDir, "keys");
  const probe = join(dir, `.probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(probe, "", { mode: 0o600 });
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
