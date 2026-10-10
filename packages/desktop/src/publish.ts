import type { AgentKey } from "@lineage/protocol";
import { CoreClient } from "../../core/src/client.ts";
import type { DesktopPool } from "./pool.ts";
import { desktopHandler } from "./serve.ts";

// The recording publisher and the stream server for a process that runs desktops (the hosted runtime,
// or a worker with --desktop). SPEC 17.7.

/** Every 30 s: held recordings whose session gate opened go to Core's blob store and the session. */
export function startRecordingPublisher(pool: DesktopPool, core: string, keyOf: (agent: string) => AgentKey | null, log: (m: string) => void, everyMs = 30_000): () => void {
  // recordings off (the default): no publisher, so no POST /v1/sessions/:id/recording
  if (!pool.recording) return () => {};
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
