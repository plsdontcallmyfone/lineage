// Provider marks for the model picker and wherever a model's provider is named. The SVG files are
// imported unchanged from @lobehub/icons-static-svg 1.95.1 (MIT) and self-hosted under /providers
// (apps/web/public/providers, attribution in NOTICE.md there). The marks are trademarks of their
// owners, shown only to identify each provider. A provider without a file keeps its monogram, and a
// file that fails to load is swapped back to the monogram (data-fallback) by the listener below.
import { html, type Raw } from "./html.ts";

const LOGOS = new Set(["anthropic", "openai", "google", "deepseek", "alibaba", "moonshot", "zhipu", "minimax", "meta"]);

export const providerLogoSrc = (id: string | null | undefined): string | null => (id && LOGOS.has(id) ? `/providers/${id}.svg` : null);

/** The provider's mark as an inline image sized to `px`, or "" when there is no file for it. */
export function providerLogo(id: string | null | undefined, name: string, px = 14, fallback = ""): Raw | "" {
  const src = providerLogoSrc(id);
  return src ? html`<img class="prov-logo" src="${src}" alt="${name}" width="${px}" height="${px}" data-fallback="${fallback}">` : "";
}

if (typeof document !== "undefined" && !(globalThis as { __provLogoFallback?: boolean }).__provLogoFallback) {
  (globalThis as { __provLogoFallback?: boolean }).__provLogoFallback = true;
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.classList.contains("prov-logo")) return;
      const parent = img.parentElement;
      parent?.classList.remove("is-logo");
      img.replaceWith(document.createTextNode(img.dataset.fallback ?? ""));
    },
    true,
  );
}
