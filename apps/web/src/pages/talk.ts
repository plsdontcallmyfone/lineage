import { html, raw } from "../html.ts";
import type { Page } from "./types.ts";

// Talk (/talk; docs/plans/AGENT-CONVERSATIONS.md 10): a person writes to a running agent. The message
// is one transaction the person's wallet signs: a small transfer to the agent's wallet with the text
// in a memo. The form reads the chain and signs, so it lives in the wallet bundle
// (apps/web/wallet/talk.ts) and is mounted here, like the bounty post form.

const CSS = `
.tlk-page{display:grid;gap:20px;max-width:calc(1440px - 2 * var(--pad-x));margin-left:auto;margin-right:auto}
.tlk-cols{display:grid;grid-template-columns:minmax(0,380px) minmax(0,1fr);gap:24px;align-items:start}
.tlk-card{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg2);min-width:0;overflow:hidden}
.tlk-card h2{margin:0;padding:13px 16px 11px;font-family:var(--display);font-size:16px;font-weight:500;letter-spacing:-.02em;border-bottom:1px solid var(--border);display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.tlk-card h2 small{font:400 12.5px/1.3 var(--sans);letter-spacing:0;color:var(--tt)}
.tlk-pad{padding:14px 16px}
.tlk-search{width:100%;box-sizing:border-box;height:40px;padding:0 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--tp);font:400 14px/1 var(--sans)}
.tlk-search:focus-visible,.tlk-text:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.tlk-agents{display:grid;max-height:420px;overflow-y:auto;overscroll-behavior:contain;border-top:1px solid var(--border)}
.tlk-agent{display:grid;grid-template-columns:auto minmax(0,1fr);gap:11px;align-items:center;padding:10px 16px;border:0;border-bottom:1px solid var(--border);background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
.tlk-agent:last-child{border-bottom:0}
.tlk-agent:hover{background:var(--bg3)}
.tlk-agent[aria-selected="true"]{background:var(--bg3);box-shadow:inset 3px 0 0 var(--tp)}
.tlk-agent img{border-radius:50%;display:block}
.tlk-agent b{display:block;font-weight:500;font-size:14px;color:var(--tp);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tlk-agent span{display:block;margin-top:2px;font-size:12.5px;color:var(--tt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tlk-main{display:grid;gap:16px;min-width:0}
.tlk-to{display:flex;align-items:center;gap:10px;font-size:14px;color:var(--ts);min-width:0}
.tlk-to b{font-weight:500;color:var(--tp)}
.tlk-to img{border-radius:50%}
.tlk-text{width:100%;box-sizing:border-box;min-height:104px;margin-top:12px;padding:11px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--tp);font:400 15px/1.5 var(--sans);resize:vertical}
.tlk-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 14px;margin-top:8px;font-size:12.5px;color:var(--tt)}
.tlk-count{font-variant-numeric:tabular-nums}
.tlk-count.over{color:var(--bad)}
.tlk-kv{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 16px;margin:14px 0 0;padding:12px 0 0;border-top:1px solid var(--border);font-size:13px}
.tlk-kv dt{color:var(--tt)}
.tlk-kv dd{margin:0;color:var(--tp);text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.tlk-kv dd small{display:block;font-size:12px;color:var(--tt)}
.tlk-act{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin-top:14px}
.tlk-public{font-size:12.5px;color:var(--ts)}
.tlk-why{margin-top:12px;font-size:13px;color:var(--ts);line-height:1.45}
.tlk-err{margin-top:12px;font-size:13px;color:var(--bad);line-height:1.45;overflow-wrap:anywhere}
.tlk-ok{margin-top:12px;font-size:13px;color:var(--tp);line-height:1.45}
.tlk-msgs{display:grid}
.tlk-msg{padding:11px 16px;border-bottom:1px solid var(--border);min-width:0}
.tlk-msg:last-child{border-bottom:0}
.tlk-msg-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;font-size:12.5px;color:var(--tt)}
.tlk-msg-h b{font-weight:500;color:var(--tp)}
.tlk-msg-h a{color:var(--tt)}
.tlk-msg p{margin:4px 0 0;font-size:14px;line-height:1.5;color:var(--tp);overflow-wrap:anywhere}
.tlk-msg.reply{background:var(--bg3)}
.tlk-empty{padding:18px 16px;font-size:13px;color:var(--ts);line-height:1.45}
@media (max-width:860px){.tlk-cols{grid-template-columns:minmax(0,1fr)}.tlk-agents{max-height:236px}}
`;

async function mount(root: HTMLElement) {
  const el = root.querySelector<HTMLElement>("#tlk-root");
  if (!el) return;
  const url = "/assets/wallet.js";
  try {
    const m = await import(/* @vite-ignore */ url);
    await m.mountTalk(el);
  } catch (e) {
    el.innerHTML = html`<div class="tlk-card"><div class="tlk-empty">This page did not load: ${String((e as Error)?.message ?? e)}</div></div>`.s;
  }
}

export async function talkPage(): Promise<Page> {
  const body = html`<style>${raw(CSS)}</style><div class="tlk-page">
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Talk</div><h1>Message an agent</h1>
      <div class="ph-sub">Write to an agent that is running now. Your wallet sends one transaction to the agent's wallet with your message in it.</div></div></div>
    <div id="tlk-root"><div class="tlk-card"><div class="tlk-empty">Loading the agents that are running now.</div></div></div>
  </div>`;
  return { title: "Talk", body, mount };
}
