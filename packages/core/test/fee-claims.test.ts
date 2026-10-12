import { afterEach, describe, expect, test } from "bun:test";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { accountDisc, addressBytes, claimMessage, claimPdas, LAUNCH_PROGRAM_ID, Rpc, Writer, type Address } from "@units/chain";
import { feeClaimDigest, feeClaimGistText, feeClaimsOf, feeClaimStatement } from "../src/fee-claims.ts";
import { base58Decode, generateAgentKey, signMessage, type AgentKey } from "../src/protocol.ts";
import { startMockGithub, type MockGithub } from "../../../scripts/claims/mock-github.ts";
import { bare } from "./helpers.ts";

// GitHub fee claims, Core side (docs/plans/GITHUB-FEE-CLAIMS.md 5): the mock OAuth provider, the
// gist proof, the wallet statement, the attestation Core signs (checked here with plain ed25519
// against the exact bytes the program rebuilds), and the feature flag.

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

function setup(o: { balance?: bigint; seq?: bigint; pinned?: Address; paused?: boolean; flag?: boolean; attestorOnChain?: Address } = {}) {
  if (o.flag !== false) process.env.UNITS_FEATURE_GITHUB_FEE_CLAIMS = "1";
  env = bare();
  gh = startMockGithub({ port: 0, users: [OCTO, MONA], clientId: "cid", clientSecret: "csecret" });
  const attestor = generateAgentKey();
  const agent = generateAgentKey().id;
  const accounts = new Map<Address, { owner: string; data: Uint8Array }>();
  accounts.set(claimPdas.config(), acct("ClaimConfig", new Writer().address(o.attestorOnChain ?? attestor.id).u16(1000).u16(3000).i64(600).i64(120).i64(600).bool(!!o.paused).u8(255)));
  accounts.set(claimPdas.feeRoute(agent), acct("FeeRoute", new Writer().address(agent).u64(OCTO.id).u16(2000).i64(1_900_000_000).u64(0).u16(0).i64(0).u64(777).u64(777).u32(0).u8(254)));
  accounts.set(claimPdas.escrow(OCTO.id), acct("ClaimEscrow", new Writer().u64(OCTO.id).address(o.pinned ?? ZERO).address(ZERO).i64(0).u64(777).u64(0).u64(o.seq ?? 0n).u8(255).u8(254)));
  accounts.set(claimPdas.vault(OCTO.id), tokenAccount(o.balance ?? 777n));
  const fc = feeClaimsOf(env.core).configure({
    githubApi: gh.url, rpc: fakeChain(accounts), lineMint: LINE, attestor,
    oauth: { clientId: "cid", clientSecret: "csecret", authorizeUrl: `${gh.url}/login/oauth/authorize`, tokenUrl: `${gh.url}/login/oauth/access_token`,
      redirectUri: `${env.base}/v1/fee-claims/oauth/callback`, name: "mock" },
    claimPage: "http://127.0.0.1:9661/claim",
  });
  return { e: env, gh, fc, attestor, agent };
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
async function oauthSession(e: E, login?: string): Promise<string> {
  const start = await get(e, "/v1/fee-claims/oauth/start");
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
  return page.hash.replace(/^#session=/, "");
}
function verifyAttestation(att: any, attestor: string) {
  const msg = claimMessage({ githubId: BigInt(att.github_id), wallet: att.wallet, ceiling: BigInt(att.ceiling), claimSeq: BigInt(att.claim_seq), expiresAt: att.expires_at });
  expect(Buffer.from(msg).toString("hex")).toBe(att.message);
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(addressBytes(attestor))]), format: "der", type: "spki" });
  return edVerify(null, Buffer.from(msg), key, Buffer.from(base58Decode(att.signature)));
}

describe("fee claims", () => {
  test("off by default: every route answers 404 feature_off", async () => {
    const { e } = setup({ flag: false });
    for (const p of ["/v1/github/users/octocat", "/v1/fee-claims/providers", `/v1/fee-claims/recipients/${OCTO.id}`, "/v1/fee-claims/oauth/start", "/v1/fee-claims/session?session=x"]) {
      const r = await get(e, p);
      expect([p, r.status, r.body?.error]).toEqual([p, 404, "feature_off"]);
    }
    for (const p of ["/v1/fee-claims/proofs/gist", "/v1/fee-claims/wallet", "/v1/fee-claims/attest"]) expect((await post(e, p, {})).status).toBe(404);
  });

  test("lookup, route and recipient views", async () => {
    const { e, agent } = setup();
    const u = await get(e, "/v1/github/users/OctoCat");
    expect([u.status, u.body.id, u.body.login]).toEqual([200, OCTO.id, "octocat"]);
    expect((await get(e, "/v1/github/users/nobody-here")).status).toBe(404);
    expect((await get(e, "/v1/github/users/bad_login!")).status).toBe(400);
    const r = await get(e, `/v1/agents/${agent}/fee-route`);
    expect(r.body.route).toMatchObject({ github_id: String(OCTO.id), login: "octocat", bps: 2000, accrued: "777", pending: null });
    expect(r.body.bounds).toMatchObject({ min_bps: 1000, max_bps: 3000 });
    expect((await get(e, `/v1/agents/${generateAgentKey().id}/fee-route`)).body.route).toBeNull();
    const rec = await get(e, `/v1/fee-claims/recipients/${OCTO.id}`);
    expect(rec.body.escrow).toMatchObject({ accrued: "777", claimed: "0", claimable: "777", claim_seq: "0", wallet: null });
    expect(rec.body.agents).toEqual([{ agent, bps: 2000, accrued: "777", set_at: 1_900_000_000, pending_change: null }]);
    expect((await get(e, "/v1/fee-claims/recipients?login=octocat")).body.github_id).toBe(String(OCTO.id));
    expect((await get(e, "/v1/fee-claims/recipients/2")).body).toMatchObject({ escrow: null, agents: [] });
  });

  test("mock OAuth, wallet statement, attestation over the program's exact bytes", async () => {
    const { e, gh, attestor } = setup();
    const session = await oauthSession(e);
    expect(gh.calls).toEqual({ authorize: 1, token: 1, user: 1 });
    const s = await get(e, `/v1/fee-claims/session?session=${session}`);
    expect(s.body).toMatchObject({ github_id: String(OCTO.id), login: "octocat", method: "mock", wallet: null });
    // no wallet yet
    expect((await post(e, "/v1/fee-claims/attest", { session })).body.error).toBe("no_wallet");
    const wallet = generateAgentKey();
    // a statement for another account, by another key, stale, or future
    const other = walletProof(e, wallet, "mona");
    expect((await post(e, "/v1/fee-claims/wallet", { session, ...other })).status).toBe(400);
    const forged = { statement: feeClaimStatement("octocat", wallet.id, e.clock.now() / 1000), sig: signMessage(generateAgentKey(), feeClaimDigest(feeClaimStatement("octocat", wallet.id, e.clock.now() / 1000))) };
    expect((await post(e, "/v1/fee-claims/wallet", { session, ...forged })).status).toBe(403);
    expect((await post(e, "/v1/fee-claims/wallet", { session, ...walletProof(e, wallet, "octocat", e.clock.now() / 1000 - 90_000) })).status).toBe(400);
    const bound = await post(e, "/v1/fee-claims/wallet", { session, ...walletProof(e, wallet, "octocat") });
    expect([bound.status, bound.body.wallet]).toEqual([200, wallet.id]);
    const att = await post(e, "/v1/fee-claims/attest", { session: bound.body.session });
    expect(att.status).toBe(200);
    expect(att.body).toMatchObject({ github_id: String(OCTO.id), wallet: wallet.id, ceiling: "777", claim_seq: "0", attestor: attestor.id, rebind: null });
    expect(att.body.expires_at - Math.floor(e.clock.now() / 1000)).toBeLessThanOrEqual(600);
    expect(verifyAttestation(att.body, attestor.id)).toBe(true);
    // rate limit, then the record (no signature in it)
    expect((await post(e, "/v1/fee-claims/attest", { session: bound.body.session })).status).toBe(429);
    const log = await get(e, `/v1/fee-claims/attestations?github_id=${OCTO.id}`);
    expect(log.body).toHaveLength(1);
    expect(JSON.stringify(log.body)).not.toContain(att.body.signature);
    // a session cannot be edited: flipping the id breaks the MAC
    const [body, mac] = bound.body.session.split(".");
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), github_id: 2 })).toString("base64url");
    expect((await post(e, "/v1/fee-claims/attest", { session: `${edited}.${mac}` })).status).toBe(401);
    // and it expires
    e.clock.advance(901_000);
    expect((await post(e, "/v1/fee-claims/attest", { session: bound.body.session })).status).toBe(401);
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

  test("gist proof: the account's public gist holding the wallet's statement", async () => {
    const { e, gh, attestor } = setup();
    const wallet = generateAgentKey();
    const p = walletProof(e, wallet, "octocat");
    const url = gh.addGist("octocat", feeClaimGistText(p.statement, p.sig));
    const ok = await post(e, "/v1/fee-claims/proofs/gist", { gist_url: url });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ github_id: String(OCTO.id), login: "octocat", method: "gist", wallet: wallet.id });
    const att = await post(e, "/v1/fee-claims/attest", { session: ok.body.session });
    expect(verifyAttestation(att.body, attestor.id)).toBe(true);
    // the same statement posted by another account proves nothing for octocat (and nothing for Mona: it names octocat)
    const stolen = gh.addGist("Mona", feeClaimGistText(p.statement, p.sig));
    expect((await post(e, "/v1/fee-claims/proofs/gist", { gist_url: stolen })).status).toBe(400);
    // a gist URL that names another owner than the real one
    expect((await post(e, "/v1/fee-claims/proofs/gist", { gist_url: url.replace("octocat", "mona") })).status).toBe(400);
    // secret gist, missing gist, a statement signed by another key
    expect((await post(e, "/v1/fee-claims/proofs/gist", { gist_url: gh.addGist("octocat", feeClaimGistText(p.statement, p.sig), { public: false }) })).status).toBe(400);
    expect((await post(e, "/v1/fee-claims/proofs/gist", { gist_url: "https://gist.github.com/octocat/00000000000000000000000000000000" })).status).toBe(400);
    const bad = gh.addGist("octocat", feeClaimGistText(p.statement, signMessage(generateAgentKey(), feeClaimDigest(p.statement))));
    expect((await post(e, "/v1/fee-claims/proofs/gist", { gist_url: bad })).status).toBe(403);
    expect((await post(e, "/v1/fee-claims/proofs/gist", { gist_url: "https://example.com/x" })).status).toBe(400);
  });

  test("attest refuses: empty escrow, paused, an attestor the program does not trust; a pinned escrow is flagged as a rebind", async () => {
    let s = setup({ balance: 0n });
    let wallet = generateAgentKey();
    let p = walletProof(s.e, wallet, "octocat");
    let sess = (await post(s.e, "/v1/fee-claims/proofs/gist", { gist_url: s.gh.addGist("octocat", feeClaimGistText(p.statement, p.sig)) })).body.session;
    expect((await post(s.e, "/v1/fee-claims/attest", { session: sess })).status).toBe(409);
    s.e.close(); s.gh.stop();
    s = setup({ paused: true });
    p = walletProof(s.e, wallet, "octocat");
    sess = (await post(s.e, "/v1/fee-claims/proofs/gist", { gist_url: s.gh.addGist("octocat", feeClaimGistText(p.statement, p.sig)) })).body.session;
    expect((await post(s.e, "/v1/fee-claims/attest", { session: sess })).status).toBe(409);
    s.e.close(); s.gh.stop();
    s = setup({ attestorOnChain: generateAgentKey().id });
    p = walletProof(s.e, wallet, "octocat");
    sess = (await post(s.e, "/v1/fee-claims/proofs/gist", { gist_url: s.gh.addGist("octocat", feeClaimGistText(p.statement, p.sig)) })).body.session;
    expect((await post(s.e, "/v1/fee-claims/attest", { session: sess })).status).toBe(503);
    s.e.close(); s.gh.stop();
    const pinned = generateAgentKey().id;
    s = setup({ pinned, seq: 3n });
    wallet = generateAgentKey();
    p = walletProof(s.e, wallet, "octocat");
    sess = (await post(s.e, "/v1/fee-claims/proofs/gist", { gist_url: s.gh.addGist("octocat", feeClaimGistText(p.statement, p.sig)) })).body.session;
    const att = await post(s.e, "/v1/fee-claims/attest", { session: sess });
    expect(att.body).toMatchObject({ claim_seq: "3", rebind: { pinned_wallet: pinned, delay_s: 120 } });
    // Mona has no escrow
    const mw = generateAgentKey();
    const mp = walletProof(s.e, mw, "mona");
    const ms = (await post(s.e, "/v1/fee-claims/proofs/gist", { gist_url: s.gh.addGist("Mona", feeClaimGistText(mp.statement, mp.sig)) })).body.session;
    expect((await post(s.e, "/v1/fee-claims/attest", { session: ms })).status).toBe(404);
  });
});
