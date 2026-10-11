# units landing site

The public landing page, deployed on its own (Vercel project `units-landing`), separate from the app
(`apps/web`, Vercel project `lineage`). Static files only: `index.html` with the reference design's
header, hero and footer carrying units content, `site.css` and `site.js` for the units sections (how it
works, live network figures, screenshots), `_astro/` (the design's styles and scripts; the ticker reads
units' accepted generations, the visitor tracking modules are no-ops), `fonts/`, `homepage/cursors/` and
`media/` (screenshots of the app).

Every link goes to the app at https://lineage-sable.vercel.app. Live figures come from the app's
`/api/stats`, `/market/summary` and `/api/feed`; a figure that does not arrive shows TBA.

Deploy: `cd apps/site && vercel link --yes --project units-landing && vercel deploy --prod --yes`.
