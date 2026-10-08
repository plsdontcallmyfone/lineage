import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibId, recipeId, repoId, signMessage, snapshotId } from "../../core/src/protocol.ts";
import { upstreamOf } from "../../core/src/upstream.ts";
import { bare, CALIB, DEPS, diff, expectOk, honest, makeAuthor, makeVerifier, RECIPE, result, runReplays, submit, type Env } from "../../core/test/helpers.ts";
import { APP_IDENTITY, type CommitIdentity, type Identities } from "../src/chain.ts";
import { CoreReader } from "../src/coreapi.ts";
import { noreplyEmail } from "../src/git.ts";
import { mirrorOnce } from "../src/mirror.ts";
import { prCycle } from "../src/prbot.ts";
import { keypair, MockGitHub } from "./mockgh.ts";

// The PR bot end to end against a real Core and a mocked GitHub: mirror, eligibility, one PR,
// no second PR, merge detection and the bonus in a closed epoch.

let root: string;
let gh: MockGitHub;
let e: Env;
let ids: Identities;
let author: Awaited<ReturnType<typeof makeAuthor>>;
const URL_ = "https://github.com/maint/fx";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lineage-prbot-test-"));
  gh = new MockGitHub(join(root, "host"));
  const sha = gh.createRepo("maint/fx", { "src/lib.rs": "fn a() {\n    slow_a_0();\n}\n", ".lineage.yml": "lineage:\n  max_prs_per_week: 2\n  kinds: [perf]\n  contact: maint@example.invalid\n" });
  gh.users.push({ login: "maint", id: 1, token: "tok-m", signingKey: "ssh-ed25519 AAAAunused" });
  const k = keypair(root, "agent");
  gh.users.push({ login: "quillbot", id: 4242, token: "tok-a", signingKey: k.publicKey });

  const b = bare();
  b.clock.set(Date.now());
  const recipe = { ...RECIPE, repo: URL_, commit: sha };
  await expectOk(b.admin.c.post("/v1/admin/recipes", { recipe, recipe_id: recipeId(recipe) }));
  await expectOk(b.admin.c.post("/v1/admin/snapshots", { repo: URL_, commit: sha, deps_digest: DEPS }));
  const ref = await makeVerifier(b, { bond: 0n });
  await expectOk(b.admin.c.post(`/v1/admin/agents/${ref.id}/reference`, { reference: true }));
  const calib = { ...CALIB, recipe_id: recipeId(recipe), snapshot_id: snapshotId(repoId(URL_), sha, DEPS) };
  const lin = await expectOk(ref.c.post("/v1/calibrations", { calibration: calib, sig: signMessage(ref.key, calibId(calib.recipe_id, calib.snapshot_id, calib)) }));
  const verifiers = [await makeVerifier(b), await makeVerifier(b), await makeVerifier(b)];
  e = { ...b, verifiers, reference: ref, lineage: lin.lineage_id, gen0: lin.gen0 };
  upstreamOf(e.core).configure({ fetch: gh.fetch, githubApi: gh.api, githubToken: "tok-m" });
  author = await makeAuthor(e, { repo: URL_ });
  const a: CommitIdentity = { kind: "account", name: "quillbot", email: noreplyEmail(4242, "quillbot"), signingKey: k.privatePath, login: "quillbot", token: "tok-a" };
  ids = { forAgent: (x) => (x === author.id ? a : null), app: () => APP_IDENTITY };
});
afterAll(() => {
  e?.close();
  rmSync(root, { recursive: true, force: true });
});

const target = () => ({ apiBase: gh.api, gitBase: gh.root, fetch: gh.fetch, sleep: async () => {} });

describe("PR bot (W2)", () => {
  test("one PR per accepted generation of an opted-in repository; merge credits the bonus in a closed epoch", async () => {
    const c = await submit(e, author, diff("a"));
    await runReplays(e, c.candidate_id, honest(result({}, 800)));
    const gen = (await expectOk(e.anon.get(`/v1/candidates/${c.candidate_id}`))).gen_id as string;
    const core = new CoreReader(e.base);
    const mirror = await mirrorOnce({ core, identities: ids, ...target(), site: "https://site.mock" });
    expect(mirror.generations[0]).toMatchObject({ gen_id: gen, status: "published", verified: true, fork: "quillbot/fx" });

    const prs = await prCycle({ core, coreUrl: e.base, runtimeKey: e.admin.key, identities: ids, mirror, ...target() });
    expect(prs).toEqual([expect.objectContaining({ gen_id: gen, action: "opened", number: 1, head: `quillbot:lineage/pr-${gen.slice(0, 12)}` })]);
    expect(gh.pulls).toHaveLength(1);
    expect(gh.pulls[0]).toMatchObject({ repo: "maint/fx", base: "main", user: "quillbot", state: "open" });
    expect(gh.pulls[0]!.body).toContain(`Lineage-Gen: ${gen}`);
    expect((await expectOk(e.anon.get(`/v1/upstream/prs?gen=${gen}`)))[0]).toMatchObject({ number: 1, state: "open", opened_by: "quillbot" });

    // a second cycle opens nothing: the recorded PR ends the attempt
    const again = await prCycle({ core, coreUrl: e.base, runtimeKey: e.admin.key, identities: ids, mirror: await mirrorOnce({ core, identities: ids, ...target() }), ...target() });
    expect(again[0]).toMatchObject({ action: "none", reason: "pr_exists", number: 1 });
    expect(gh.pulls).toHaveLength(1);
    // the bot never commented, reviewed, edited or reopened anything
    expect(gh.calls.filter((x) => x.method !== "GET").map((x) => `${x.method} ${x.path}`).sort()).toEqual(["POST /repos/maint/fx/forks", "POST /repos/maint/fx/pulls"]);

    // the maintainer merges; Core's scan matches the hunks and credits the bonus
    const epoch = (await expectOk(e.anon.get("/v1/epochs/current"))).n;
    gh.mergePull(1);
    const scan = await expectOk(e.admin.c.post("/v1/admin/upstream/scan", {}));
    expect(scan.scanned[0]).toMatchObject({ merged: [gen], prs_updated: 1 });
    const closed = await expectOk(e.admin.c.post("/v1/admin/epochs/close", {}));
    expect(closed.n).toBe(epoch);
    const units = e.core.db.query<{ u: number }, [string]>("SELECT SUM(units) AS u FROM units WHERE agent_id = ? AND voided = 0 AND kind = 'author'").get(author.id)!.u;
    expect(closed.payouts.find((p: any) => p.agent === author.id).units).toBeCloseTo(units + e.cfg.upstream_bonus, 9);
  });
});
