import { join } from "node:path";
import type { AgentKey } from "@lineage/protocol";
import { CoreClient } from "../../core/src/client.ts";
import { DesktopPool } from "../../desktop/src/pool.ts";
import { desktopHandler } from "../../desktop/src/serve.ts";
import type { RuntimeConfig } from "./config.ts";

// Agent desktops in the hosted runtime (SPEC 17.7): the slot pool (our server first, then E2B), the
// stream files for the gate, and the publisher that links each held recording once its session's gate
// is open.

export function desktopPool(cfg: RuntimeConfig, log: (m: string) => void): DesktopPool | null {
  const local = cfg.desktops_max ?? 0;
  const e2b = cfg.e2b_max ?? 0;
  if (local <= 0 && e2b <= 0) return null;
  const pool = new DesktopPool(
    {
      root: join(cfg.state_dir, "desktops"),
      desktops_max: local,
      e2b_max: e2b,
      desktop_usd_per_day: cfg.desktop_usd_per_day ?? 5,
      allow: cfg.desktop_allow ?? ["github.com", "githubusercontent.com", "githubassets.com"],
      e2b: cfg.e2b,
    },
    { log },
  );
  const s = pool.status();
  log(`desktops: ${local} on this server${pool.local.unavailable() ? ` (${pool.local.unavailable()})` : ""}, ${e2b} on E2B${pool.e2b.unavailable() ? ` (${pool.e2b.unavailable()})` : ""}; E2B spend today ${s.e2b.spent_today_usd.toFixed(4)} of ${s.e2b.cap_usd} USD`);
  return pool;
}

/** Every 30 s: held recordings whose session gate opened go to Core's blob store and the session. */
export function startRecordingPublisher(pool: DesktopPool, core: string, keyOf: (agent: string) => AgentKey | null, log: (m: string) => void, everyMs = 30_000): () => void {
  const anon = new CoreClient(core);
  const client = (agent: string) => {
    const k = keyOf(agent);
    return k ? new CoreClient(core, { ...k, agent }) : null;
  };
  let busy = false;
  const run = async () => {
    if (busy || !pool.pending().length) return;
    busy = true;
    try {
      await pool.publishPending({
        gateState: async (id) => {
          const r = await anon.get(`/v1/sessions/${id}?after=999999`);
          return r.status === 200 ? (r.body.state as string) : null;
        },
        putBlob: async (agent, sha, bytes) => (await client(agent)?.putBlob(sha, bytes))?.status ?? 0,
        link: async (agent, id, rec) => (await client(agent)?.post(`/v1/sessions/${id}/recording`, rec))?.status ?? 0,
      });
    } catch (e) {
      log(`desktops: publisher: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };
  const t = setInterval(() => void run(), everyMs);
  void run();
  return () => clearInterval(t);
}

/** Serves /desktops/* first, then whatever else shares the port (the bind endpoint). */
export function withDesktops(pool: DesktopPool | null, rest?: (req: Request) => Promise<Response>) {
  const desk = pool ? desktopHandler(pool.cfg.root) : null;
  return async (req: Request): Promise<Response> => {
    const r = desk ? await desk(req) : null;
    if (r) return r;
    return rest ? rest(req) : Response.json({ error: "not_found" }, { status: 404 });
  };
}
