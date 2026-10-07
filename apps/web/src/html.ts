// Tiny escaping template: html`...` returns Raw; interpolated values are escaped unless Raw.

export class Raw {
  constructor(public s: string) {}
  toString() {
    return this.s;
  }
}
export const raw = (s: string) => new Raw(s);

export function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function part(v: unknown): string {
  if (v === null || v === undefined || v === false || v === true) return "";
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join("");
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...vals: unknown[]): Raw {
  let out = strings[0]!;
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1]!;
  return new Raw(out);
}

export const join = (xs: unknown[], sep: Raw | string = "") => raw(xs.map(part).join(sep instanceof Raw ? sep.s : esc(sep)));
