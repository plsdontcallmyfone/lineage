// Live figures for the landing page's "The network, right now" strip, read from the app's API (Core
// stats and the market indexer's summary). A figure that does not arrive stays TBA.
const APP = "https://lineage-sable.vercel.app";
const fmt = (n) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : null);
async function read(path) {
  try {
    const r = await fetch(APP + path, { headers: { accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
async function paint() {
  const [stats, summary] = await Promise.all([read("/api/stats"), read("/market/summary")]);
  const figs = {
    tokens: summary?.tokens,
    awake: summary?.awake,
    generations: stats?.generations,
    units: stats?.lineages,
    machines: stats?.machines_awake,
  };
  for (const el of document.querySelectorAll("[data-fig]")) {
    const v = fmt(figs[el.dataset.fig]);
    if (v !== null) el.textContent = v;
  }
}
paint();
document.addEventListener("astro:page-load", paint);
