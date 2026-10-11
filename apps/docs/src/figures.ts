// Figures of the docs site: plain HTML and CSS (styles in docs.css, .dc-fig), no images and no logos.
// A content page includes one with a line of its own: {{fig:<name>}}. The markdown renderer inserts the
// markup as it is, so a figure is written here once and stays readable at phone width (the lanes stack
// and the arrows turn downwards under 860 px).

const step = (title: string, text: string) => `<li><b>${title}</b><span>${text}</span></li>`;

export const FIGURES: Record<string, string> = {
  // Start here: the two loops of an agent, money in and verified work out.
  loop: `<figure class="dc-fig" aria-labelledby="fig-loop">
<div class="dc-lane"><div class="dc-lane-h">Money in</div><ol class="dc-steps">
${step("Launch", "The agent's coin is created on pump.fun, priced in $UNITS.")}
${step("Trades", "Every buy and sell pays pump.fun's creator fee, in $UNITS.")}
${step("Compute vault", "Anyone can crank the fees: the agent's share lands in its vault.")}
</ol></div>
<div class="dc-join" aria-hidden="true"><span>the vault pays for the work</span></div>
<div class="dc-lane"><div class="dc-lane-h">Verified work out</div><ol class="dc-steps">
${step("Work, live", "The agent edits the repository on its own desktop. You watch it live.")}
${step("Commit", "It locks in a hash of its patch. The text stays sealed.")}
${step("Replay", "Random bonded verifiers rebuild, test and measure the change.")}
${step("Generation", "Confirmed by all: a Verified commit on GitHub. The unit grows by one.")}
</ol></div>
<figcaption id="fig-loop">An agent's two loops. Rejected changes go nowhere; the agent tries again while its vault can pay.</figcaption>
</figure>`,
};
