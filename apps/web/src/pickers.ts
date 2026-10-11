// The app's own pickers in place of the operating system's: every <select> becomes a button that
// opens a styled list, every <input type="date"> a button that opens a small calendar. The native
// element stays in the page, transparent under the button, so forms, page code and tests read and
// set it as before; picking writes its value and fires input and change like a native pick. One
// observer covers controls that pages render later or re-render. Opt out with data-native.

const SEL = "select:not([data-native]):not([multiple]), input[type=date]:not([data-native])";
const chev = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const cal = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let pop: HTMLElement | null = null;
let owner: HTMLElement | null = null;

function close() {
  pop?.remove();
  pop = null;
  owner?.setAttribute("aria-expanded", "false");
  owner = null;
}

function place(btn: HTMLElement, p: HTMLElement) {
  const r = btn.getBoundingClientRect();
  const w = Math.max(r.width, p.dataset.kind === "date" ? 260 : 180);
  p.style.minWidth = `${w}px`;
  const below = window.innerHeight - r.bottom;
  const h = Math.min(p.scrollHeight, 300);
  const top = below < h + 12 && r.top > h + 12 ? r.top - h - 6 : r.bottom + 6;
  p.style.top = `${Math.round(top)}px`;
  p.style.left = `${Math.round(Math.min(r.left, window.innerWidth - w - 8))}px`;
}

function fire(el: HTMLInputElement | HTMLSelectElement) {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// ------------------------------------------------------------------------------------------------ select

function label(s: HTMLSelectElement) {
  return s.selectedOptions[0]?.textContent?.trim() || s.options[0]?.textContent?.trim() || "";
}

function openSelect(s: HTMLSelectElement, btn: HTMLElement) {
  close();
  owner = btn;
  btn.setAttribute("aria-expanded", "true");
  const p = document.createElement("div");
  p.className = "cs-pop";
  p.setAttribute("role", "listbox");
  p.innerHTML = [...s.options]
    .map(
      (o, i) =>
        `<button type="button" role="option" class="cs-opt" data-i="${i}" aria-selected="${o.selected}"${o.disabled ? " disabled" : ""}><span>${esc(o.textContent?.trim() || o.value)}</span>${o.selected ? `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>` : ""}</button>`,
    )
    .join("");
  document.body.appendChild(p);
  pop = p;
  place(btn, p);
  (p.querySelector<HTMLElement>('[aria-selected="true"]') ?? p.querySelector<HTMLElement>(".cs-opt:not([disabled])"))?.focus();
  p.addEventListener("click", (ev) => {
    const o = (ev.target as HTMLElement).closest<HTMLButtonElement>(".cs-opt");
    if (!o || o.disabled) return;
    const i = Number(o.dataset.i);
    if (s.selectedIndex !== i) {
      s.selectedIndex = i;
      fire(s);
    }
    sync(s);
    close();
    btn.focus();
  });
  p.addEventListener("keydown", (ev) => {
    const items = [...p.querySelectorAll<HTMLButtonElement>(".cs-opt:not([disabled])")];
    const k = items.indexOf(document.activeElement as HTMLButtonElement);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, k + (ev.key === "ArrowDown" ? 1 : -1)))]?.focus();
    } else if (ev.key === "Escape") {
      close();
      btn.focus();
    }
  });
}

// ------------------------------------------------------------------------------------------------ date

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : null);
const pretty = (v: string) => {
  const d = parse(v);
  return d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
};

function openDate(inp: HTMLInputElement, btn: HTMLElement) {
  close();
  owner = btn;
  btn.setAttribute("aria-expanded", "true");
  const p = document.createElement("div");
  p.className = "cs-pop cs-cal";
  p.dataset.kind = "date";
  const cur = parse(inp.value);
  let view = new Date((cur ?? new Date()).getFullYear(), (cur ?? new Date()).getMonth(), 1);
  const min = parse(inp.min);
  const max = parse(inp.max);
  const draw = () => {
    const first = (view.getDay() + 6) % 7; // weeks start on Monday
    const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const today = ymd(new Date());
    let cells = "";
    for (let i = 0; i < first; i++) cells += `<span></span>`;
    for (let d = 1; d <= days; d++) {
      const date = new Date(view.getFullYear(), view.getMonth(), d);
      const v = ymd(date);
      const off = (min && date < min) || (max && date > max);
      cells += `<button type="button" class="cs-day${v === inp.value ? " on" : ""}${v === today ? " today" : ""}" data-v="${v}"${off ? " disabled" : ""}>${d}</button>`;
    }
    p.innerHTML = `<div class="cs-cal-h"><button type="button" class="cs-nav" data-m="-1" aria-label="Previous month">${chev}</button><b>${view.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</b><button type="button" class="cs-nav" data-m="1" aria-label="Next month">${chev}</button></div>
      <div class="cs-wk">${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="cs-grid">${cells}</div>
      <div class="cs-cal-f"><button type="button" class="cs-link" data-v="">Clear</button><button type="button" class="cs-link" data-v="${today}">Today</button></div>`;
  };
  draw();
  document.body.appendChild(p);
  pop = p;
  place(btn, p);
  p.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const nav = t.closest<HTMLElement>(".cs-nav");
    if (nav) {
      view = new Date(view.getFullYear(), view.getMonth() + Number(nav.dataset.m), 1);
      draw();
      return;
    }
    const b = t.closest<HTMLButtonElement>("[data-v]");
    if (!b || b.disabled) return;
    if (inp.value !== b.dataset.v) {
      inp.value = b.dataset.v!;
      fire(inp);
    }
    sync(inp);
    close();
    btn.focus();
  });
  p.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      close();
      btn.focus();
    }
  });
}

// ------------------------------------------------------------------------------------------------ wiring

const buttons = new WeakMap<HTMLElement, HTMLButtonElement>();

function sync(el: HTMLSelectElement | HTMLInputElement) {
  const b = buttons.get(el);
  if (!b) return;
  const text = el instanceof HTMLSelectElement ? label(el) : pretty(el.value) || (el.placeholder || "Any date");
  b.querySelector(".cs-v")!.textContent = text;
  b.classList.toggle("is-empty", el instanceof HTMLInputElement && !el.value);
  b.disabled = el.disabled;
}

function enhance(el: HTMLSelectElement | HTMLInputElement) {
  if (buttons.has(el) || el.closest(".cs")) return;
  const wrap = document.createElement("span");
  wrap.className = "cs";
  el.parentNode!.insertBefore(wrap, el);
  wrap.appendChild(el);
  el.classList.add("cs-native");
  el.tabIndex = -1;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cs-btn";
  btn.setAttribute("aria-haspopup", el instanceof HTMLSelectElement ? "listbox" : "dialog");
  btn.setAttribute("aria-expanded", "false");
  const lab = el.closest("label")?.querySelector(".eyebrow")?.textContent?.trim() ?? el.getAttribute("aria-label");
  if (lab) btn.setAttribute("aria-label", lab);
  btn.innerHTML = `<span class="cs-v"></span>${el instanceof HTMLSelectElement ? chev : cal}`;
  wrap.appendChild(btn);
  buttons.set(el, btn);
  sync(el);
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (owner === btn) return close();
    if (el instanceof HTMLSelectElement) openSelect(el, btn);
    else openDate(el, btn);
  });
  el.addEventListener("change", () => sync(el));
  new MutationObserver(() => sync(el)).observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "value"] });
}

export function pickers() {
  const scan = () => document.querySelectorAll<HTMLSelectElement | HTMLInputElement>(SEL).forEach(enhance);
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  }).observe(document.body, { childList: true, subtree: true });
  scan();
  document.addEventListener("click", (ev) => {
    if (pop && !pop.contains(ev.target as Node)) close();
  });
  window.addEventListener("resize", close);
  window.addEventListener("scroll", () => owner && pop && place(owner, pop), { passive: true });
  window.addEventListener("units:route", close);
}
