import { get, loadConfig, state } from "../api.ts";
import { int, repoLabel, tokenText, TOKEN } from "../fmt.ts";
import { esc, html, raw, type Raw } from "../html.ts";
import { badge, icon, linLink, panel, stat } from "../ui.ts";
import type { Page } from "./types.ts";

// Spawn (PARITY "Spawn"): per target class, what a verifier needs, how many qualified verifiers and
// lineages Core holds, and the exact commands of the verifier kit. The agent launch is a preview of
// the record a launch creates; the onchain launch itself is M2.

/** SPEC 6.1 target classes, as written in the spec (metric and hardware text). */
export const CLASSES: { cls: string; title: string; metric: string; needs: string; image: string }[] = [
  { cls: "rust", title: "Systems performance", metric: "instruction count under cachegrind (Ir) for a seeded workload", needs: "image arch; CPU", image: "images/rust" },
  { cls: "solana", title: "Compute units", metric: "compute units per instruction, measured in-process by an SVM test harness on seeded instruction data", needs: "image arch; CPU", image: "images/solana" },
  { cls: "zig", title: "Binary size", metric: "bytes of the ReleaseSmall artifact", needs: "image arch; CPU", image: "images/zig" },
  { cls: "cuda", title: "Kernel throughput", metric: "executed warp instructions per kernel launch (ncu smsp__inst_executed.sum)", needs: "NVIDIA GPU of the recipe's compute capability, driver at least the image's CUDA version", image: "images/cuda" },
  { cls: "python", title: "Interpreter performance", metric: "instruction count under cachegrind", needs: "image arch; CPU", image: "images/python" },
  { cls: "go", title: "Systems performance", metric: "instruction count under cachegrind, GOMAXPROCS=1 GOGC=off", needs: "image arch; CPU", image: "images/go" },
  { cls: "cpp", title: "Systems performance", metric: "instruction count under cachegrind of a seeded workload", needs: "image arch; CPU", image: "images/cpp" },
];

const W = "bun packages/worker/src/main.ts";

function cmd(lines: string[], label: string): Raw {
  const text = lines.join("\n");
  return html`<div class="cmd"><div class="cmd-h"><span>${label}</span><button type="button" class="copy" data-copy="${text}" aria-label="Copy commands">${icon.copy} Copy</button></div><pre>${text}</pre></div>`;
}

export async function spawnPage(): Promise<Page> {
  const [cfg, lineages, agents] = await Promise.all([loadConfig(), get<any[]>("lineages"), get<any[]>("agents")]);
  const views = await Promise.all(lineages.map((l) => get(`lineages/${l.lineage_id}`)));
  const core = state.coreUrl ?? "http://127.0.0.1:9660";
  const verifiers = agents.filter((a) => a.kind === "verifier" && !a.reference);
  const rows = CLASSES.map((c) => {
    const ls = views.filter((v) => v.recipe?.class === c.cls && v.status === "active");
    const ids = new Set(ls.map((v) => v.lineage_id));
    // a passed qualification, whatever the verifier's momentary load (eligibility also needs a free replay slot)
    const qualified = verifiers.filter((a) => (a.qualifications as any[]).some((q) => q.status === "passed" && ids.has(q.lineage_id)));
    const declared = verifiers.filter((a) => a.capabilities && ls.some((v) => satisfies(a.capabilities, v.recipe.requires)));
    const arches = [...new Set(ls.map((v) => v.recipe.requires?.arch))].filter(Boolean);
    const gpus = [...new Set(ls.map((v) => (v.recipe.requires?.gpu ? `sm ${v.recipe.requires.gpu.sm}` : null)))].filter(Boolean);
    const images = [...new Set(ls.map((v) => v.recipe.image as string))];
    const offered = ls.length > 0 && qualified.length >= cfg.quorum;
    return { ...c, ls, qualified, declared, arches, gpus, images, offered };
  });
  const offered = rows.filter((r) => r.offered).length;

  const table = html`<div class="tw"><table class="t">
    <thead><tr><th>Class</th><th class="hide-sm">Primary metric</th><th class="hide-sm">Verifier needs</th><th class="right">Lineages</th><th class="right">Qualified verifiers</th><th>At launch</th></tr></thead>
    <tbody>${rows.map(
      (r) => html`<tr>
        <td><b>${r.cls}</b><div class="sub">${r.title}</div><div class="sub show-sm">${r.metric}; needs ${r.needs}</div></td>
        <td class="wrap hide-sm">${r.metric}</td>
        <td class="wrap hide-sm">${r.needs}${r.arches.length ? html`<div class="sub">recipes pin ${r.arches.join(", ")}${r.gpus.length ? `, ${r.gpus.join(", ")}` : ""}</div>` : ""}</td>
        <td class="right num">${int(r.ls.length)}<div class="sub">${r.ls.slice(0, 3).map((v, i) => html`${i ? ", " : ""}${linLink(v.lineage_id, v.recipe.name)}`)}</div></td>
        <td class="right num">${int(r.qualified.length)}<div class="sub">of ${int(r.declared.length)} with capable hardware</div></td>
        <td>${r.offered ? badge("offered", "good", icon.check) : badge(r.ls.length ? `needs ${cfg.quorum} qualified` : "no calibrated lineage", "", icon.info)}</td>
      </tr>`,
    )}</tbody></table></div>`;

  const minBond = tokenText(cfg.min_bond, 2);
  const burn = tokenText(cfg.register_burn, 2);
  const tabs = html`<div class="seg" role="group" aria-label="Target class" data-tabs="spawn-class">${rows.map(
    (r, i) => html`<button type="button" data-tab="${r.cls}" aria-pressed="${i === 0}">${r.cls}</button>`,
  )}</div>`;
  const panes = rows.map((r, i) => {
    const key = `~/.lineage/keys/verifier-${r.cls}.json`;
    const imageLines = r.images.length
      ? r.images.map((im) => `docker build -t ${im.split("@")[0]} ${r.image}    # must produce ${im.split("@")[1]?.slice(0, 19)}...`)
      : [`docker build -t lineage/${r.cls} ${r.image}    # no calibrated ${r.cls} lineage pins a digest yet`];
    return html`<div data-pane="${r.cls}" ${i === 0 ? "" : raw("hidden")}>
      <div class="kit">
        ${cmd([`${W} keygen --out ${key}`], "1. Create the verifier key (ed25519, Solana keypair layout)")}
        ${cmd([`${W} doctor --full`], "2. Check this machine: arch, CPUs, memory, GPUs, lineage images")}
        ${cmd(imageLines, `3. Build the ${r.cls} toolchain image the recipes pin`)}
        ${cmd([`${W} register --core ${core} --key ${key}`], `4. Register with the capabilities doctor detected (burns register_burn = ${burn ?? "TBA"} ${TOKEN})`)}
        ${cmd([`${W} bond --core ${core} --key ${key} --amount ${cfg.min_bond}`], `5. Bond min_bond = ${minBond ?? "TBA"} ${TOKEN} (base units shown; slashable)`)}
        ${cmd([`${W} run --core ${core} --key ${key}`, `${W} status --core ${core} --key ${key}    # qualifications and eligibility`], "6. Run: qualification replay first, then assignments")}
      </div>
      <div class="kit-note">${
        r.ls.length
          ? html`On start the worker declares its hardware and Core issues a qualification replay for each of the ${int(r.ls.length)} ${r.cls} lineage${r.ls.length === 1 ? "" : "s"} it satisfies. It becomes assignable after one passes. Image digests must match the recipe exactly; a public registry for pinned images is TBA, so today the image is built locally.`
          : html`No ${r.cls} lineage is calibrated on this Core yet, so a ${r.cls} verifier would register and wait without a qualification.`
      } In M1 the burn and bond move simulated balances in Core's ledger; the wallet is funded by the admin faucet. M2 moves both on chain (<span class="num">lineage_registry</span>).</div>
    </div>`;
  });

  const repoOptions = views
    .filter((v) => v.status === "active")
    .map((v) => html`<option value="${v.repo}" data-class="${v.recipe.class}">${repoLabel(v.repo)} (${v.recipe.class}, ${v.recipe.name})</option>`);
  const launch = html`<form class="launch" data-launch-form>
      <label><span class="eyebrow">Class</span><select name="cls">${rows.map((r) => html`<option value="${r.cls}">${r.cls}, ${r.title.toLowerCase()}</option>`)}</select></label>
      <label><span class="eyebrow">Target repository</span><select name="repo"><option value="">Another public GitHub repository</option>${repoOptions}</select>
        <input name="repo_url" type="url" placeholder="https://github.com/owner/repo" autocomplete="off"></label>
      <fieldset><legend class="eyebrow">GitHub identity</legend>
        <label class="radio"><input type="radio" name="identity" value="token" checked> <span><b>Own token.</b> Paste a GitHub token at launch; a fine-grained token limited to the agent's forks is recommended. Any scope is accepted, and a full-scope token is a large liability for whoever holds it.</span></label>
        <label class="radio"><input type="radio" name="identity" value="purchased"> <span><b>Purchased account</b> from the operated pool. Price TBA.</span></label>
        <label class="radio"><input type="radio" name="identity" value="app"> <span><b>App identity</b> only (lineage-app[bot] on the project's forks). Always the fallback.</span></label>
      </fieldset>
      <label class="radio"><input type="checkbox" name="hosted" checked> <span>Hosted runtime (compute paid from the agent's vault). Hosted agents never verify.</span></label>
    </form>
    <div class="launch-out" data-launch-out>${launchPreview({ cls: rows[0]!.cls, repo: "", identity: "token", hosted: true }, views)}</div>`;

  const body = html`
    <div class="ph-row"><div class="ph-title"><div class="eyebrow">Spawn</div><h1>Run a verifier, or preview an agent launch</h1>
      <div class="ph-sub"><span>Counts are read from Core: lineages per class from calibrated recipes, verifiers from declared capabilities and passed qualifications. A class is offered at launch once it has a calibrated lineage and at least quorum (${cfg.quorum}) qualified verifiers (SPEC 6.1).</span></div></div></div>
    <section class="panel milled"><div class="stats" style="--n:4">
      ${stat("Classes offered", html`${int(offered)}<span class="unit">of ${CLASSES.length}</span>`, "lineage plus quorum of qualified verifiers")}
      ${stat("Verifiers", int(verifiers.length), `${int(verifiers.filter((a) => a.eligible).length)} with a free replay slot now`)}
      ${stat("Register burn", html`${burn ?? "TBA"}<span class="unit">${TOKEN}</span>`, "register_burn, M1 test value", "sm")}
      ${stat("Minimum bond", html`${minBond ?? "TBA"}<span class="unit">${TOKEN}</span>`, "min_bond, slashable", "sm")}
    </div></section>
    <div style="margin-top:16px">${panel("Target classes", table, { count: CLASSES.length, aside: html`<span>SPEC 6.1</span>` })}</div>
    <div class="grid-2" style="margin-top:16px">
      ${panel("Verifier kit", html`<div class="panel-b">${tabs}${panes}</div>`, { note: html`Commands use this repository's worker (<span class="num">packages/worker</span>) against the Core this dashboard reads: <span class="num">${core}</span>.` })}
      ${panel(html`Agent launch preview ${badge("M2", "warn")}`, launch, { note: html`Nothing is launched from this page. In M2 a launch is an onchain transaction (<span class="num">lineage_launch</span>, Meteora DBC paired with ${TOKEN}); curve, fees and thresholds are TBA (SPEC 13.7, 20).` })}
    </div>`;
  // no background refresh: it would reset the launch form while someone is typing
  return { title: "Spawn", body };
}

function satisfies(caps: any, req: any): boolean {
  if (!caps || !req) return false;
  if (req.arch && caps.arch !== req.arch) return false;
  if (req.min_cpus && caps.cpus < req.min_cpus) return false;
  if (req.min_memory_mb && caps.memory_mb < req.min_memory_mb) return false;
  if (req.gpu) return (caps.gpus ?? []).some((g: any) => g.vendor === req.gpu.vendor && g.sm === req.gpu.sm);
  return true;
}

let lastViews: any[] = [];
export function launchPreview(f: { cls: string; repo: string; identity: string; hosted: boolean }, views?: any[]): Raw {
  if (views) lastViews = views;
  const lin = lastViews.find((v) => v.repo === f.repo && v.status === "active");
  const record = {
    agent: "<new ed25519 key, created at launch>",
    mint: "<agent token mint, created by lineage_launch>",
    launcher: "<your wallet>",
    target_repo: f.repo || "<repository URL>",
    class: f.cls,
    hosted: f.hosted,
    identity_mode: f.identity,
  };
  const lifecycle = !f.repo
    ? html`Enter a repository to see what happens next.`
    : lin
      ? html`${badge("active at launch", "good", icon.check)} ${linLink(lin.lineage_id, lin.recipe.name)} is calibrated for this repository (class ${lin.recipe.class}${lin.recipe.class !== f.cls ? html`, <b>not ${f.cls}</b>` : ""}), so the agent can author as soon as its vault reaches wake_threshold.`
      : html`${badge("setting_up", "warn")} No calibrated lineage for this repository on this Core. The agent's first job is drafting a recipe; it authors only after calibration replays agree (SPEC 13.8).`;
  return html`<div class="panel-b"><div class="eyebrow" style="margin-bottom:6px">Launch record (SPEC 13.7)</div><pre class="json">${JSON.stringify(record, null, 2)}</pre><div class="dim" style="margin-top:10px">${lifecycle}</div></div>`;
}

/** Called by the shell when the launch form changes. */
export function onLaunchInput(form: HTMLFormElement) {
  const d = new FormData(form);
  const sel = String(d.get("repo") ?? "");
  const url = String(d.get("repo_url") ?? "").trim();
  const repoInput = form.querySelector<HTMLInputElement>('input[name="repo_url"]');
  if (repoInput) repoInput.hidden = sel !== "";
  const out = document.querySelector("[data-launch-out]");
  if (out) out.innerHTML = launchPreview({ cls: String(d.get("cls")), repo: sel || url, identity: String(d.get("identity")), hosted: d.get("hosted") === "on" }).s;
}
export { esc };
