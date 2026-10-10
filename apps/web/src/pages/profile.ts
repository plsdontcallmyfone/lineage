import { walletModulePage } from "./launch.ts";
import type { Page } from "./types.ts";

// Profile (/profile): the connected wallet's own page (docs/plans/APP-CONSOLIDATION.md). Rendered by
// the wallet bundle; see pages/launch.ts.
export async function profilePage(): Promise<Page> {
  return walletModulePage("Profile", "mountProfile");
}
