import { html, type Raw } from "./html.ts";

// Unified diff renderer: file headers, hunk headers, old and new line numbers, add and remove
// colouring. Code text uses the UI sans (owner rule: no monospace fonts) with whitespace preserved.

export function renderDiff(patch: string | null | undefined): Raw {
  if (!patch) return html`<div class="empty"><div class="t1">No patch</div></div>`;
  const rows: Raw[] = [];
  let oldN = 0;
  let newN = 0;
  const lines = patch.replace(/\n$/, "").split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      rows.push(html`<tr class="file"><td colspan="4">${m ? m[2] : line.slice(11)}</td></tr>`);
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ") || /^(new|deleted) file mode/.test(line)) continue;
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (m) {
        oldN = Number(m[1]);
        newN = Number(m[2]);
      }
      rows.push(html`<tr class="hunk"><td class="ln"></td><td class="ln"></td><td class="sg"></td><td class="code">${line}</td></tr>`);
      continue;
    }
    if (line.startsWith("+")) {
      rows.push(html`<tr class="add"><td class="ln"></td><td class="ln">${newN++}</td><td class="sg">+</td><td class="code">${line.slice(1)}</td></tr>`);
    } else if (line.startsWith("-")) {
      rows.push(html`<tr class="del"><td class="ln">${oldN++}</td><td class="ln"></td><td class="sg">−</td><td class="code">${line.slice(1)}</td></tr>`);
    } else if (line.startsWith("\\")) {
      rows.push(html`<tr><td class="ln"></td><td class="ln"></td><td class="sg"></td><td class="code faint">${line}</td></tr>`);
    } else {
      rows.push(html`<tr><td class="ln">${oldN++}</td><td class="ln">${newN++}</td><td class="sg"></td><td class="code">${line.slice(1)}</td></tr>`);
    }
  }
  return html`<div class="diff"><table>${rows}</table></div>`;
}

export function diffStats(patch: string | null | undefined): { files: number; add: number; del: number } {
  if (!patch) return { files: 0, add: 0, del: 0 };
  let files = 0,
    add = 0,
    del = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("diff --git ")) files++;
    else if (l.startsWith("+") && !l.startsWith("+++ ")) add++;
    else if (l.startsWith("-") && !l.startsWith("--- ")) del++;
  }
  return { files, add, del };
}
