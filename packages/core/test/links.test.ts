import { afterEach, describe, expect, test } from "bun:test";
import { addressBytes, pda, REGISTRY_PROGRAM_ID } from "@lineage/chain";
import { ERC8004_TYPE, erc8004Of, SOLANA_CAIP2 } from "../src/erc8004.ts";
import { domainProofJson, extractProofs, linksOf, linkStatement, proofText, signLink } from "../src/links.ts";
import { generateAgentKey, type AgentKey } from "../src/protocol.ts";
import { agentClient, bare, expectOk } from "./helpers.ts";

// Verified links (identity plan I3) and the ERC-8004 registration file (I6), against a fake GitHub
// and a real local HTTP server for the domain proof.

type E = ReturnType<typeof bare>;
let env: E | null = null;
let servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  env?.close();
  env = null;
  for (const s of servers) s.stop(true);
  servers = [];
});

/** A fake GitHub gist API: gists[id] = { owner, content, public? }. Anything else: 404. */
function fakeGithub(gists: Record<string, { owner: string; content: string; public?: boolean } | "down">) {
  return async (url: string) => {
    const m = /\/gists\/([0-9a-f]+)$/.exec(url);
    const g = m ? gists[m[1]!] : undefined;
    if (g === "down") throw new Error("connect ECONNREFUSED");
    if (!g) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify({ id: m![1], public: g.public ?? true, owner: { login: g.owner }, files: { "lineage-proof.md": { content: g.content, truncated: false } } }), { status: 200 });
  };
}

async function launched(e: E, key: AgentKey = generateAgentKey()) {
  await expectOk(e.admin.c.post("/v1/admin/launches", { agent: key.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: "https://github.com/example/fx", hosted: true, identity_mode: "purchased" }));
  return agentClient(e, key);
}

const GIST = "aa11bb22cc33dd44ee55ff66";

describe("verified links", () => {
  test("gist proof verifies, shows on card and registration file, turns broken when the gist is deleted", async () => {
    const e = bare();
    env = e;
    const a = await launched(e);
    const proof = signLink(a.key, linkStatement(a.id, "github", "PoolAcct1", e.clock.now() / 1000));
    expect(extractProofs(proofText(proof))).toEqual([proof]);
    const gists: Record<string, any> = { [GIST]: { owner: "PoolAcct1", content: proofText(proof) } };
    linksOf(e.core).configure({ fetch: fakeGithub(gists), recheckS: 60 });

    const added = await expectOk(a.c.post(`/v1/agents/${a.id}/links`, { service: "github", handle: "PoolAcct1", proof_url: `https://gist.github.com/PoolAcct1/${GIST}` }));
    expect(added).toMatchObject({ service: "github", handle: "poolacct1", status: "verified", proof_url: `https://gist.github.com/poolacct1/${GIST}` });
    const list = await expectOk(e.anon.get(`/v1/agents/${a.id}/links`));
    expect(list.map((l: any) => l.status)).toEqual(["verified"]);
    expect((await expectOk(e.anon.get("/v1/links"))).links).toHaveLength(1);

    const card = await expectOk(e.anon.get(`/v1/agents/${a.id}/card`));
    expect(card.protocolVersion).toBe("0.3.0");
    expect(card.lineage.links[0]).toMatchObject({ service: "github", handle: "poolacct1" });
    const reg = await expectOk(e.anon.get(`/v1/agents/${a.id}/registration.json`));
    expect(reg.services.some((s: any) => s.name === "GitHub" && s.endpoint === "https://github.com/poolacct1")).toBe(true);

    // within link_recheck_s nothing is fetched again
    e.core.tick();
    await linksOf(e.core).idle();
    // the gist is deleted; after link_recheck_s the tick's recheck marks the link broken
    delete gists[GIST];
    e.clock.advance(61_000);
    e.core.tick();
    await linksOf(e.core).idle();
    const after = (await expectOk(e.anon.get(`/v1/agents/${a.id}/links`)))[0];
    expect(after.status).toBe("broken");
    expect(after.detail).toContain("gist not found");
    const evs = await expectOk(e.anon.get("/v1/events/log?since=0"));
    expect(evs.map((x: any) => x.type)).toEqual(expect.arrayContaining(["link.verified", "link.broken"]));
    // a broken link leaves the card and the registration file
    expect((await expectOk(e.anon.get(`/v1/agents/${a.id}/card`))).lineage.links).toEqual([]);
  });

  test("refuses another account's gist, a stranger's signature, another agent and secret gists", async () => {
    const e = bare();
    env = e;
    const a = await launched(e);
    const b = await launched(e);
    const now = e.clock.now() / 1000;
    const good = signLink(a.key, linkStatement(a.id, "github", "acct1", now));
    const forged = signLink(generateAgentKey(), linkStatement(a.id, "github", "acct1", now));
    linksOf(e.core).configure({
      fetch: fakeGithub({
        ["1".repeat(20)]: { owner: "someoneelse", content: proofText(good) },
        ["2".repeat(20)]: { owner: "acct1", content: proofText(forged) },
        ["3".repeat(20)]: { owner: "acct1", content: proofText(good), public: false },
        ["4".repeat(20)]: { owner: "acct1", content: proofText(good) },
        ["5".repeat(20)]: "down",
      }),
    });
    const post = (c: typeof a, gist: string, handle = "acct1") => c.c.post(`/v1/agents/${a.id}/links`, { service: "github", handle, proof_url: `https://gist.github.com/${gist}` });
    const r1 = await post(a, "1".repeat(20));
    expect(r1.status).toBe(400);
    expect(r1.body.message).toContain("belongs to someoneelse");
    expect((await post(a, "2".repeat(20))).body.message).toContain("signature does not verify");
    expect((await post(a, "3".repeat(20))).body.message).toContain("secret");
    expect((await post(a, "5".repeat(20))).status).toBe(502);
    expect((await post(b, "4".repeat(20))).status).toBe(403); // b cannot add a's link
    expect((await post(a, "4".repeat(20), "other")).body.error).toBe("proof_invalid"); // statement names acct1
    expect((await a.c.post(`/v1/agents/${a.id}/links`, { service: "github", handle: "acct1", proof_url: "https://example.com/x" })).body.error).toBe("bad_proof_url");
    expect((await a.c.post(`/v1/agents/${a.id}/links`, { service: "x", handle: "acct1" })).body.error).toBe("bad_service");
    expect((await a.c.post(`/v1/agents/${a.id}/links`, { service: "domain", handle: "127.0.0.1" })).body.error).toBe("bad_handle");
    expect((await a.c.post(`/v1/agents/${a.id}/links`, { service: "domain", handle: "localhost" })).body.error).toBe("bad_handle");
    expect(await expectOk<any[]>(e.anon.get(`/v1/agents/${a.id}/links`))).toEqual([]);
    // the good one lands; a fetch failure on recheck is stale (not broken) and recovers
    await expectOk(post(a, "4".repeat(20)));
    linksOf(e.core).configure({ fetch: async () => new Response("rate limited", { status: 403 }) });
    let r = await expectOk(e.admin.c.post("/v1/admin/links/recheck", { force: true }));
    expect(r.results[0].status).toBe("stale");
    linksOf(e.core).configure({ fetch: fakeGithub({ ["4".repeat(20)]: { owner: "acct1", content: proofText(good) } }) });
    r = await expectOk(e.admin.c.post("/v1/admin/links/recheck", { force: true }));
    expect(r.results[0].status).toBe("verified");
    // the gist's statement replaced by another (still valid) one: broken, Core verified a specific statement
    const later = signLink(a.key, linkStatement(a.id, "github", "acct1", now + 10));
    linksOf(e.core).configure({ fetch: fakeGithub({ ["4".repeat(20)]: { owner: "acct1", content: proofText(later) } }) });
    e.clock.advance(20_000);
    r = await expectOk(e.admin.c.post("/v1/admin/links/recheck", { force: true }));
    expect(r.results[0].status).toBe("broken");
    // revoke
    expect((await a.c.request("DELETE", `/v1/agents/${a.id}/links/github/acct1`)).status).toBe(200);
    expect((await expectOk(e.anon.get(`/v1/agents/${a.id}/links`)))[0].status).toBe("revoked");
    expect((await expectOk(e.admin.c.post("/v1/admin/links/recheck", { force: true }))).checked).toBe(0);
  });

  test("domain proof served by a local test server verifies and breaks when removed", async () => {
    const e = bare();
    env = e;
    const a = await launched(e);
    let body: string | null = null;
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/.well-known/lineage-agent.json" && body ? new Response(body, { headers: { "content-type": "application/json" } }) : new Response("no", { status: 404 })) });
    servers.push(srv);
    const host = `127.0.0.1:${srv.port}`;
    linksOf(e.core).configure({ httpHosts: [host] });
    const other = generateAgentKey();
    body = domainProofJson([signLink(other, linkStatement(other.id, "domain", host, e.clock.now() / 1000)), signLink(a.key, linkStatement(a.id, "domain", host, e.clock.now() / 1000))]);
    const added = await expectOk(a.c.post(`/v1/agents/${a.id}/links`, { service: "domain", handle: host }));
    expect(added).toMatchObject({ status: "verified", proof_url: `http://${host}/.well-known/lineage-agent.json` });
    body = null;
    const r = await expectOk(e.admin.c.post("/v1/admin/links/recheck", { force: true }));
    expect(r.results[0]).toMatchObject({ status: "broken" });
  });
});

describe("ERC-8004 registration file", () => {
  test("carries every field the EIP lists and names the agent's registry PDA", async () => {
    const e = bare();
    env = e;
    const a = await launched(e);
    erc8004Of(e.core).configure({ siteUrl: "https://site.example" });
    const reg = await expectOk(e.anon.get(`/v1/agents/${a.id}/registration.json`));
    for (const k of ["type", "name", "description", "image", "services", "x402Support", "active", "registrations", "supportedTrust"]) expect(reg).toHaveProperty(k);
    expect(reg.type).toBe(ERC8004_TYPE);
    expect(reg.active).toBe(true);
    expect(reg.x402Support).toBe(false);
    for (const s of reg.services) {
      expect(typeof s.name).toBe("string");
      expect(typeof s.endpoint).toBe("string");
    }
    expect(reg.services.find((s: any) => s.name === "A2A")).toEqual({ name: "A2A", endpoint: `https://site.example/api/agents/${a.id}/card`, version: "0.3.0" });
    expect(reg.services.find((s: any) => s.name === "web").endpoint).toBe(`https://site.example/agents/${a.id}`);
    expect(reg.registrations).toEqual([{ agentId: a.id, agentRegistry: `${SOLANA_CAIP2.devnet}:${REGISTRY_PROGRAM_ID}`, agentAccount: pda(REGISTRY_PROGRAM_ID, "agent", addressBytes(a.id)) }]);
    expect(reg.supportedTrust).toContain("crypto-economic");
    expect((await e.anon.get(`/v1/agents/${generateAgentKey().id}/registration.json`)).status).toBe(404);
  });
});
