// Local signer for GitHub genesis proofs (docs/plans/GITHUB-GENESIS.md 2.1). The identity service
// publishes each agent's profile repository with lineage-proof.json, which must be signed by the
// agent's registry signing key; for hosted agents only this runtime holds that key. On the bind port
// (127.0.0.1; the site gate forwards only /runtime/bind/*, so this is never public):
//
//   POST /runtime/genesis/<agent> { statement }   statement = every genesis field except signer
//        -> { ...statement, signer, sig }           sig = signStatement(key, "github-genesis", statement)
//
// The statement's shape is checked exactly and its agent must be the path agent; the purpose
// github-genesis signs nothing that counts anywhere else, so a local caller can at most make a proof
// that Core still checks against the identity service's login for the agent.
import type { AgentKey } from "@lineage/protocol";
import { genesisShapeError, signGenesis, type UnsignedGenesis } from "../../identity/src/genesis-proof.ts";
import { isAgentId } from "./state.ts";

export const GENESIS_MAX_BODY = 4 * 1024;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Answers /runtime/genesis/<agent>, or null for any other path. */
export async function genesisRoute(req: Request, host: { keyOf(agent: string): AgentKey | null }, log: (m: string) => void = () => {}): Promise<Response | null> {
  const url = new URL(req.url);
  const m = /^\/runtime\/genesis\/([^/]+)$/.exec(url.pathname);
  if (!m) return null;
  const agent = m[1]!;
  if (!isAgentId(agent)) return json(400, { error: "bad_agent" });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const raw = await req.arrayBuffer();
  if (raw.byteLength > GENESIS_MAX_BODY) return json(413, { error: "too_large" });
  let st: UnsignedGenesis;
  try {
    st = (JSON.parse(new TextDecoder().decode(raw)) as { statement: UnsignedGenesis }).statement;
  } catch {
    return json(400, { error: "bad_body", message: "{ statement } expected" });
  }
  const why = genesisShapeError(st, { withSigner: false });
  if (why) return json(400, { error: "bad_statement", message: why });
  if (st.agent !== agent) return json(400, { error: "bad_statement", message: "statement agent is not the path agent" });
  const key = host.keyOf(agent);
  if (!key) return json(404, { error: "no_key", message: "this runtime holds no key for the agent" });
  log(`genesis proof signed for ${agent} (login ${st.github_login})`);
  return json(200, signGenesis(key, st));
}

/** Wraps another handler: genesis requests here, everything else to `inner`. */
export function withGenesis(host: { keyOf(agent: string): AgentKey | null }, inner: (req: Request) => Promise<Response>, log?: (m: string) => void) {
  return async (req: Request) => (await genesisRoute(req, host, log)) ?? inner(req);
}
