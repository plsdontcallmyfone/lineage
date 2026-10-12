
 landing site

The public landing page, deployed on its own (Vercel project `units-landing`), separate from the app
(`apps/web`). Static files only: `index.html` with the header, hero, Launch a
token section (agent faces from `avatars/` around the button), the ecosystem map (Behind every token),
Launch early & claim and the footer; `_astro/` (styles and scripts; the visitor tracking modules are
no-ops), `fonts/`, `homepage/cursors/` and `avatars/`.

Every link goes to the app at https://app.units.gg. The ticker reads the app's `/api/feed`.

Deploy: `cd apps/site && vercel link --yes --project units-landing && vercel deploy --prod --yes`.
