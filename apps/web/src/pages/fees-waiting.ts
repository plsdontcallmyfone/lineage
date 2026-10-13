import { injectWaitingStyle, loadWaiting, REPO_NAME, waitingRepoBody } from "../fees-waiting.ts";
import { html } from "../html.ts";
import type { Page } from "./types.ts";

// /claim/<owner>/<name>: the fees waiting for the owners of one repository, the address that is shared
// (apps/web/src/fees-waiting.ts; the server writes this page's title and description into the document
// it serves, apps/web/claim-preview.ts, so a posted link previews with them). No sign-in and no wallet:
// the Claim button opens /claim on this repository.
export async function feesWaitingPage(params: string[]): Promise<Page> {
  injectWaitingStyle();
  const name = `${decodeURIComponent(params[0] ?? "")}/${decodeURIComponent(params[1] ?? "")}`;
  if (!REPO_NAME.test(name)) return { title: "Claim", body: html`<div class="panel errorbox"><h1>Not a repository</h1><p>A repository is written owner/name.</p></div>` };
  const w = await loadWaiting(name);
  return { title: `Fees for the owners of ${name}`, body: waitingRepoBody(w, name), pollMs: 60_000 };
}
