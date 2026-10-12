// Where the docs live. They are a web site of their own (apps/docs; canonical origin
// https://docs.units.gg), so every link from the app to a docs page is built here. The value is
// config/sites.json docs_url (the temporary docs host until the DNS record of docs.units.gg exists),
// or UNITS_DOCS_URL in the environment of the server that builds the bundles (apps/web/server.ts,
// scripts/deploy/vercel/build.ts define __UNITS_DOCS_URL__).
import sites from "../../../config/sites.json" with { type: "json" };

declare const __UNITS_DOCS_URL__: string | undefined;

export const DOCS_URL: string = ((typeof __UNITS_DOCS_URL__ === "string" && __UNITS_DOCS_URL__) || sites.docs_url).replace(/\/+$/, "");

/** A docs page: docsUrl("/verification"), docsUrl("/launch-an-agent#5-funding"); docsUrl() is the start page. */
export const docsUrl = (path = "/"): string => `${DOCS_URL}${path.startsWith("/") ? path : `/${path}`}`;
