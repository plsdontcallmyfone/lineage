// Trade box for the token page (plan L3): buy and sell one agent token with a Wallet Standard
// wallet, on its pump.fun bonding curve (Pump buy_exact_quote_in_v3 / sell_v3) before graduation and
// on its canonical PumpSwap pool (buy_exact_quote_in_v2 / sell_v2) after (owner decisions 2026-10-10).
// Tokens launched on the earlier Meteora venue (devnet history) are read only here. Part of the
// wallet bundle (/assets/wallet.js), so the dashboard bundle carries no transaction code.
//
// The venue is read from chain (AgentLaunch.venue and graduated, the bonding curve and the pool),
// never from the indexer. Every quote is a simulation of the exact transaction the wallet will be asked to
// sign on the profile's cluster; the minimum out is the simulated output less the slippage
// tolerance. The wallet signs, the page sends and confirms. Balances are read back from chain after
// the trade. Mainnet (SPEC 14.9, 14.10): a buy may pay in SOL or USDC, swapped by Jupiter to the
// quote token in the same transaction (or a swap first when one does not fit, then the buy).
import "../../../packages/chain/src/browser/buffer.ts";
import {
  ata,
  curveMigrated,
  decodeAgentLaunch,
  decodeBondingCurve,
  decodeTokenAccount,
  explorerAddress,
  explorerTx,
  launchPdas,
  pump,
  PUMP,
  pumpAmm,
  pumpPdas,
  token,
  system,
  rentLamports,
  launchTempWsol,
  LAUNCH_WSOL_SEED,
  TOKEN_ACCOUNT_LEN,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  type AgentLaunch,
  type BondingCurve,
  type Hop,
  type Ix,
} from "../../../packages/chain/src/browser/index.ts";
import { esc, html, raw, type Raw } from "../src/html.ts";
import { banner, icon } from "../src/ui.ts";
import { tradeDecimals } from "./decimals.ts";
import { payAsset, payWithControl, prepareSwapThen, routeLines, sendSwapPlan, simulatePlan, withAction, type PreparedSwap } from "./swap.ts";
import { buildAndSimulate, clusterGate, isMainnet, loadChainCfg, NET, netName, parseUnits, qsym, rpc, signAndSend, sol, testLabels, units, type Built, type ChainCfg } from "./chain.ts";
import { fmtUsd, loadUsd, quoteToUsd, solToUsd } from "../src/usd.ts";
import { onSession, restoreSession, session, startDiscovery, walletChain, type StdAccount, type StdWallet } from "./standard.ts";

const T22 = TOKEN_2022_PROGRAM;

export interface TradeToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  decimals: number;
  phase: string;
  /** the token's US dollar price from the indexer; null or absent when it has none */
  price_usd?: number | null;
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

/** curve: on its bonding curve; pool: on its PumpSwap pool; waiting: curve complete, migration pending; legacy: a Meteora-era token (read only). */
type Venue = { kind: "curve"; pool: string } | { kind: "pool"; pool: string } | { kind: "waiting"; pool: string } | { kind: "legacy"; pool: string };

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
  private curve: BondingCurve | null = null;
  private venue: Venue | null = null;
  private sol: bigint | null = null;
  private line: bigint | null = null;
  private tok: bigint | null = null;
  private side: "buy" | "sell" = "buy";
  private amount = "";
  private slip = "100";
  private quote: { side: "buy" | "sell"; amountIn: bigint; out: bigint; minOut: bigint; built: Built; /** paid in SOL through the quote coin's curve */ sol?: boolean } | null = null;
  /** pay with SOL or USDC (mainnet buys): the composed Jupiter swap and buy */
  private pay: "LINE" | "SOL" | "USDC" = "LINE";
  private swapQ: { prepared: PreparedSwap; amountIn: bigint; out: bigint | null; minOut: bigint | null; fee: bigint | null } | null = null;
  private msg: Raw | null = null;
  private err: Raw | null = null;
  private busy = false;
  /** the gear: slippage and the Pay with choice */
  private settings = false;
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
  /**
   * The US dollar value of an amount in the box (owner 2026-10-12), as " ($12.34)" beside it: SOL and the
   * quote coin at the indexer's reading (src/usd.ts), the token at the indexer's price_usd. The wallet
   * pays in SOL or the quote coin, so those amounts stay; "$ unavailable" when there is no dollar price.
   */
  private usd(base: bigint, unit: "sol" | "quote" | "token"): string {
    const ui = Number(base) / 10 ** (unit === "sol" ? 9 : unit === "quote" ? this.qd() : this.td());
    return fmtUsd(unit === "sol" ? solToUsd(ui) : unit === "quote" ? quoteToUsd(ui) : this.t.price_usd == null ? null : ui * this.t.price_usd);
  }
  /** The typed amount in dollars, for the line under the input; empty when nothing valid is typed. */
  private typedUsd(): string {
    const solIn = this.solBuy(), buy = this.side === "buy";
    if (/%$/.test(this.amount) || !/^\d*\.?\d+$/.test(this.amount.replace(/,/g, ""))) return "";
    const v = Number(this.amount.replace(/,/g, ""));
    if (!(v > 0)) return "";
    return `about ${fmtUsd(solIn ? solToUsd(v) : buy ? quoteToUsd(v) : this.t.price_usd == null ? null : v * this.t.price_usd)}`;
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
    void loadUsd().then(() => this.render()); // the dollar price behind the values beside each amount (src/usd.ts)
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
      if (!this.cfg.state) throw new Error(isMainnet() ? "units is not deployed on mainnet yet (no mainnet state on this server)." : "This server has no devnet state (scripts/devnet/devnet.json).");
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
    this.la = la;
    if (la.venue === "meteora") {
      this.venue = { kind: "legacy", pool: la.bondingCurve };
      return;
    }
    const pool = pumpPdas.pool(la.mint, this.lineMint());
    const [c, p] = await rpc.getMultipleAccounts([la.bondingCurve, pool]);
    this.curve = c ? decodeBondingCurve(c.data) : null;
    if (la.graduated || p || (this.curve && curveMigrated(this.curve))) this.venue = { kind: "pool", pool };
    else if (this.curve?.complete) this.venue = { kind: "waiting", pool };
    else this.venue = { kind: "curve", pool: la.bondingCurve };
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
    // the buyback recipient's $UNITS account must exist for every pump.fun trade in $UNITS (anyone may create it)
    const pre = [token.createAtaIdempotent(a, a, lm, T22), token.createAtaIdempotent(a, a, this.t.mint, T22),
      token.createAtaIdempotent(a, PUMP.buybackRecipients[0], lm, T22)];
    if (v.kind !== "curve" && v.kind !== "pool") throw new Error(v.kind === "legacy" ? "This token was launched on the earlier Meteora venue and is read only here." :
      "The curve is complete; trading resumes on PumpSwap once anyone runs the migration.");
    const t = { mint: this.t.mint, quoteMint: lm, quoteTokenProgram: T22, user: a, userBase: agentAccount, userQuote: lineAccount };
    const swap = v.kind === "curve"
      ? buy ? pump.buyExactQuoteInV3({ ...t, spendableQuoteIn: amountIn, minTokensOut: minOut }) : pump.sellV3({ ...t, amount: amountIn, minQuoteOut: minOut })
      : buy ? pumpAmm.buyExactQuoteInV2({ ...t, pool: v.pool, spendableQuoteIn: amountIn, minBaseOut: minOut })
      : pumpAmm.sellV2({ ...t, pool: v.pool, baseIn: amountIn, minQuoteOut: minOut });
    return [...pre, swap];
  }

  /**
   * SOL straight in when Jupiter is off for this deployment (a mainnet profile with swap false: the
   * mainnet test's throwaway quote coin): pump.fun's multi_hop_swap, SOL to the quote coin on its own
   * curve or, once it has migrated, its canonical PumpSwap pool, then to this token on its curve or pool, one
   * transaction. Proven on the mainnet fork (curve then curve: scripts/mainnet/test-rehearsal.ts; pool then curve and
   * pool then pool: scripts/mainnet/pump-fork-proof.ts steps 7b and 9c). The review simulates it before anything is signed.
   */
  /** The quote coin has migrated: its hop of a SOL buy runs on its canonical PumpSwap pool (set when a SOL buy is reviewed). */
  private lineOnPool = false;
  /** Rent of a token account at the cluster's rate (the temporary wrapped SOL account's; it comes back when the account closes). */
  private rentToken = 0n;
  private solDirect(): boolean {
    return isMainnet() && !NET.p.swap;
  }
  private solBuy(): boolean {
    return this.side === "buy" && this.pay === "SOL" && this.solDirect();
  }
  private ixsSol(amountIn: bigint, minOut: bigint): Ix[] {
    const a = this.account!.address, lm = this.lineMint();
    const wsolAccount = ata(a, PUMP.wsol, TOKEN_PROGRAM), agentAccount = ata(a, this.t.mint, T22);
    const agentHop: Hop = this.venue?.kind === "pool" ? { kind: "pool", mint: this.t.mint, quoteMint: lm, pool: this.venue.pool, quoteTokenProgram: T22 } : { kind: "curve", mint: this.t.mint, quoteMint: lm, quoteTokenProgram: T22 };
    if (this.lineOnPool) {
      // The quote coin trades on its canonical PumpSwap pool, which takes wrapped SOL (its curve took plain SOL): the SOL goes
      // through a temporary wrapped SOL account of the wallet, made, spent and closed in this transaction (the launch's own
      // purchase does the same, packages/chain pumpSolToLinePool), so the wallet's own wrapped SOL account is never touched.
      // Proven on the mainnet fork with the real pool: 1,208 bytes, 158,913 compute units.
      const temp = launchTempWsol(a);
      return [
        token.createAtaIdempotent(a, a, this.t.mint, T22),
        system.createAccountWithSeed(a, LAUNCH_WSOL_SEED, this.rentToken + amountIn, TOKEN_ACCOUNT_LEN, TOKEN_PROGRAM), token.initializeAccount3(temp, PUMP.wsol, a, TOKEN_PROGRAM),
        pumpAmm.multiHopSwap({ user: a, userIn: temp, userOut: agentAccount, amountIn, minOut, buybackQuoteMint: PUMP.wsol,
          hops: [{ kind: "pool", mint: lm, quoteMint: PUMP.wsol, pool: pumpPdas.pool(lm, PUMP.wsol) }, agentHop] }),
        token.closeAccount(temp, a, a, TOKEN_PROGRAM),
      ];
    }
    return [
      token.createAtaIdempotent(a, a, PUMP.wsol, TOKEN_PROGRAM), token.createAtaIdempotent(a, a, this.t.mint, T22),
      token.createAtaIdempotent(a, PUMP.buybackRecipients[0], lm, T22),
      pumpAmm.multiHopSwap({ user: a, userIn: wsolAccount, userOut: agentAccount, amountIn, minOut, buybackQuoteMint: PUMP.wsol,
        hops: [{ kind: "curve", mint: lm, quoteMint: PUMP.wsol }, agentHop] }),
    ];
  }
  private async reviewSol() {
    const amountIn = parseUnits(this.amount, 9);
    const slip = Number(this.slip);
    if (!amountIn || !Number.isInteger(slip) || slip < 0 || slip > 5000) {
      this.err = this.errBox("Enter a positive amount of SOL and a slippage tolerance between 0 and 5000 bps.");
      return this.render();
    }
    if (this.sol !== null && amountIn >= this.sol) {
      this.err = this.errBox(`You hold ${sol(this.sol)} SOL.`);
      return this.render();
    }
    this.err = null;
    this.msg = html`<span class="dim">Simulating on ${netName()}…</span>`;
    this.render();
    await this.readVenue();
    const lc = await rpc.getAccountInfo(pumpPdas.bondingCurve(this.lineMint()));
    const quoteCurve = lc ? decodeBondingCurve(lc.data) : null;
    // pump.fun's multi-hop swap takes each coin on its curve or on its pool; neither while a curve is complete and not migrated yet
    const waiting = !!quoteCurve && quoteCurve.complete && !curveMigrated(quoteCurve);
    if ((this.venue?.kind !== "curve" && this.venue?.kind !== "pool") || !quoteCurve || waiting) {
      this.msg = null;
      this.err = this.errBox(waiting || this.venue?.kind === "waiting" ? `Paying in SOL is not offered right now: a curve is complete and its PumpSwap pool does not exist yet. Pay in ${qsym()} once it does.`
        : `Paying in SOL is not offered for this token. Pay in ${qsym()} instead.`);
      return this.render();
    }
    this.lineOnPool = curveMigrated(quoteCurve);
    if (this.lineOnPool) this.rentToken = rentLamports(TOKEN_ACCOUNT_LEN, BigInt(await rpc.call<number>("getMinimumBalanceForRentExemption", [0])));
    const built = await buildAndSimulate(this.account!.address, this.ixsSol(amountIn, 1n), 400_000);
    const row = built.sim.accounts.find((x) => x.address === ata(this.account!.address, this.t.mint, T22));
    const before = row?.dataBefore ? decodeTokenAccount(row.dataBefore).amount : 0n;
    const after = row?.dataAfter && row.dataAfter.length >= 165 ? decodeTokenAccount(row.dataAfter).amount : before;
    const out = after - before;
    this.quote = { side: "buy", amountIn, out, built, minOut: (out * BigInt(10_000 - slip)) / 10_000n || 1n, sol: true };
    this.msg = null;
    if (built.sim.err) this.err = this.errBox(`Simulation failed: ${JSON.stringify(built.sim.err)}`, built.sim.logs);
    this.render();
  }

  private async review() {
    if (!this.ready()) return;
    const buy = this.side === "buy";
    if (this.dec === null) await this.readVenue();
    if (this.solBuy()) return this.reviewSol();
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
    this.msg = html`<div class="mk-tb-done" data-sig="${c.signature}">${banner("info", html`Paid in ${q.prepared.pay}, bought on ${this.venue?.kind === "pool" ? "PumpSwap" : "the curve"}: <a class="link" href="${explorerTx(c.signature)}" target="_blank" rel="noopener" title="${c.signature}">${c.signature.slice(0, 8)}… ${icon.ext}</a>`, "Your balances are read back from chain.")}</div>`;
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
    const r = await signAndSend({ wallet: this.wallet!, account: this.account!, ixs: q.sol ? this.ixsSol(q.amountIn, q.minOut) : this.ixs(q.side === "buy", q.amountIn, q.minOut), units: q.sol ? 400_000 : 300_000, onStatus: st });
    const c = r.confirmed!;
    if (c.err) throw Object.assign(new Error(`swap failed on chain: ${JSON.stringify(c.err)}`), { logs: c.logs });
    this.quote = null;
    this.amount = "";
    await this.readBalances();
    this.msg = html`<div class="mk-tb-done" data-sig="${c.signature}">${banner("info", html`${q.side === "buy" ? "Bought" : "Sold"} on ${this.venue?.kind === "pool" ? "PumpSwap" : "the curve"}: <a class="link" href="${explorerTx(c.signature)}" target="_blank" rel="noopener" title="${c.signature}">${c.signature.slice(0, 8)}… ${icon.ext}</a>`, "Your balances are read back from chain. The trade list and price update when the indexer has read it.")}</div>`;
    this.render();
    this.opts.onTrade?.(c.signature, q.side);
  }

  // ------------------------------------------------------------------------------------- wallet

  private ready(): boolean {
    if (this.gate !== "ok" || !this.venue) return false;
    if (this.venue.kind === "legacy" || this.venue.kind === "waiting") return false;
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
    if (v.kind === "legacy") return html`<span class="b warn">Meteora (earlier venue), read only</span> ${pool}`;
    if (v.kind === "waiting") return html`<span class="b warn">pump.fun curve complete</span> <span class="faint">trading resumes on PumpSwap after the migration</span>`;
    return v.kind === "curve"
      ? html`<span class="b info">pump.fun bonding curve</span> ${pool}`
      : html`<span class="b good">PumpSwap pool</span> ${pool}${this.la && !this.la.graduated ? html` <span class="faint">(migrated, graduation record pending)</span>` : ""}`;
  }

  private render() {
    if (this.dead) return;
    const qd = this.qd();
    const sym = this.sym();
    let body: Raw;
    if (this.gate === "checking") body = html`<div class="dim">Checking that the RPC is ${netName()}…</div>`;
    else if (this.gate !== "ok") body = this.errBox(`Trading is off: ${this.gate}`);
    else if (this.venue?.kind === "legacy" || this.venue?.kind === "waiting") body = html`<div class="mk-tb-venue">${this.venueLine()}</div>`;
    else {
      // Buy or Sell with a gear for the settings, one large amount, quick amounts, one action button,
      // then the venue and balances in a small footer. Disconnected, the same box asks to connect.
      const q = this.quote;
      const buy = this.side === "buy";
      const solIn = this.solBuy();
      const inU = solIn ? "SOL" : buy ? qsym() : sym;
      const outU = buy ? sym : qsym();
      const inD = solIn ? 9 : buy ? qd : this.td();
      const outD = buy ? this.td() : qd;
      const inK = solIn ? "sol" : buy ? "quote" : "token";
      const outK = buy ? "token" : "quote";
      const on = !!this.account;
      const chips: [string, string][] = solIn
        ? ["0.01", "0.05", "0.1", "0.5"].map((v) => [v, `${v} SOL`])
        : buy
        ? ["10", "100", "500", "1000"].map((v) => [v, `${Number(v).toLocaleString("en-US")} ${qsym()}`]) // amounts of the coin the wallet pays; the dollar value shows under the input
        : ["25", "50", "75", "100"].map((p) => [`${p}%`, `${p}%`]);
      const action = !on
        ? this.btn("connect", "Connect wallet", { primary: true })
        : (q && !q.built.sim.err) || this.swapQ
          ? this.btn("sign", html`Sign and ${this.swapQ ? (this.swapQ.out === null ? "swap" : "buy") : q!.side} ${this.swapQ?.out === null ? "" : sym}`, { primary: true, disabled: this.busy })
          : this.btn("review", html`${buy ? "Buy" : "Sell"} ${sym}`, { primary: true, disabled: this.busy });
      body = html`<div class="mk-tb2${buy ? " is-buy" : " is-sell"}">
        <div class="mk-tb2-top">
          <div class="mk-tb2-side" role="group" aria-label="Side"><button type="button" data-tb="side" data-side="buy" aria-pressed="${String(buy)}">Buy</button><button type="button" data-tb="side" data-side="sell" aria-pressed="${String(!buy)}">Sell</button></div>
          <button type="button" class="mk-tb2-gear" data-tb="gear" aria-label="Trade settings" aria-expanded="${String(this.settings)}" title="Slippage${buy ? " and Pay with" : ""}"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg></button>
        </div>
        ${this.settings
          ? html`<div class="mk-tb2-set">${buy && on ? payWithControl("tb_pay", qsym(), this.pay, this.solDirect()) : ""}<label class="wl-field"><span class="eyebrow">Slippage tolerance (bps)</span><input name="tb_slip" inputmode="numeric" value="${esc(this.slip)}"></label></div>`
          : ""}
        <label class="mk-tb2-amt"><span class="mk-tb2-u">${inU}</span><input name="tb_amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(this.amount)}" aria-label="${solIn ? "Amount of SOL to pay" : buy ? `Amount of ${qsym()} to pay` : `Amount of ${sym} to sell`}"${on ? "" : raw(" disabled")}><span class="mk-tb2-hint">${on ? html`<button type="button" class="mk-tb2-max" data-tb="max">Max</button>` : "Enter amount"}</span></label>
        <div class="wl-fine mk-tb2-usd" data-tb-usd aria-live="polite">${this.typedUsd()}</div>
        <div class="mk-tb2-chips">${chips.map(([v, l]) => html`<button type="button" data-tb="chip" data-v="${v}"${on ? "" : raw(" disabled")}>${l}</button>`)}</div>
        <div class="mk-tb2-bal">${on
          ? html`<span>${qsym()} <b class="num" data-bal="line">${this.line === null ? "TBA" : units(this.line, qd)}</b>${this.line === null ? "" : ` (${this.usd(this.line, "quote")})`}</span><span>${sym} <b class="num" data-bal="token">${this.tok === null ? "TBA" : units(this.tok, this.td())}</b>${this.tok === null ? "" : ` (${this.usd(this.tok, "token")})`}</span><span>SOL <b class="num" data-bal="sol">${this.sol === null ? "TBA" : sol(this.sol)}</b>${this.sol === null ? "" : ` (${this.usd(this.sol, "sol")})`}</span>`
          : html`<span class="faint">Connect a wallet to see your balances</span>`}</div>
        ${q && !q.built.sim.err
          ? html`<div class="mk-tb-quote"><div><span>You pay</span><b class="num">${units(q.amountIn, inD)} ${inU} <span class="dim">(${this.usd(q.amountIn, inK)})</span></b></div><div><span>You get (simulated)</span><b class="num" data-quote-out="${q.out}">${units(q.out, outD)} ${outU} <span class="dim">(${this.usd(q.out, outK)})</span></b></div><div><span>Minimum at your tolerance</span><b class="num">${units(q.minOut, outD)} ${outU} <span class="dim">(${this.usd(q.minOut, outK)})</span></b></div><div><span>Network fee</span><b class="num">${q.built.sim.fee === null ? "TBA" : html`${sol(q.built.sim.fee)} SOL <span class="dim">(${this.usd(q.built.sim.fee, "sol")})</span>`}</b></div></div>`
          : ""}
        ${this.swapQ ? html`${routeLines(this.swapQ.prepared)}<div class="mk-tb-quote">${this.swapQ.out === null ? html`<div><span>You get</span><b>simulated after the swap lands (two transactions)</b></div>` : html`<div><span>You get (simulated)</span><b class="num" data-quote-out="${this.swapQ.out}">${units(this.swapQ.out, outD)} ${outU}</b></div><div><span>Minimum at your tolerance</span><b class="num">${units(this.swapQ.minOut, outD)} ${outU}</b></div><div><span>Network fee</span><b class="num">${this.swapQ.fee === null ? "TBA" : sol(this.swapQ.fee)} SOL</b></div>`}</div>` : ""}
        <div class="mk-tb2-go">${action}${q || this.swapQ ? this.btn("clear", "Change") : ""}</div>
        <div class="mk-tb2-foot"><span class="mk-tb-venue">${this.venueLine()}</span>${on ? html`<a class="link mk-tb-acct" href="/profile" title="${this.account!.address}">${this.account!.address.slice(0, 4)}…${this.account!.address.slice(-4)}</a>` : ""}</div>
        ${NET.p.faucet ? html`<div class="wl-fine mk-tb2-note">Get ${qsym()} from the faucet on your <a class="link" href="/profile">Profile</a>.</div>` : ""}
      </div>`;
    }
    this.el.innerHTML = html`<div class="panel-b mk-tb">${body}${this.err ?? ""}${this.msg ? html`<div class="mk-tb-msg">${this.msg}</div>` : ""}</div>`.s;
  }

  private onInput(ev: Event) {
    const t = ev.target as HTMLInputElement;
    if (ev.type === "change" && t.name !== "tb_pay") return;
    if (t.name === "tb_amount") {
      this.amount = t.value.trim();
      const u = this.el.querySelector("[data-tb-usd]");
      if (u) u.textContent = this.typedUsd();
    }
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
          if (this.solBuy()) {
            // SOL: leave what fees and new token accounts need (0.01 SOL)
            if (this.sol !== null && this.sol > 10_000_000n) this.amount = sol(this.sol - 10_000_000n).replace(/,/g, "");
          } else if (have !== null) this.amount = units(have, this.side === "buy" ? this.qd() : this.td()).replace(/,/g, "");
          this.quote = null;
          break;
        }
        case "clear":
          this.quote = this.swapQ = null;
          break;
        case "gear":
          this.settings = !this.settings;
          break;
        case "chip": {
          const v = b.dataset.v ?? "";
          if (v.endsWith("%")) {
            const p = BigInt(v.slice(0, -1));
            if (this.tok !== null) this.amount = units((this.tok * p) / 100n, this.td()).replace(/,/g, "");
          } else this.amount = v;
          this.quote = this.swapQ = null;
          this.err = this.msg = null;
          break;
        }
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
