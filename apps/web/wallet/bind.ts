// Finishing a hosted agent's bind (docs/plans/SEAMLESS-BIND.md). A launch carries its bind in the same
// wallet approval (bind-plan.ts), so this is what runs when that did not happen, and for agents
// launched before it existed: the one routine behind the launched screen, Profile > Manage and the
// "Finish setup" action on the agent's own page. It never needs to be found: each of those places
// calls it by itself, it retries what can be retried without the wallet, and it asks the wallet only
// for the one signature that is missing, after saying so.
import { registry } from "../../../packages/chain/src/browser/index.ts";
import { html } from "../src/html.ts";
import { banner, icon } from "../src/ui.ts";
import { declined, runtimeKeyOf, runtimeSend, takeSignedBind, type RuntimeKey } from "./bind-plan.ts";
import { loadChainCfg, reader, signAndSend } from "./chain.ts";
import { onSession, restoreSession, session, startDiscovery, type StdAccount, type StdWallet } from "./standard.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Answers of the runtime that pass by themselves: it has not read the launch yet, it is busy, the chain did not answer. */
const transient = (e: unknown) => [404, 409, 429, 502, 503].includes((e as { status?: number })?.status ?? 0) || e instanceof TypeError;

export class BindStop extends Error {}

export interface BindDone {
  newKey: string;
  /** the rotation's signature; null when the agent was already bound (the launch carried it) */
  signature: string | null;
}

/** The runtime's key for an agent on chain, waiting out the few seconds the runtime may need to read a launch that just landed. */
export async function awaitRuntimeKey(agent: string, tries = 20, gapMs = 3000): Promise<RuntimeKey | null> {
  for (let i = 0; i < tries; i++) {
    const t = await runtimeKeyOf(agent);
    if (t) return t;
    if (i < tries - 1) await sleep(gapMs);
  }
  return null;
}

async function settled(agent: string, newKey: string): Promise<boolean> {
  for (let i = 0; i < 8; i++) {
    if ((await reader.agent(agent).catch(() => null))?.signingKey === newKey) return true;
    await sleep(1500);
  }
  return false;
}

/** Sends one wallet-signed bind through the runtime, waiting out its transient answers. */
async function send(agent: string, wire: Uint8Array, say: (line: string) => void): Promise<{ signature: string; bound?: boolean }> {
  for (let i = 0; ; i++) {
    try {
      return await runtimeSend(agent, wire);
    } catch (e) {
      if (i >= 5 || !transient(e)) throw e;
      say("The hosted runtime is catching up with the launch. Trying again in a moment.");
      await sleep(2500);
    }
  }
}

/**
 * Binds `agent` to the hosted runtime's key unless it already is. Uses what the wallet signed with the
 * launch when that is still good; otherwise the wallet is asked for this one signature (said first in
 * `say`), once more by itself when the first one ran out of time. Throws BindStop with a plain line
 * when it cannot finish; a refusal in the wallet is thrown as it came.
 */
export async function finishBind(o: { agent: string; wallet: StdWallet | null; account: StdAccount | null; say: (line: string) => void; tries?: number }): Promise<BindDone> {
  const t = await awaitRuntimeKey(o.agent, o.tries);
  if (!t) throw new BindStop("The hosted runtime has not picked this agent up yet.");
  const rec = await reader.agent(o.agent);
  if (t.status === "bound" || rec?.signingKey === t.new_key) return { newKey: t.new_key, signature: null };
  const kept = takeSignedBind(o.agent, t.new_key);
  if (kept) {
    o.say("Finishing the setup your wallet already approved.");
    try {
      const r = await send(o.agent, kept.wire, o.say);
      if (r.bound || (await settled(o.agent, t.new_key))) return { newKey: t.new_key, signature: r.signature || null };
    } catch {
      // too late for that signature (its blockhash expired): the wallet is asked again below, and told why
    }
    o.say("The approval given with the launch ran out of time before the agent could be bound. Your wallet asks once more, for this one signature.");
  }
  if (!o.wallet || !o.account) throw new BindStop("Connect the wallet that launched this agent to finish its setup.");
  if (rec && rec.owner !== o.account.address) throw new BindStop("Only the wallet that launched this agent can finish its setup.");
  let last: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) o.say("That signature ran out of time before it was sent. Your wallet asks once more.");
    else if (!kept) o.say("One signature is missing: your wallet hands the agent's signing key to the hosted runtime.");
    const s = await signAndSend({ wallet: o.wallet, account: o.account, ixs: [registry.rotateAgentKey({ owner: o.account.address, agent: o.agent, newKey: t.new_key })], leaveFor: t.new_key });
    o.say("Signed. The hosted runtime is sending it.");
    try {
      const r = await send(o.agent, s.partial!, o.say);
      if (r.bound || (await settled(o.agent, t.new_key))) return { newKey: t.new_key, signature: r.signature || null };
      throw new BindStop("The binding was sent, and the chain has not shown it yet. Check again in a moment.");
    } catch (e) {
      if (e instanceof BindStop) throw e;
      last = e;
      // only an expired signature is worth asking the wallet for again
      if (!/blockhash|expired|block height/i.test(String((e as Error).message))) break;
    }
  }
  throw new BindStop(`The hosted runtime could not send the binding: ${String((last as Error)?.message ?? last).replace(/\.$/, "")}.`);
}

/** The plain line for a bind that did not finish (what is missing, never a stack of technical detail). */
export const bindProblem = (e: unknown): string =>
  e instanceof BindStop ? e.message : declined(e) ? "The signature was declined in the wallet. The agent starts working once it is given." : `The binding did not go through: ${String((e as Error)?.message ?? e).replace(/\.$/, "")}.`;

/**
 * "Finish setup" on an agent's own page (apps/web/src/pages/agent-profile.ts): shown to the agent's
 * owner while the hosted runtime waits for the bind, and to nobody else. One press, one signature.
 */
export async function mountBind(el: HTMLElement, o: { agent: string }): Promise<void> {
  let busy = false;
  let note: string | null = null;
  let done = false;
  let owner: string | null = null;
  let waiting = false;
  const paint = () => {
    const me = session().account?.address ?? null;
    const show = done || (waiting && !!owner && me === owner);
    el.hidden = !show;
    if (!show) return void (el.innerHTML = "");
    el.innerHTML = (done
      ? html`<section class="panel pf-bind" data-bind="done"><div class="panel-b">${banner("info", html`${icon.check} Setup finished`, "The hosted runtime now holds this agent's signing key. It starts working on the runtime's next pass.")}</div></section>`
      : html`<section class="panel pf-bind" data-bind="waiting"><div class="panel-b">${banner("warn", "Finish setup: this agent is not working yet", "You launched it, and one signature is still missing: your wallet hands the agent's signing key to the hosted runtime. Nothing else changes and it costs only the network fee.")}
          <div class="wl-row" style="margin-top:10px"><button type="button" class="wl-btn primary" data-bind-go${busy ? " disabled" : ""}>Finish setup: bind</button><span class="wl-why" data-bind-note>${note ?? ""}</span></div></div></section>`).s;
  };
  const check = async () => {
    const t = await runtimeKeyOf(o.agent);
    const rec = await reader.agent(o.agent).catch(() => null);
    owner = rec?.owner ?? null;
    waiting = !!t && t.status === "awaiting_owner" && !!rec && rec.hosted && rec.signingKey !== t.new_key;
    paint();
  };
  el.addEventListener("click", async (e) => {
    if (!(e.target as HTMLElement).closest("[data-bind-go]") || busy) return;
    busy = true;
    note = "Waiting for the wallet.";
    paint();
    const say = (line: string) => {
      note = line;
      const n = el.querySelector<HTMLElement>("[data-bind-note]");
      if (n) n.textContent = line;
    };
    try {
      const s = session();
      await finishBind({ agent: o.agent, wallet: s.wallet, account: s.account, say, tries: 3 });
      done = true;
    } catch (err) {
      note = bindProblem(err);
    } finally {
      busy = false;
      paint();
    }
  });
  await loadChainCfg().catch(() => undefined);
  startDiscovery();
  restoreSession();
  onSession(() => paint());
  await check().catch(() => undefined);
}
