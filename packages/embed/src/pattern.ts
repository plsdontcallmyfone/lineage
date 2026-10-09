// Generated profile patterns (plan S): an agent without an uploaded avatar or banner gets a pattern
// drawn from its id, never an AI image. Deterministic (FNV-1a over the id drives a small PRNG), pure
// strings, so the dashboard, the embed kit and tests produce the same SVG for the same agent.

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function rng(seed: number) {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

/** Two hues and a lightness pair from the id (readable on light and dark surfaces). */
export function patternColors(id: string) {
  const r = rng(fnv(id));
  const h1 = Math.floor(r() * 360);
  const h2 = (h1 + 40 + Math.floor(r() * 140)) % 360;
  return { a: `hsl(${h1} 62% 52%)`, b: `hsl(${h2} 58% 44%)`, bg: `hsl(${h1} 40% 92%)`, bgDark: `hsl(${h1} 30% 18%)`, h1, h2 };
}

/** A 5 by 5 mirrored grid on a soft ground, like an identicon, in the id's two hues. */
export function avatarSvg(id: string, size = 64, label = "Generated pattern"): string {
  const r = rng(fnv(`avatar:${id}`));
  const c = patternColors(id);
  const cell = size / 6;
  const off = cell / 2;
  let rects = "";
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++) {
      const v = r();
      if (v < 0.5) continue;
      const fill = v > 0.8 ? c.b : c.a;
      for (const xx of x === 2 ? [2] : [x, 4 - x]) rects += `<rect x="${(off + xx * cell).toFixed(2)}" y="${(off + y * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" rx="${(cell * 0.18).toFixed(2)}" fill="${fill}"/>`;
    }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${label}"><rect width="${size}" height="${size}" fill="${c.bg}"/>${rects}</svg>`;
}

/** A wide banner: layered contour bands in the id's hues. */
export function bannerSvg(id: string, w = 1200, h = 240): string {
  const r = rng(fnv(`banner:${id}`));
  const c = patternColors(id);
  const bands = 7;
  let paths = "";
  for (let i = 0; i < bands; i++) {
    const base = (h / bands) * (i + 0.6);
    const amp = h * (0.05 + r() * 0.12);
    const ph = r() * Math.PI * 2;
    const f = 1 + Math.floor(r() * 3);
    let d = `M0 ${h}`;
    for (let x = 0; x <= w; x += w / 24) d += ` L${x.toFixed(1)} ${(base + Math.sin((x / w) * Math.PI * 2 * f + ph) * amp).toFixed(1)}`;
    d += ` L${w} ${h} Z`;
    const op = (0.16 + (i / bands) * 0.5).toFixed(2);
    paths += `<path d="${d}" fill="${i % 2 ? c.b : c.a}" fill-opacity="${op}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Generated banner"><rect width="${w}" height="${h}" fill="${c.bgDark}"/>${paths}</svg>`;
}

export const svgDataUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
