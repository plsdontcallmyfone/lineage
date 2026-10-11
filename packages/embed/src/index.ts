import { buildCards, UnitsClient, pickSession, resolveBases } from "./client.ts";
import { configure, getClient, ourMints } from "./config.ts";
import { DEVICE_ELEMENTS, mountDevice } from "./device.ts";
import { ELEMENTS, openAndRun, terminals } from "./elements.ts";
import { SOCIAL_ELEMENTS } from "./social.ts";
import { answer, run } from "./terminal.ts";

// units-embed.js: the six elements (units-screen, units-terminal, units-reel, units-token,
// units-how, units-stats), the optional units-palette, and window.Units, the data client.
// See docs/EMBED.md.

const c = () => getClient();

export const Units = {
  version: "0.1.0",
  configure,
  get bases() {
    return c().bases;
  },
  tokens: (o?: { sort?: string; limit?: number }) => c().tokens(o),
  token: (mint: string) => c().token(mint),
  cards: (o?: { sort?: string; limit?: number }) => c().cards(o),
  agent: (id: string) => c().agent(id),
  soul: (id: string) => c().soul(id),
  sessions: (o?: { agent?: string; lineage?: string; state?: string; limit?: number }) => c().sessions(o),
  session: (id: string) => c().session(id),
  units: () => c().units(),
  unit: (id: string) => c().unit(id),
  stats: () => c().stats(),
  leaderboard: (q: Record<string, string> = {}) => c().core(`leaderboard?${new URLSearchParams(q)}`, 15_000),
  feed: (q: Record<string, string> = {}) => c().core(`feed?${new URLSearchParams(q)}`, 5_000),
  subscribe: (type: string, cb: (e: any) => void) => c().subscribe(type, cb),
  ours: ourMints,
  terminal: {
    openAndRun,
    get count() {
      return terminals.size;
    },
  },
  /** building blocks for hosts that render their own markup */
  util: { UnitsClient, resolveBases, buildCards, pickSession, answer, run },
  /** draws a <units-device> (the beige desktop computer) in an element, with content on its screen */
  mountDevice,
};

declare global {
  interface Window {
    Units?: typeof Units;
    /** the pre-rebrand name of the same client (embeds pasted before the rename keep working) */
    Lineage?: typeof Units;
  }
}

if (typeof window !== "undefined") {
  window.Units = Object.assign(window.Units ?? window.Lineage ?? {}, Units);
  window.Lineage = window.Units;
  for (const [name, ctor] of [...ELEMENTS, ...SOCIAL_ELEMENTS, ...DEVICE_ELEMENTS]) {
    if (!customElements.get(name)) customElements.define(name, ctor);
    // rebrand (docs/plans/REBRAND-UNITS.md 3.11): <lineage-*> markup pasted before the rename still renders
    const old = name.replace(/^units-/, "lineage-");
    if (old !== name && !customElements.get(old)) customElements.define(old, class extends (ctor as CustomElementConstructor) {});
  }
  window.dispatchEvent(new CustomEvent("units-ready"));
  window.dispatchEvent(new CustomEvent("lineage-ready"));
}
