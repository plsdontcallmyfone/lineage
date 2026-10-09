import { mountExplorer } from "../../../apps/web/src/pages/explorer.ts";

// lineage-explorer.js: the explorer+docs lane's mountExplorer, loaded on demand by <lineage-explorer>.
(window as any).__lineageMountExplorer = mountExplorer;
