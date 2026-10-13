// The Claim card's state machine (owner 2026-10-13: "a more seamless design ... for claiming fees").
// One card, one primary action that changes with what is known: sign in with GitHub, connect a wallet,
// then the visitor's repositories with a Claim button each. Pure: the facts the page holds go in, the
// words and the one action come out, so every state and every error is unit-tested without a browser
// (apps/web/test/claim-state.test.ts). Nothing here proves anything or talks to anyone: the proofs,
// the endpoints and the transaction are the ones apps/web/wallet/claim.ts always sent.

export interface CardRepo { id: string; full_name: string }
export interface CardEscrow { claimable: string; claimed: string; wallet: string | null; pending_wallet: { wallet: string; effective_at: number } | null }
/** One repository's balance as Core served it: undefined while it is read, null when the read failed. */
export type CardRec = { escrow: CardEscrow | null; agents: number } | null | undefined;

export interface CardFacts {
  /** what the site offers; null while that is still being asked */
  providers: { oauth: boolean; gist: boolean } | null;
  /** claims are not offered here, or the site could not be asked */
  off: "feature_off" | "unreachable" | null;
  sess: { login: string; method: string; wallet: string | null; repositories: CardRepo[] } | null;
  /** the wallet connected in the header, which receives the fees */
  connected: string | null;
  recs: ReadonlyMap<string, CardRec>;
  /** a repository named in the address or looked up; `routed`: an agent shares fees with it */
  focus: { full_name: string; id: string | null; routed: boolean } | null;
  /** repositories claimed in this visit */
  done: ReadonlySet<string>;
  /** unix seconds */
  now: number;
}

export type CardKey = "loading" | "off" | "unreachable" | "signed-out" | "gist-only" | "connect" | "ready" | "empty" | "none";
export type RowState = "loading" | "error" | "ready" | "move" | "moving" | "empty" | "done";
export interface RowView {
  id: string;
  full_name: string;
  state: RowState;
  claimable: bigint;
  claimed: bigint;
  agents: number;
  /** the wallet earlier claims were paid to, when it is not the connected one */
  paidTo: string | null;
  /** unix seconds: when a requested move to the connected wallet takes effect */
  movesAt: number | null;
  /** the one button of the row; null when there is nothing to press */
  button: { action: "claim"; label: string; primary: boolean } | null;
  focused: boolean;
}
export interface StepView { key: "github" | "wallet" | "claim"; label: string; state: "done" | "now" | "todo" }
export interface CardView {
  key: CardKey;
  steps: StepView[];
  lead: string;
  /** the card's one action before the list exists */
  primary: { action: "oauth" | "oauth-repo" | "connect" | "retry"; label: string; repo?: string } | null;
  rows: RowView[];
  /** a quiet line under the list or the lead */
  note: string | null;
  /** wallet approvals the next claim asks for: a free signature that ties the wallet to the sign-in (once per sign-in and wallet), then the claim itself */
  prompts: 1 | 2;
}

export const HEADLINE = "Claim fees for your repository";
/** The bounty owner mark's sentence for the same case (apps/web/wallet/bounty-owner.ts): GitHub did not report admin. */
export const NOT_ADMIN = (repo: string) => `GitHub did not say this account has admin on ${repo}. For an organisation's repository, an owner of the organisation may first have to approve the units app on GitHub's sign-in screen.`;

const big = (s: string | undefined | null) => { try { return BigInt(s ?? "0"); } catch { return 0n; } };
const ORDER: RowState[] = ["ready", "done", "move", "moving", "loading", "error", "empty"];

function row(repo: CardRepo, f: CardFacts, usd: (base: bigint) => string): RowView {
  const rec = f.recs.get(repo.id);
  const base = { id: repo.id, full_name: repo.full_name, claimable: 0n, claimed: 0n, agents: 0, paidTo: null, movesAt: null, button: null, focused: f.focus?.id === repo.id };
  if (rec === undefined) return { ...base, state: "loading" };
  if (rec === null) return { ...base, state: "error" };
  const e = rec.escrow;
  const claimable = big(e?.claimable), claimed = big(e?.claimed);
  const pinned = e?.wallet ?? null;
  const other = !!pinned && !!f.connected && pinned !== f.connected;
  const pending = other && e?.pending_wallet?.wallet === f.connected ? e!.pending_wallet!.effective_at : null;
  const matured = pending !== null && f.now >= pending;
  const v = { ...base, claimable, claimed, agents: rec.agents };
  if (f.done.has(repo.id)) return { ...v, state: "done" };
  if (other && !matured) {
    if (pending !== null) return { ...v, state: "moving", paidTo: pinned, movesAt: pending };
    return { ...v, state: "move", paidTo: pinned, button: f.connected ? { action: "claim", label: "Move claims to this wallet", primary: false } : null };
  }
  if (claimable === 0n) return { ...v, state: "empty" };
  return { ...v, state: "ready", button: f.connected ? { action: "claim", label: `Claim ${usd(claimable)}`, primary: true } : null };
}

/** The card for what is known now. `usd`: an amount in the coin's base units as dollars ("$412.30"). */
export function claimCard(f: CardFacts, usd: (base: bigint) => string): CardView {
  const step = (key: StepView["key"], label: string, state: StepView["state"]): StepView => ({ key, label, state });
  const prompts: 1 | 2 = f.sess?.wallet && f.sess.wallet === f.connected ? 1 : 2;
  const steps = (claim: StepView["state"]): StepView[] => [
    step("github", "GitHub", f.sess ? "done" : "now"),
    step("wallet", "Wallet", f.connected ? "done" : f.sess ? "now" : "todo"),
    step("claim", "Claim", f.sess && f.connected ? claim : "todo"),
  ];
  const view = (key: CardKey, lead: string, o: Partial<CardView> = {}): CardView => ({ key, steps: steps("now"), lead, primary: null, rows: [], note: null, prompts, ...o });

  if (f.off === "feature_off") return view("off", "The owners of a repository claim their share of an agent's fees on this page.", { steps: [] });
  if (f.off === "unreachable") return view("unreachable", "The site did not answer, so this page cannot tell what is waiting. Try again.", { steps: [], primary: { action: "retry", label: "Try again" } });
  if (!f.providers) return view("loading", "Checking what is waiting.", { steps: [] });

  if (!f.sess) {
    const named = f.focus?.routed ? f.focus.full_name : null;
    if (!f.providers.oauth) return view("gist-only", "Prove which GitHub account is yours with a public gist that your wallet signed. It covers repositories under your own account.");
    return view("signed-out", named ? `Sign in with GitHub to claim the fees waiting for ${named}.` : "Sign in with GitHub to see what is waiting for the repositories you have admin on.",
      { primary: named ? { action: "oauth-repo", label: "Sign in with GitHub", repo: named } : { action: "oauth", label: "Sign in with GitHub" } });
  }

  const repos = f.sess.repositories;
  const rows = repos.map((r) => row(r, f, usd)).sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (b.claimable > a.claimable ? 1 : b.claimable < a.claimable ? -1 : a.full_name.toLowerCase() < b.full_name.toLowerCase() ? -1 : 1));
  // a repository the visitor came for that GitHub did not report admin on
  const missed = f.focus && f.focus.routed && !repos.some((r) => r.id === f.focus!.id || r.full_name.toLowerCase() === f.focus!.full_name.toLowerCase()) ? f.focus.full_name : null;
  const gist = f.sess.method === "gist";

  if (!repos.length) {
    return view("none", "None of your repositories receive fees yet.", {
      steps: steps("todo"),
      note: missed ? (gist ? `A gist covers repositories under your own account. For ${missed}, sign in with GitHub.` : NOT_ADMIN(missed))
        : gist ? "A gist covers repositories under your own account. For an organisation's repository, sign in with GitHub."
        : "That changes when someone launches an agent on one of them and shares its fees with the owners. An organisation's repository shows here once one of its owners has approved the units app on GitHub's sign-in screen.",
    });
  }

  const waiting = rows.filter((r) => r.state === "ready");
  const total = waiting.reduce((s, r) => s + r.claimable, 0n);
  const reading = rows.some((r) => r.state === "loading");
  const note = missed ? NOT_ADMIN(missed) : null;
  if (!f.connected) {
    return view("connect", waiting.length ? `${usd(total)} is waiting for ${waiting.length === 1 ? waiting[0]!.full_name : `${waiting.length} of your repositories`}. Connect the wallet it should go to.`
      : "Connect the wallet your fees should go to.", { rows, note, primary: { action: "connect", label: "Connect wallet" } });
  }
  if (waiting.length) {
    return view("ready", `${usd(total)} is waiting for ${waiting.length === 1 ? waiting[0]!.full_name : `${waiting.length} of your repositories`}.`, { rows, note });
  }
  // something was claimed in this visit and nothing more can be: the card closes on that
  const all = rows.some((r) => r.state === "done") && !rows.some((r) => r.state === "move" || r.state === "loading");
  const lead = all ? "Claimed. The next fees arrive here as agents earn them." : reading ? "Reading what is waiting for your repositories."
    : rows.some((r) => r.state === "move") ? "What is waiting is paid to the wallet that claimed before. You can ask to move it to yours."
    : rows.some((r) => r.state === "moving") ? "Claims are moving to your wallet. Until the date below they are paid to the wallet that claimed before."
    : "Nothing is waiting right now. Fees arrive here as the agents working on your repositories earn them.";
  return view("empty", lead,
    { rows, note, steps: steps(all ? "done" : rows.some((r) => r.state === "move") ? "now" : "todo") });
}

/** The two parts of a claim as the visitor sees them, in order; `prove` is left out when the wallet is already tied to this sign-in. */
export function claimPhases(prompts: 1 | 2): { key: "prove" | "claim"; label: string; hint: string }[] {
  const claim = { key: "claim" as const, label: "Claiming", hint: "Approve the claim in your wallet. It costs only the network fee." };
  return prompts === 1 ? [claim] : [{ key: "prove", label: "Proving your wallet", hint: "Approve the message in your wallet. It is free and moves nothing." }, claim];
}

/**
 * An error in the visitor's words. `code`: Core's error code, or the page's own ("wallet_declined", "tx_failed",
 * "no_sign_message", "network"); `message`: what came with it, used only to recognise a refusal in the wallet.
 * `again`: true when signing in again is the way on (the page then drops the sign-in).
 */
export function claimError(code: string | null | undefined, message = "", repo?: string | null): { text: string; again: boolean } {
  const m = message.toLowerCase();
  if (code === "wallet_declined" || /reject|declin|denied|cancel/.test(m)) return { text: "You declined in the wallet. Nothing was sent.", again: false };
  switch (code) {
    case "github_unreachable": return { text: "GitHub did not answer. Try again.", again: false };
    case "core_unreachable": case "network": case "http_error": return { text: "The site did not answer. Try again.", again: false };
    case "no_session": case "bad_session": case "session_expired": return { text: "Your sign-in has run out. Sign in with GitHub again.", again: true };
    case "not_admin": return { text: NOT_ADMIN(repo ?? "that repository"), again: false };
    case "not_a_repository_escrow": case "not_found": return { text: `No agent shares fees with ${repo ?? "that repository"}, so there is nothing to claim for it.`, again: false };
    case "nothing_to_claim": return { text: "Nothing is waiting right now. Someone else with admin may have just claimed it.", again: false };
    case "claims_paused": return { text: "Claims are paused right now. What is waiting stays where it is. Try again later.", again: false };
    case "attest_rate": return { text: "A claim for this repository was started a moment ago. Try again in a few seconds.", again: false };
    case "bad_signature": case "bad_statement": case "stale_statement": case "no_wallet": return { text: "The wallet's signature could not be checked. Try again.", again: false };
    case "no_sign_message": return { text: "This wallet cannot sign a message. Connect one that can.", again: false };
    case "no_attestor": case "attestor_mismatch": case "no_claim_config": case "no_chain": return { text: "Claims cannot be confirmed right now. What is waiting stays where it is. Try again later.", again: false };
    case "tx_failed": return { text: "The claim did not go through. Nothing was taken. Try again.", again: false };
    case "bad_gist_url": return { text: "That is not a gist address. It looks like https://gist.github.com/you/0123abcd.", again: false };
    case "proof_invalid": return { text: "GitHub has no public gist at that address holding the text. Check that it is public, is under your account and holds exactly the text above.", again: false };
    case "bad_login": return { text: "Type your GitHub username.", again: false };
    case "bad_repository": case "bad_repo": return { text: "Type a repository as owner/name.", again: false };
    case "no_wallet_connected": return { text: "Connect a wallet first.", again: false };
    case "wrong_wallet": return { text: "The connected wallet changed while this was running. Try again.", again: false };
    default: return { text: "That did not work. Try again.", again: false };
  }
}

/** Why a sign-in came back without one (the address the sign-in returns to carries the code). */
export function signinError(code: string): string {
  switch (code) {
    case "access_denied": return "You cancelled the GitHub sign-in. Nothing was shared.";
    case "bad_state": case "bad_callback": return "That sign-in had run out before it finished. Sign in again.";
    case "github_unreachable": return "GitHub did not answer. Try again.";
    case "oauth_refused": return "GitHub did not complete the sign-in. Try again.";
    default: return "The sign-in did not finish. Try again.";
  }
}
