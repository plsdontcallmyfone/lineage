import { afterEach, describe, expect, test } from "bun:test";
import { genesisFileText, signGenesis, type UnsignedGenesis } from "../../identity/src/genesis-proof.ts";
import { linksOf } from "../src/links.ts";
import { generateAgentKey, type AgentKey } from "../src/protocol.ts";
import { agentClient, bare, expectOk } from "./helpers.ts";

// GitHub genesis proof recorded by Core (docs/plans/GITHUB-GENESIS.md 3): Core fetches
// lineage-proof.json from <login>/<login>, checks the signature against the agent's key at issued_at
// and that the identity service names the same login, against a fake raw host and identity service.

type E = ReturnType<typeof bare>;
let env: E | null = null;
afterEach(() => {
  env?.close();
  env = null;
});

async function launched(e: E, key: AgentKey = generateAgentKey()) {
  await expectOk(e.admin.c.post("/v1/admin/launches", { agent: key.id, mint: generateAgentKey().id, launcher: generateAgentKey().id, target_repo: "https://github.com/example/fx", hosted: true, identity_mode: "purchased" }));
  return agentClient(e, key);
}

function fakeHosts(files: Record<string, string>, logins: Record<string, string | null>) {
  return async (url: string) => {
    const raw = /^https:\/\/raw\.test\/([^/]+)\/([^/]+)\/HEAD\/lineage-proof\.json$/.exec(url);
    if (raw) {
      const t = files[`${raw[1]}/${raw[2]}`];
      return t === undefined ? new Response("404: Not Found", { status: 404 }) : new Response(t, { status: 200 });
    }
    const id = /^http:\/\/identity\.test\/identity\/agents\/([^/]+)$/.exec(url);
    if (id) return new Response(JSON.stringify({ agent: id[1], login: logins[id[1]!] ?? null }), { status: 200 });
    return new Response("nope", { status: 404 });
  };
}

const unsigned = (agent: string, login: string, at: number): UnsignedGenesis => ({
  v: 1, kind: "lineage-github-genesis", agent, mint: generateAgentKey().id, launch_tx: null, soul_digest: "a".repeat(64), target_repo: "https://github.com/example/fx",
  github_login: login, network: "devnet", site: "https://site.test", issued_at: at,
});

describe("genesis proof in Core", () => {
  test("verifies, is served, rechecks to broken when the file goes, and refuses forgeries", async () => {
    const e = bare();
    env = e;
    const a = await launched(e);
    const other = generateAgentKey();
    const files: Record<string, string> = {};
    const logins: Record<string, string | null> = { [a.id]: "poolacct9" };
    linksOf(e.core).configure({ fetch: fakeHosts(files, logins) as never, githubRaw: "https://raw.test", identityApi: "http://identity.test", recheckS: 60 });
    const now = Math.floor(e.clock.now() / 1000);

    // nothing there yet
    let r = await e.anon.post(`/v1/agents/${a.id}/genesis`, { login: "poolacct9" });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("no units-proof.json or lineage-proof.json");
    expect((await e.anon.get(`/v1/agents/${a.id}/genesis`)).status).toBe(404);

    // signed by a stranger: refused
    files["poolacct9/poolacct9"] = genesisFileText(signGenesis(other, unsigned(a.id, "poolacct9", now)));
    r = await e.anon.post(`/v1/agents/${a.id}/genesis`, { login: "poolacct9" });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("registry signing key");

    // a tampered field: refused
    const good = signGenesis(a.key, unsigned(a.id, "poolacct9", now));
    files["poolacct9/poolacct9"] = genesisFileText({ ...good, target_repo: "https://github.com/evil/x" });
    r = await e.anon.post(`/v1/agents/${a.id}/genesis`, { login: "poolacct9" });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("signature does not verify");

    // a proof naming another login than the repository owner: refused
    files["poolacct9/poolacct9"] = genesisFileText(signGenesis(a.key, unsigned(a.id, "someoneelse", now)));
    r = await e.anon.post(`/v1/agents/${a.id}/genesis`, { login: "poolacct9" });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("names login someoneelse");

    // the identity service names another account: refused
    files["poolacct9/poolacct9"] = genesisFileText(good);
    logins[a.id] = "different1";
    r = await e.anon.post(`/v1/agents/${a.id}/genesis`, { login: "poolacct9" });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain("identity service names different1");

    // the real thing
    logins[a.id] = "PoolAcct9";
    const row = await expectOk(e.anon.post(`/v1/agents/${a.id}/genesis`, { login: "PoolAcct9" }));
    expect(row).toMatchObject({ service: "github-genesis", handle: "poolacct9", status: "verified", url: "https://github.com/poolacct9/poolacct9", proof_url: "https://github.com/poolacct9/poolacct9/blob/HEAD/lineage-proof.json" });
    expect(await expectOk(e.anon.get(`/v1/agents/${a.id}/genesis`))).toMatchObject({ status: "verified", handle: "poolacct9" });
    // the agent profile lists it among its links; the ERC-8004 file does not treat it as a service
    const prof = await expectOk(e.anon.get(`/v1/agents/${a.id}/profile`));
    expect(prof.links.some((l: any) => l.service === "github-genesis" && l.status === "verified")).toBe(true);
    const reg = await expectOk(e.anon.get(`/v1/agents/${a.id}/registration.json`));
    expect(reg.services.some((s: any) => s.endpoint === "https://github.com/poolacct9/poolacct9")).toBe(false);

    // the recheck job: the file is replaced by another proof -> broken
    files["poolacct9/poolacct9"] = genesisFileText(signGenesis(a.key, unsigned(a.id, "poolacct9", now + 5)));
    e.clock.advance(61_000);
    e.core.tick();
    await linksOf(e.core).idle();
    expect(await expectOk(e.anon.get(`/v1/agents/${a.id}/genesis`))).toMatchObject({ status: "broken" });
    // recording again (the identity service after a re-publish) verifies the new proof
    expect(await expectOk(e.anon.post(`/v1/agents/${a.id}/genesis`, { login: "poolacct9" }))).toMatchObject({ status: "verified" });
    // the file is deleted -> broken on the next recheck
    delete files["poolacct9/poolacct9"];
    e.clock.advance(61_000);
    e.core.tick();
    await linksOf(e.core).idle();
    const after = await expectOk(e.anon.get(`/v1/agents/${a.id}/genesis`));
    expect(after.status).toBe("broken");
    expect(after.detail).toContain("no units-proof.json or lineage-proof.json");
    // unknown agent, bad login
    expect((await e.anon.post(`/v1/agents/${generateAgentKey().id}/genesis`, { login: "x" })).status).toBe(404);
    expect((await e.anon.post(`/v1/agents/${a.id}/genesis`, { login: "../x" })).status).toBe(400);
  });
});
