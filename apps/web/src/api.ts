// Read-only client for Core through the dashboard proxy (/api/* maps to <core>/v1/*).

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public core?: string,
  ) {
    super(message);
  }
}

export async function get<T = any>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${path.replace(/^\/+/, "")}`, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new ApiError(0, "web_unreachable", `the dashboard server did not answer (${(e as Error).message})`);
  }
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? "http_error", body?.message ?? `HTTP ${res.status}`, body?.core);
  return body as T;
}

/**
 * Like get, for records whose absence is normal (provenance, soul): the server answers a 404 or 409
 * as 200 with `_miss`, so the browser logs no failed request; the miss is thrown as the same ApiError.
 */
export async function getOptional<T = any>(path: string): Promise<T> {
  const p = path.replace(/^\/+/, "");
  const body = await get<any>(`${p}${p.includes("?") ? "&" : "?"}optional=1`);
  if (body && typeof body === "object" && body._miss) throw new ApiError(body._miss.status, body._miss.error, body._miss.message);
  return body as T;
}

export interface Ev {
  id: number;
  at: number;
  type: string;
  data: any;
}

export async function recent(q: Record<string, string | number> = {}): Promise<{ upstream: string; last_id: number; events: Ev[] }> {
  const s = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]));
  const r = await fetch(`/live/recent?${s}`);
  return r.json();
}

// ------------------------------------------------------------------------------------------------
// shared network state used by formatters (config, lineage names)

export interface NetCfg {
  token_decimals: number;
  quorum: number;
  [k: string]: any;
}
export const state: { cfg: NetCfg | null; lineageNames: Map<string, string>; coreUrl: string | null } = {
  cfg: null,
  lineageNames: new Map(),
  coreUrl: null,
};

export async function loadConfig(): Promise<NetCfg> {
  if (state.cfg) return state.cfg;
  const c = await get<{ network: NetCfg }>("config");
  state.cfg = c.network;
  return state.cfg;
}

export async function loadLineageNames(force = false) {
  if (state.lineageNames.size && !force) return state.lineageNames;
  const ls = await get<any[]>("lineages");
  state.lineageNames = new Map(ls.map((l) => [l.lineage_id, l.recipe_name]));
  return state.lineageNames;
}
