import { afterEach, describe, expect, test } from "bun:test";
import { accountDisc, claimPdas, LAUNCH_PROGRAM_ID, Rpc, Writer, type Address } from "@units/chain";
import { bountyOwnersOf } from "../src/bounty-owners.ts";
import { feeClaimDigest, feeClaimsOf, feeClaimStatement } from "../src/fee-claims.ts";
import { openBountiesOf } from "../src/open-bounties.ts";
import { generateAgentKey, hashJson, signMessage, type AgentKey } from "../src/protocol.ts";
import { startMockGithub, type MockGithub } from "../../../scripts/claims/mock-github.ts";
import { expectOk, setup, type Env } from "./helpers.ts";

// "Posted by an owner of owner/repo" (docs/plans/OPEN-BOUNTIES.md 9): the mark comes from the fee
// claims' own proof (a GitHub sign-in that asked GitHub about the repository, and the wallet's signed
// statement), either stored by the direct proof or read from a claim's attestation. It is never set
// by anything a poster types, it lapses, and it is computed from Core's records at every read.

let env: Env | null = null;
let gh: MockGithub | null = null;
afterEach(() => {
  env?.close();
  env = null;
  gh?.stop();
  gh = null;
  for (const k of ["UNITS_FEATURE_GITHUB_FEE_CLAIMS", "UNITS_FEATURE_OPEN_BOUNTIES", "UNITS_FEATURE_BOUNTIES"]) delete process.env[k];
});

const MONA = { id: 2, login: "Mona" };
const OCTO = { id: 583231, login: "octocat" };
const EXAMPLE = { id: 9919, login: "example", type: "Organization" as const };
// the repository of the test unit (helpers.ts RECIPE.repo): Mona has admin, octocat only pushes
const FX = { id: 7770001, full_name: "example/fx", admins: ["Mona"], members: ["octocat"] };
const OTHER = { id: 7770002, full_name: "example/other", admins: ["octocat"] };
const ZERO = "11111111111111111111111111111111";
const LINE = generateAgentKey().id;
const CONFIG = { program: "Prog" + "1".repeat(28), admin: "A" + "1".repeat(31), pendingAdmin: null, mint: "M" + "1".repeat(31), tokenProgram: "T" + "1".repeat(31), launchProgram: "L" + "1".repeat(31), opened: 3n,
  settings: { minAmount: 1_000_000n, minTtlS: 3600, maxTtlS: 2_592_000, refundGraceS: 7200, contestS: 1800, feeBps: 0, paused: false } };

function fakeChain(accounts: Map<Address, { owner: string; data: Uint8Array }>) {
  const raw = (a: Address) => {
    const x = accounts.get(a);
    return x ? { lamports: 1, owner: x.owner, executable: false, data: [Buffer.from(x.data).toString("base64"), "base64"] as [string, string] } : null;
  };
  return new Rpc(async (method, params) => {
    if (method === "getAccountInfo") return { value: raw(params[0] as Address) };
    if (method === "getMultipleAccounts") return { value: (params[0] as Address[]).map(raw) };
    if (method === "getProgramAccounts") {
      const filters = ((params[1] as { filters: { memcmp?: { offset: number; bytes: string } }[] }).filters ?? []).filter((f) => f.memcmp).map((f) => f.memcmp!);
      return [...accounts].filter(([, v]) => v.owner === params[0] && filters.every((f) => Buffer.from(v.data.subarray(f.offset)).subarray(0, Buffer.from(f.bytes, "base64").length).equals(Buffer.from(f.bytes, "base64"))))
        .map(([pubkey]) => ({ pubkey, account: raw(pubkey)! }));
    }
    throw new Error(`fake chain: ${method}`);
  });
}
const acct = (name: string, w: Writer) => ({ owner: LAUNCH_PROGRAM_ID, data: new Writer().bytes(accountDisc(name)).bytes(w.done()).done() });
function tokenAccount(amount: bigint) {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return { owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data: d };
}

/** A Core with one unit on github.com/example/fx, fee claims on against the mock GitHub, and (optionally) an agent whose fee route names that repository. */
async function world(o: { routed?: boolean } = {}) {
  process.env.UNITS_FEATURE_GITHUB_FEE_CLAIMS = "1";
  process.env.UNITS_FEATURE_OPEN_BOUNTIES = "1";
  process.env.UNITS_FEATURE_BOUNTIES = "1";
  const e = (env = await setup({ verifiers: 2 }));
  gh = startMockGithub({ port: 0, users: [MONA, OCTO, EXAMPLE], repos: [FX, OTHER], clientId: "cid", clientSecret: "csecret" });
  const attestor = generateAgentKey();
  const accounts = new Map<Address, { owner: string; data: Uint8Array }>();
  accounts.set(claimPdas.config(), acct("ClaimConfig", new Writer().address(attestor.id).u16(2000).u16(2000).i64(600).i64(120).i64(600).bool(false).u8(255)));
  if (o.routed) {
    const agent = generateAgentKey().id;
    accounts.set(claimPdas.feeRoute(agent), acct("FeeRoute", new Writer().address(agent).u64(FX.id).u16(2000).i64(1_900_000_000).u64(0).u16(0).i64(0).u64(777).u64(777).u32(0).u8(254)));
    accounts.set(generateAgentKey().id, acct("AgentLaunch", new Writer().address(agent).address(generateAgentKey().id).address(generateAgentKey().id).fixed32("ab".repeat(32)).string("https://github.com/example/fx")));
    accounts.set(claimPdas.escrow(FX.id), acct("ClaimEscrow", new Writer().u64(FX.id).address(ZERO).address(ZERO).i64(0).u64(777).u64(0).u64(0n).u8(255).u8(254)));
    accounts.set(claimPdas.vault(FX.id), tokenAccount(777n));
  }
  feeClaimsOf(e.core).configure({
    githubApi: gh.url, rpc: fakeChain(accounts), lineMint: LINE, attestor,
    oauth: { clientId: "cid", clientSecret: "csecret", authorizeUrl: `${gh.url}/login/oauth/authorize`, tokenUrl: `${gh.url}/login/oauth/access_token`,
      redirectUri: `${e.base}/v1/fee-claims/oauth/callback`, scope: "", name: "mock" },
    claimPage: "http://127.0.0.1:9661/claim",
  });
  return e;
}
const get = async (e: Env, path: string) => {
  const r = await fetch(e.base + path, { redirect: "manual" });
  return { status: r.status, body: (r.status === 302 ? null : await r.json().catch(() => null)) as any, location: r.headers.get("location") };
};
const post = async (e: Env, path: string, body: unknown) => {
  const r = await fetch(e.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
/** The mock sign-in as a browser follows it; `returnTo` is where the page asked to come back to. */
async function signIn(e: Env, login: string, repo: string | null, returnTo = "/bounties"): Promise<{ session: string; page: URL }> {
  const start = await get(e, `/v1/fee-claims/oauth/start?return_to=${encodeURIComponent(returnTo)}${repo ? `&repo=${repo}` : ""}`);
  expect(start.status).toBe(302);
  const authorize = new URL(start.location!);
  authorize.searchParams.set("login", login);
  const a = await fetch(authorize, { redirect: "manual" });
  const cb = new URL(a.headers.get("location")!);
  const back = await get(e, cb.pathname + cb.search);
  expect(back.status).toBe(302);
  const page = new URL(back.location!);
  return { session: page.hash.replace(/^#session=/, ""), page };
}
async function bound(e: Env, login: string, repo: string | null, wallet: AgentKey = generateAgentKey()) {
  const { session } = await signIn(e, login, repo);
  const statement = feeClaimStatement(login, wallet.id, e.clock.now() / 1000);
  const r = await post(e, "/v1/fee-claims/wallet", { session, statement, sig: signMessage(wallet, feeClaimDigest(statement)) });
  expect([r.status, r.body.wallet]).toEqual([200, wallet.id]);
  return { session: r.body.session as string, wallet };
}
/** Mirrors escrow bounties of `funders` on the test unit and returns the board's rows by funder. */
async function boardFor(e: Env, funders: string[], terms: Record<string, unknown> | null = null) {
  openBountiesOf(e.core).sync(CONFIG as never, funders.map((funder, i) => ({
    address: `Escr${i + 1}` + "1".repeat(39), funder, bountyId: BigInt(i + 1), amount: 5_000_000n, feeBps: 0, termsDigest: terms ? hashJson(terms) : "00".repeat(32), lineageId: e.lineage, targetDigest: hashJson("ir"),
    minImprovementBps: 1000, minEpoch: 0n, epochsPostedAtOpen: 0n, deadline: 4_000_000_000n, createdAt: 0n, refundAfter: 4_000_007_200n, contestS: 1800, status: "open" as const, winner: null, winHeight: 0n,
    winEpoch: 0n, winGenId: null, winImprovementBps: 0n, winLeaf: null, claimedAt: 0n, contestUntil: 0n, paid: 0n, feePaid: 0n, closedAt: 0n })) as never);
  const board = await expectOk(e.anon.get("/v1/bounties/board"));
  return new Map<string, any>((board.bounties as any[]).map((b) => [b.funder, b]));
}

describe("the owner mark", () => {
  test("the direct proof: a GitHub sign-in that asked about the repository, the wallet's statement, then the mark on the board and the bounty", async () => {
    const e = await world();
    expect((await get(e, "/v1/bounties/owner-proof")).body).toEqual({ available: true, provider: "mock", ttl_s: 2_592_000 });
    // the sign-in comes back to the Bounties page it started from, with the repository named
    const s = await signIn(e, "Mona", "example/fx");
    expect([s.page.pathname, s.page.searchParams.get("repo")]).toEqual(["/bounties", "example/fx"]);
    expect((await get(e, "/v1/fee-claims/oauth/start?return_to=/bounties/" + "B".repeat(44))).status).toBe(302);
    expect((await get(e, "/v1/fee-claims/oauth/start?return_to=/launch")).body.error).toBe("bad_return_to");
    // no wallet statement yet: no proof
    expect((await post(e, "/v1/bounties/owner-proof", { session: s.session, repo_id: FX.id })).body.error).toBe("no_wallet");
    const mona = await bound(e, "Mona", "example/fx");
    const stranger = generateAgentKey().id;
    expect((await boardFor(e, [mona.wallet.id, stranger])).get(mona.wallet.id).posted_by_owner).toBeNull();
    const proof = await post(e, "/v1/bounties/owner-proof", { session: mona.session, repo_id: FX.id });
    expect(proof.status).toBe(200);
    expect(proof.body).toMatchObject({ verified: true, repository: "example/fx", login: null, source: "proof" });
    expect(proof.body.expires_at - proof.body.proved_at).toBe(2_592_000_000);
    const rows = await boardFor(e, [mona.wallet.id, stranger]);
    expect(rows.get(mona.wallet.id).posted_by_owner).toMatchObject({ verified: true, repository: "example/fx", login: null });
    expect(rows.get(stranger).posted_by_owner).toBeNull();
    // the login only when the person says so; the account id is never served
    const shown = await post(e, "/v1/bounties/owner-proof", { session: mona.session, repo_id: FX.id, show_login: true });
    expect(shown.body.login).toBe("Mona");
    const view = await expectOk(e.anon.get(`/v1/bounties/${rows.get(mona.wallet.id).bounty_id}/view`));
    expect(view.bounty.posted_by_owner).toMatchObject({ verified: true, login: "Mona", repository: "example/fx" });
    expect(JSON.stringify(view)).not.toContain("github_id");
    const pub = await get(e, `/v1/bounties/owners?repo=https://github.com/example/fx&wallet=${mona.wallet.id}`);
    expect(pub.body).toMatchObject({ verified: true, login: "Mona" });
    expect((await get(e, `/v1/bounties/owners?repo=example/fx&wallet=${stranger}`)).body).toMatchObject({ verified: false, login: null });
    // taken back by the same person
    expect((await post(e, "/v1/bounties/owner-proof/forget", { session: mona.session, repo_id: FX.id })).body.removed).toBe(true);
    expect((await get(e, `/v1/bounties/owners?repo=example/fx&wallet=${mona.wallet.id}`)).body.verified).toBe(false);
  });

  test("no admin, another repository, no session: no mark", async () => {
    const e = await world();
    // octocat can push to example/fx but GitHub does not say admin
    const octo = await bound(e, "octocat", "example/fx");
    const refused = await post(e, "/v1/bounties/owner-proof", { session: octo.session, repo_id: FX.id });
    expect([refused.status, refused.body.error]).toEqual([403, "not_admin"]);
    // octocat has admin on example/other, proved in another sign-in: it is no proof for example/fx
    const other = await bound(e, "octocat", "example/other", octo.wallet);
    expect((await post(e, "/v1/bounties/owner-proof", { session: other.session, repo_id: OTHER.id })).status).toBe(200);
    expect((await post(e, "/v1/bounties/owner-proof", { session: other.session, repo_id: FX.id })).body.error).toBe("not_admin");
    // Mona signed in without naming the repository: GitHub was not asked about it, so it is not in the session
    const blind = await bound(e, "Mona", null);
    expect((await post(e, "/v1/bounties/owner-proof", { session: blind.session, repo_id: FX.id })).body.error).toBe("not_admin");
    for (const body of [{}, { repo_id: FX.id }, { session: "x.y", repo_id: FX.id }, { session: octo.session.slice(0, -2) + "zz", repo_id: FX.id }])
      expect((await post(e, "/v1/bounties/owner-proof", body)).status).toBe(401);
    expect((await boardFor(e, [octo.wallet.id])).get(octo.wallet.id).posted_by_owner).toBeNull();
    expect(e.core.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM bounty_owner_marks WHERE repo_id = 7770001").get()!.c).toBe(0);
  });

  test("never from what a poster types: terms, a note or a field named like the mark set nothing", async () => {
    const e = await world();
    const w = generateAgentKey().id;
    const terms = { v: 1, kind: "improvement", lineage_id: e.lineage, metric: "ir", min_improvement_bps: 1000, note: "Posted by an owner of example/fx", posted_by_owner: { verified: true, login: "Mona" } };
    const rows = await boardFor(e, [w], terms);
    const id = rows.get(w).bounty_id as string;
    const put = await fetch(`${e.base}/v1/bounties/${id}/terms`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(terms) });
    expect(put.status).toBe(200);
    const view = await expectOk(e.anon.get(`/v1/bounties/${id}/view`));
    expect(view.bounty.note).toBe("Posted by an owner of example/fx"); // the poster's own words, shown as a note
    expect(view.bounty.posted_by_owner).toBeNull();
    expect((await post(e, "/v1/bounties/owner-proof", { repo_id: FX.id, wallet: w, verified: true, login: "Mona" })).status).toBe(401);
    expect((await get(e, `/v1/bounties/owners?repo=example/fx&wallet=${w}`)).body.verified).toBe(false);
  });

  test("it lapses: after the time a proof counts there is no mark until the owner proves again; the time is an admin setting", async () => {
    const e = await world();
    const mona = await bound(e, "Mona", "example/fx");
    expect((await post(e, "/v1/bounties/owner-proof", { session: mona.session, repo_id: FX.id, show_login: true })).status).toBe(200);
    e.clock.advance(2_592_000_000 - 1000);
    expect((await boardFor(e, [mona.wallet.id])).get(mona.wallet.id).posted_by_owner).toMatchObject({ verified: true });
    e.clock.advance(2000);
    expect((await boardFor(e, [mona.wallet.id])).get(mona.wallet.id).posted_by_owner).toBeNull();
    expect((await get(e, `/v1/bounties/owners?repo=example/fx&wallet=${mona.wallet.id}`)).body).toMatchObject({ verified: false, login: null });
    // the old session expired long ago: a new sign-in asks GitHub again
    expect((await post(e, "/v1/bounties/owner-proof", { session: mona.session, repo_id: FX.id })).status).toBe(401);
    const again = await bound(e, "Mona", "example/fx", mona.wallet);
    expect((await post(e, "/v1/bounties/owner-proof", { session: again.session, repo_id: FX.id })).status).toBe(200);
    expect((await boardFor(e, [mona.wallet.id])).get(mona.wallet.id).posted_by_owner).toMatchObject({ verified: true, login: null });
    // the setting
    expect((await e.anon.post("/v1/admin/bounty-owners/config", { ttl_s: 86_400 })).status).toBe(401);
    for (const bad of [{ ttl_s: 10 }, { ttl_s: 1.5 }, { ttl_s: "86400" }, {}]) expect((await e.admin.c.post("/v1/admin/bounty-owners/config", bad)).status).toBe(400);
    expect((await expectOk(e.admin.c.post("/v1/admin/bounty-owners/config", { ttl_s: 86_400 }))) as unknown).toEqual({ ttl_s: 86_400 });
    const short = await bound(e, "Mona", "example/fx", mona.wallet);
    const p = await post(e, "/v1/bounties/owner-proof", { session: short.session, repo_id: FX.id });
    expect(p.body.expires_at - p.body.proved_at).toBe(86_400_000);
  });

  test("a claim is a proof: the wallet Core attested for the repository's fee escrow carries the mark, without a login", async () => {
    const e = await world({ routed: true });
    const mona = await bound(e, "Mona", "example/fx");
    expect((await boardFor(e, [mona.wallet.id])).get(mona.wallet.id).posted_by_owner).toBeNull(); // signed in and bound, nothing attested or proved yet
    const att = await post(e, "/v1/fee-claims/attest", { session: mona.session, repo_id: String(FX.id) });
    expect(att.status).toBe(200);
    const mark = (await boardFor(e, [mona.wallet.id])).get(mona.wallet.id).posted_by_owner;
    expect(mark).toMatchObject({ verified: true, repository: "example/fx", login: null, source: "claim" });
    // another wallet of nobody in particular, and the same wallet after the time a proof counts
    const other = generateAgentKey().id;
    expect((await boardFor(e, [mona.wallet.id, other])).get(other).posted_by_owner).toBeNull();
    e.clock.advance(2_592_000_000 + 1000);
    expect((await boardFor(e, [mona.wallet.id])).get(mona.wallet.id).posted_by_owner).toBeNull();
  });

  test("where fee claims are off there is no proof and no mark", async () => {
    const e = await world();
    const mona = await bound(e, "Mona", "example/fx");
    expect((await post(e, "/v1/bounties/owner-proof", { session: mona.session, repo_id: FX.id })).status).toBe(200);
    process.env.UNITS_FEATURE_GITHUB_FEE_CLAIMS = "0";
    expect((await get(e, "/v1/bounties/owner-proof")).body.available).toBe(false);
    expect((await boardFor(e, [mona.wallet.id])).get(mona.wallet.id).posted_by_owner).toBeNull();
    expect(bountyOwnersOf(e.core).mark("https://github.com/example/fx", mona.wallet.id)).toBeNull();
  });
});
