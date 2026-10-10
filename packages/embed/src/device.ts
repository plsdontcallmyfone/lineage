// <lineage-device>: an original drawing of a beige all-in-one desktop computer in the classic style,
// in CSS only (no images, no marks or logos), with a screen slot any content can be mounted into.
// The landing page puts <lineage-terminal> on its screen; the live agent panel can go there too.
//
//   <lineage-device label="Lineage" keyboard lights="6">
//     <lineage-terminal frame="crt" height="372"></lineage-terminal>   <!-- slotted onto the screen -->
//   </lineage-device>
//
//   const d = mountDevice(el, { screen: myNode, keyboard: true });   // or { screen: "<p>html</p>" }
//   mountPanel(d.screen, ...);                                        // d.screen is a light-DOM div on the screen
//   d.setLights([true, true, false]);
//
// Attributes: `label` (the moulded name under the screen; default "Lineage"; empty for none),
// `keyboard` (draw a keyboard in front), `lights` (number of indicator lights under the screen, 0 to 8,
// default 6), `glass` crt (scanlines and curvature, default) or clear (no overlay, for dense content),
// `screen-height` (px; otherwise the screen is as tall as its content).
// Theming (custom properties on the element or an ancestor): --lineage-device-case,
// --lineage-device-case-hi, --lineage-device-case-lo, --lineage-device-ink, --lineage-device-tube-bg,
// --lineage-device-glow, --lineage-device-label-font. Parts: case, screen, chin, label, lights, light,
// drive, base, keyboard. Content on the screen keeps the page's styles (it is slotted, light DOM).

const CSS = `
:host { display: block; position: relative; container-type: inline-size; min-width: 0;
  --c: var(--lineage-device-case, #d8d0bf); --hi: var(--lineage-device-case-hi, #ece6d8); --lo: var(--lineage-device-case-lo, #b4aa94);
  --ink: var(--lineage-device-ink, #6d6453); --tube-bg: var(--lineage-device-tube-bg, #061008); --glow: var(--lineage-device-glow, #95eaa8); }
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
.dev { position: relative; display: flex; flex-direction: column; align-items: center; }
.dev::after { content: ""; position: absolute; left: 8%; right: 8%; bottom: -6px; height: 34px; border-radius: 50%; background: rgba(0,0,0,.5); filter: blur(20px); z-index: -1; }
:host([keyboard]) .dev::after { bottom: 10px; }
.case { position: relative; width: 100%; padding: 5.5cqi 6.5cqi 0; border-radius: 22px 22px 12px 12px;
  background: linear-gradient(178deg, var(--hi) 0%, var(--c) 30%, var(--c) 72%, var(--lo) 100%);
  box-shadow: inset 0 2px 0 rgba(255,255,255,.7), inset 2px 0 0 rgba(255,255,255,.3), inset -2px 0 0 rgba(0,0,0,.08), 0 30px 50px -24px rgba(0,0,0,.7); }
.case::before { content: ""; position: absolute; inset: 6px 6px 0; border-radius: 17px 17px 0 0; border: 1px solid rgba(0,0,0,.06); border-bottom: 0; pointer-events: none; }
.recess { padding: 3.4cqi; border-radius: 14px; background: linear-gradient(180deg, var(--lo), var(--c) 22%, var(--hi));
  box-shadow: inset 0 3px 6px rgba(0,0,0,.28), inset 0 -1px 0 rgba(255,255,255,.5), 0 1px 0 rgba(255,255,255,.7); }
.glass { position: relative; overflow: hidden; border-radius: 12px / 16px; padding: 10px 12px; min-height: 120px;
  background: radial-gradient(120% 95% at 50% 45%, color-mix(in oklab, var(--glow) 12%, var(--tube-bg)) 0%, var(--tube-bg) 62%, #020403 100%);
  box-shadow: inset 0 0 46px rgba(0,0,0,.85), inset 0 0 2px color-mix(in oklab, var(--glow) 30%, transparent), 0 0 0 3px #1c1c19; }
.glass.fixed { height: var(--sh); }
.glass.fixed ::slotted(*) { height: 100%; }
::slotted(*) { position: relative; z-index: 1; }
.glass::before, .glass::after { content: ""; position: absolute; inset: 0; pointer-events: none; border-radius: inherit; }
.glass::before { z-index: 2; background: repeating-linear-gradient(0deg, rgba(0,0,0,.22) 0 1px, transparent 1px 3px); mix-blend-mode: multiply; }
.glass::after { z-index: 3; background: radial-gradient(80% 50% at 22% 0%, rgba(255,255,255,.09), transparent 60%), linear-gradient(180deg, transparent 72%, rgba(0,0,0,.22)); }
:host([glass="clear"]) .glass { padding: 0; }
:host([glass="clear"]) .glass::before, :host([glass="clear"]) .glass::after { display: none; }
.chin { display: flex; align-items: center; gap: 14px; padding: 3.6cqi 1cqi 3.2cqi; min-height: 64px; }
.label { font-family: var(--lineage-device-label-font, "Instrument Serif", "Iowan Old Style", Georgia, serif); font-style: italic; font-size: 21px; line-height: 1; color: var(--ink);
  text-shadow: 0 1px 0 rgba(255,255,255,.75), 0 -1px 0 rgba(0,0,0,.12); white-space: nowrap; }
.label:empty { display: none; }
.lights { display: inline-flex; gap: 5px; padding: 5px 7px; border-radius: 5px; background: rgba(0,0,0,.09); box-shadow: inset 0 1px 2px rgba(0,0,0,.25), 0 1px 0 rgba(255,255,255,.55); }
.lights:empty { display: none; }
.lights i { width: 7px; height: 7px; border-radius: 2px; background: #6f6857; box-shadow: inset 0 1px 1px rgba(0,0,0,.35); transition: background .3s ease, box-shadow .3s ease; }
.lights i.on { background: color-mix(in oklab, var(--glow) 85%, white); box-shadow: 0 0 6px var(--glow), inset 0 -1px 1px rgba(0,0,0,.2); }
.drive { margin-left: auto; display: flex; flex-direction: column; align-items: flex-end; gap: 7px; }
.slot { width: clamp(70px, 24cqi, 150px); height: 9px; border-radius: 3px; background: linear-gradient(180deg, #24211c, #4a453a); box-shadow: 0 1px 0 rgba(255,255,255,.65), inset 0 1px 2px rgba(0,0,0,.6); }
.eject { width: 18px; height: 6px; border-radius: 2px; background: linear-gradient(180deg, var(--lo), var(--hi)); box-shadow: inset 0 1px 1px rgba(0,0,0,.3), 0 1px 0 rgba(255,255,255,.6); }
.base { width: 100%; height: 22px; margin-top: 0; border-radius: 0 0 12px 12px; position: relative;
  background: linear-gradient(180deg, var(--lo), var(--c) 30%, var(--lo)); box-shadow: inset 0 2px 0 rgba(0,0,0,.12), inset 0 3px 0 rgba(255,255,255,.35); }
.base::before { content: ""; position: absolute; left: 5%; top: 7px; width: 14%; height: 8px; border-radius: 2px;
  background: repeating-linear-gradient(90deg, rgba(0,0,0,.25) 0 2px, transparent 2px 5px); }
.keyboard { display: none; width: 90%; margin-top: 14px; padding: 9px 12px; gap: 5px; border-radius: 9px 9px 13px 13px;
  background: linear-gradient(180deg, var(--hi), var(--lo)); transform: perspective(700px) rotateX(42deg); transform-origin: top center;
  box-shadow: inset 0 2px 0 rgba(255,255,255,.6), 0 18px 24px -14px rgba(0,0,0,.7); }
:host([keyboard]) .keyboard { display: grid; }
.keyboard span { display: block; height: 11px; border-radius: 3px; background: repeating-linear-gradient(90deg, #f1ece1 0 calc(6.25% - 4px), transparent calc(6.25% - 4px) 6.25%); filter: drop-shadow(0 2px 0 rgba(0,0,0,.22)); }
.keyboard span:nth-child(2) { margin-left: 3%; }
.keyboard span:nth-child(3) { margin-left: 5%; }
.keyboard span:nth-child(4) { margin: 0 22%; background: #f1ece1; }
@container (max-width: 480px) {
  .case { border-radius: 16px 16px 10px 10px; padding: 12px 12px 0; }
  .recess { padding: 8px; border-radius: 11px; }
  .glass { padding: 6px; border-radius: 9px / 12px; }
  .chin { min-height: 50px; gap: 10px; padding: 12px 2px 10px; }
  .label { font-size: 18px; }
  .eject { display: none; }
  .keyboard { display: none !important; }
  .base { height: 16px; }
}
@media (prefers-reduced-motion: reduce) { .lights i { transition: none; } }
`;

const clampLights = (v: string | null) => {
  const n = v === null ? 6 : Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(8, n)) : 6;
};

export class LineageDevice extends HTMLElement {
  static observedAttributes = ["label", "lights", "screen-height"];
  private root: ShadowRoot | null = null;
  private lit: boolean[] = [];

  connectedCallback() {
    if (!this.root) {
      this.root = this.attachShadow({ mode: "open" });
      this.root.innerHTML = `<style>${CSS}</style><div class="dev" part="root">
        <div class="case" part="case">
          <div class="recess"><div class="glass" part="screen"><slot></slot></div></div>
          <div class="chin" part="chin"><span class="label" part="label"></span><span class="lights" part="lights" role="img"></span>
            <span class="drive" part="drive" aria-hidden="true"><span class="slot"></span><span class="eject"></span></span></div>
        </div>
        <div class="base" part="base" aria-hidden="true"></div>
        <div class="keyboard" part="keyboard" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      </div>`;
    }
    this.sync();
  }

  attributeChangedCallback() {
    if (this.root) this.sync();
  }

  /** Turns the indicator lights on or off, in order; missing entries are off. */
  setLights(on: boolean[]) {
    this.lit = on.slice();
    this.paintLights();
  }

  private sync() {
    const r = this.root!;
    const label = this.getAttribute("label");
    r.querySelector(".label")!.textContent = label === null ? "Lineage" : label;
    const n = clampLights(this.getAttribute("lights"));
    const box = r.querySelector<HTMLElement>(".lights")!;
    if (box.children.length !== n) box.innerHTML = `<i part="light"></i>`.repeat(n);
    const glass = r.querySelector<HTMLElement>(".glass")!;
    const h = Number(this.getAttribute("screen-height"));
    glass.classList.toggle("fixed", h > 0);
    if (h > 0) glass.style.setProperty("--sh", `${h}px`);
    else glass.style.removeProperty("--sh");
    this.paintLights();
  }

  private paintLights() {
    const box = this.root?.querySelector<HTMLElement>(".lights");
    if (!box) return;
    const leds = [...box.children] as HTMLElement[];
    leds.forEach((led, i) => led.classList.toggle("on", !!this.lit[i]));
    const on = leds.filter((_, i) => this.lit[i]).length;
    box.setAttribute("aria-label", `${leds.length} indicator lights, ${on} on`);
    box.hidden = leds.length === 0;
  }
}

export interface DeviceOptions {
  /** content for the screen: a node (moved onto the screen) or an HTML string; default an empty div */
  screen?: Node | string;
  label?: string;
  keyboard?: boolean;
  lights?: number;
  glass?: "crt" | "clear";
  /** fixed screen height in px; otherwise the screen is as tall as its content */
  screenHeight?: number;
}

export interface DeviceHandle {
  device: LineageDevice;
  /** a light-DOM div on the device's screen: mount anything into it (it keeps the page's styles) */
  screen: HTMLElement;
  setLights(on: boolean[]): void;
  destroy(): void;
}

/** Draws a device inside `el` and puts `opts.screen` on its screen. */
export function mountDevice(el: HTMLElement, opts: DeviceOptions = {}): DeviceHandle {
  if (!customElements.get("lineage-device")) customElements.define("lineage-device", LineageDevice);
  const device = document.createElement("lineage-device") as LineageDevice;
  if (opts.label !== undefined) device.setAttribute("label", opts.label);
  if (opts.keyboard) device.setAttribute("keyboard", "");
  if (opts.lights !== undefined) device.setAttribute("lights", String(opts.lights));
  if (opts.glass) device.setAttribute("glass", opts.glass);
  if (opts.screenHeight) device.setAttribute("screen-height", String(opts.screenHeight));
  const screen = document.createElement("div");
  screen.className = "lineage-device-screen";
  if (typeof opts.screen === "string") screen.innerHTML = opts.screen;
  else if (opts.screen) screen.appendChild(opts.screen);
  device.appendChild(screen);
  el.appendChild(device);
  return { device, screen, setLights: (on) => device.setLights(on), destroy: () => device.remove() };
}

export const DEVICE_ELEMENTS: [string, CustomElementConstructor][] = [["lineage-device", LineageDevice]];
