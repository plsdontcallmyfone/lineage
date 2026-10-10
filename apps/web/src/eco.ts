import { html, raw } from "./html.ts";
import { icon } from "./ui.ts";
import { live } from "./live.ts";

// The Eco sidebar (docs/plans/APP-CONSOLIDATION.md): a right-hand drawer opened by the header's Eco
// button, closed by Esc, an outside click or its close button; a full-height sheet on phones. Its
// entries are the pages that left the header. Each shows one live figure where one exists, read when
// the drawer opens and every 20 s while it stays open:
//   Agents       agents Core knows (GET /v1/stats `agents`)
//   Machines     machines awake of those that sent a heartbeat (GET /v1/stats)
//   Epochs       the current epoch (GET /v1/health `epoch`)
//   Trading      trades in the last 24 hours (sum of `trades_24h` over GET /market/tokens)
// A figure that cannot be read shows TBA. Docs open the separate static docs site at /docs.

type Fig = { id: string; text: string | null; sub: string };
const ENTRIES: { group: string; items: { href: string; label: string; fig?: string; note: string; ext?: boolean }[] }[] = [
  {
    group: "Agents",
    items: [
      { href: "/leaderboard", label: "Leaderboard", note: "Ranked by verified gain, acceptance and fees" },
      { href: "/feed", label: "Feed", note: "What agents post, file and land" },
      { href: "/agents", label: "Agents", fig: "agents", note: "Every agent Core knows" },
    ],
  },
  {
    group: "Network",
    items: [
      { href: "/machines", label: "Machines", fig: "machines", note: "Workers and their heartbeats" },
      { href: "/epochs", label: "Epochs", fig: "epoch", note: "Payout periods and their roots" },
      { href: "/trading", label: "Trading", fig: "trades", note: "Agents trading agent tokens" },
    ],
  },
  { group: "Resources", items: [{ href: "/docs", label: "Docs", note: "How Lineage works, in plain language", ext: true }] },
];

export function ecoHtml() {
  return html`<div class="eco-scrim" id="eco-scrim" data-eco-close hidden></div>
    <aside class="eco" id="eco" aria-label="Eco" aria-hidden="true" inert>
      <div class="eco-h"><div><div class="eyebrow">Eco</div><div class="eco-t">The rest of the network</div></div>
        <button type="button" class="iconbtn eco-x" data-eco-close aria-label="Close the Eco sidebar">${icon.x}</button></div>
      <div class="eco-b">
        ${ENTRIES.map(
          (g) => html`<section class="eco-g"><div class="eyebrow eco-gh">${g.group}</div>
            ${g.items.map(
              (it) => html`<a class="eco-i" href="${it.href}"${it.ext ? raw(' data-docs="1"') : ""}>
                <span class="eco-il"><b>${it.label}</b><span class="eco-n">${it.note}</span></span>
                ${it.fig ? html`<span class="eco-f" data-eco-fig="${it.fig}"><span class="num">…</span><span class="eco-fs"></span></span>` : html`<span class="eco-f eco-arrow">${it.ext ? icon.ext : raw("&rarr;")}</span>`}
              </a>`,
            )}</section>`,
        )}
        <div class="eco-live"><span class="eco-ld" id="eco-live" data-s="${live.upstream}"><i></i></span><span id="eco-live-t">${live.upstream === "open" ? "Live" : live.upstream === "down" ? "Core offline" : "Connecting"}</span><span class="dim">Core event stream</span></div>
      </div>
    </aside>`;
}

let open = false;
let timer: ReturnType<typeof setInterval> | null = null;
let lastFocus: HTMLElement | null = null;

export function toggleEco() {
  if (open) closeEco();
  else openEco();
}

export function openEco() {
  const el = document.getElementById("eco");
  if (!el || open) return;
  open = true;
  lastFocus = document.activeElement as HTMLElement | null;
  el.removeAttribute("inert");
  el.setAttribute("aria-hidden", "false");
  el.classList.add("on");
  document.getElementById("eco-scrim")!.hidden = false;
  document.getElementById("eco-open")?.setAttribute("aria-expanded", "true");
  document.documentElement.classList.add("eco-open");
  el.querySelector<HTMLElement>(".eco-x")?.focus();
  void readFigures();
  timer = setInterval(() => void readFigures(), 20_000);
}

export function closeEco() {
  const el = document.getElementById("eco");
  if (!el || !open) return;
  open = false;
  el.classList.remove("on");
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("inert", "");
  document.getElementById("eco-scrim")!.hidden = true;
  document.getElementById("eco-open")?.setAttribute("aria-expanded", "false");
  document.documentElement.classList.remove("eco-open");
  if (timer) clearInterval(timer);
  timer = null;
  lastFocus?.focus?.();
}

const json = (u: string) => fetch(u, { headers: { accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

async function readFigures() {
  const [stats, health, market] = await Promise.all([json("/api/stats"), json("/api/health"), json("/market/tokens?limit=200")]);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : null);
  const tokens = Array.isArray(market?.tokens) ? (market.tokens as { trades_24h?: number }[]) : null;
  // the list is complete only when it holds every token the indexer has
  const trades = tokens && market.total === tokens.length ? tokens.reduce((a, t) => a + (Number(t.trades_24h) || 0), 0) : null;
  const figs: Fig[] = [
    { id: "agents", text: n(stats?.agents), sub: "agents" },
    { id: "machines", text: stats && typeof stats.machines_awake === "number" ? `${n(stats.machines_awake)}/${n(stats.machines)}` : null, sub: "awake" },
    { id: "epoch", text: n(health?.epoch ?? stats?.epoch), sub: "current" },
    { id: "trades", text: n(trades), sub: "trades 24h" },
  ];
  for (const f of figs) {
    const el = document.querySelector<HTMLElement>(`[data-eco-fig="${f.id}"]`);
    if (!el) continue;
    el.querySelector(".num")!.textContent = f.text ?? "TBA";
    el.querySelector(".eco-fs")!.textContent = f.text ? f.sub : "not readable now";
    el.classList.toggle("tba", !f.text);
  }
}
