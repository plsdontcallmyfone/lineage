#!/usr/bin/env bun
// Offchain audit (A2): fuzzes every Core route with hostile path params, query values and
// type-confused JSON bodies, signed by a registered agent and unsigned. A 500 is a finding: it is an
// unhandled exception (and used to echo the exception text). Runs on an ephemeral port in-process.
//   bun scripts/audit/fuzz-core.ts [--rounds 3]
import { buildRoutes } from "../../packages/core/src/http.ts";
import { linksOf } from "../../packages/core/src/links.ts";
import { upstreamOf } from "../../packages/core/src/upstream.ts";
import { makeAuthor, setup, submit, diff, expectOk } from "../../packages/core/test/helpers.ts";

const rounds = Number(process.argv.includes("--rounds") ? process.argv[process.argv.indexOf("--rounds") + 1] : 2);
const env = await setup({ verifiers: 2 });
// no network: GitHub and proof fetches answer 404 at once
const offline = async () => new Response("{}", { status: 404 });
upstreamOf(env.core).opts.fetch = offline;
linksOf(env.core).opts.fetch = offline;
const author = await makeAuthor(env);
const sub = await submit(env, author, diff("fuzz"));
const v = env.verifiers[0]!;

const ids = [env.lineage, env.gen0, sub.candidate_id, sub.commit_id, author.id, v.id, "x", "%00", "..%2F..%2Fetc", "%E0%A4%A", "a".repeat(3000), "-1", "1e309", "NaN", "__proto__", "constructor"];
const qvals = ["", "-1", "NaN", "1e309", "99999999999999999999", "0x10", "[]", "%00", "a'--", "1 OR 1=1", "__proto__"];
const bodies: unknown[] = [null, 1, "s", [], [1, 2], {}, { __proto__: { admin: true } }, { lineage_id: [], gen_id: {}, commit: 1, patch: 5, salt: null, amount: "-1", events: "x", statement: [], sig: {}, limit: -1 },
  { amount: "1e999" }, { amount: -5 }, { amount: "0x10" }, { amount: "99999999999999999999999999999" }, { events: [{ kind: "edit", path: {}, before: [] }] }, { events: Array(3).fill(null) }];

const routes = buildRoutes(env.core);
const fails: string[] = [];
let n = 0;
for (let r = 0; r < rounds; r++) {
  for (const rt of routes) {
    const src = rt.pattern.source.replace(/^\^|\$$/g, "");
    if (rt.method === "GET" && src === "\\/v1\\/events") continue; // SSE stream: never ends
    const nParams = (src.match(/\(\[\^\/\]\+\)/g) ?? []).length;
    const pick = () => ids[Math.floor(Math.random() * ids.length)]!;
    const path = src.replace(/\(\[\^\/\]\+\)/g, () => pick()).replace(/\\\//g, "/");
    void nParams;
    const qs = ["limit", "after", "since", "epoch", "status", "lineage", "agent", "gen", "path", "author", "state", "url", "prefix", "account", "kind", "repo"]
      .filter(() => Math.random() < 0.4).map((k) => `${k}=${encodeURIComponent(qvals[Math.floor(Math.random() * qvals.length)]!)}`).join("&");
    const full = qs ? `${path}?${qs}` : path;
    for (const who of [env.anon, author.c, env.admin.c] as any[]) {
      const body = rt.method === "GET" || rt.method === "DELETE" ? undefined : bodies[Math.floor(Math.random() * bodies.length)];
      let res: { status: number; body: any };
      try {
        res = await Promise.race([
          who.request(rt.method, full, body, { sign: who !== env.anon }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout 5s")), 5000)),
        ]);
      } catch (e) {
        fails.push(`${rt.method} ${full}: client threw ${(e as Error).message}`);
        continue;
      }
      n++;
      if (res.status >= 500 && res.body?.error !== "tree_unavailable") fails.push(`${rt.method} ${full} body=${JSON.stringify(body)?.slice(0, 120)}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    }
  }
}
env.close();
console.log(`requests ${n}, 5xx ${fails.length}`);
for (const f of [...new Set(fails)].slice(0, 80)) console.log(f);
process.exit(fails.length ? 1 : 0);
