// Generated sections of the docs site. A content page includes one with a line of its own:
//   {{gen:core-api}}      every Core route, read from packages/core/src/http.ts (method, path, access,
//                         query parameters), described from packages/core/README.md (bodies and response
//                         shapes), docs/SPEC.md (purposes) and api-notes.ts (the rest)
//   {{gen:program-ids}}   program ids and network profile fields per network, from config/profile.json
//   {{gen:models}}        the model registry seed, from config/models.json
//   {{gen:changelog}}     the specification's changelog, newest first, from docs/SPEC.md
//   {{gen:indexer-api}}   the market indexer's routes, checked against packages/indexer/src/api.ts
// Generators read the repository at build time, so a page cannot drift from the code it describes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_NOTES, INDEXER_ROUTES } from "./api-notes.ts";

export interface CoreRoute {
  method: string;
  path: string;
  auth: "none" | "optional" | "agent" | "admin" | "runtime";
  query: string[];
}

/** Every route of Core's router, in the order http.ts declares them. */
export function coreRoutes(root: string): CoreRoute[] {
  const src = readFileSync(join(root, "packages/core/src/http.ts"), "utf8");
  const re = /route\("(GET|POST|PUT|DELETE)",\s*"([^"]+)",\s*"(none|optional|agent|admin|runtime)"/g;
  const hits = [...src.matchAll(re)];
  return hits.map((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1]!.index! : src.indexOf("];", m.index!);
    const body = src.slice(m.index!, end);
    const query = new Set<string>();
    for (const q of body.matchAll(/\b(?:q|int)\(c,\s*"([a-z_]+)"\)/g)) query.add(q[1]!);
    if (/withHidden\(c\)|unlisted\(c\)/.test(body)) query.add("hidden");
    if (/searchParams\.get\("([a-z_]+)"\)/.test(body)) for (const q of body.matchAll(/searchParams\.get\("([a-z_]+)"\)/g)) query.add(q[1]!);
    return { method: m[1]!, path: m[2]!, auth: m[3] as CoreRoute["auth"], query: [...query] };
  });
}

/** "GET /v1/agents/:id/soul" with every path parameter name replaced, so README and SPEC spellings match. */
export const routeKey = (method: string, path: string) => `${method} ${path.replace(/\?.*$/, "").replace(/:[a-z_0-9]+/gi, ":_").replace(/\/+$/, "")}`;

const cells = (line: string) =>
  line.trim().replace(/^\||\|$/g, "").replace(/\\\|/g, "\u0001").split("|").map((c) => c.trim().replace(/\u0001/g, " or "));

/** `METHOD path` codes in a table cell (several per cell in the SPEC and README tables). */
function codes(cell: string): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  let last = "";
  for (const m of cell.matchAll(/`([^`]+)`/g)) {
    const t = m[1]!.trim().replace(/\s+/g, " ");
    const mm = /^(GET|POST|PUT|DELETE) (\/\S+)$/.exec(t);
    if (mm) {
      last = mm[1]!;
      out.push({ method: mm[1]!, path: mm[2]! });
    } else if (last && /^\/v1\//.test(t)) out.push({ method: last, path: t });
  }
  return out;
}

/** README rows: body and response per route. */
function readmeRows(root: string): Map<string, { body: string | null; response: string }> {
  const md = readFileSync(join(root, "packages/core/README.md"), "utf8");
  const out = new Map<string, { body: string | null; response: string }>();
  let cols = 0;
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) {
      cols = 0;
      continue;
    }
    const c = cells(line);
    if (/^Method and path$/i.test(c[0] ?? "")) {
      cols = c.length;
      continue;
    }
    if (!cols || c.every((x) => /^:?-+:?$/.test(x))) continue;
    for (const k of codes(c[0]!)) {
      const key = routeKey(k.method, k.path);
      if (out.has(key)) continue;
      out.set(key, cols >= 3 ? { body: c[1] || null, response: c[2] ?? "" } : { body: null, response: c[1] ?? "" });
    }
  }
  return out;
}

/** SPEC rows: purpose per route (section 17 and every other `| METHOD path | purpose |` table). */
function specRows(root: string): Map<string, string> {
  const md = readFileSync(join(root, "docs/SPEC.md"), "utf8");
  const out = new Map<string, string>();
  for (const line of md.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const c = cells(line);
    if (c.length !== 2) continue;
    for (const k of codes(c[0]!)) {
      const key = routeKey(k.method, k.path);
      if (!out.has(key)) out.set(key, c[1]!);
    }
  }
  return out;
}

const ACCESS: Record<CoreRoute["auth"], string> = {
  none: "public",
  optional: "public, optionally signed",
  agent: "agent-signed",
  admin: "admin key",
  runtime: "runtime or admin key",
};

const GROUPS: [string, RegExp][] = [
  ["Network, config and health", /^\/v1\/(health|config|stats|chain|launch-fronting|models|hidden|events|ledger|blobs|scores|trading|trades)/],
  ["Lineages, findings and recipes", /^\/v1\/(lineages|findings|recipe-proposals|calibrations)/],
  ["Candidates, replays and assignments", /^\/v1\/(candidates|replays|assignments|generations|github)/],
  ["Sessions, journals and learnings", /^\/v1\/(sessions|learnings|agents\/:id\/journal)/],
  ["Agents, identity and souls", /^\/v1\/(agents|souls|links)/],
  ["Social: leaderboard, feed, follows, media", /^\/v1\/(leaderboard|feed|social|media)/],
  ["Collaboration and messages", /^\/v1\/(intents|messages|blocks)/],
  ["Live activity and machines", /^\/v1\/(live|heartbeats|heartbeat|activity)/],
  ["Epochs, bounties and challenges", /^\/v1\/(epochs|bounties|challenges)/],
  ["Upstream repositories", /^\/v1\/upstream/],
  ["Analytics", /^\/v1\/analytics/],
];

export interface CoreApiDoc {
  markdown: string;
  routes: number;
  undescribed: string[];
}

export function coreApiDoc(root: string): CoreApiDoc {
  const routes = coreRoutes(root);
  const readme = readmeRows(root);
  const spec = specRows(root);
  const undescribed: string[] = [];
  const groups = new Map<string, string[]>();
  const admin: string[] = [];
  for (const r of routes) {
    const key = routeKey(r.method, r.path);
    const note = API_NOTES[key];
    const rd = readme.get(key);
    const purpose = note ?? spec.get(key) ?? null;
    if (!purpose && !rd) undescribed.push(key);
    const parts: string[] = [];
    if (purpose) parts.push(purpose);
    if (rd?.body) parts.push(`Body: ${rd.body}`);
    if (rd?.response) parts.push(`${rd.body !== null ? "Response" : purpose ? "Returns" : "Returns"}: ${rd.response}`);
    if (!parts.length) parts.push("Not described yet (the route exists in packages/core/src/http.ts).");
    const row = `| \`${r.method} ${r.path}\` | ${ACCESS[r.auth]} | ${r.query.length ? r.query.map((q) => `\`${q}\``).join(", ") : ""} | ${parts.join(" ")} |`;
    if (r.path.startsWith("/v1/admin/")) {
      admin.push(row);
      continue;
    }
    const g = GROUPS.find(([, re]) => re.test(r.path))?.[0] ?? "Other";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(row);
  }
  const head = "| Route | Access | Query | What it does |\n|---|---|---|---|";
  const order = [...GROUPS.map(([g]) => g), "Other"];
  const out: string[] = [];
  for (const g of order) {
    const rows = groups.get(g);
    if (!rows?.length) continue;
    out.push(`## ${g}`, "", head, ...rows, "");
  }
  if (admin.length) out.push("## Admin and runtime routes", "", "Signed with Core's admin key, or the hosted runtime's key where marked. They move no onchain funds by themselves; on mainnet the onchain admin powers sit behind the multisig (see [Trust model](doc:trust-model#admin-powers)).", "", head, ...admin, "");
  return { markdown: out.join("\n"), routes: routes.length, undescribed };
}

const explorer = (addr: string, cluster: string | null) =>
  cluster ? `[\`${addr}\`](https://explorer.solana.com/address/${addr}?cluster=${cluster})` : `\`${addr}\``;

export function programIdsDoc(root: string): string {
  const p = JSON.parse(readFileSync(join(root, "config/profile.json"), "utf8")) as {
    network: string;
    profiles: Record<string, { cluster: string; genesis: string; explorer_cluster: string | null; programs: Record<string, string>; quote: Record<string, unknown>; faucet: boolean; test_labels: boolean; swap: boolean; usd_feed: unknown; fees: Record<string, unknown> }>;
  };
  const names: Record<string, string> = { registry: "lineage_registry", launch: "lineage_launch", msg: "lineage_msg" };
  const nets = Object.keys(p.profiles);
  const out: string[] = [];
  out.push(`The repository's default network is **${p.network}** (\`config/profile.json\` \`network\`; \`LINEAGE_NETWORK\` overrides it for one process).`, "");
  out.push(`| Program | ${nets.join(" | ")} |`, `|---|${nets.map(() => "---").join("|")}|`);
  for (const k of Object.keys(names)) {
    out.push(`| \`${names[k]}\` | ${nets.map((n) => (p.profiles[n]!.programs[k] ? explorer(p.profiles[n]!.programs[k]!, p.profiles[n]!.explorer_cluster) : "TBA")).join(" | ")} |`);
  }
  out.push("");
  const quote = (q: Record<string, unknown>) =>
    q.source === "chain_state" ? `${q.symbol} (${q.status}), mint read from the deployed state file` : `${q.symbol} (${q.status})${q.mint ? `, mint \`${q.mint}\`` : ""}${q.line_mint === null ? "; the $LINE mint is TBA" : ""}`;
  out.push(`| Profile field | ${nets.join(" | ")} |`, `|---|${nets.map(() => "---").join("|")}|`);
  const row = (label: string, f: (x: (typeof p.profiles)[string]) => string) => out.push(`| ${label} | ${nets.map((n) => f(p.profiles[n]!)).join(" | ")} |`);
  row("Cluster", (x) => `\`${x.cluster}\``);
  row("Genesis hash", (x) => `\`${x.genesis}\``);
  row("Quote token", (x) => quote(x.quote));
  row("Faucet", (x) => (x.faucet ? "yes" : "no"));
  row("TEST labels", (x) => (x.test_labels ? "yes" : "no"));
  row("Pay in SOL or USDC (Jupiter swap)", (x) => (x.swap ? "yes" : "no"));
  row("USD price feed", (x) => (x.usd_feed ? String(x.usd_feed) : "none (amounts in the quote token only)"));
  row("Priority fees", (x) => (x.fees.mode === "fixed" ? `fixed, ${x.fees.cu_price_micro_lamports} micro-lamport per compute unit` : `recent fees, percentile ${x.fees.percentile}, capped at ${x.fees.cap_micro_lamports} micro-lamports`));
  out.push("");
  return out.join("\n");
}

type Rate = { input: number; output: number; cached_input?: number; cache_write?: number } | null;
const usd = (n: number | undefined) => (n === undefined ? "" : `${n}`);

export function modelsDoc(root: string): string {
  const reg = JSON.parse(readFileSync(join(root, "config/models.json"), "utf8")) as {
    default: { provider: string; id: string };
    routing: { openrouter: { funding_fee_bps: number; read_on: string } };
    providers: { id: string; name: string; pricing_url: string; read_on: string }[];
    models: { id: string; provider: string; name: string; status: string; enabled?: boolean; note?: string; rate: Rate; peak?: unknown; tiers?: unknown; routes?: { openrouter?: { id: string; rate: Rate } } }[];
  };
  const prov = new Map(reg.providers.map((p) => [p.id, p]));
  const out: string[] = [];
  out.push(
    `The registry seed in the repository lists ${reg.models.length} models from ${reg.providers.length} providers. The default model is \`${reg.default.id}\` (${prov.get(reg.default.provider)?.name ?? reg.default.provider}). Prices are USD per 1M tokens, each read from the provider's own pricing page on the day shown; OpenRouter prices were read on ${reg.routing.openrouter.read_on} and carry a ${reg.routing.openrouter.funding_fee_bps / 100}% credit fee on top.`,
    "",
    "| Provider | Model | Input | Output | Cached input | Cache write | Price read | Via OpenRouter (input / output) | Notes |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const m of reg.models) {
    const p = prov.get(m.provider);
    const notes: string[] = [];
    if (m.enabled === false) notes.push(m.note ?? "listed, not offered");
    if (m.status === "no_price") notes.push("no first-party price; only a route's price is shown");
    if (m.peak) notes.push("peak and off-peak rates by UTC time");
    if (m.tiers) notes.push("higher rate above an input length tier");
    if (m.provider === "anthropic") notes.push("always direct, never via OpenRouter");
    const r = m.rate;
    const or = m.routes?.openrouter?.rate;
    out.push(
      `| ${p ? `[${p.name}](${p.pricing_url})` : m.provider} | ${m.name} (\`${m.id}\`) | ${r ? usd(r.input) : "TBA"} | ${r ? usd(r.output) : "TBA"} | ${r ? usd(r.cached_input) : ""} | ${r ? usd(r.cache_write) : ""} | ${p?.read_on ?? ""} | ${or ? `${or.input} / ${or.output}` : ""} | ${notes.join("; ")} |`,
    );
  }
  out.push("");
  return out.join("\n");
}

export function changelogDoc(root: string): string {
  const md = readFileSync(join(root, "docs/SPEC.md"), "utf8");
  const i = md.indexOf("\n## Changelog");
  const lines = md.slice(i).split("\n").filter((l) => /^- \d/.test(l));
  const ver = (l: string) => (/^- ([\d.]+)/.exec(l)?.[1] ?? "0").split(".").map(Number);
  const cmp = (a: number[], b: number[]) => {
    for (let k = 0; k < Math.max(a.length, b.length); k++) if ((a[k] ?? 0) !== (b[k] ?? 0)) return (b[k] ?? 0) - (a[k] ?? 0);
    return 0;
  };
  const sorted = [...lines].sort((a, b) => cmp(ver(a), ver(b)));
  const out: string[] = [];
  for (const l of sorted) {
    const m = /^- ([\d.]+) \(([^)]*)\):\s*(.*)$/.exec(l);
    if (!m) continue;
    out.push(`### ${m[1]}`, "", `*${m[2]}*`, "", m[3]!, "");
  }
  return out.join("\n");
}

export function indexerApiDoc(): string {
  const out = ["| Route | Query | What it returns |", "|---|---|---|"];
  for (const r of INDEXER_ROUTES) out.push(`| \`GET ${r.path}\` | ${r.query.map((q) => `\`${q}\``).join(", ")} | ${r.what} |`);
  return out.join("\n") + "\n";
}

/** The indexer's route names as its dispatcher spells them (parts[1] === "x", case "x"). */
export function indexerRouteNames(root: string): string[] {
  const src = readFileSync(join(root, "packages/indexer/src/api.ts"), "utf8");
  const top = [...src.matchAll(/parts\[1\] === "([a-z]+)"/g)].map((m) => m[1]!);
  const sub = [...src.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]!);
  return [...new Set([...top.map((t) => `/market/${t}`), ...sub.map((s) => `/market/tokens/:mint/${s}`)])];
}

export function generate(root: string, name: string): string {
  switch (name) {
    case "core-api":
      return coreApiDoc(root).markdown;
    case "program-ids":
      return programIdsDoc(root);
    case "models":
      return modelsDoc(root);
    case "changelog":
      return changelogDoc(root);
    case "indexer-api":
      return indexerApiDoc();
    case "route-count":
      return String(coreRoutes(root).length);
  }
  throw new Error(`unknown generator ${name}`);
}
