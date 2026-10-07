import { get } from "./api.ts";
import { html, type Raw } from "./html.ts";

// Files at a generation, read from Core (GET /v1/lineages/:id/file), with the sha256 recomputed
// in the browser so the live wall can prove the bytes on screen are the bytes the agent reported.

export interface TreeFile {
  lineage_id: string;
  gen_id: string;
  height: number;
  path: string;
  source: string;
  sha256: string | null;
  lines: number | null;
  truncated: boolean;
  text: string | null;
  /** sha256 computed here, in the browser, over the UTF-8 bytes of text */
  local_sha256: string | null;
}

const cache = new Map<string, Promise<TreeFile | { error: string; message: string }>>();

async function sha256(text: string): Promise<string | null> {
  try {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null; // not a secure context
  }
}

export function fileAt(lineage: string, gen: string, path: string) {
  const key = `${lineage}/${gen}/${path}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const f = await get<TreeFile>(`lineages/${lineage}/file?gen=${gen}&path=${encodeURIComponent(path)}`);
        f.local_sha256 = f.text !== null && !f.truncated ? await sha256(f.text) : null;
        return f;
      } catch (e) {
        const err = e as { code?: string; message?: string };
        cache.delete(key);
        return { error: err.code ?? "error", message: err.message ?? String(e) };
      }
    })();
    cache.set(key, p);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** A window of a file around [start, end], with that range highlighted. Sans font, whitespace kept. */
export function codeWindow(text: string, start: number | null, end: number | null, opts: { context?: number; rows?: number } = {}): Raw {
  const lines = text.replace(/\n$/, "").split("\n");
  const ctx = opts.context ?? 3;
  const rowsN = opts.rows ?? 16;
  const s = Math.min(start ?? 1, lines.length);
  const e = Math.min(end ?? s, lines.length);
  // a fixed-height window, so every channel on the wall has the same shape
  let from = Math.max(1, s - ctx);
  let to = Math.min(lines.length, from + rowsN - 1);
  from = Math.max(1, to - rowsN + 1);
  const rows: Raw[] = [];
  for (let n = from; n <= to; n++) {
    const hit = start !== null && n >= s && n <= e;
    rows.push(html`<tr class="${hit ? "hit" : ""}"><td class="ln">${n}</td><td class="code">${lines[n - 1] ?? ""}</td></tr>`);
  }
  const more = e > to ? html`<div class="code-more">range continues for ${e - to} more lines; ${lines.length} lines in the file</div>` : html`<div class="code-more">${lines.length} lines in the file</div>`;
  return html`<div class="codeview"><table>${rows}</table>${more}</div>`;
}
