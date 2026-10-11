// Protocol noun rename (docs/plans/REBRAND-UNITS.md 3.14): a repository's chain of verified
// generations is a "unit". The database and every hashed or signed payload keep `lineage_id`; the API
// adds the new names next to the old ones, so clients of either name keep working.
//
//   paths    /v1/units[...] and /v1/admin/units/... are served by the /v1/lineages handlers
//   queries  ?unit= and ?unit_id= are read as ?lineage= and ?lineage_id=
//   output   an object with `lineage_id` also gets `unit_id` (same value); one with `lineages` and no
//            `units` key also gets `units`
//
// Never touched: signed statements (an object with `sig`, or whose `kind` is a lineage-*/units-*
// statement kind), and the subtrees whose bytes are hashed or recomputed by verifiers (recipe,
// calibration, verdict, result, statement, record(s), leaf, doc, soul, episode(s), report(s)). Routes
// whose payloads are verification data are not rewritten at all (UNTOUCHED_ROUTES).

const SKIP_KEYS = new Set(["recipe", "calibration", "verdict", "result", "statement", "record", "records", "leaf", "leaves", "doc", "soul", "episode", "episodes", "report", "reports", "proof", "contribution", "contributions", "members", "commitment"]);
const UNTOUCHED_ROUTES = /^\/v1\/(epochs|replica|events|learnings|bounties|challenges|records|admin\/)|^\/v1\/agents\/[^/]+\/(journal|credential|genesis)/;

/** The path the router matches: /v1/units... answered by the /v1/lineages... routes. */
export function unitPath(path: string): string {
  if (path === "/v1/units" || path.startsWith("/v1/units/")) return "/v1/lineages" + path.slice("/v1/units".length);
  if (path.startsWith("/v1/admin/units/")) return "/v1/admin/lineages/" + path.slice("/v1/admin/units/".length);
  return path;
}

/** A copy of `url` whose path and query use the lineage names the handlers read. */
export function unitUrl(url: URL): URL {
  const u = new URL(url.href);
  u.pathname = unitPath(u.pathname);
  for (const [from, to] of [["unit", "lineage"], ["unit_id", "lineage_id"]] as const) {
    const v = u.searchParams.get(from);
    if (v !== null && !u.searchParams.has(to)) u.searchParams.set(to, v);
  }
  return u;
}

const isSigned = (o: Record<string, unknown>) =>
  "sig" in o || (typeof o.kind === "string" && /^(lineage|units)-/.test(o.kind) && "v" in o);

function add(x: unknown, depth: number): unknown {
  if (depth > 12 || x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) {
    for (const e of x) add(e, depth + 1);
    return x;
  }
  const o = x as Record<string, unknown>;
  if (isSigned(o)) return x;
  for (const [k, v] of Object.entries(o)) if (!SKIP_KEYS.has(k) && v && typeof v === "object") add(v, depth + 1);
  if (typeof o.lineage_id === "string" && !("unit_id" in o)) o.unit_id = o.lineage_id;
  if ("lineages" in o && !("units" in o) && (typeof o.lineages === "number" || Array.isArray(o.lineages))) o.units = o.lineages;
  return x;
}

/**
 * The JSON text of a response body with the unit names added (see the header), unless the route is
 * untouched. Works on a parsed copy: the handler's objects may be Core's own state and are never
 * changed.
 */
export function unitJson(path: string, body: unknown): string {
  const s = JSON.stringify(body);
  if (s === undefined || UNTOUCHED_ROUTES.test(path) || !s.includes('"lineage')) return s;
  return JSON.stringify(add(JSON.parse(s), 0));
}
