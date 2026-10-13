import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { base58Decode, base58Encode } from "../../packages/protocol/src/index.ts";
import { useProfilePrograms } from "../../packages/chain/src/programs.ts";
import * as reg from "../../packages/chain/src/registry.ts";
import { expect, test } from "./support/fixtures.ts";

// The "finish setting up" bar and its popup, and "Finish setup" on an agent's own page
// (docs/plans/SEAMLESS-BIND.md, apps/web/wallet/setup-bar.ts, apps/web/wallet/bind.ts). A wallet that
// launched a hosted agent which is still not bound sees one slim bar above the navigation; one press
// opens a popup whose Bind button runs the bind (the wallet signs one transaction, the hosted runtime
// co-signs and sends it), and the bar is gone once nothing is unbound.
//
// Nothing is sent anywhere: the hosted runtime's answers and the one agent record are stand-ins made
// here, the wallet is a throwaway key made for the run, and the write guard still refuses every
// sendTransaction. Every other read is the site's own.

const registryPdas = reg.registryPdas;
// the registry of the site under test (its public profile), so the stood-in record sits where the page looks for it
test.beforeAll(async ({ request }) => {
  const c = await (await request.get("/chain/config")).json();
  if (c?.profile?.programs) useProfilePrograms(c.profile);
});
const key = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(12));
  return { address: base58Encode(pub), pub, sign: (m: Uint8Array) => new Uint8Array(sign(null, Buffer.from(m), createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" })))) };
};
const WALLET = "units Setup Test Wallet";
const launcher = key(), agent = key().address, runtimeKey = key().address, mint = key().address;

/** An Agent v2 record as the registry stores it: a hosted launch owned by `owner`, speaking with `signingKey`. */
function agentRecord(o: { agent: string; owner: string; mint: string; signingKey: string }): string {
  const u = (n: number, v = 0) => Buffer.alloc(n, v);
  const a = (s: string) => Buffer.from(base58Decode(s));
  const data = Buffer.concat([
    createHash("sha256").update("account:Agent").digest().subarray(0, 8),
    a(o.agent), a(o.owner), Buffer.of(1), a(o.mint), Buffer.of(1), // kind launched, hosted
    u(8 * 5), u(4), u(8), u(2), u(8), u(8), u(32), u(32), u(8), Buffer.of(255), // bonds, strikes, operator, capabilities, registered_at, bump
    a(o.signingKey), u(4), u(8), u(32), u(4), u(32), u(8), u(32), // Agent v2: signing key, key_seq, key_changed_at, profile, pending owner, owner_since, the rest
  ]);
  return data.toString("base64");
}

/** A Wallet Standard wallet that signs with the throwaway key (the page only ever sees signatures), remembered as a returning visitor. */
async function installWallet(ctx: BrowserContext, w: ReturnType<typeof key>, signed: string[]) {
  await ctx.exposeFunction("__setupSign", (b64: string) => {
    const wire = Buffer.from(b64, "base64");
    const message = wire.subarray(1 + 64 * wire[0]!);
    signed.push(createHash("sha256").update(message).digest("hex"));
    Buffer.from(w.sign(message)).copy(wire, 1); // the launcher is the fee payer: the first signature
    return wire.toString("base64");
  });
  await ctx.addInitScript(({ address, pub, name }: { address: string; pub: number[]; name: string }) => {
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    try { localStorage.setItem("units-wallet", name); } catch {}
    const chains = ["solana:devnet", "solana:mainnet"];
    const account = { address, publicKey: new Uint8Array(pub), chains, features: ["solana:signTransaction", "solana:signMessage"], label: "setup test" };
    const w = {
      version: "1.0.0", name, chains, accounts: [] as unknown[],
      icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#2a78d6"/></svg>'),
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => { w.accounts = [account]; return { accounts: [account] }; } },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => { w.accounts = []; } },
        "standard:events": { version: "1.0.0", on: () => () => {} },
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0],
          signTransaction: async (...inputs: { transaction: Uint8Array }[]) => Promise.all(inputs.map(async (i) => ({ signedTransaction: unb64(await (window as any).__setupSign(b64(i.transaction))) }))) },
        "solana:signMessage": { version: "1.0.0", signMessage: async () => { throw new Error("not used"); } },
      },
    };
    window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
  }, { address: w.address, pub: Array.from(w.pub), name: WALLET });
}

/** The stand-ins: the runtime's list and bind endpoint, the agent's record on chain, its name and coin. Returns what was posted. */
async function standIns(page: Page, o: { agent: string; owner: string; waiting: boolean; profile?: boolean }) {
  const st = { bound: !o.waiting, posted: [] as any[], unboundAsked: [] as string[] };
  const record = registryPdas.agent(o.agent);
  await page.route("**/runtime/unbound/*", (route) => {
    const w = new URL(route.request().url()).pathname.split("/").pop()!;
    st.unboundAsked.push(w);
    return route.fulfill({ json: { owner: w, agents: w === o.owner && !st.bound ? [{ agent: o.agent, new_key: runtimeKey, mint }] : [] } });
  });
  await page.route(`**/runtime/bind/${o.agent}`, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { agent: o.agent, new_key: runtimeKey, status: st.bound ? "bound" : "awaiting_owner" } });
    const body = JSON.parse(route.request().postData() ?? "{}");
    st.posted.push(body);
    st.bound = true; // the runtime co-signed and sent it
    return route.fulfill({ json: { agent: o.agent, new_key: runtimeKey, signature: "5".repeat(88) } });
  });
  await page.route("**/chain/rpc", async (route) => {
    const q = JSON.parse(route.request().postData() ?? "null");
    if (q?.method === "getAccountInfo" && q.params?.[0] === record)
      return route.fulfill({ json: { jsonrpc: "2.0", id: q.id, result: { context: { slot: 1 }, value: { data: [agentRecord({ agent: o.agent, owner: o.owner, mint, signingKey: st.bound ? runtimeKey : o.agent }), "base64"], owner: reg.REGISTRY_PROGRAM_ID, lamports: 3_000_000, executable: false, rentEpoch: 0, space: 0 } } } });
    // the rotation's own transaction is never looked up on chain: it was never sent
    if (q?.method === "getTransaction") return route.fulfill({ json: { jsonrpc: "2.0", id: q.id, result: null } });
    return route.fallback();
  });
  if (o.profile !== false) await page.route(`**/api/agents/${o.agent}/profile`, (route) => route.fulfill({ json: { soul: { name: "Basalt" }, hosted: true, launcher: o.owner, mint } }));
  await page.route(`**/market/tokens/${mint}`, (route) => route.fulfill({ json: { mint, name: "Basalt base58", symbol: "BSLT" } }));
  return st;
}

test.describe("finish setting up: the bar above the navigation", () => {
  test("the launcher of an unbound hosted agent sees the bar; its popup binds with one signature and both go away", async ({ page, context }) => {
    const signed: string[] = [];
    await installWallet(context, launcher, signed);
    const st = await standIns(page, { agent, owner: launcher.address, waiting: true });
    await page.goto("/");
    const bar = page.locator("#setup-bar");
    await expect(bar).toBeVisible({ timeout: 60_000 });
    await expect(bar.locator('[data-sb="open"]')).toHaveText("Finish setting up Basalt");
    // above the navigation, inside the page's width, with nothing spilling sideways
    const [b, h] = [await bar.boundingBox(), await page.locator("header.top").boundingBox()];
    expect(b!.y + b!.height).toBeLessThanOrEqual(h!.y + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const open = await bar.locator('[data-sb="open"]').boundingBox();
    expect(open!.x).toBeGreaterThanOrEqual(0);
    expect(open!.x + open!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await bar.evaluate((e) => getComputedStyle(e.querySelector(".sb-go")!).fontFamily)).not.toMatch(/mono/i);

    if (process.env.SETUP_SHOTS) await page.screenshot({ path: `${process.env.SETUP_SHOTS}/bar-${page.viewportSize()!.width}.png` });
    await bar.locator('[data-sb="open"]').click();
    const modal = page.locator(".sb-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("role", "dialog");
    await expect(modal.locator(".sb-row")).toHaveCount(1);
    await expect(modal).toContainText("Basalt");
    await expect(modal).toContainText("$BSLT");
    await expect(modal.locator(".sb-p")).toHaveText("One signature from your wallet lets the hosted runtime start working for this agent. Nothing else changes and it costs only the network fee.");
    await expect(modal).not.toContainText(/—|devnet|test/i);
    const box = await modal.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);

    if (process.env.SETUP_SHOTS) await page.screenshot({ path: `${process.env.SETUP_SHOTS}/popup-${page.viewportSize()!.width}.png` });
    await modal.locator('[data-sb="bind"]').click();
    await expect(modal.locator(".sb-row")).toHaveAttribute("data-state", "done", { timeout: 90_000 });
    await expect(modal).toContainText("bound");
    // one signature, of a transaction that is exactly the rotation the runtime was then handed
    expect(signed).toHaveLength(1);
    expect(st.posted).toHaveLength(1);
    expect(Object.keys(st.posted[0])).toEqual(["tx"]);
    const wire = Buffer.from(st.posted[0].tx, "base64");
    expect(createHash("sha256").update(wire.subarray(1 + 64 * wire[0]!)).digest("hex")).toBe(signed[0]);
    expect(wire[0]).toBe(2); // the launcher and the runtime's key sign
    expect(wire.includes(Buffer.from(base58Decode(runtimeKey)))).toBe(true);
    expect(wire.includes(Buffer.from(base58Decode(registryPdas.agent(agent))))).toBe(true);
    // the popup closes itself and the bar is gone
    await expect(modal).toHaveCount(0, { timeout: 10_000 });
    await expect(bar).toBeHidden();
    await page.reload();
    await page.locator("header.top").waitFor();
    await expect.poll(() => st.unboundAsked.length).toBeGreaterThan(1);
    await expect(bar).toBeHidden();
  });

  test("hidden for a wallet with nothing unbound and for a visitor with no wallet; it takes no room and loads no wallet code", async ({ page, context, browser }) => {
    const other = key();
    await installWallet(context, other, []);
    const st = await standIns(page, { agent, owner: launcher.address, waiting: true });
    const scripts: string[] = [];
    page.on("request", (r) => void (r.url().endsWith("/assets/wallet.js") && scripts.push(r.url())));
    await page.goto("/");
    await expect.poll(() => st.unboundAsked, { timeout: 60_000 }).toEqual([other.address]);
    const bar = page.locator("#setup-bar");
    await expect(bar).toBeHidden();
    expect(await bar.evaluate((e) => e.getBoundingClientRect().height)).toBe(0);
    expect((await page.locator("header.top").boundingBox())!.y).toBe(0);
    expect(scripts).toEqual([]);
    // no wallet at all: not even the question is asked
    const ctx2 = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: page.viewportSize()! });
    const p2 = await ctx2.newPage();
    const asked: string[] = [];
    await p2.route("**/runtime/unbound/*", (route) => (asked.push(route.request().url()), route.fulfill({ json: { agents: [] } })));
    await p2.goto("/");
    await p2.locator("header.top").waitFor();
    await p2.waitForTimeout(5000);
    await expect(p2.locator("#setup-bar")).toBeHidden();
    expect(asked).toEqual([]);
    await ctx2.close();
  });

  test("dismissed for this visit only; a refusal in the wallet leaves the agent waiting and says so", async ({ page, context }) => {
    await installWallet(context, launcher, []);
    await standIns(page, { agent, owner: launcher.address, waiting: true });
    await page.goto("/");
    const bar = page.locator("#setup-bar");
    await expect(bar).toBeVisible({ timeout: 60_000 });
    // the wallet says no
    await page.evaluate(() => { (window as any).__setupSign = async () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); }; });
    await bar.locator('[data-sb="open"]').click();
    await page.locator('.sb-modal [data-sb="bind"]').click();
    await expect(page.locator(".sb-modal [data-sb-note]")).toHaveText("The signature was declined in the wallet. The agent starts working once it is given.", { timeout: 60_000 });
    await expect(page.locator('.sb-modal [data-sb="bind"]')).toBeEnabled();
    await page.locator('.sb-modal [data-sb="close"]').click();
    await expect(page.locator(".sb-modal")).toHaveCount(0);
    await expect(bar).toBeVisible();
    await bar.locator('[data-sb="dismiss"]').click();
    await expect(bar).toBeHidden();
    await page.reload(); // the same visit
    await page.locator("header.top").waitFor();
    await page.waitForTimeout(4000);
    await expect(bar).toBeHidden();
    // the next visit: it is back while the agent is unbound
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await expect(bar).toBeVisible({ timeout: 60_000 });
  });
});

test.describe("finish setup on the agent's own page", () => {
  test("the owner of a hosted agent the runtime still waits on gets Finish setup at the top of its page, and one press binds it", async ({ page, context, data }) => {
    // a real hosted agent's page (its record's owner is stood in as the test wallet; nothing is sent)
    const coins = await data.coins();
    let real: string | null = null;
    for (const c of coins.slice(0, 12)) {
      const p = await page.request.get(`/api/agents/${c.agent}/profile`).then((r) => (r.ok() ? r.json() : null)).catch(() => null);
      if (p?.hosted) {
        real = c.agent as string;
        break;
      }
    }
    test.skip(!real, "the site lists no hosted agent");
    const signed: string[] = [];
    await installWallet(context, launcher, signed);
    const st = await standIns(page, { agent: real!, owner: launcher.address, waiting: true, profile: false });
    await page.goto(`/agents/${real}/profile`);
    const box = page.locator("#pf-bind");
    await expect(box.locator('[data-bind="waiting"]')).toBeVisible({ timeout: 90_000 });
    await expect(box).toContainText("Finish setup: this agent is not working yet");
    // at the top: above the profile's header
    expect((await box.boundingBox())!.y).toBeLessThan((await page.locator(".pf-head").boundingBox())!.y);
    if (process.env.SETUP_SHOTS) await page.screenshot({ path: `${process.env.SETUP_SHOTS}/profile-${page.viewportSize()!.width}.png` });
    await box.locator("[data-bind-go]").click();
    await expect(box.locator('[data-bind="done"]')).toBeVisible({ timeout: 90_000 });
    await expect(box).toContainText("Setup finished");
    expect(signed).toHaveLength(1);
    expect(st.posted).toHaveLength(1);
  });

  test("nobody else sees it: another wallet on the same page gets no Finish setup", async ({ page, context, data }) => {
    const coins = await data.coins();
    let real: string | null = null;
    for (const c of coins.slice(0, 12)) {
      const p = await page.request.get(`/api/agents/${c.agent}/profile`).then((r) => (r.ok() ? r.json() : null)).catch(() => null);
      if (p?.hosted) {
        real = c.agent as string;
        break;
      }
    }
    test.skip(!real, "the site lists no hosted agent");
    await installWallet(context, key(), []);
    await standIns(page, { agent: real!, owner: launcher.address, waiting: true, profile: false });
    await page.goto(`/agents/${real}/profile`);
    await page.locator(".pf-head").waitFor({ timeout: 90_000 });
    await page.waitForTimeout(6000);
    await expect(page.locator("#pf-bind")).toBeHidden();
    await expect(page.locator("#setup-bar")).toBeHidden();
  });
});
