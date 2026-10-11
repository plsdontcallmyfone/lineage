// Low-key motion for the app's toggles: in every segmented control (.seg, .ex-seg) the pressed
// option's dark pill slides to the option you pick instead of jumping. One observer covers every page.
// Pages often re-render a control on each pick (a new element), so the pill's last box is remembered
// per control (page, label and order) and a new control starts from there and glides; a control seen
// for the first time just appears. Reduced motion: the pill moves without easing (CSS).

const GROUPS = ".seg, .ex-seg";
type Box = { x: number; y: number; w: number; h: number };
const last = new Map<string, Box>();

function keyOf(g: HTMLElement, i: number) {
  return `${location.pathname}|${g.getAttribute("aria-label") ?? g.className}|${i}`;
}
function set(g: HTMLElement, b: Box) {
  g.style.setProperty("--gx", `${b.x}px`);
  g.style.setProperty("--gy", `${b.y}px`);
  g.style.setProperty("--gw", `${b.w}px`);
  g.style.setProperty("--gh", `${b.h}px`);
}

function place(g: HTMLElement, key: string) {
  const on = g.querySelector<HTMLElement>(':scope > [aria-pressed="true"]');
  if (!on || !g.offsetParent) return;
  const gb = g.getBoundingClientRect();
  const r = on.getBoundingClientRect();
  const box: Box = { x: r.left - gb.left - g.clientLeft + g.scrollLeft, y: r.top - gb.top - g.clientTop, w: r.width, h: r.height };
  const prev = last.get(key);
  last.set(key, box);
  if (g.hasAttribute("data-glide")) return set(g, box);
  g.setAttribute("data-glide", "");
  if (prev && (prev.x !== box.x || prev.w !== box.w)) {
    // a re-rendered control: start where the pill was, then glide to the pick
    set(g, prev);
    g.setAttribute("data-glide-ready", "");
    requestAnimationFrame(() => requestAnimationFrame(() => set(g, box)));
  } else {
    set(g, box);
    requestAnimationFrame(() => requestAnimationFrame(() => g.setAttribute("data-glide-ready", "")));
  }
}

let queued = false;
function all() {
  queued = false;
  const seen = new Map<string, number>();
  for (const g of document.querySelectorAll<HTMLElement>(GROUPS)) {
    const base = `${g.getAttribute("aria-label") ?? g.className}`;
    const i = seen.get(base) ?? 0;
    seen.set(base, i + 1);
    place(g, keyOf(g, i));
  }
}
const soon = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(all);
};

export function glide() {
  new MutationObserver(soon).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-pressed", "hidden"] });
  window.addEventListener("resize", soon, { passive: true });
  document.fonts?.ready.then(soon).catch(() => {});
  soon();
}
