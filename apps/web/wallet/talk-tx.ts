// The transaction of a message to an agent (docs/plans/AGENT-CONVERSATIONS.md 11), apart from the page
// so that scripts and tests build exactly what the page builds.
import { r, system, type Ix } from "../../../packages/chain/src/browser/index.ts";

export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/** The text as it will be sent: one line, like Core shows it. */
export const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

/** The two instructions of a message (the compute budget is added when it is built): the transfer to the agent's wallet, and the memo the sender signs. */
export function talkIxs(o: { from: string; agent: string; wallet: string; lamports: bigint; prefix: string; text: string }): Ix[] {
  return [system.transfer(o.from, o.wallet, o.lamports), { programId: MEMO_PROGRAM, keys: [r(o.from, true)], data: new TextEncoder().encode(`${o.prefix}${o.agent}:${tidy(o.text)}`) }];
}
