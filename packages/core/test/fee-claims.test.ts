import { afterEach, describe, expect, test } from "bun:test";
import { createHmac, createPublicKey, verify as edVerify } from "node:crypto";
import { accountDisc, addressBytes, claimMessage, claimPdas, LAUNCH_PROGRAM_ID, Rpc, Writer, type Address } from "@units/chain";
import { feeClaimDigest, feeClaimGistText, feeClaimsOf, feeClaimStatement } from "../src/fee-claims.ts";
import { base58Decode, generateAgentKey, signMessage, type AgentKey } from "../src/protocol.ts";
import { startMockGithub, type MockGithub } from "../../../scripts/claims/mock-github.ts";
import { bare } from "./helpers.ts";

// GitHub fee claims, Core side (docs/plans/GITHUB-FEE-CLAIMS.md 5 and 11): fees are keyed by the
// REPOSITORY's numeric id and claimed by anyone GitHub says has admin on it. The mock OAuth provider
// with repository permissions, the gist proof for a personally owned repository, the wallet
// statement, the attestation Core signs (checked here with plain ed25519 against the exact bytes the
// program rebuilds), the refusal of a non-admin and of an id that is not a repository's, and the flag.

type E = ReturnType<typeof bare>;
let env: E | null = null;
let gh: MockGithub | null = null;
afterEach(() => {
  env?.close();
  env = null;
  gh?.stop();
  gh = null;
  delete process.env.UNITS_FEATURE_GITHUB_FEE_CLAIMS;
});

const LINE = generateAgentKey().id;
const OCTO = { id: 583231, login: "octocat", name: "The Octocat" };
const MONA = { id: 2, login: "Mona" };
const HUBOT = { id: 3, login: "hubot" };
const ACME = { id: 9919, login: "acme", type: "Organization" as const };
// a personal repository, an organisation's (Mona and hubot are admins, octocat only pushes), and a
// repository whose numeric id happens to equal octocat's ACCOUNT id
const HELLO = { id: 1296269, full_name: "octocat/Hello-World", admins: ["octocat"], former: ["octocat/old-hello"] };
const ENGINE = { id: 5000001, full_name: "acme/engine", admins: ["Mona", "hubot"], members: ["octocat"] };
const CLASH = { id: OCTO.id, full_name: "Mona/unrelated", admins: ["Mona"] };

/** A chain that holds exactly the accounts given (address -> { owner, data }). */
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
        .map(([pubkey, v]) => ({ pubkey, account: raw(pubkey)! }));
    }
    throw new Error(`fake chain: ${method}`);
  });
}

const acct = (name: string, w: Writer) => ({ owner: LAUNCH_PROGRAM_ID, data: new Writer().bytes(accountDisc(name)).bytes(w.done()).done() });
const ZERO = "11111111111111111111111111111111";
function tokenAccount(amount: bigint) {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return { owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data: d };
}

function setup(o: { balance?: bigint; seq?: bigint; pinned?: Address; paused?: boolean; flag?: boolean; attestorOnChain?: Address; directCheckMax?: number } = {}) {
  if (o.flag !== false) process.env.UNITS_FEATURE_GITHUB_FEE_CLAIMS = "1";
  env = bare();
  gh = startMockGithub({ port: 0, users: [OCTO, MONA, HUBOT, ACME], repos: [HELLO, ENGINE, CLASH], clientId: "cid", clientSecret: "csecret" });
  const attestor = generateAgentKey();
  const accounts = new Map<Address, { owner: string; data: Uint8Array }>();
  // the owner's rule: one share for every agent, so the admin's bounds are one number
  accounts.set(claimPdas.config(), acct("ClaimConfig", new Writer().address(o.attestorOnChain ?? attestor.id).u16(2000).u16(2000).i64(600).i64(120).i64(600).bool(!!o.paused).u8(255)));
  /** An agent registered on `repoUrl` whose route names `id`, with the id's escrow and vault. */
  const routed = (id: number, repoUrl: string, balance = 777n) => {
    const agent = generateAgentKey().id, mint = generateAgentKey().id;
    accounts.set(claimPdas.feeRoute(agent), acct("FeeRoute", new Writer().address(agent).u64(id).u16(2000).i64(1_900_000_000).u64(0).u16(0).i64(0).u64(777).u64(777).u32(0).u8(254)));
    accounts.set(generateAgentKey().id, acct("AgentLaunch", new Writer().address(agent).address(mint).address(generateAgentKey().id).fixed32("ab".repeat(32)).string(repoUrl)));
    accounts.set(claimPdas.escrow(id), acct("ClaimEscrow", new Writer().u64(id).address(o.pinned ?? ZERO).address(ZERO).i64(0).u64(777).u64(0).u64(o.seq ?? 0n).u8(255).u8(254)));
    accounts.set(claimPdas.vault(id), tokenAccount(balance));
    return agent;
  };
  const agent = routed(HELLO.id, "https://github.com/octocat/hello-world", o.balance ?? 777n);
  const orgAgent = routed(ENGINE.id, "https://github.com/acme/engine", o.balance ?? 555n);
  // the first build keyed a route by an ACCOUNT id: this agent works on another repository and names octocat's account id
  const legacyAgent = routed(OCTO.id, "https://github.com/someone/else");
  const fc = feeClaimsOf(env.core).configure({
    githubApi: gh.url, rpc: fakeChain(accounts), lineMint: LINE, attestor,
    oauth: { clientId: "cid", clientSecret: "csecret", authorizeUrl: `${gh.url}/login/oauth/authorize`, tokenUrl: `${gh.url}/login/oauth/access_token`,
      redirectUri: `${env.base}/v1/fee-claims/oauth/callback`, scope: "", name: "mock" },
    claimPage: "http://127.0.0.1:9661/claim",
    ...(o.directCheckMax !== undefined ? { directCheckMax: o.directCheckMax } : {}),
  });
  return { e: env, gh, fc, attestor, agent, orgAgent, legacyAgent };
}

const get = async (e: E, path: string) => {
  const r = await fetch(e.base + path, { redirect: "manual" });
  return { status: r.status, body: r.status === 302 ? null : await r.json().catch(() => null), location: r.headers.get("location") };
};
const post = async (e: E, path: string, body: unknown) => {
  const r = await fetch(e.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const walletProof = (e: E, wallet: AgentKey, login: string, at = e.clock.now() / 1000) => {
  const statement = feeClaimStatement(login, wallet.id, at);
  return { statement, sig: signMessage(wallet, feeClaimDigest(statement)) };
};
/** The whole mock OAuth round trip, as a browser would follow it. */
async function oauthSession(e: E, login?: string, repo?: string): Promise<string> {
  const start = await get(e, `/v1/fee-claims/oauth/start${repo ? `?repo=${repo}` : ""}`);
  expect(start.status).toBe(302);
  const authorize = new URL(start.location!);
  if (login) authorize.searchParams.set("login", login);
  const a = await fetch(authorize, { redirect: "manual" });
  expect(a.status).toBe(302);
  const cb = new URL(a.headers.get("location")!);
  const back = await get(e, cb.pathname + cb.search);
  expect(back.status).toBe(302);
  const page = new URL(back.location!);
  expect(page.origin + page.pathname).toBe("http://127.0.0.1:9661/claim");
  if (repo) expect(page.searchParams.get("repo")).toBe(repo);
  return page.hash.replace(/^#session=/, "");
}
function verifyAttestation(att: any, attestor: string) {
  const msg = claimMessage({ githubId: BigInt(att.github_id), wallet: att.wallet, ceiling: BigInt(att.ceiling), claimSeq: BigInt(att.claim_seq), expiresAt: att.expires_at });
  expect(Buffer.from(msg).toString("hex")).toBe(att.message);
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(addressBytes(attestor))]), format: "der", type: "spki" });
  return edVerify(null, Buffer.from(msg), key, Buffer.from(base58Decode(att.signature)));
}

const names = (body: any) => (body.repositories as { full_name: string }[]).map((r) => r.full_name).sort();
/** Signs in, binds a fresh wallet, returns the bound session and the wallet. */
async function signedIn(e: E, login: string, repo?: string) {
  const session = await oauthSession(e, login, repo);
  const wallet = generateAgentKey();
  const bound = await post(e, "/v1/fee-claims/wallet", { session, ...walletProof(e, wallet, login) });
  expect([bound.status, bound.body.wallet]).toEqual([200, wallet.id]);
  return { session: bound.body.session as string, wallet, body: bound.body };
}
async function gistSession(e: E, g: MockGithub, login: string) {
  const wallet = generateAgentKey();
  const p = walletProof(e, wallet, login);
  const r = await post(e, "/v1/fee-claims/proofs/gist", { gist_url: g.addGist(login, feeClaimGistText(p.statement, p.sig)) });
  return { ...r, wallet, session: r.body?.session as string };
}

describe("fee claims", () => {
  test("off by default: every route answers 404 feature_off", async () => {
    const { e } = setup({ flag: false });
    for (const p of ["/v1/github/repos/octocat/Hello-World", "/v1/fee-claims/providers", `/v1/fee-claims/recipients/${HELLO.id}`, "/v1/fee-claims/recipients?repo=octocat/Hello-World", "/v1/fee-claims/oauth/start", "/v1/fee-claims/session?session=x"]) {
      const r = await get(e, p);
      expect([p, r.status, r.body?.error]).toEqual([p, 404, "feature_off"]);
    }
    for (const p of ["/v1/fee-claims/proofs/gist", "/v1/fee-claims/wallet", "/v1/fee-claims/attest"]) expect((await post(e, p, {})).status).toBe(404);
  });

  test("keyed by the repository's numeric id: lookup, route and escrow views; the share is the one number in the chain config", async () => {
    const { e, agent, legacyAgent } = setup();
    const u = await get(e, "/v1/github/repos/OctoCat/hello-world");
    expect([u.status, u.body.id, u.body.full_name, u.body.owner.login, u.body.owner.type]).toEqual([200, String(HELLO.id), "octocat/Hello-World", "octocat", "User"]);
    // a former name still resolves to the same id (GitHub redirects a renamed or transferred repository)
    expect((await get(e, "/v1/github/repos/octocat/old-hello")).body.id).toBe(String(HELLO.id));
    expect((await get(e, "/v1/github/repos/acme/engine")).body).toMatchObject({ id: String(ENGINE.id), owner: { login: "acme", type: "Organization" } });
    expect((await get(e, "/v1/github/repos/octocat/nothing-here")).status).toBe(404);
    expect((await get(e, "/v1/github/repos/bad_owner!/x")).status).toBe(400);
    // the account lookup of the first build is gone: nothing turns a login into an escrow key
    expect((await get(e, "/v1/github/users/octocat")).status).toBe(404);
    const r = await get(e, `/v1/agents/${agent}/fee-route`);
    expect(r.body.route).toMatchObject({ github_id: String(HELLO.id), repository: { full_name: "octocat/Hello-World" }, bps: 2000, accrued: "777", pending: null });
    expect(r.body.bounds).toMatchObject({ min_bps: 2000, max_bps: 2000 });
    expect((await get(e, `/v1/agents/${generateAgentKey().id}/fee-route`)).body.route).toBeNull();
    const rec = await get(e, `/v1/fee-claims/recipients/${HELLO.id}`);
    expect(rec.body).toMatchObject({ github_id: String(HELLO.id), repository: { full_name: "octocat/Hello-World" }, claimable_by_admins: true });
    expect(rec.body.escrow).toMatchObject({ accrued: "777", claimed: "0", claimable: "777", claim_seq: "0", wallet: null });
    expect(rec.body.agents).toEqual([{ agent, bps: 2000, accrued: "777", set_at: 1_900_000_000, pending_change: null }]);
    expect((await get(e, "/v1/fee-claims/recipients?repo=octocat/Hello-World")).body.github_id).toBe(String(HELLO.id));
    expect((await get(e, "/v1/fee-claims/recipients?repo=https://github.com/acme/engine")).body.github_id).toBe(String(ENGINE.id));
    expect((await get(e, "/v1/fee-claims/recipients/424242")).body).toMatchObject({ escrow: null, agents: [], claimable_by_admins: false });
    // an escrow keyed by an ACCOUNT id: its number is also some repository's id on GitHub, and it is still nobody's
    const legacy = await get(e, `/v1/fee-claims/recipients/${OCTO.id}`);
    expect(legacy.body).toMatchObject({ repository: null, claimable_by_admins: false, escrow: { claimable: "777" } });
    expect((await get(e, `/v1/agents/${legacyAgent}/fee-route`)).body.route).toMatchObject({ github_id: String(OCTO.id), repository: null });
  });

  test("admin proof by sign-in on a personal repository: no scope asked, the token used inside the callback only, attestation over the program's exact bytes", async () => {
    const { e, gh, attestor } = setup();
    const session = await oauthSession(e, "octocat");
    expect(gh.scopes).toEqual([""]);
    expect(gh.calls).toEqual({ authorize: 1, token: 1, user: 1 });
    // with the token Core asked who the user is and about each routed repository, and nothing else
    const during = [...gh.tokenCalls].sort();
    expect(during).toEqual(["GET /repositories/1296269", "GET /repositories/5000001", "GET /user"]);
    const s = await get(e, `/v1/fee-claims/session?session=${session}`);
    expect(s.body).toMatchObject({ github_id: String(OCTO.id), login: "octocat", method: "mock", wallet: null });
    // octocat owns Hello-World; on acme/engine octocat can push but is no admin
    expect(names(s.body)).toEqual(["octocat/Hello-World"]);
    expect((await post(e, "/v1/fee-claims/attest", { session, repo_id: String(HELLO.id) })).body.error).toBe("no_wallet");
    const wallet = generateAgentKey();
    // a statement for another account, by another key, stale
    expect((await post(e, "/v1/fee-claims/wallet", { session, ...walletProof(e, wallet, "mona") })).status).toBe(400);
    const forged = { statement: feeClaimStatement("octocat", wallet.id, e.clock.now() / 1000), sig: signMessage(generateAgentKey(), feeClaimDigest(feeClaimStatement("octocat", wallet.id, e.clock.now() / 1000))) };
    expect((await post(e, "/v1/fee-claims/wallet", { session, ...forged })).status).toBe(403);
    expect((await post(e, "/v1/fee-claims/wallet", { session, ...walletProof(e, wallet, "octocat", e.clock.now() / 1000 - 90_000) })).status).toBe(400);
    const bound = await post(e, "/v1/fee-claims/wallet", { session, ...walletProof(e, wallet, "octocat") });
    expect([bound.status, bound.body.wallet, names(bound.body)]).toEqual([200, wallet.id, ["octocat/Hello-World"]]);
    const att = await post(e, "/v1/fee-claims/attest", { session: bound.body.session, repo_id: String(HELLO.id) });
    expect(att.status).toBe(200);
    // the id in the signed bytes is the REPOSITORY's, not octocat's account id
    expect(att.body).toMatchObject({ github_id: String(HELLO.id), repository: { full_name: "octocat/Hello-World" }, login: "octocat", wallet: wallet.id, ceiling: "777", claim_seq: "0", attestor: attestor.id, rebind: null });
    expect(att.body.escrow).toBe(claimPdas.escrow(HELLO.id));
    expect(att.body.expires_at - Math.floor(e.clock.now() / 1000)).toBeLessThanOrEqual(600);
    expect(verifyAttestation(att.body, attestor.id)).toBe(true);
    // rate limit, then the record (who claimed, never a signature)
    expect((await post(e, "/v1/fee-claims/attest", { session: bound.body.session, repo_id: String(HELLO.id) })).status).toBe(429);
    const log = await get(e, `/v1/fee-claims/attestations?github_id=${HELLO.id}`);
    expect(log.body).toHaveLength(1);
    expect(log.body[0]).toMatchObject({ login: "octocat", wallet: wallet.id });
    expect(JSON.stringify(log.body)).not.toContain(att.body.signature);
    // the token: no GitHub call with it after the callback, none in the session, none in the database
    expect([...gh.tokenCalls].sort()).toEqual(during);
    expect(Buffer.from(bound.body.session.split(".")[0], "base64url").toString()).not.toContain("mock_");
    const tables = e.core.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fee_claim%'").all().map((t) => t.name);
    expect(tables).toContain("fee_claim_repos");
    for (const t of tables) expect(JSON.stringify(e.core.db.query(`SELECT * FROM ${t}`).all())).not.toContain("mock_");
    // a session cannot be edited: adding a repository breaks the MAC
    const [body, mac] = bound.body.session.split(".");
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), repos: [HELLO.id, ENGINE.id] })).toString("base64url");
    expect((await post(e, "/v1/fee-claims/attest", { session: `${edited}.${mac}`, repo_id: String(ENGINE.id) })).status).toBe(401);
    // and it expires
    e.clock.advance(901_000);
    expect((await post(e, "/v1/fee-claims/attest", { session: bound.body.session, repo_id: String(HELLO.id) })).status).toBe(401);
  });

  test("an organisation's repository: an admin claims it, a member without admin and a stranger are refused", async () => {
    const { e, attestor } = setup();
    const mona = await signedIn(e, "Mona");
    // Mona administers acme/engine. She also administers a repository whose id equals octocat's account id, where an
    // account-keyed escrow of the first build sits: that id is not listed and not claimable
    expect(names(mona.body)).toEqual(["acme/engine"]);
    const att = await post(e, "/v1/fee-claims/attest", { session: mona.session, repo_id: String(ENGINE.id) });
    expect(att.body).toMatchObject({ github_id: String(ENGINE.id), wallet: mona.wallet.id, ceiling: "555" });
    expect(verifyAttestation(att.body, attestor.id)).toBe(true);
    const clash = await post(e, "/v1/fee-claims/attest", { session: mona.session, repo_id: String(OCTO.id) });
    expect([clash.status, clash.body.error]).toEqual([403, "not_admin"]);
    // octocat can push to acme/engine and is not an admin
    const octo = await signedIn(e, "octocat");
    const refused = await post(e, "/v1/fee-claims/attest", { session: octo.session, repo_id: String(ENGINE.id) });
    expect([refused.status, refused.body.error]).toEqual([403, "not_admin"]);
    // one repository in the session: it is the default; a bad id is refused before anything else
    expect((await post(e, "/v1/fee-claims/attest", { session: octo.session })).body.github_id).toBe(String(HELLO.id));
    expect((await post(e, "/v1/fee-claims/attest", { session: octo.session, repo_id: "1 OR 1" })).status).toBe(400);
  });

  test("an id that is not a repository's is never attested, even for a session that names it", async () => {
    const { e, fc } = setup();
    // a session Core itself would never issue: Mona with the clashing id (her repository's number, octocat's account's escrow)
    const wallet = generateAgentKey();
    const forged = (fc as any).issue({ github_id: MONA.id, login: "Mona", method: "mock", wallet: wallet.id, repos: [OCTO.id] }).session;
    const r = await post(e, "/v1/fee-claims/attest", { session: forged, repo_id: String(OCTO.id) });
    expect([r.status, r.body.error]).toEqual([403, "not_a_repository_escrow"]);
    // a session of the first build (an account, no repositories) claims nothing
    const oldBody = Buffer.from(JSON.stringify({ github_id: OCTO.id, login: "octocat", method: "mock", wallet: wallet.id, exp: Math.floor(e.clock.now() / 1000) + 600 })).toString("base64url");
    const old = `${oldBody}.${createHmac("sha256", (fc as any).secret()).update(oldBody).digest().toString("base64url")}`;
    expect((await post(e, "/v1/fee-claims/attest", { session: old })).status).toBe(401);
  });

  test("several admins: either claims the whole escrow; a second admin's other wallet on a pinned escrow starts a rebind", async () => {
    let s = setup();
    const mona = await signedIn(s.e, "Mona"), hubot = await signedIn(s.e, "hubot");
    expect(names(hubot.body)).toEqual(["acme/engine"]);
    const a1 = await post(s.e, "/v1/fee-claims/attest", { session: mona.session, repo_id: String(ENGINE.id) });
    s.e.clock.advance(2_500);
    const a2 = await post(s.e, "/v1/fee-claims/attest", { session: hubot.session, repo_id: String(ENGINE.id) });
    // both attestations are for the whole balance at the same sequence number: the first to land on chain is paid, the other no longer verifies
    expect([a1.body.ceiling, a1.body.claim_seq, a1.body.wallet]).toEqual(["555", "0", mona.wallet.id]);
    expect([a2.body.ceiling, a2.body.claim_seq, a2.body.wallet, a2.body.rebind]).toEqual(["555", "0", hubot.wallet.id, null]);
    expect((await get(s.e, `/v1/fee-claims/attestations?github_id=${ENGINE.id}`)).body.map((x: any) => x.login).sort()).toEqual(["Mona", "hubot"]);
    s.e.close(); s.gh.stop();
    const pinned = generateAgentKey().id;
    s = setup({ pinned, seq: 3n });
    const later = await signedIn(s.e, "hubot");
    const att = await post(s.e, "/v1/fee-claims/attest", { session: later.session, repo_id: String(ENGINE.id) });
    expect(att.body).toMatchObject({ claim_seq: "3", wallet: later.wallet.id, rebind: { pinned_wallet: pinned, delay_s: 120 } });
  });

  test("a large routed set is matched against the user's own list; a repository named at the sign-in is checked by name", async () => {
    const { e, gh } = setup({ directCheckMax: 0 });
    const mona = await signedIn(e, "Mona");
    expect(names(mona.body)).toEqual(["acme/engine"]);
    expect(gh.tokenCalls).toContain("GET /user/repos");
    expect(gh.tokenCalls.some((c) => c.startsWith("GET /repositories/"))).toBe(false);
    const octo = await signedIn(e, "octocat", "octocat/Hello-World");
    expect(names(octo.body)).toEqual(["octocat/Hello-World"]);
    expect(gh.tokenCalls).toContain("GET /repos/octocat/Hello-World");
    // naming a repository one does not administer adds nothing
    expect(names((await signedIn(e, "octocat", "acme/engine")).body)).toEqual(["octocat/Hello-World"]);
    expect((await get(e, "/v1/fee-claims/oauth/start?repo=not-a-repo")).status).toBe(400);
  });

  test("an OAuth state works once and a code cannot be replayed", async () => {
    const { e } = setup();
    const start = await get(e, "/v1/fee-claims/oauth/start");
    const a = await fetch(start.location!, { redirect: "manual" });
    const cb = new URL(a.headers.get("location")!);
    expect((await get(e, cb.pathname + cb.search)).status).toBe(302);
    expect((await get(e, cb.pathname + cb.search)).status).toBe(403); // state used
    expect((await get(e, `/v1/fee-claims/oauth/callback?code=x&state=${"A".repeat(32)}`)).status).toBe(403);
    // return_to may not leave the claim page
    expect((await get(e, "/v1/fee-claims/oauth/start?return_to=https://evil.example/claim")).status).toBe(400);
    expect((await get(e, "/v1/fee-claims/oauth/start?return_to=/claim?id=5")).status).toBe(302);
  });

  test("gist proof: opens the repositories the account owns itself, never an organisation's", async () => {
    const { e, gh, attestor } = setup();
    const ok = await gistSession(e, gh, "octocat");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ github_id: String(OCTO.id), login: "octocat", method: "gist", wallet: ok.wallet.id });
    expect(names(ok.body)).toEqual(["octocat/Hello-World"]);
    const att = await post(e, "/v1/fee-claims/attest", { session: ok.session, repo_id: String(HELLO.id) });
    expect(att.body.github_id).toBe(String(HELLO.id));
    expect(verifyAttestation(att.body, attestor.id)).toBe(true);
    // Mona is an admin of acme/engine, which a gist cannot show: her gist opens nothing
    const mona = await gistSession(e, gh, "Mona");
    expect([mona.status, names(mona.body)]).toEqual([200, []]);
    expect((await post(e, "/v1/fee-claims/attest", { session: mona.session, repo_id: String(ENGINE.id) })).body.error).toBe("not_admin");
    expect((await post(e, "/v1/fee-claims/attest", { session: mona.session })).body.error).toBe("no_repository");
    // the same statement posted by another account proves nothing
    const wallet = generateAgentKey();
    const p = walletProof(e, wallet, "octocat");
    const url = gh.addGist("octocat", feeClaimGistText(p.statement, p.sig));
    expect((await post(e, "/v1/fee-claims/proofs/gist", { gist_url: gh.addGist("Mona", feeClaimGistText(p.statement, p.sig)) })).status).toBe(400);
    expect((await post(e, "/v1/fee-claims/proofs/gist", { gist_url: url.replace("octocat", "mona") })).status).toBe(400);
    // secret gist, missing gist, a statement signed by another key
    expect((await post(e, "/v1/fee-claims/proofs/gist", { gist_url: gh.addGist("octocat", feeClaimGistText(p.statement, p.sig), { public: false }) })).status).toBe(400);
    expect((await post(e, "/v1/fee-claims/proofs/gist", { gist_url: "https://gist.github.com/octocat/00000000000000000000000000000000" })).status).toBe(400);
    const badSig = gh.addGist("octocat", feeClaimGistText(p.statement, signMessage(generateAgentKey(), feeClaimDigest(p.statement))));
    expect((await post(e, "/v1/fee-claims/proofs/gist", { gist_url: badSig })).status).toBe(403);
    expect((await post(e, "/v1/fee-claims/proofs/gist", { gist_url: "https://example.com/x" })).status).toBe(400);
  });

  test("attest refuses: empty escrow, paused, an attestor the program does not trust", async () => {
    let s = setup({ balance: 0n });
    expect((await post(s.e, "/v1/fee-claims/attest", { session: (await gistSession(s.e, s.gh, "octocat")).session })).status).toBe(409);
    s.e.close(); s.gh.stop();
    s = setup({ paused: true });
    expect((await post(s.e, "/v1/fee-claims/attest", { session: (await gistSession(s.e, s.gh, "octocat")).session })).status).toBe(409);
    s.e.close(); s.gh.stop();
    s = setup({ attestorOnChain: generateAgentKey().id });
    expect((await post(s.e, "/v1/fee-claims/attest", { session: (await gistSession(s.e, s.gh, "octocat")).session })).status).toBe(503);
  });
});

// Fees waiting for the owners (owner 2026-10-13): the public view, no sign-in.
describe("fees waiting for the owners", () => {
  const SOLO = { id: 7000001, full_name: "octocat/solo", admins: ["octocat"] };
  const QUIET = { id: 7000002, full_name: "acme/quiet", admins: ["Mona"] };
  /** Three repository escrows (unclaimed with two agents, partly claimed, empty) and one keyed by an account id. */
  function seeded(o: { usd?: boolean } = {}) {
    process.env.UNITS_FEATURE_GITHUB_FEE_CLAIMS = "1";
    env = bare();
    gh = startMockGithub({ port: 0, users: [OCTO, MONA, HUBOT, ACME], repos: [HELLO, ENGINE, CLASH, SOLO, QUIET], clientId: "cid", clientSecret: "csecret" });
    const accounts = new Map<Address, { owner: string; data: Uint8Array }>();
    accounts.set(claimPdas.config(), acct("ClaimConfig", new Writer().address(generateAgentKey().id).u16(2000).u16(2000).i64(600).i64(120).i64(600).bool(false).u8(255)));
    const route = (id: number, repoUrl: string, routed: bigint, setAt: number) => {
      const agent = generateAgentKey().id;
      accounts.set(claimPdas.feeRoute(agent), acct("FeeRoute", new Writer().address(agent).u64(id).u16(2000).i64(setAt).u64(0).u16(0).i64(0).u64(routed).u64(routed).u32(0).u8(254)));
      accounts.set(generateAgentKey().id, acct("AgentLaunch", new Writer().address(agent).address(generateAgentKey().id).address(generateAgentKey().id).fixed32("ab".repeat(32)).string(repoUrl)));
      return agent;
    };
    const escrow = (id: number, o: { accrued: bigint; claimed: bigint; seq: bigint; wallet?: Address }) => {
      accounts.set(claimPdas.escrow(id), acct("ClaimEscrow", new Writer().u64(id).address(o.wallet ?? ZERO).address(ZERO).i64(0).u64(o.accrued).u64(o.claimed).u64(o.seq).u8(255).u8(254)));
      accounts.set(claimPdas.vault(id), tokenAccount(o.accrued - o.claimed));
    };
    // 250 UNITS unclaimed from two agents; 100 routed and 40 claimed; a route that has earned nothing yet
    const big = route(ENGINE.id, "https://github.com/acme/engine", 200_000_000n, 1_760_000_500), small = route(ENGINE.id, "https://github.com/acme/engine", 50_000_000n, 1_760_000_100);
    escrow(ENGINE.id, { accrued: 250_000_000n, claimed: 0n, seq: 0n });
    const part = route(HELLO.id, "https://github.com/octocat/hello-world", 100_000_000n, 1_760_000_900);
    const pinned = generateAgentKey().id;
    escrow(HELLO.id, { accrued: 100_000_000n, claimed: 40_000_000n, seq: 2n, wallet: pinned });
    const none = route(QUIET.id, "https://github.com/acme/quiet", 0n, 1_760_001_000);
    escrow(QUIET.id, { accrued: 0n, claimed: 0n, seq: 0n });
    // keyed by octocat's ACCOUNT id by an agent on another repository: never a repository's escrow
    route(OCTO.id, "https://github.com/someone/else", 9_000_000n, 1_760_000_000);
    escrow(OCTO.id, { accrued: 9_000_000n, claimed: 0n, seq: 0n });
    feeClaimsOf(env.core).configure({
      githubApi: gh.url, rpc: fakeChain(accounts), lineMint: LINE,
      usd: () => (o.usd === false ? { ok: false, reason: "no market indexer configured for this Core (UNITS_INDEXER_URL)" } : { ok: true, quote_usd: 0.0004, read_at: 1_760_002_000, decimals: 6 }),
    });
    return { e: env, big, small, part, none, pinned };
  }

  test("the list: unclaimed, partly claimed and empty escrows, largest first, in dollars at the current price with the coin amount", async () => {
    const { e, big, small, part, none, pinned } = seeded();
    const t0 = Math.floor(e.clock.now() / 1000);
    const r = await get(e, "/v1/fee-claims/waiting");
    expect(r.status).toBe(200);
    expect(r.body.repositories.map((x: any) => x.repository.full_name)).toEqual(["acme/engine", "octocat/Hello-World", "acme/quiet"]);
    const [engine, hello, quiet] = r.body.repositories;
    expect(engine).toEqual({
      github_id: String(ENGINE.id), repository: { id: String(ENGINE.id), full_name: "acme/engine", html_url: "https://github.com/acme/engine", owner: { id: String(ACME.id), login: "acme", type: "Organization", avatar_url: expect.anything() } },
      waiting: "250000000", waiting_usd: 0.1, claimed: "0", claimed_usd: 0, routed_total: "250000000",
      agents: [{ agent: big, bps: 2000, routed_total: "200000000", set_at: 1_760_000_500 }, { agent: small, bps: 2000, routed_total: "50000000", set_at: 1_760_000_100 }],
      routed_since: 1_760_000_100, waiting_since: t0,
    });
    // the dollar rule for a figure of now: the amount times the current reading
    expect(hello).toMatchObject({ waiting: "60000000", claimed: "40000000", routed_total: "100000000", agents: [{ agent: part, routed_total: "100000000" }], routed_since: 1_760_000_900, waiting_since: t0 });
    expect(hello.waiting_usd).toBeCloseTo(0.024, 10);
    expect(hello.claimed_usd).toBeCloseTo(0.016, 10);
    // nothing has come in yet: listed with zero, and no waiting time
    expect(quiet).toMatchObject({ waiting: "0", waiting_usd: 0, claimed: "0", routed_total: "0", agents: [{ agent: none }], waiting_since: null });
    expect(r.body).toMatchObject({ total_waiting: "310000000", usd: { quote_usd: 0.0004, read_at: 1_760_002_000, decimals: 6 }, usd_reason: null });
    expect(r.body.total_waiting_usd).toBeCloseTo(0.124, 10);
    // nothing private: no wallet (the pinned one included), no session, no login of a claimant, no attestation, and no escrow that is not a repository's
    const text = JSON.stringify(r.body);
    for (const secret of [pinned, "wallet", "session", "login\":\"octocat\",\"method", "signature", "attest", String(OCTO.id) + "\",\"repository", "someone/else"]) expect(text).not.toContain(secret);
    expect(Object.keys(engine).sort()).toEqual(["agents", "claimed", "claimed_usd", "github_id", "repository", "routed_since", "routed_total", "waiting", "waiting_since", "waiting_usd"]);
    expect(r.body.repositories.some((x: any) => x.github_id === String(OCTO.id))).toBe(false);
  });

  test("one repository by name (a former name too); a repository nothing is routed to answers an empty list; the waiting time is kept and starts again after a claim", async () => {
    const { e } = seeded();
    const first = await get(e, "/v1/fee-claims/waiting?repo=Acme/Engine");
    expect(first.body.repositories.map((x: any) => x.repository.full_name)).toEqual(["acme/engine"]);
    expect(first.body.total_waiting).toBe("250000000");
    const since = first.body.repositories[0].waiting_since;
    e.clock.advance(3_600_000);
    expect((await get(e, "/v1/fee-claims/waiting?repo=https://github.com/acme/engine")).body.repositories[0].waiting_since).toBe(since);
    expect((await get(e, "/v1/fee-claims/waiting?repo=octocat/hello-world")).body.repositories[0]).toMatchObject({ waiting: "60000000" });
    for (const name of ["octocat/solo", "nobody/nothing", "Mona/unrelated", "someone/else"]) expect((await get(e, `/v1/fee-claims/waiting?repo=${name}`)).body).toMatchObject({ repositories: [], total_waiting: "0" });
    for (const bad of ["nope", "a/b/c", "a b/c"]) expect((await get(e, `/v1/fee-claims/waiting?repo=${encodeURIComponent(bad)}`)).status).toBe(400);
  });

  test("without a dollar reading every dollar figure is null with the reason, never a coin number in its place; with the feature off the route is not served", async () => {
    const { e } = seeded({ usd: false });
    const r = await get(e, "/v1/fee-claims/waiting");
    expect(r.body).toMatchObject({ usd: null, usd_reason: "no market indexer configured for this Core (UNITS_INDEXER_URL)", total_waiting: "310000000", total_waiting_usd: null });
    for (const x of r.body.repositories) expect([x.waiting_usd, x.claimed_usd]).toEqual([null, null]);
    delete process.env.UNITS_FEATURE_GITHUB_FEE_CLAIMS;
    const off = await get(e, "/v1/fee-claims/waiting");
    expect([off.status, off.body.error]).toEqual([404, "feature_off"]);
  });
});
