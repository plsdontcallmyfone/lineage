import type { Address } from "./codec.ts";
import { ata, TOKEN_2022_PROGRAM } from "./pda.ts";
import { token } from "./spl.ts";
import type { Ix } from "./registry.ts";

// The launch holding of a hosted agent (docs/plans/LAUNCH-FRONTING.md section 5, decision D3, built
// 2026-10-10 by the devnet pump.fun redeploy lane). The launcher's initial buy lands in the agent
// key's token account, because at creation the agent key is the only treasury that exists. A hosted
// agent's treasury is the hosted runtime's key (its registry signing key after the bind), so right
// after the bind one more transaction, signed by the agent key that is still in the launcher's tab
// (the launcher pays), moves the whole holding to the runtime key's account. The trader's own-token
// rule then covers it: the runtime key is the agent's trading key and never sells its own token.

/** Instructions moving `amount` agent tokens from the agent key's account to `treasury`'s (created when missing). */
export function moveLaunchHolding(a: { payer: Address; agentKey: Address; treasury: Address; agentMint: Address; amount: bigint; decimals: number; tokenProgram?: Address }): Ix[] {
  const tp = a.tokenProgram ?? TOKEN_2022_PROGRAM;
  if (a.amount <= 0n) throw new Error("nothing to move: the launch holding is empty");
  if (a.treasury === a.agentKey) throw new Error("the treasury is the agent key already");
  return [
    token.createAtaIdempotent(a.payer, a.treasury, a.agentMint, tp),
    token.transferChecked(ata(a.agentKey, a.agentMint, tp), a.agentMint, ata(a.treasury, a.agentMint, tp), a.agentKey, a.amount, a.decimals, tp),
  ];
}
