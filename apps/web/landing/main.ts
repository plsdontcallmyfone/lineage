// Landing page behaviour (apps/web/landing/index.html). Loaded before the embed kit (both deferred), so
// it can size the terminal before the kit mounts it. Live figures come from window.Lineage (the kit's
// data client: Core and the market indexer); a figure that cannot be read shows as TBA.
import { fmtAmount } from "../src/market.ts";

type Stats = {
  tokens: number | null;
  graduated: number | null;
  agents_working: number | null;
  generations: number | null;
  candidates: number | null;
  fees_to_compute: number | null;
  sessions_live: number | null;
};
type Client = {
  bases: { market: string };
  stats(o?: { fees?: boolean }): Promise<Stats>;
  ours(): Promise<string[]>;
  subscribe(type: string, cb: (e: unknown) => void): () => void;
};

const root = document.documentElement;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const int = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

// ------------------------------------------------------------------------------------------- theme

const isLight = () => root.getAttribute("data-theme") === "light";
function applyScheme() {
  const scheme = isLight() ? "light" : "dark";
  // the terminal lives in the drawn tube and stays dark; every other element follows the page
  for (const el of document.querySelectorAll("lineage-reel, lineage-screen, lineage-palette")) el.setAttribute("scheme", scheme);
  const b = document.getElementById("theme");
  b?.setAttribute("aria-label", isLight() ? "Switch to dark theme" : "Switch to light theme");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", isLight() ? "#f3f1ea" : "#0d0e0c");
}
document.getElementById("theme")?.addEventListener("click", () => {
  if (isLight()) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", "light");
  try {
    localStorage.setItem("lineage-theme", isLight() ? "light" : "dark");
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  applyScheme();
});
applyScheme();

// ----------------------------------------------------------------------- sizes, read once at mount

const narrow = matchMedia("(max-width: 560px)").matches;
document.getElementById("term")?.setAttribute("height", narrow ? "400" : "372");
document.getElementById("watch-screen")?.setAttribute("height", narrow ? "340" : "420");

// ------------------------------------------------------------------- the lineage graph behind the hero
// Decorative: a few lanes of generations that branch and rejoin, drawn from a fixed seed.

function drawGraph() {
  const svg = document.getElementById("hero-graph");
  if (!svg) return;
  const w = svg.clientWidth || 1200;
  const h = svg.clientHeight || 700;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const lanes = Math.max(4, Math.round(h / 120));
  const step = Math.max(70, Math.round(w / 16));
  const ys = Array.from({ length: lanes }, (_, i) => Math.round(((i + 0.5) * h) / lanes));
  const r = (n: number) => Math.round(n * 10) / 10;
  let paths = "";
  let nodes = "";
  for (let i = 0; i < lanes; i++) {
    const y = ys[i]!;
    const x0 = Math.round(rnd() * step * 3);
    paths += `<path d="M${x0} ${y}H${w}"/>`;
    for (let x = x0 + step; x < w; x += step) {
      const roll = rnd();
      if (roll < 0.18 && i + 1 < lanes) {
        const y2 = ys[i + 1]!;
        paths += `<path d="M${x} ${y}C${r(x + step * 0.5)} ${y} ${r(x + step * 0.5)} ${y2} ${x + step} ${y2}"/>`;
      }
      nodes += `<circle cx="${x}" cy="${y}" r="${roll > 0.86 ? 3.4 : 2.6}"${roll > 0.86 ? ' class="k"' : ""}/>`;
    }
  }
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = paths + nodes;
}
drawGraph();
let resizeT: ReturnType<typeof setTimeout> | undefined;
addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(drawGraph, 150);
});

// ------------------------------------------------------------------------------------ live figures

function fig(key: keyof Stats, v: number | null) {
  const text = v === null || !Number.isFinite(v) ? "TBA" : key === "fees_to_compute" ? fmtAmount(v) : int.format(v);
  for (const el of document.querySelectorAll<HTMLElement>(`[data-stat="${key}"]`)) {
    // the hero's narrow column shows large amounts compactly (690.2K); the full figure is the title
    el.textContent = text !== "TBA" && el.dataset.fmt === "compact" && v !== null && Math.abs(v) >= 100_000 ? compact.format(v) : text;
    el.title = text === "TBA" ? "" : text;
    el.classList.toggle("tba", text === "TBA");
  }
  if (key === "fees_to_compute") for (const u of document.querySelectorAll<HTMLElement>('[data-unit="fees_to_compute"]')) u.hidden = text === "TBA";
}

/** The chin's six lights: light n is on when step n's figure is above zero on the network. */
function lights(s: Stats) {
  const on = [s.tokens, s.fees_to_compute, s.agents_working, s.candidates, s.generations, s.graduated].map((v) => typeof v === "number" && v > 0);
  const dev = document.getElementById("device") as (HTMLElement & { setLights?: (on: boolean[]) => void }) | null;
  if (!dev?.setLights) return;
  // light them one by one, like a machine booting
  if (reduced) dev.setLights(on);
  else on.forEach((_, i) => setTimeout(() => dev.setLights!(on.map((v, k) => v && k <= i)), 140 * i));
}

function door(key: string, text: string) {
  const el = document.querySelector<HTMLElement>(`[data-door="${key}"]`);
  if (el) el.textContent = text;
}

/** One request to the indexer's counters instead of a detail read per token (the kit's fee sum). */
async function summary(L: Client): Promise<{ tokens: number; graduated: number; fees_to_compute: number } | null> {
  try {
    const r = await fetch(`${L.bases.market}/summary`);
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j?.tokens === "number" ? j : null;
  } catch {
    return null;
  }
}

async function load(L: Client) {
  const [core, sum] = await Promise.all([L.stats({ fees: false }).catch(() => null), summary(L)]);
  const s: Stats | null =
    core || sum
      ? {
          tokens: sum?.tokens ?? core?.tokens ?? null,
          graduated: sum?.graduated ?? core?.graduated ?? null,
          fees_to_compute: typeof sum?.fees_to_compute === "number" ? sum.fees_to_compute : null,
          agents_working: core?.agents_working ?? null,
          generations: core?.generations ?? null,
          candidates: core?.candidates ?? null,
          sessions_live: core?.sessions_live ?? null,
        }
      : null;
  const keys: (keyof Stats)[] = ["tokens", "agents_working", "generations", "fees_to_compute", "candidates", "graduated"];
  for (const k of keys) fig(k, s ? s[k] : null);
  if (s) {
    lights(s);
    if (s.tokens !== null) door("tokens", `${int.format(s.tokens)} ${s.tokens === 1 ? "token" : "tokens"} launched`);
    if (s.graduated !== null && s.tokens !== null) door("explorer", `${int.format(s.tokens)} tokens, ${int.format(s.graduated)} graduated`);
  }
  const ours = await L.ours().catch(() => null);
  if (ours) door("ours", ours.length ? `${int.format(ours.length)} listed` : "None listed yet");
}

let started = false;
function start() {
  const L = (window as unknown as { Lineage?: Client }).Lineage;
  if (started || !L || typeof L.stats !== "function") return;
  started = true;
  void load(L);
  // refresh the figures when the network moves (an accepted generation, a launch), at most once a minute
  let last = Date.now();
  L.subscribe("*", () => {
    if (Date.now() - last < 60_000) return;
    last = Date.now();
    void load(L);
  });
}
addEventListener("lineage-ready", start);
if (document.readyState === "complete") start();
else addEventListener("load", start);
// a page whose kit never loads still says plainly that the figures are missing
setTimeout(() => {
  if (started) return;
  for (const k of ["tokens", "agents_working", "generations", "fees_to_compute", "candidates", "graduated"] as (keyof Stats)[]) fig(k, null);
}, 12_000);

