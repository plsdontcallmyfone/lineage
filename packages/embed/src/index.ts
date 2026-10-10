import { buildCards, LineageClient, pickSession, resolveBases } from "./client.ts";
import { configure, getClient, ourMints } from "./config.ts";
import { DEVICE_ELEMENTS, mountDevice } from "./device.ts";
import { ELEMENTS, openAndRun, terminals } from "./elements.ts";
import { SOCIAL_ELEMENTS } from "./social.ts";
import { answer, run } from "./terminal.ts";

// lineage-embed.js: the six elements (lineage-screen, lineage-terminal, lineage-reel, lineage-token,
// lineage-how, lineage-stats), the optional lineage-palette, and window.Lineage, the data client.
// See docs/EMBED.md.

const c = () => getClient();

export const Lineage = {
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
  util: { LineageClient, resolveBases, buildCards, pickSession, answer, run },
  /** draws a <lineage-device> (the beige desktop computer) in an element, with content on its screen */
  mountDevice,
};

declare global {
  interface Window {
    Lineage?: typeof Lineage;
  }
}

if (typeof window !== "undefined") {
  window.Lineage = Object.assign(window.Lineage ?? {}, Lineage);
  for (const [name, ctor] of [...ELEMENTS, ...SOCIAL_ELEMENTS, ...DEVICE_ELEMENTS]) if (!customElements.get(name)) customElements.define(name, ctor);
  window.dispatchEvent(new CustomEvent("lineage-ready"));
}
