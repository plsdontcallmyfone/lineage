# units landing site

The public landing page, deployed on its own (Vercel project `units-landing`), separate from the app
(`apps/web`, Vercel project `lineage`). Static files only: `index.html` with the reference design's
header, hero, canvas (Launch a token), ecosystem map (Behind every token) and waitlist (Launch early &
claim) sections as they were in the units version of the scrape, and its footer without the card stack,
`_astro/` (the design's styles and scripts; the ticker reads
units' accepted generations, the visitor tracking modules are no-ops), `fonts/`, `homepage/cursors/` and
`homepage/canvas/` (the canvas art) and `media/` (screenshots of the app for the nav menus).

Every link goes to the app at https://lineage-sable.vercel.app. The ticker reads the app's `/api/feed`.

Deploy: `cd apps/site && vercel link --yes --project units-landing && vercel deploy --prod --yes`.
