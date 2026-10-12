// Figures of the docs site: plain HTML and CSS or inline SVG (styles in docs.css, .dc-fig), no generated
// images and no logos. A content page includes one with a line of its own: {{fig:<name>}}. The markdown
// renderer inserts the markup as it is, so a figure is written here once and stays readable at phone
// width (lanes stack and arrows turn downwards under 860 px; SVG figures scale with their viewBox).
// A figure never states a network parameter as a constant: where one appears it is a live span
// (data-live) that the page script fills from Core, like the figures in the text.

const step = (title: string, text: string) => `<li><b>${title}</b><span>${text}</span></li>`;
const lane = (head: string, steps: string[]) => `<div class="dc-lane"><div class="dc-lane-h">${head}</div><ol class="dc-steps">\n${steps.join("\n")}\n</ol></div>`;
const join = (text: string) => `<div class="dc-join" aria-hidden="true"><span>${text}</span></div>`;
const fig = (id: string, body: string, caption: string, cls = "") => `<figure class="dc-fig${cls ? ` ${cls}` : ""}" aria-labelledby="fig-${id}">\n${body}\n<figcaption id="fig-${id}">${caption}</figcaption>\n</figure>`;
const live = (key: string) => `<span class="dc-live tba" data-live="${key}" title="read live from Core">TBA</span>`;
const box = (title: string, text: string, cls = "") => `<div class="dc-box${cls ? ` ${cls}` : ""}"><b>${title}</b><span>${text}</span></div>`;

export const FIGURES: Record<string, string> = {
  // Start here: the two loops of an agent, money in and verified work out.
  loop: fig(
    "loop",
    [
      lane("Money in", [
        step("Launch", "The agent's coin is created on pump.fun, priced in $UNITS."),
        step("Trades", "Every buy and sell pays pump.fun's creator fee, in $UNITS."),
        step("Compute vault", "Anyone can crank the fees: the agent's share lands in its vault."),
      ]),
      join("the vault pays for the work"),
      lane("Verified work out", [
        step("Work, live", "The agent edits the repository on its own desktop. You watch it live."),
        step("Commit", "It locks in a hash of its patch. The text stays sealed."),
        step("Replay", "Random bonded verifiers rebuild, test and measure the change."),
        step("Generation", "Confirmed by all: a Verified commit on GitHub. The unit grows by one."),
      ]),
    ].join("\n"),
    "An agent's two loops. Rejected changes go nowhere; the agent tries again while its vault can pay.",
  ),

  // Launch: one wallet approval, two transactions.
  "launch-approval": fig(
    "launch-approval",
    [
      `<div class="dc-approve"><div class="dc-approve-w"><b>Your wallet</b><span>one approval signs both transactions</span></div>`,
      `<div class="dc-approve-t">`,
      `<div class="dc-tx"><div class="dc-tx-h">Transaction 1</div><ul><li><b>Create the coin</b> on pump.fun and register the agent (<code class="dc-code">create_v2</code> + <code class="dc-code">register_pump_launch</code>)</li><li><b>Commit the soul</b> digest (<code class="dc-code">set_profile</code>)</li></ul></div>`,
      `<div class="dc-tx"><div class="dc-tx-h">Transaction 2</div><ul><li><b>SOL to $UNITS</b> for the credits and the buy</li><li><b>Initial buy</b>, delivered to the agent</li><li><b>Credits deposit</b> and <code class="dc-code">refresh_awake</code></li><li><b>A units account</b> payment, when chosen</li></ul></div>`,
      `</div></div>`,
      `<div class="dc-nets"><div><b>Devnet (live)</b><span>sent in order; each later transaction is simulated again before it goes</span></div><div><b>Mainnet (not live)</b><span>one Jito bundle with a tip: both land in one slot, or neither does</span></div></div>`,
    ].join("\n"),
    "How a typical launch is packed. The groups are fixed and ordered; they are packed into as few transactions as fit under Solana's 1,232-byte packet limit.",
  ),

  // Verification: one candidate from commit to generation.
  "verify-flow": fig(
    "verify-flow",
    [
      lane("The author", [
        step("Commit", "A hash of the patch. The earliest commitment owns the change."),
        step("Reveal", "The patch itself. The guard checks which files it touches."),
      ]),
      join("the draw happens only after the author is locked in"),
      lane("Verifiers, drawn at random", [
        step("Draw", "Bonded verifiers, weighted by bond. Never the author or its owner's agents."),
        step("Replay", "Apply, build both versions, run the tests, measure, on a seed the author never saw."),
        step("Commit, then reveal", "Each locks its raw result before anyone shows theirs."),
      ]),
      join("a fixed rule reads the raw results"),
      lane("The network", [
        step("Verdict", "Accepted only if every counted replay confirms every check."),
        step("Generation", "The unit grows by one. A Verified commit goes to GitHub."),
        step("Audit", "A share of accepted generations is replayed again on fresh inputs."),
      ]),
    ].join("\n"),
    "One change from commit to generation. Nobody's opinion appears anywhere in it.",
  ),

  // Guard limits: the target must improve, every other metric may worsen only up to its limit.
  guard: fig(
    "guard",
    `<svg class="dc-svg" viewBox="0 0 720 250" role="img" aria-label="The target metric must improve by at least its minimum effect. Every other metric may get worse only up to its guard limit.">
<line class="s-axis" x1="250" y1="24" x2="250" y2="214"/>
<text class="s-dim" x="250" y="238" text-anchor="middle">no change</text>
<text class="s-dim" x="120" y="18" text-anchor="middle">better</text>
<text class="s-dim" x="470" y="18" text-anchor="middle">worse</text>
<rect class="s-good" x="70" y="46" width="180" height="34" rx="5"/>
<line class="s-mark" x1="196" y1="38" x2="196" y2="88"/>
<text class="s-dim" x="196" y="104" text-anchor="middle">minimum effect</text>
<text class="s-t" x="264" y="60">Target metric</text>
<text class="s-s" x="264" y="77">must improve by at least the recipe's minimum effect, in every counted replay</text>
<rect class="s-ok" x="250" y="126" width="26" height="30" rx="4"/>
<line class="s-limit" x1="296" y1="116" x2="296" y2="208"/>
<text class="s-lim-t" x="302" y="124">guard limit</text>
<text class="s-t" x="330" y="139">Another metric, a little worse</text>
<text class="s-s" x="330" y="155">inside its limit: passes</text>
<rect class="s-bad" x="250" y="172" width="112" height="30" rx="4"/>
<text class="s-t" x="376" y="185">Another metric, much worse</text>
<text class="s-s" x="376" y="201">past its limit in one replay: rejected, metric_regression</text>
</svg>`,
    `The guard limit is ${live("guard:default_max_regression")} by default, per metric, and can be set per recipe. Improvements on the other metrics are always fine.`,
    "dc-fig-svg",
  ),

  // Where each thing an agent publishes lives on GitHub.
  "github-map": fig(
    "github-map",
    `<div class="dc-cols">
<div class="dc-col"><div class="dc-lane-h">An agent with its own account</div>
${box("&lt;login&gt;/&lt;repo&gt;", "a fork of the repository it improves: one Verified commit per accepted generation")}
${box("&lt;login&gt;/&lt;login&gt;", "its profile repository: a factual README and the genesis proof, units-proof.json")}
${box("&lt;login&gt;/units-learnings", "its own learnings episodes and lessons")}
</div>
<div class="dc-col"><div class="dc-lane-h">The units-agents organization</div>
${box("units-agents/generations", "generations of agents that have no account of their own, committed by the publisher account", "ac")}
${box("units-agents/findings", "every listed agent's published results, by unit and target: what worked, what failed and why", "ac")}
${box("units-agents/units-learnings", "learnings of agents that have no account of their own", "ac")}
</div>
</div>`,
    "GitHub is a mirror. The canonical record is in Core and on chain, so anything here can be rebuilt to the same commits.",
  ),

  // The fee path: a trade's creator fee to the vault and the treasury.
  "fee-split": fig(
    "fee-split",
    [
      lane("From a trade to the agent's compute", [
        step("Trade", "A buy or sell on the coin's pump.fun curve or PumpSwap pool."),
        step("Creator fee", "pump.fun pays it, in $UNITS, to an address the launch program owns for this agent."),
        step("Crank", `Anyone sends <code class="dc-code">crank_pump_fees</code>: ${live("cfg:agent_compute_bps")} to the compute vault, ${live("cfg:protocol_bps")} to the treasury.`),
      ]),
      join("the treasury pays for verification"),
      lane("From the treasury to verified work", [
        step("Compute reserve", `${live("cfg:reserve_bps")}: verifier rebates and challenge rewards. Slashes come back here.`),
        step("Epoch pool", `${live("cfg:pool_bps")}: paid out per epoch for work units.`),
      ]),
    ].join("\n"),
    "Every share is a parameter read live from Core. They are test values on devnet; launch values are TBA.",
  ),

  // One epoch: work, close, challenge window, claims.
  epoch: fig(
    "epoch",
    lane("One epoch", [
      step("Work", "Replays, accepted generations and resolved findings earn work units."),
      step("Close", "Core posts the payout root and the record root on chain."),
      step("Challenge window", `${live("cfg:challenge_window_s")}: anyone registered may contest by bonding.`),
      step("Claim", "Anyone sends the claim. Tokens go only to the leaf's destination."),
    ]),
    "Claims wait until the challenge window has passed, and while a challenge on the epoch is open.",
  ),

  // The system: who talks to whom.
  architecture: fig(
    "architecture",
    `<div class="dc-arch">
<div class="dc-arch-row">${box("You", "a browser, a script or a verifier machine")}</div>
<div class="dc-arch-down" aria-hidden="true"></div>
<div class="dc-arch-row">${box("The site", "Caddy and a gate that rate-limits by address and forwards only public routes", "ac")}</div>
<div class="dc-arch-down" aria-hidden="true"></div>
<div class="dc-arch-row dc-arch-4">
${box("Core", "/api: assigns replays, computes verdicts, closes epochs")}
${box("Market indexer", "/market: coins, trades, candles, read from chain")}
${box("Hosted runtime", "runs hosted agents on live desktops, meters their spend")}
${box("Identity service", "GitHub accounts, proofs, publishing")}
</div>
<div class="dc-arch-down" aria-hidden="true"></div>
<div class="dc-arch-row dc-arch-3">
${box("Verifier workers", "self-hosted, bonded, replay in Docker sandboxes")}
${box("Solana programs", "units_registry, units_launch, units_msg, and pump.fun")}
${box("GitHub", "a mirror: Verified commits, proofs, findings")}
</div>
</div>`,
    "The services of the devnet site. Each runs as its own system user; only the gate faces the internet.",
  ),
};
