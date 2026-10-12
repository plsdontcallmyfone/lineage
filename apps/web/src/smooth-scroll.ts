// The landing site's scroll feel on every page: the mouse wheel glides to where it points instead of
// jumping (this eases the window's own scroll
// position, so sticky headers, anchors and inner scroll areas keep working). Only the wheel: touch,
// keys, the scrollbar and programmatic scrolls stay native. Off with reduced motion, with Ctrl
// (zoom), and over anything that can still scroll itself in the wheel's direction (deck columns,
// feeds, menus, the chart).

const TAU = 0.16; // seconds to close about 63% of the gap; settles in about .8 s
let target = 0;
let pos = 0;
let raf = 0;
let last = 0;

function scrollsItself(el: Element | null, dy: number): boolean {
  for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    if (n.matches?.(".tk-chart, .tv-lightweight-charts, [data-native-scroll]")) return true;
    const s = getComputedStyle(n);
    if (!/(auto|scroll|overlay)/.test(s.overflowY) || n.scrollHeight <= n.clientHeight + 1) continue;
    if (dy < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1) return true;
  }
  return false;
}

function frame(t: number) {
  const dt = Math.min(0.05, last ? (t - last) / 1000 : 1 / 60);
  last = t;
  pos += (target - pos) * (1 - Math.exp(-dt / TAU));
  if (Math.abs(target - pos) < 0.5) pos = target;
  window.scrollTo(0, pos);
  raf = pos === target ? 0 : requestAnimationFrame(frame);
  if (!raf) last = 0;
}

export function smoothScroll() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  window.addEventListener(
    "wheel",
    (ev) => {
      if (ev.ctrlKey || ev.defaultPrevented || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
      if (scrollsItself(ev.target as Element, ev.deltaY)) return;
      ev.preventDefault();
      if (!raf) pos = target = window.scrollY;
      const px = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * window.innerHeight : ev.deltaY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      target = Math.max(0, Math.min(max, target + px));
      if (!raf) raf = requestAnimationFrame(frame);
    },
    { passive: false },
  );
  // a scroll that is not ours (keys, scrollbar, anchors, route changes) resets the glide
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
  };
  for (const e of ["keydown", "pointerdown", "touchstart"]) window.addEventListener(e, stop, { passive: true });
  window.addEventListener("units:route", stop);
}
