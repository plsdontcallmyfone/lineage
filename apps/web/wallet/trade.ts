// Trade box for the token page (plan L3): buy and sell one agent token with a Wallet Standard
// wallet, on the Meteora DBC curve before graduation and on the DAMM v2 pool after. Part of the
// wallet bundle (/assets/wallet.js), so the dashboard bundle carries no transaction code.
//
// The venue is read from chain (AgentLaunch.graduated and the DBC pool's migration flag), never
// from the indexer. Every quote is a simulation of the exact transaction the wallet will be asked to
// sign on the profile's cluster; the minimum out is the simulated output less the slippage
// tolerance. The wallet signs, the page sends and confirms. Balances are read back from chain after
// the trade. Mainnet (SPEC 14.9, 14.10): a buy may pay in SOL or USDC, swapped by Jupiter to the
// quote token in the same transaction (or a swap first when one does not fit, then the buy).
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
import { payAsset, payWithControl, prepareSwapThen, routeLines, sendSwapPlan, simulatePlan, withAction, type PreparedSwap } from "./swap.ts";
import { buildAndSimulate, clusterGate, isMainnet, loadChainCfg, netName, parseUnits, qsym, rpc, signAndSend, sol, testLabels, units, type Built, type ChainCfg } from "./chain.ts";
import { onSession, restoreSession, session, startDiscovery, walletChain, type StdAccount, type StdWallet } from "./standard.ts";

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
  /** pay with SOL or USDC (mainnet buys): the composed Jupiter swap and buy */
  private pay: "LINE" | "SOL" | "USDC" = "LINE";
  private swapQ: { prepared: PreparedSwap; amountIn: bigint; out: bigint | null; minOut: bigint | null; fee: bigint | null } | null = null;
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
    this.el.addEventListener("change", (ev) => this.onInput(ev));
    // the site's one wallet session (the header's Connect button); the box follows its changes
    startDiscovery();
    restoreSession();
    this.wallet = session().wallet;
    this.account = session().account;
    this.offWallets = onSession((s) => {
      if ((s.account?.address ?? null) === (this.account?.address ?? null)) return;
      this.wallet = s.wallet;
      this.account = s.account;
      this.quote = null;
      this.err = null;
      if (this.account) void this.readBalances().then(() => this.render());
      else this.render();
    });
    this.render();
    try {
      this.cfg = await loadChainCfg();
      if (!this.cfg.state) throw new Error(isMainnet() ? "Lineage is not deployed on mainnet yet (no mainnet state on this server)." : "This server has no devnet state (scripts/devnet/devnet.json).");
      await clusterGate();
      this.gate = "ok";
    } catch (e) {
      this.gate = (e as Error).message;
    }
    if (this.gate === "ok") await this.readVenue().catch((e) => (this.err = this.errBox(e)));
    if (this.account) await this.readBalances().catch(() => {});
    this.render();
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
    if (!accs[0]) throw new Error(`No AgentLaunch account for this mint on ${netName()}.`);
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
    if (buy && this.pay !== "LINE") return this.reviewSwap();
    const amountIn = parseUnits(this.amount, buy ? this.qd() : this.dec!);
    const slip = Number(this.slip);
    if (!amountIn || !Number.isInteger(slip) || slip < 0 || slip > 5000) {
      this.err = this.errBox("Enter a positive amount and a slippage tolerance between 0 and 5000 bps.");
      return this.render();
    }
    const have = buy ? this.line : this.tok;
    if (have !== null && amountIn > have) {
      this.err = this.errBox(`You hold ${units(have, buy ? this.qd() : this.td())} ${buy ? qsym() : this.sym()}.`);
      return this.render();
    }
    this.err = null;
    this.msg = html`<span class="dim">Simulating on ${netName()}…</span>`;
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

  /** Mainnet buy paid in SOL or USDC: Jupiter quote for exactly the typed quote amount, then the buy, simulated together. */
  private async reviewSwap() {
    const amountIn = parseUnits(this.amount, this.qd());
    const slip = Number(this.slip);
    if (!amountIn || !Number.isInteger(slip) || slip < 0 || slip > 5000) {
      this.err = this.errBox("Enter a positive amount and a slippage tolerance between 0 and 5000 bps.");
      return this.render();
    }
    this.err = null;
    this.quote = null;
    this.msg = html`<span class="dim">Asking Jupiter for a ${this.pay} route to ${units(amountIn, this.qd())} ${qsym()}…</span>`;
    this.render();
    await this.readVenue();
    const taker = this.account!.address;
    let prepared = await prepareSwapThen({ pay: this.pay as "SOL" | "USDC", need: amountIn, taker, action: this.ixs(true, amountIn, 1n), cuLimit: 600_000 });
    if (prepared.plan.mode === "two") {
      // the buy is simulated after the swap lands (it spends what the swap delivers)
      this.swapQ = { prepared, amountIn, out: null, minOut: null, fee: null };
      this.msg = null;
      return this.render();
    }
    this.msg = html`<span class="dim">Simulating the swap and the buy on ${netName()}…</span>`;
    this.render();
    const sim = await simulatePlan(prepared, taker);
    if (sim.err) {
      this.err = this.errBox(`Simulation failed: ${JSON.stringify(sim.err)}`, sim.logs);
      this.msg = null;
      return this.render();
    }
    const outAcc = ata(taker, this.t.mint, T22);
    const row = sim.accounts.find((x) => x.address === outAcc);
    const before = row?.dataBefore ? decodeTokenAccount(row.dataBefore).amount : 0n;
    const after = row?.dataAfter && row.dataAfter.length >= 165 ? decodeTokenAccount(row.dataAfter).amount : before;
    const out = after - before;
    const minOut = (out * BigInt(10_000 - slip)) / 10_000n || 1n;
    prepared = withAction(prepared, taker, this.ixs(true, amountIn, minOut));
    this.swapQ = { prepared, amountIn, out, minOut, fee: sim.fee };
    this.msg = null;
    this.render();
  }

  private async signSwap() {
    const q = this.swapQ!;
    const st = (m: string) => {
      this.msg = html`<span class="dim">${m}</span>`;
      this.render();
    };
    if (q.prepared.plan.mode === "two") {
      // the swap first; then the buy is reviewed in the quote token the wallet now holds
      const swapOnly = { ...q.prepared, plan: { mode: "one" as const, txs: [q.prepared.plan.txs[0]!] } };
      const [c] = await sendSwapPlan({ rpc, wallet: this.wallet!, account: this.account!, prepared: swapOnly, onStatus: st });
      this.swapQ = null;
      this.pay = "LINE";
      await this.readBalances();
      this.msg = html`<span class="dim">Swap landed (${c!.signature.slice(0, 8)}…); review the buy in ${qsym()}.</span>`;
      return this.review();
    }
    const cs = await sendSwapPlan({ rpc, wallet: this.wallet!, account: this.account!, prepared: q.prepared, onStatus: st });
    const c = cs[cs.length - 1]!;
    this.swapQ = null;
    this.amount = "";
    await this.readBalances();
    this.msg = html`<div class="mk-tb-done" data-sig="${c.signature}">${banner("info", html`Paid in ${q.prepared.pay}, bought on ${this.venue?.kind === "damm" ? "DAMM v2" : "the curve"}: <a class="link" href="${explorerTx(c.signature)}" target="_blank" rel="noopener" title="${c.signature}">${c.signature.slice(0, 8)}… ${icon.ext}</a>`, "Your balances are read back from chain.")}</div>`;
    this.render();
    this.opts.onTrade?.(c.signature, "buy");
  }

  private async sign() {
    if (this.swapQ) return this.signSwap();
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
    if (this.account.chains?.length && !this.account.chains.includes(walletChain())) {
      this.err = this.errBox(`This wallet account does not offer ${walletChain()}.`);
      this.render();
      return false;
    }
    return true;
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
    if (!v) return html`<span class="faint">reading the pool from ${netName()}…</span>`;
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
    if (this.gate === "checking") body = html`<div class="dim">Checking that the RPC is ${netName()}…</div>`;
    else if (this.gate !== "ok") body = this.errBox(`Trading is off: ${this.gate}`);
    else if (!this.account) {
      body = html`<div class="mk-tb-venue">${this.venueLine()}</div>
        <div class="eyebrow" style="margin:12px 0 8px">Connect a wallet to trade</div>
        <div class="wl-row">${this.btn("connect", "Connect", { primary: true })}</div>
        ${testLabels() ? html`<div class="wl-fine">Devnet only, TEST tokens. Get tLINE from the faucet on your <a class="link" href="/profile">Profile</a>.</div>` : html`<div class="wl-fine">Prices in ${qsym()}. A buy can pay in SOL or USDC through Jupiter.</div>`}`;
    } else {
      const q = this.quote;
      const buy = this.side === "buy";
      const inU = buy ? qsym() : sym;
      const outU = buy ? sym : qsym();
      const inD = buy ? qd : this.td();
      const outD = buy ? this.td() : qd;
      body = html`<div class="mk-tb-venue">${this.venueLine()}</div>
        <div class="mk-tb-acct"><span title="${this.account.address}">${this.wallet?.name ?? "Wallet"} ${this.account.address.slice(0, 4)}…${this.account.address.slice(-4)}</span><a class="link" href="/profile">Profile</a></div>
        <div class="mk-tb-bal">
          <div><span class="eyebrow">${qsym()}</span><b class="num" data-bal="line">${this.line === null ? "TBA" : units(this.line, qd)}</b></div>
          <div><span class="eyebrow">${sym}</span><b class="num" data-bal="token">${this.tok === null ? "TBA" : units(this.tok, this.td())}</b></div>
          <div><span class="eyebrow">SOL</span><b class="num" data-bal="sol">${this.sol === null ? "TBA" : sol(this.sol)}</b></div>
        </div>
        <div class="seg mk-tb-side" role="group" aria-label="Side"><button type="button" data-tb="side" data-side="buy" aria-pressed="${String(buy)}">Buy</button><button type="button" data-tb="side" data-side="sell" aria-pressed="${String(!buy)}">Sell</button></div>
        <label class="wl-field mk-tb-f"><span class="eyebrow">${buy ? `${this.pay === "LINE" ? "Pay" : "Spend"} ${qsym()}` : `Sell ${sym}`}</span><span class="mk-tb-in"><input name="tb_amount" inputmode="decimal" autocomplete="off" placeholder="0.0" value="${esc(this.amount)}"><button type="button" class="mk-tb-max" data-tb="max">Max</button></span></label>
        ${buy ? payWithControl("tb_pay", qsym(), this.pay) : ""}
        <label class="wl-field mk-tb-f"><span class="eyebrow">Slippage tolerance (bps)</span><input name="tb_slip" inputmode="numeric" value="${esc(this.slip)}"></label>
        ${q && !q.built.sim.err
          ? html`<div class="mk-tb-quote"><div><span>You pay</span><b class="num">${units(q.amountIn, inD)} ${inU}</b></div><div><span>You get (simulated)</span><b class="num" data-quote-out="${q.out}">${units(q.out, outD)} ${outU}</b></div><div><span>Minimum at your tolerance</span><b class="num">${units(q.minOut, outD)} ${outU}</b></div><div><span>Network fee</span><b class="num">${q.built.sim.fee === null ? "TBA" : sol(q.built.sim.fee)} SOL</b></div></div>`
          : ""}
        ${this.swapQ ? html`${routeLines(this.swapQ.prepared)}<div class="mk-tb-quote">${this.swapQ.out === null ? html`<div><span>You get</span><b>simulated after the swap lands (two transactions)</b></div>` : html`<div><span>You get (simulated)</span><b class="num" data-quote-out="${this.swapQ.out}">${units(this.swapQ.out, outD)} ${outU}</b></div><div><span>Minimum at your tolerance</span><b class="num">${units(this.swapQ.minOut, outD)} ${outU}</b></div><div><span>Network fee</span><b class="num">${this.swapQ.fee === null ? "TBA" : sol(this.swapQ.fee)} SOL</b></div>`}</div>` : ""}
        <div class="mk-tb-go">${(q && !q.built.sim.err) || this.swapQ ? this.btn("sign", html`Sign and ${this.swapQ ? (this.swapQ.out === null ? "swap" : "buy") : q!.side}`, { primary: true, disabled: this.busy }) : this.btn("review", "Review", { primary: true, disabled: this.busy })}${q || this.swapQ ? this.btn("clear", "Change") : ""}</div>`;
    }
    this.el.innerHTML = html`<div class="panel-b mk-tb">${body}${this.err ?? ""}${this.msg ? html`<div class="mk-tb-msg">${this.msg}</div>` : ""}</div>`.s;
  }

  private onInput(ev: Event) {
    const t = ev.target as HTMLInputElement;
    if (ev.type === "change" && t.name !== "tb_pay") return;
    if (t.name === "tb_amount") this.amount = t.value.trim();
    else if (t.name === "tb_slip") this.slip = t.value.trim();
    else if (t.name === "tb_pay") {
      this.pay = payAsset(t.value);
      this.quote = this.swapQ = null;
      return this.render();
    } else return;
    if (this.quote || this.swapQ) {
      this.quote = this.swapQ = null;
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
          // the header's Connect button owns the connection and its menu
          document.getElementById("cn-btn")?.click();
          break;
        case "side":
          this.side = b.dataset.side as "buy" | "sell";
          this.quote = this.swapQ = null;
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
          this.quote = this.swapQ = null;
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
