import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "@playwright/test";
import { base58Decode, base58Encode } from "../../packages/protocol/src/index.ts";
import { decodeMessage, parseWire, placeSignature } from "../../packages/chain/src/browser/wire.ts";
import { launchPdas } from "../../packages/chain/src/launch.ts";
import * as programs from "../../packages/chain/src/programs.ts";
const useProfilePrograms = programs.useProfilePrograms;
import { PUMP } from "../../packages/chain/src/pump.ts";
import * as reg from "../../packages/chain/src/registry.ts";
import { newSoul } from "../../packages/souls/src/schema.ts";
import { expect, plainLaunch, test, type Page } from "./support/fixtures.ts";

// A hosted launch through the wizard with the bind REQUIRED and its backup signature
// (docs/plans/SEAMLESS-BIND.md sections 9 and 10; apps/web/wallet/bind-plan.ts, chain.ts, main.ts).
//
// Nothing is sent anywhere and nothing real is signed for: the wallet is a throwaway key made for the
// run that signs whatever it is shown, and every sendTransaction and sendBundle of the page is answered
// here and never reaches a node. The hosted runtime (reservation, co-signature, health) is a stand-in
// whose key is another throwaway; its co-signature is a real signature over the message the wallet
// signed. Everything else the wizard reads (prices, the pool, the repository, rent) is the site's own;
// the launcher's SOL balance is stood in so the review opens.
//
//   normal        one approval carries the launch, the bind and its backup; both co-signed before the first send
//   slow          the reservation answers late: one plain line while it waits, then the review as usual
//   unavailable   no reservation: the launch is not built, one sentence, Try again; the wallet is never asked
//   gone at sign  the runtime stops answering after the review was built: nothing is signed
//   tab closed    the page is closed the moment the launch was sent: the runtime already holds both rotations
//   delayed       the launch lands without its bind and the runtime is away: "Nothing more to sign."

const key = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(12));
  return { address: base58Encode(pub), pub, sign: (m: Uint8Array) => new Uint8Array(sign(null, Buffer.from(m), createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" })))) };
};
const addr = () => base58Encode(randomBytes(32));
const WALLET = "units Bind Test Wallet";
const ONE_PX_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const WAIT_LINE = "Getting the agent's runtime key…";
const NO_KEY = "The hosted runtime did not give this agent its key, so the launch was not built. Nothing was signed or sent.";
const NO_ANSWER = "The hosted runtime is not answering, so nothing was signed. Try again.";
const BACKUP_WAIT = "Your agent will start as soon as the runtime is back. Nothing more to sign.";

test.beforeAll(async ({ request }) => {
  const c = await (await request.get("/chain/config")).json();
  if (c?.profile?.programs) useProfilePrograms(c.profile);
});

interface World {
  launcher: ReturnType<typeof key>;
  runtime: ReturnType<typeof key>;
  nonce: { account: string; value: string };
  /** how the stood-in runtime answers a reservation: "ok", "down", or a number of refusals before it answers */
  reserve: "ok" | "down" | number;
  /** the runtime answers nothing at all (as when the bind service is unreachable behind the gate) */
  runtimeDown: boolean;
  /** everything in the order it happened: wallet requests, runtime calls, sends */
  events: string[];
  /** transactions per wallet request */
  walletRequests: number[];
  agent: string | null;
  mint: string | null;
  cosigned: { durable: boolean; programs: string[] }[];
  sent: string[];
  /** the bundle is refused and the last ordered send (the bind) fails: the launch lands without its bind */
  bindFailsOnSend: boolean;
  landed: boolean;
  bound: boolean;
}
const world = (o: Partial<World> = {}): World => ({ launcher: key(), runtime: key(), nonce: { account: addr(), value: addr() }, reserve: "ok", runtimeDown: false, events: [], walletRequests: [], agent: null, mint: null, cosigned: [], sent: [], bindFailsOnSend: false, landed: false, bound: false, ...o });

/** A Wallet Standard wallet that signs with the throwaway key, remembered as a returning visitor. */
async function installWallet(ctx: BrowserContext, w: World) {
  await ctx.exposeFunction("__bindBatch", (n: number) => void (w.walletRequests.push(n), w.events.push(`wallet:${n}`)));
  await ctx.exposeFunction("__bindSign", (b64: string) => {
    const wire = Buffer.from(b64, "base64");
    const message = wire.subarray(1 + 64 * wire[0]!);
    Buffer.from(w.launcher.sign(message)).copy(wire, 1); // the launcher is the fee payer: the first signature
    return wire.toString("base64");
  });
  await ctx.addInitScript(({ address, pub, name }: { address: string; pub: number[]; name: string }) => {
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    try { localStorage.setItem("units-wallet", name); } catch {}
    const chains = ["solana:devnet", "solana:mainnet"];
    const account = { address, publicKey: new Uint8Array(pub), chains, features: ["solana:signTransaction", "solana:signMessage"], label: "bind test" };
    const w = {
      version: "1.0.0", name, chains, accounts: [] as unknown[],
      icon: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#2a78d6"/></svg>'),
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => { w.accounts = [account]; return { accounts: [account] }; } },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => { w.accounts = []; } },
        "standard:events": { version: "1.0.0", on: () => () => {} },
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0],
          signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
            await (window as any).__bindBatch(inputs.length);
            return Promise.all(inputs.map(async (i) => ({ signedTransaction: unb64(await (window as any).__bindSign(b64(i.transaction))) })));
          } },
        "solana:signMessage": { version: "1.0.0", signMessage: async () => { throw new Error("not used"); } },
      },
    };
    window.addEventListener("wallet-standard:app-ready", (e: any) => e.detail.register(w));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(w) }));
  }, { address: w.launcher.address, pub: Array.from(w.launcher.pub), name: WALLET });
}

const disc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const a32 = (s: string) => Buffer.from(base58Decode(s));
const zeros = (n: number) => Buffer.alloc(n);
/** An Agent v2 record: a hosted launch owned by the launcher, speaking with `signingKey`. */
const agentRecord = (o: { agent: string; owner: string; mint: string; signingKey: string }) =>
  Buffer.concat([disc("Agent"), a32(o.agent), a32(o.owner), Buffer.of(1), a32(o.mint), Buffer.of(1), zeros(8 * 5), zeros(4), zeros(8), zeros(2), zeros(8), zeros(8), zeros(32), zeros(32), zeros(8), Buffer.of(255),
    a32(o.signingKey), zeros(4), zeros(8), zeros(32), zeros(4), zeros(32), zeros(8), zeros(32)]).toString("base64");
/** An AgentLaunch record of a hosted pump.fun launch. */
function launchRecord(o: { agent: string; mint: string; launcher: string }) {
  const url = Buffer.from("https://github.com/keis/base58");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(url.length);
  const created = Buffer.alloc(8);
  created.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)));
  return Buffer.concat([disc("AgentLaunch"), a32(o.agent), a32(o.mint), a32(o.launcher), zeros(32), len, url, Buffer.of(2), Buffer.of(1), a32(PUMP.program), a32(addr()), a32(addr()), a32(addr()), zeros(32), Buffer.of(0), Buffer.of(1), created, zeros(8 * 5)]).toString("base64");
}

// A runtime that does not answer is stood in by a request that never completes for the page (the guard's own
// allowed console line, net::ERR_BLOCKED_BY_CLIENT): to the page it is the same as a gate that could not reach it.
/** The stand-ins: the hosted runtime, the launcher's SOL, every send, and (once "landed") the launch's two records. */
async function standIns(page: Page, w: World) {
  page.on("request", (r) => {
    const m = /\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})\.json/.exec(r.url());
    if (m) w.mint = m[1]!;
  });
  await page.route("**/runtime/bind/health", (route) => (w.runtimeDown ? route.abort("blockedbyclient") : route.fulfill({ json: { ok: true, backup: { ok: true, ready: 3 } } })));
  await page.route(/\/runtime\/bind\/[1-9A-HJ-NP-Za-km-z]{32,44}$/, async (route) => {
    const agent = new URL(route.request().url()).pathname.split("/").pop()!;
    if (w.runtimeDown) return route.abort("blockedbyclient");
    if (route.request().method() === "GET") return w.landed ? route.fulfill({ json: { agent, new_key: w.runtime.address, status: w.bound ? "bound" : "awaiting_owner" } }) : route.abort("blockedbyclient");
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (body.reserve === true) {
      w.agent = agent;
      if (w.reserve === "down") return (w.events.push("reserve:refused"), route.abort("blockedbyclient"));
      if (typeof w.reserve === "number" && w.reserve > 0) return (w.reserve--, w.events.push("reserve:refused"), route.abort("blockedbyclient"));
      w.events.push("reserve:ok");
      return route.fulfill({ json: { agent, new_key: w.runtime.address, status: "reserved", expires_at: Math.floor(Date.now() / 1000) + 900, nonce: w.nonce } });
    }
    if (body.sign_only === true) {
      // a real co-signature over the message the wallet signed
      const wire = new Uint8Array(Buffer.from(body.tx, "base64"));
      const m = decodeMessage(parseWire(wire).message);
      const durable = m.instructions[0]?.programId === "11111111111111111111111111111111";
      w.cosigned.push({ durable, programs: m.instructions.map((i) => i.programId) });
      w.events.push(durable ? "cosign:backup" : "cosign:bind");
      const back = placeSignature(wire, w.runtime.address, w.runtime.sign(parseWire(wire).message));
      return route.fulfill({ json: { agent, new_key: w.runtime.address, tx: Buffer.from(back).toString("base64"), signature: "5".repeat(88) } });
    }
    // a send asked of the runtime (the launched screen finishing a bind): it is away
    return route.abort("blockedbyclient");
  });
  await page.route("**/chain/rpc", async (route) => {
    const q = JSON.parse(route.request().postData() ?? "null");
    const ok = (result: unknown) => route.fulfill({ json: { jsonrpc: "2.0", id: q.id, result } });
    const sigOf = (b64: string) => base58Encode(parseWire(new Uint8Array(Buffer.from(b64, "base64"))).signatures[0]!);
    switch (q?.method) {
      case "getBalance":
        return q.params?.[0] === w.launcher.address ? ok({ context: { slot: 1 }, value: 5_000_000_000 }) : route.fallback();
      case "sendBundle": {
        if (w.bindFailsOnSend) return route.fulfill({ json: { jsonrpc: "2.0", id: q.id, error: { code: -32602, message: "bundle refused (stand-in)" } } });
        const sigs = (q.params[0] as string[]).map(sigOf);
        w.sent.push(...sigs);
        w.events.push(`bundle:${sigs.length}`);
        w.landed = w.bound = true;
        return ok("bundle-stand-in");
      }
      case "getInflightBundleStatuses":
        return ok({ context: { slot: 1 }, value: [{ bundle_id: "bundle-stand-in", status: "Landed", landed_slot: 5 }] });
      case "getBundleStatuses":
        return ok({ context: { slot: 1 }, value: [] });
      case "sendTransaction": {
        const wire = new Uint8Array(Buffer.from(q.params[0], "base64"));
        const isBind = decodeMessage(parseWire(wire).message).keys.includes(w.runtime.address);
        if (isBind && w.bindFailsOnSend) {
          w.events.push("send:bind-refused");
          return route.fulfill({ json: { jsonrpc: "2.0", id: q.id, error: { code: -32002, message: "Transaction simulation failed (stand-in)", data: { err: "AccountNotFound", logs: [] } } } });
        }
        const sig = sigOf(q.params[0]);
        if (!w.sent.includes(sig)) w.sent.push(sig);
        w.events.push(isBind ? "send:bind" : "send:launch");
        w.landed = true;
        if (isBind) w.bound = true;
        return ok(sig);
      }
      case "getSignatureStatuses":
        if ((q.params[0] as string[]).some((s) => w.sent.includes(s))) return ok({ context: { slot: 5 }, value: (q.params[0] as string[]).map((s) => (w.sent.includes(s) ? { slot: 5, confirmations: 1, err: null, confirmationStatus: "confirmed" } : null)) });
        return route.fallback();
      case "getTransaction":
        return w.sent.includes(q.params?.[0]) ? ok(null) : route.fallback();
      case "getSignaturesForAddress":
        return w.landed ? ok([]) : route.fallback();
      case "getAccountInfo": {
        if (!w.landed || !w.agent || !w.mint) return route.fallback();
        // owned by the site's own programs, as the page's readers require
        const value = (data: string, owner: string) => ok({ context: { slot: 5 }, value: { data: [data, "base64"], executable: false, lamports: 2_000_000, owner, rentEpoch: 0, space: 0 } });
        if (q.params[0] === launchPdas.agentLaunch(w.mint)) return value(launchRecord({ agent: w.agent, mint: w.mint, launcher: w.launcher.address }), programs.LAUNCH_PROGRAM_ID);
        if (q.params[0] === reg.registryPdas.agent(w.agent)) return value(agentRecord({ agent: w.agent, owner: w.launcher.address, mint: w.mint, signingKey: w.bound ? w.runtime.address : w.agent }), programs.REGISTRY_PROGRAM_ID);
        return ok({ context: { slot: 5 }, value: null });
      }
      default:
        return route.fallback();
    }
  });
  // what the launched screen posts and polls after a launch: none of it is this spec's subject
  await page.route(/\/(souls\/publish|api\/tweet-launches|identity\/.*)$/, (route) => (route.request().method() === "GET" ? route.fallback() : route.fulfill({ status: 200, json: {} })));
}

/** Walks the wizard to the Review step with a hosted launch on keis/base58. */
async function toReview(page: Page, name: string) {
  const persona = JSON.parse(readFileSync(join(__dirname, "../../scripts/launch-e2e/STATE.json"), "utf8")).soul_core.doc.persona;
  await page.route("**/souls/draft", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const doc = newSoul({ agent: body.agent, seed: { vibe: body.vibe || "dry and exacting", specialty: "keis/base58: measured improvements, same behaviour", values: ["measure before claiming"], lines: body.lines ?? "" }, persona, created_at: Math.floor(Date.now() / 1000) } as Parameters<typeof newSoul>[0]);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ doc, usd: 0 }) });
  });
  await page.route("**/social/media/*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/coin/image/*", (r) => r.fulfill({ status: 200, contentType: "image/png", body: ONE_PX_PNG }));
  await page.goto("/launch");
  await page.locator(".lz-nav").waitFor({ timeout: 30_000 });
  await page.locator("#cn-btn.on").waitFor({ timeout: 30_000 });
  await page.fill('[name="l_name"]', name);
  await page.fill('[name="l_symbol"]', "UIBIND");
  await page.fill('[name="l_desc"]', "A check of the required bind. Nothing is launched by this run.");
  await page.locator('[name="l_image"]').setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: ONE_PX_PNG });
  await page.click('[data-act="lz-next"]');
  await page.fill('[name="l_repo"]', "https://github.com/keis/base58");
  await page.locator("#w-work .lz-rec, #w-work .banner, #w-work .dim").first().waitFor({ timeout: 60_000 });
  await plainLaunch(page);
  await expect(page.locator('input[name="l_hosted"][value="hosted"]')).toBeChecked();
  await page.click('[data-act="lz-next"]');
  await page.fill('[name="s_vibe"]', "dry, exact, cheerful about small wins");
  await page.locator(".wl-soul .wl-hash").waitFor({ timeout: 60_000 });
  await page.click('[data-act="lz-next"]');
  await expect(page.locator("#w-id-price")).not.toHaveText(/^$|price from Core/, { timeout: 60_000 });
  await page.click('[data-act="lz-next"]');
  await expect(page.locator("[data-fronting-total]")).toHaveText(/\$[\d,]*\.?\d+/, { timeout: 60_000 });
  await page.click('[data-act="lz-next"]');
}
const reviewReady = (page: Page) => page.locator('#w-launch-out [data-act="launch-sign"]').waitFor({ timeout: 90_000 });

test.describe("a hosted launch and its bind", () => {
  // each case walks the whole wizard against the live site's reads
  test.setTimeout(300_000);

  test("normal: one approval for the launch, the bind and its backup; both co-signed before anything is sent", async ({ page, context, guard }) => {
    const w = world();
    await installWallet(context, w);
    await standIns(page, w);
    guard.allowWrite(/^\/chain\/rpc$/); // every send is answered by the stand-in above; none reaches a node
    await toReview(page, "ui bind normal");
    await reviewReady(page);
    // the review: the bind is a transaction of the approval, the backup a row with no fee
    const review = page.locator('[data-step="5"]');
    await expect(review.locator(".wl-why")).toContainText("the hosted runtime's binding with them and a backup of it that does not expire");
    await review.locator("details.lz-tech summary").click();
    const backupRow = review.locator("tr[data-tx-backup]");
    await expect(backupRow).toContainText("bind backup");
    await expect(backupRow).toContainText("the hosted runtime keeps it and sends it only if the binding above did not land");
    await expect(backupRow).toContainText("no fee unless used");
    await expect(review.locator('tr[data-tx]').filter({ hasText: "hands the agent's signing key to the hosted runtime" })).toHaveCount(1);
    expect(w.walletRequests, "nothing is signed before Launch is pressed").toEqual([]);
    await page.click('[data-act="launch-sign"]');
    await expect.poll(() => w.sent.length, { timeout: 60_000 }).toBeGreaterThan(0);
    // one request to the wallet, holding the launch's transactions plus the bind and the backup
    expect(w.walletRequests.length).toBe(1);
    const firstSend = w.events.findIndex((e) => e.startsWith("send:") || e.startsWith("bundle:"));
    const before = w.events.slice(0, firstSend);
    expect(before.filter((e) => e === "cosign:bind").length, "the bind was co-signed before the first send").toBe(1);
    expect(before.filter((e) => e === "cosign:backup").length, "the backup was handed to the runtime before the first send").toBe(1);
    expect(before.indexOf("wallet:" + w.walletRequests[0])).toBeLessThan(before.indexOf("cosign:bind"));
    // the reservation was asked for again right before the wallet was
    expect(w.events.slice(0, w.events.indexOf("wallet:" + w.walletRequests[0])).filter((e) => e === "reserve:ok").length).toBeGreaterThanOrEqual(2);
    // the backup: the advance of the key's nonce account first, then the budget and one rotation; never sent by the page
    const backup = w.cosigned.find((c) => c.durable)!;
    expect(backup.programs[0]).toBe("11111111111111111111111111111111");
    expect(backup.programs.filter((p) => p === "11111111111111111111111111111111").length).toBe(1);
    expect(w.sent.length, "the backup is not among what the page sent").toBe(w.walletRequests[0]! - 1);
    // the launched screen ends at bound by itself
    const row = page.locator('[data-track="runtime"]');
    await expect(row).toHaveAttribute("data-state", "ok", { timeout: 90_000 });
    await expect(row).toContainText("the hosted runtime's");
    await expect(page.locator('[data-act="rt-bind"]')).toHaveCount(0);
    expect(w.walletRequests.length, "the wallet was asked once in all").toBe(1);
  });

  test("slow reservation: one plain line while it waits, then the review; unavailable: refused in one sentence, nothing signed", async ({ page, context, guard }) => {
    const w = world({ reserve: 3 });
    await installWallet(context, w);
    await standIns(page, w);
    void guard;
    // the launch is built as soon as the Funding step opens, so the line is watched for from the start
    const sawWait = page.waitForFunction((line) => document.querySelector("#w-launch-out [data-bind-wait]")?.textContent === line, WAIT_LINE, { timeout: 240_000, polling: 100 });
    await toReview(page, "ui bind slow");
    await sawWait;
    await reviewReady(page);
    expect(w.events.filter((e) => e === "reserve:refused").length).toBe(3);
    await expect(page.locator('[data-step="5"] .wl-why')).toContainText("the hosted runtime's binding with them");

    // now the runtime hands out nothing: building again is refused, with a way to try again
    w.reserve = "down";
    await page.click('[data-act="launch-review"]');
    await expect(page.locator("#w-launch-out [data-bind-wait]")).toHaveText(WAIT_LINE, { timeout: 30_000 });
    await expect(page.locator("#w-launch-out")).toContainText(NO_KEY, { timeout: 60_000 });
    await expect(page.locator('#w-launch-out [data-act="launch-sign"]')).toHaveCount(0);
    const again = page.locator('#w-launch-out [data-act="launch-review"]');
    await expect(again).toHaveText("Try again");
    expect(w.walletRequests, "the wallet was never asked").toEqual([]);
    expect(w.sent).toEqual([]);
    // Try again works once the runtime is back
    w.reserve = "ok";
    await again.click();
    await reviewReady(page);
    expect(w.walletRequests).toEqual([]);
  });

  test("the runtime stops answering after the review was built: Launch signs nothing and says so", async ({ page, context, guard }) => {
    const w = world();
    await installWallet(context, w);
    await standIns(page, w);
    void guard;
    await toReview(page, "ui bind gone");
    await reviewReady(page);
    w.runtimeDown = true;
    await page.click('[data-act="launch-sign"]');
    await expect(page.locator("#w-launch-status")).toContainText(NO_ANSWER, { timeout: 60_000 });
    expect(w.walletRequests, "the wallet was never asked").toEqual([]);
    expect(w.sent).toEqual([]);
    // the button is there again: nothing was consumed
    await expect(page.locator('[data-act="launch-sign"]')).toBeEnabled();
  });

  test("tab closed right after the launch was sent: the runtime already holds the bind and its backup", async ({ page, context, guard }) => {
    const w = world();
    await installWallet(context, w);
    await standIns(page, w);
    guard.allowWrite(/^\/chain\/rpc$/);
    await toReview(page, "ui bind closed");
    await reviewReady(page);
    await page.click('[data-act="launch-sign"]');
    await expect.poll(() => w.events.some((e) => e.startsWith("send:") || e.startsWith("bundle:")), { timeout: 60_000 }).toBe(true);
    const at = w.events.findIndex((e) => e.startsWith("send:") || e.startsWith("bundle:"));
    await page.close();
    // what the server needs to finish by itself was with it before the first send left the page
    expect(w.events.slice(0, at)).toEqual(expect.arrayContaining(["cosign:bind", "cosign:backup"]));
    expect(w.walletRequests.length).toBe(1);
  });

  test("delayed: the launch lands without its bind and the runtime is away; the screen says nothing more is to be signed", async ({ page, context, guard }) => {
    const w = world({ bindFailsOnSend: true });
    await installWallet(context, w);
    await standIns(page, w);
    guard.allowWrite(/^\/chain\/rpc$/);
    await toReview(page, "ui bind delayed");
    await reviewReady(page);
    await page.click('[data-act="launch-sign"]');
    await expect.poll(() => w.events.includes("send:bind-refused"), { timeout: 90_000 }).toBe(true);
    expect(w.events).toEqual(expect.arrayContaining(["cosign:bind", "cosign:backup", "send:launch"]));
    w.runtimeDown = true; // the hosted runtime is away from here on
    const row = page.locator('[data-track="runtime"]');
    await expect(row.locator("[data-bind-backup]")).toHaveText(BACKUP_WAIT, { timeout: 120_000 });
    await expect(row).toHaveAttribute("data-state", "wait");
    await expect(page.locator('[data-act="rt-bind"]')).toHaveCount(0);
    expect(w.walletRequests.length, "the wallet was asked once, for the launch, and never again").toBe(1);
    // the runtime comes back and the agent is bound (its backup landed): the screen finds it by itself
    w.runtimeDown = false;
    w.bound = true;
    await expect(row).toHaveAttribute("data-state", "ok", { timeout: 120_000 });
    await expect(row.locator("[data-bind-backup]")).toHaveCount(0);
    expect(w.walletRequests.length).toBe(1);
  });
});
