// Is the deployment this site serves answering yet? The Launch page asks before it mounts the wizard
// (pages/launch.ts). While a deployment is being opened (its programs are deployed but not initialized,
// or the site's services are restarting) the page shows a calm "opening" panel and asks again every few
// seconds; the first "live" answer mounts the wizard and the asking stops.
//
// Two cheap reads, both of which the wizard makes anyway:
//   GET /chain/config  the web server's network profile, deployed state and the RPC's genesis
//   GET /api/chain     Core's last chain read (packages/core/src/chain.ts): `read_at` is null until Core
//                      has read an initialized registry at its program id
// Only a positive sign of opening holds the wizard back. Anything else (a Core with no chain, mode
// "sim"; a server that predates one of the routes, 404) is "live": the wizard then says what it finds.

export type Probe = { ok: true; body: unknown } | { ok: false; status: number | null };
export type DeploymentState = "live" | "opening";

/** No answer worth reading: nothing came back (network error, timeout, not JSON), a 5xx, or a 429. */
const unanswered = (p: Probe): boolean => !p.ok && (p.status === null || p.status >= 500 || p.status === 429);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The registry program id /chain/config names (its profile), or null. */
export function registryOf(cfg: Probe): string | null {
  const programs = cfg.ok ? obj(obj(obj(cfg.body)?.profile)?.programs) : null;
  return typeof programs?.registry === "string" ? programs.registry : null;
}

/** `live` or `opening`, from the answers of GET /chain/config and GET /api/chain. */
export function deploymentState(cfg: Probe, chain: Probe): DeploymentState {
  // the web server or Core did not answer: the instance is restarting
  if (unanswered(cfg) || unanswered(chain)) return "opening";
  if (cfg.ok) {
    const c = obj(cfg.body);
    if (!c) return "opening";
    // the RPC behind the server has not answered yet
    if (c.genesis === null) return "opening";
    // a mainnet server with no deployed state yet
    if (obj(c.profile)?.network === "mainnet" && c.state === null) return "opening";
  }
  if (chain.ok) {
    const v = obj(chain.body);
    if (!v) return "opening";
    if (v.mode === "sim") return "live"; // a Core with no chain: nothing to wait for
    // Core has not read an initialized registry since it started
    if (v.read_at === null || v.read_at === undefined) return "opening";
    // Core still reads another deployment than the one the web server names
    const want = registryOf(cfg);
    if (want && typeof v.registry_program === "string" && v.registry_program !== want) return "opening";
    // the registry is initialized, the launch program's config is not
    if (v.launch === null) return "opening";
  }
  return "live";
}

/** The wait before check number `n` (1 is the first repeat): 2 s, growing by half each time, 10 s at most. */
export const nextDelayMs = (n: number): number => Math.min(10_000, Math.round(2_000 * 1.5 ** Math.max(0, n - 1)));

/**
 * A tab that mounted the wizard under one deployment and now sees the server name another holds the
 * earlier deployment's addresses in the wallet module: it has to load again before it builds anything.
 */
export const staleTab = (mountedRegistry: string | null, now: string | null): boolean => !!mountedRegistry && !!now && mountedRegistry !== now;

const TIMEOUT_MS = 6_000;
async function probe(url: string, f: typeof fetch): Promise<Probe> {
  try {
    const r = await f(url, { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, body: await r.json() };
  } catch {
    return { ok: false, status: null };
  }
}

/** One check: both reads at once. */
export async function checkDeployment(f: typeof fetch = fetch): Promise<{ state: DeploymentState; registry: string | null }> {
  const [cfg, chain] = await Promise.all([probe("/chain/config", f), probe("/api/chain", f)]);
  return { state: deploymentState(cfg, chain), registry: registryOf(cfg) };
}

/**
 * Checks again after nextDelayMs until the deployment is live, then resolves with the registry program
 * id of that answer. `alive` says whether anyone still waits (the page was left: resolves null, no
 * further request).
 */
export async function untilLive(alive: () => boolean, f: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<{ registry: string | null } | null> {
  for (let n = 1; ; n++) {
    await sleep(nextDelayMs(n));
    if (!alive()) return null;
    const c = await checkDeployment(f);
    if (!alive()) return null;
    if (c.state === "live") return { registry: c.registry };
  }
}
