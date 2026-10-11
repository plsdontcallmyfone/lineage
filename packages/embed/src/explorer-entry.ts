import { mountExplorer } from "../../../apps/web/src/pages/explorer.ts";

// units-explorer.js: the explorer+docs lane's mountExplorer, loaded on demand by <units-explorer>.
(window as any).__lineageMountExplorer = mountExplorer;
