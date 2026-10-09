// Trade box for the token page (plan L3): buy and sell one agent token with a Wallet Standard
// wallet, on the Meteora DBC curve before graduation and on the DAMM v2 pool after. Part of the
// wallet bundle (/assets/wallet.js), so the dashboard bundle carries no transaction code.
//
// The venue is read from chain (AgentLaunch.graduated and the DBC pool's migration flag), never
// from the indexer. Every quote is a devnet simulation of the exact transaction the wallet will be
// asked to sign; the minimum out is the simulated output less the slippage tolerance. The wallet
// signs, the page sends and confirms. Balances are read back from chain after the trade.
import "../../../packages/chain/src/browser/buffer.ts";
import {
  ata,
  damm,
  dbc,
  decodeAgentLaunch,
  decodeDbcPool,
  decodeTokenAccount,
  explorerAddress,
  explorerTx,
  launchPdas,
  token,
  TOKEN_2022_PROGRAM,
  type AgentLaunch,
  type DbcPoolView,
  type Ix,
} from "../../../packages/chain/src/browser/index.ts";
import { esc, html, raw, type Raw } from "../src/html.ts";
import { banner, icon } from "../src/ui.ts";
import { tradeDecimals } from "./decimals.ts";
import { buildAndSimulate, devnetGate, loadChainCfg, parseUnits, rpc, signAndSend, sol, units, type Built, type ChainCfg } from "./chain.ts";
import { connect, DEVNET_CHAIN, disconnect, discovered, onChange, onWallets, startDiscovery, type StdAccount, type StdWallet } from "./standard.ts";

const T22 = TOKEN_2022_PROGRAM;

export interface TradeToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  decimals: number;
  phase: string;
}
export interface TradeBoxOptions {
  token: TradeToken;
  /** called after a confirmed trade with its signature */
  onTrade?: (signature: string, side: "buy" | "sell") => void;
}
export interface TradeBoxHandle {
  update(t: TradeToken): void;
  destroy(): void;
}

type Venue = { kind: "dbc"; pool: string; config: string } | { kind: "damm"; pool: string };

export function mountTradeBox(el: HTMLElement, opts: TradeBoxOptions): TradeBoxHandle {
  const box = new Box(el, opts);
  void box.init();
  return { update: (t) => box.update(t), destroy: () => box.destroy() };
}

class Box {
  private cfg: ChainCfg | null = null;
  private gate: "checking" | "ok" | string = "checking";
  private wallet: StdWallet | null = null;
  private account: StdAccount | null = null;
  private la: AgentLaunch | null = null;
  /** the mint's decimals read from chain in readVenue (audit A2 OFF-W1); null until read */
  private dec: number | null = null;
  private pool: DbcPoolView | null = null;
  private venue: Venue | null = null;
  private sol: bigint | null = null;
  private line: bigint | null = null;
  private tok: bigint | null = null;
  private side: "buy" | "sell" = "buy";
  private amount = "";
  private slip = "100";
  private quote: { side: "buy" | "sell"; amountIn: bigint; out: bigint; minOut: bigint; built: Built } | null = null;
  private msg: Raw | null = null;
  private err: Raw | null = null;
  private busy = false;
  private dead = false;
  private unsub: (() => void) | null = null;
  private offWallets: (() => void) | null = null;

  constructor(
    private el: HTMLElement,
    private opts: TradeBoxOptions,
  ) {}

  private get t() {
    return this.opts.token;
  }
  private sym() {
    return this.t.symbol ?? "token";
  }
  /** token decimals: the chain's once read; the indexer's only for display before that */
  private td() {
    return this.dec ?? this.t.decimals;
  }
  private qd() {
    return this.cfg?.state?.line_decimals ?? 6;
  }
  private lineMint() {
    return this.cfg!.state!.line_mint;
  }

  async init() {
    this.el.addEventListener("click", (ev) => void this.onClick(ev));
    this.el.addEventListener("input", (ev) => this.onInput(ev));
    startDiscovery();
    this.offWallets = onWallets(() => {
      this.render();
      this.autoReconnect();
    }) as () => void;
    this.render();
    try {
      this.cfg = await loadChainCfg();
      if (!this.cfg.state) throw new Error("This server has no devnet state (scripts/devnet/devnet.json).");
      await devnetGate();
      this.gate = "ok";
    } catch (e) {
      this.gate = (e as Error).message;
    }
    if (this.gate === "ok") await this.readVenue().catch((e) => (this.err = this.errBox(e)));
    this.render();
    this.autoReconnect();
  }

  update(t: TradeToken) {
    const was = this.t.phase;
    this.opts.token = { ...this.opts.token, ...t };
    // a graduation seen by the indexer: re-read the venue from chain
    if (t.phase !== was && this.gate === "ok") void this.readVenue().then(() => this.render(), () => {});
  }

  destroy() {
    this.dead = true;
    this.unsub?.();
    this.offWallets?.();
  }

  // ------------------------------------------------------------------------------------- chain

  private async readVenue() {
    const accs = await rpc.getMultipleAccounts([launchPdas.agentLaunch(this.t.mint), this.t.mint]);
    if (!accs[0]) throw new Error("No AgentLaunch account for this mint on devnet.");
    this.dec = tradeDecimals(accs[1]?.data, this.t.decimals);
    const la = decodeAgentLaunch(accs[0].data);
    const p = (await rpc.getMultipleAccounts([la.dbcPool]))[0];
    this.la = la;
    this.pool = p ? decodeDbcPool(p.data) : null;
    if (la.graduated) this.venue = { kind: "damm", pool: la.dammPool };
    else if (this.pool?.isMigrated) this.venue = { kind: "damm", pool: launchPdas.dammPool(la.mint, this.lineMint()) };
    else this.venue = { kind: "dbc", pool: la.dbcPool, config: la.dbcConfig };
  }

  private async readBalances() {
    const a = this.account?.address;
    if (!a || this.gate !== "ok") return;
    const [s, accs] = await Promise.all([rpc.getBalance(a), rpc.getMultipleAccounts([ata(a, this.lineMint(), T22), ata(a, this.t.mint, T22)])]);
    this.sol = s;
    this.line = accs[0] ? decodeTokenAccount(accs[0].data).amount : 0n;
    this.tok = accs[1] ? decodeTokenAccount(accs[1].data).amount : 0n;
  }

  private ixs(buy: boolean, amountIn: bigint, minOut: bigint): Ix[] {
    const a = this.account!.address;
    const v = this.venue!;
    const lm = this.lineMint();
    const lineAccount = ata(a, lm, T22);
    const agentAccount = ata(a, this.t.mint, T22);
    const pre = [token.createAtaIdempotent(a, a, lm, T22), token.createAtaIdempotent(a, a, this.t.mint, T22)];
    const swap =
      v.kind === "dbc"
        ? dbc.swap({ config: v.config, pool: v.pool, agentMint: this.t.mint, lineMint: lm, trader: a, lineAccount, agentAccount, buy, amountIn, minOut, lineTokenProgram: T22 })
        : damm.swap({ pool: v.pool, agentMint: this.t.mint, lineMint: lm, trader: a, lineAccount, agentAccount, buy, amountIn, minOut, lineTokenProgram: T22 });
    return [...pre, swap];
  }

  private async review() {
    if (!this.ready()) return;
    const buy = this.side === "buy";
    if (this.dec === null) await this.readVenue();
    const amountIn = parseUnits(this.amount, buy ? this.qd() : this.dec!);
    const slip = Number(this.slip);
    if (!amountIn || !Number.isInteger(slip) || slip < 0 || slip > 5000) {
      this.err = this.errBox("Enter a positive amount and a slippage tolerance between 0 and 5000 bps.");
      return this.render();
    }
    const have = buy ? this.line : this.tok;
    if (have !== null && amountIn > have) {
      this.err = this.errBox(`You hold ${units(have, buy ? this.qd() : this.td())} ${buy ? "tLINE" : this.sym()}.`);
      return this.render();
    }
    this.err = null;
    this.msg = html`<span class="dim">Simulating on devnet…</span>`;
    this.render();
    await this.readVenue();
    const built = await buildAndSimulate(this.account!.address, this.ixs(buy, amountIn, 1n), 300_000);
    const outAcc = buy ? ata(this.account!.address, this.t.mint, T22) : ata(this.account!.address, this.lineMint(), T22);
    const row = built.sim.accounts.find((x) => x.address === outAcc);
    const before = row?.dataBefore ? decodeTokenAccount(row.dataBefore).amount : 0n;
    const after = row?.dataAfter && row.dataAfter.length >= 165 ? decodeTokenAccount(row.dataAfter).amount : before;
    const out = after - before;
    this.quote = { side: this.side, amountIn, out, built, minOut: (out * BigInt(10_000 - slip)) / 10_000n || 1n };
    this.msg = null;
    if (built.sim.err) this.err = this.errBox(`Simulation failed: ${JSON.stringify(built.sim.err)}`, built.sim.logs);
    this.render();
  }

  private async sign() {
    const q = this.quote;
    if (!q || !this.ready()) return;
    this.err = null;
    const st = (m: string) => {
      this.msg = html`<span class="dim">${m}</span>`;
      this.render();
    };
    const r = await signAndSend({ wallet: this.wallet!, account: this.account!, ixs: this.ixs(q.side === "buy", q.amountIn, q.minOut), units: 300_000, onStatus: st });
    const c = r.confirmed!;
    if (c.err) throw Object.assign(new Error(`swap failed on chain: ${JSON.stringify(c.err)}`), { logs: c.logs });
    this.quote = null;
    this.amount = "";
    await this.readBalances();
    this.msg = html`<div class="mk-tb-done" data-sig="${c.signature}">${banner("info", html`${q.side === "buy" ? "Bought" : "Sold"} on ${this.venue?.kind === "damm" ? "DAMM v2" : "the curve"}: <a class="link" href="${explorerTx(c.signature)}" target="_blank" rel="noopener" title="${c.signature}">${c.signature.slice(0, 8)}… ${icon.ext}</a>`, "Your balances are read back from chain. The trade list and price update when the indexer has read it.")}</div>`;
    this.render();
    this.opts.onTrade?.(c.signature, q.side);
  }

  // ------------------------------------------------------------------------------------- wallet

  private ready(): boolean {
    if (this.gate !== "ok" || !this.venue) return false;
    if (!this.account || !this.wallet) return false;
    if (this.account.chains?.length && !this.account.chains.includes(DEVNET_CHAIN)) {
      this.err = this.errBox("This wallet account does not offer solana:devnet.");
      this.render();
      return false;
    }
    return true;
  }

  private async doConnect(name: string, silent = false) {
    const w = discovered().find((x) => x.name === name);
    if (!w) return;
    try {
      const acc = await connect(w, silent);
      if (!acc) throw new Error("the wallet returned no account");
      this.wallet = w;
      this.account = acc;
      try {
        localStorage.setItem("lineage-wallet", w.name);
      } catch {
        /* storage blocked */
      }
      this.unsub?.();
      this.unsub = onChange(w, () => {
        const a = w.accounts[0];
        if (a && a.address !== this.account?.address) {
          this.account = a;
          this.quote = null;
          void this.readBalances().then(() => this.render());
        }
      });
      this.err = null;
      await this.readBalances();
    } catch (e) {
      if (!silent) this.err = this.errBox(`Connect failed: ${(e as Error).message}`);
    }
    this.render();
  }

  private triedAuto = false;
  private autoReconnect() {
    if (this.triedAuto || this.account || this.gate !== "ok") return;
    let name: string | null = null;
    try {
      name = localStorage.getItem("lineage-wallet");
    } catch {
      /* ignore */
    }
    if (name && discovered().some((w) => w.name === name)) {
      this.triedAuto = true;
      void this.doConnect(name, true);
    }
  }

  // ------------------------------------------------------------------------------------- view

  private errBox(e: unknown, logs?: string[]): Raw {
    return html`<div class="banner bad" data-err>${icon.x}<div><div class="t1">${String((e as Error)?.message ?? e)}</div>${logs?.length ? html`<pre class="block wl-logs">${logs.slice(-10).join("\n")}</pre>` : ""}</div></div>`;
  }

  private btn(act: string, label: string | Raw, o: { primary?: boolean; disabled?: boolean; data?: Record<string, string> } = {}): Raw {
    return html`<button type="button" class="wl-btn${o.primary ? " primary" : ""}" data-tb="${act}"${raw(Object.entries(o.data ?? {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join(""))}${o.disabled ? raw(" disabled") : ""}>${label}</button>`;
  }

  private venueLine(): Raw {
    const v = this.venue;
    if (!v) return html`<span class="faint">reading the pool from devnet…</span>`;
    const pool = html`<a class="link" href="${explorerAddress(v.pool)}" target="_blank" rel="noopener" title="${v.pool}">${v.pool.slice(0, 4)}…${v.pool.slice(-4)}</a>`;
    return v.kind === "dbc"
      ? html`<span class="b info">Meteora DBC curve</span> ${pool}`
      : html`<span class="b good">Meteora DAMM v2</span> ${pool}${this.la && !this.la.graduated ? html` <span class="faint">(migrated, graduation pending)</span>` : ""}`;
  }

  private render() {
    if (this.dead) return;
    const qd = this.qd();
    const sym = this.sym();
    let body: Raw;
    if (this.gate === "checking") body = html`<div class="dim">Checking that the RPC is devnet…</div>`;
    else if (this.gate !== "ok") body = this.errBox(`Trading is off: ${this.gate}`);
    else if (!this.account) {
      const ws = discovered();
      body = html`<div class="mk-tb-venue">${this.venueLine()}</div>
        <div class="eyebrow" style="margin:12px 0 8px">Connect a wallet to trade</div>
        <div class="wl-wallets">${ws.length
          ? ws.map((w) => html`<button type="button" class="wl-wallet" data-tb="connect" data-name="${w.name}"><img src="${w.icon}" alt="" width="20" height="20"><span>${w.name}</span></button>`)
          : html`<div class="dim">No Wallet Standard wallet in this browser. Install <a class="link" href="https://phantom.com" target="_blank" rel="noopener">Phantom</a>, <a class="link" href="https://solflare.com" target="_blank" rel="noopener">Solflare</a> or <a class="link" href="https://backpack.app" target="_blank" rel="noopener">Backpack</a>, switch it to devnet and reload.</div>`}</div>
        <div class="wl-fine">Devnet only, TEST tokens. Get tLINE on the <a class="link" href="/wallet">Wallet page</a>.</div>`;
    } else {
      const q = this.quote;
      const buy = this.side === "buy";
      const inU = buy ? "tLINE" : sym;
      const outU = buy ? sym : "tLINE";
      const inD = buy ? qd : this.td();
      const outD = buy ? this.td() : qd;
      body = html`<div class="mk-tb-venue">${this.venueLine()}</div>
        <div class="mk-tb-acct"><span title="${this.account.address}">${this.wallet?.name ?? "Wallet"} ${this.account.address.slice(0, 4)}…${this.account.address.slice(-4)}</span>${this.btn("disconnect", "Disconnect")}</div>
        <div class="mk-tb-bal">
          <div><span class="eyebrow">tLINE</span><b class="num" data-bal="line">${this.line === null ? "TBA" : units(this.line, qd)}</b></div>
          <div><span class="eyebrow">${sym}</span><b class="num" data-bal="token">${this.tok === null ? "TBA" : units(this.tok, this.td())}</b></div>
          <div><span class="eyebrow">SOL</span><b class="num" data-bal="sol">${this.sol === null ? "TBA" : sol(this.sol)}</b></div>
        </div>
        <div class="seg mk-tb-side" role="group" aria-label="Side"><button type="button" data-tb="side" data-side="buy" aria-pressed="${String(buy)}">Buy</button><button type="button" data-tb="side" data-side="sell" aria-pressed="${String(!buy)}">Sell</button></div>
        <label class="wl-field mk-tb-f"><span class="eyebrow">${buy ? "Pay tLINE" : `Sell ${sym}`}</span><span class="mk-tb-in"><input name="tb_amount" inputmode="decimal" autocomplete="off" placeholder="0.0" value="${esc(this.amount)}"><button type="button" class="mk-tb-max" data-tb="max">Max</button></span></label>
        <label class="wl-field mk-tb-f"><span class="eyebrow">Slippage tolerance (bps)</span><input name="tb_slip" inputmode="numeric" value="${esc(this.slip)}"></label>
        ${q && !q.built.sim.err
          ? html`<div class="mk-tb-quote"><div><span>You pay</span><b class="num">${units(q.amountIn, inD)} ${inU}</b></div><div><span>You get (simulated)</span><b class="num" data-quote-out="${q.out}">${units(q.out, outD)} ${outU}</b></div><div><span>Minimum at your tolerance</span><b class="num">${units(q.minOut, outD)} ${outU}</b></div><div><span>Network fee</span><b class="num">${q.built.sim.fee === null ? "TBA" : sol(q.built.sim.fee)} SOL</b></div></div>`
          : ""}
        <div class="mk-tb-go">${q && !q.built.sim.err ? this.btn("sign", html`Sign and ${q.side}`, { primary: true, disabled: this.busy }) : this.btn("review", "Review", { primary: true, disabled: this.busy })}${q ? this.btn("clear", "Change") : ""}</div>`;
    }
    this.el.innerHTML = html`<div class="panel-b mk-tb">${body}${this.err ?? ""}${this.msg ? html`<div class="mk-tb-msg">${this.msg}</div>` : ""}</div>`.s;
  }

  private onInput(ev: Event) {
    const t = ev.target as HTMLInputElement;
    if (t.name === "tb_amount") this.amount = t.value.trim();
    else if (t.name === "tb_slip") this.slip = t.value.trim();
    else return;
    if (this.quote) {
      this.quote = null;
      // keep focus in the field being typed in
      const pos = t.selectionStart;
      this.render();
      const n = this.el.querySelector<HTMLInputElement>(`[name="${t.name}"]`);
      n?.focus();
      if (pos !== null) n?.setSelectionRange(pos, pos);
    }
  }

  private async onClick(ev: Event) {
    const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-tb]");
    if (!b || (b as HTMLButtonElement).disabled || this.busy) return;
    const act = b.dataset.tb!;
    this.busy = act === "review" || act === "sign";
    try {
      switch (act) {
        case "connect":
          await this.doConnect(b.dataset.name!);
          break;
        case "disconnect":
          if (this.wallet) await disconnect(this.wallet);
          this.wallet = this.account = null;
          this.quote = null;
          try {
            localStorage.removeItem("lineage-wallet");
          } catch {
            /* ignore */
          }
          break;
        case "side":
          this.side = b.dataset.side as "buy" | "sell";
          this.quote = null;
          this.amount = "";
          this.err = this.msg = null;
          break;
        case "max": {
          const have = this.side === "buy" ? this.line : this.tok;
          if (have !== null) this.amount = units(have, this.side === "buy" ? this.qd() : this.td()).replace(/,/g, "");
          this.quote = null;
          break;
        }
        case "clear":
          this.quote = null;
          break;
        case "review":
          this.msg = null;
          await this.review();
          break;
        case "sign":
          await this.sign();
          break;
      }
    } catch (e) {
      this.msg = null;
      this.err = this.errBox(e, (e as any)?.logs);
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
