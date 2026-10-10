import { addressBytes, pda, REGISTRY_PROGRAM_ID } from "@lineage/chain";
import { loadNetworkProfile } from "../../chain/src/profile-node.ts";
import type { Core } from "./core.ts";
import { linksOf } from "./links.ts";
import { soulsOf } from "./souls.ts";

// ERC-8004 export (identity plan I6, 2.8) and the A2A agent card (plan 2.3). Lineage takes ERC-8004's
// registration file format and nothing else: no external registry is written (fees and approval),
// its transferable-NFT identity and open-feedback reputation are not imported. The file is generated
// from the agent's public profile (its soul, SPEC 14.8, whose digest the registry holds as
// `Agent.profile_digest`) and its verified links, and served by Core at
// `GET /v1/agents/:id/registration.json`.
//
// Field list, from the EIP text (ethereum/ERCs ERCS/erc-8004.md, status Draft, read 2026-10-08,
// last changed 2026-01-25): type, name, description, image, services[] { name, endpoint, version
// (SHOULD), skills and domains (OPTIONAL, OASF only) }, x402Support, active, registrations[]
// { agentId, agentRegistry } ("all fields in the registration are mandatory"), supportedTrust
// (OPTIONAL). Every one is present below.
//
// `registrations`: agentRegistry is `{namespace}:{chainId}:{identityRegistry}`; for Lineage that is
// the CAIP-2 Solana chain id and the `units_registry` program, and agentId is the agent's id (the
// base58 key that seeds its `Agent` PDA; ERC-8004 uses an ERC-721 tokenId there, Solana has none).
// `agentAccount` (an addition, ignored by ERC-8004 readers) is the PDA itself, so anyone can resolve
// the entry with one `getAccountInfo`: PDA("agent", agentId) under the registry program.

export const ERC8004_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
/** CAIP-2 chain ids: `solana:` + the first 32 characters of the genesis hash. */
export const SOLANA_CAIP2 = {
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  testnet: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
} as const;
export const A2A_PROTOCOL_VERSION = "0.3.0";
/** A neutral mark for agents with no account image and no public site (the field is not optional). */
export const PLACEHOLDER_IMAGE = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#8a8f98"/></svg>').toString("base64");

export interface Erc8004Options {
  /** `units_registry` program id (chain mode: the configured one). */
  registryProgram: string;
  /** CAIP-2 chain id of the cluster the registry lives on. */
  chain: string;
  /** Public site (https://...), whose /api/* proxies Core's /v1/*; null: Core's own origin. */
  siteUrl: string | null;
}

const instances = new WeakMap<Core, Erc8004>();
export function erc8004Of(core: Core): Erc8004 {
  let s = instances.get(core);
  if (!s) instances.set(core, (s = new Erc8004(core)));
  return s;
}

/** The registry PDA of an agent. */
export const agentPda = (registryProgram: string, agent: string): string => pda(registryProgram, "agent", addressBytes(agent));

export class Erc8004 {
  opts: Erc8004Options;
  constructor(private readonly core: Core) {
    // LINEAGE_CLUSTER when set, else the network profile (config/profile.json, LINEAGE_NETWORK; SPEC 14.10)
    const cluster = (process.env.LINEAGE_CLUSTER ?? loadNetworkProfile().network) as keyof typeof SOLANA_CAIP2;
    this.opts = {
      registryProgram: process.env.LINEAGE_REGISTRY_PROGRAM || REGISTRY_PROGRAM_ID,
      chain: SOLANA_CAIP2[cluster] ?? SOLANA_CAIP2.devnet,
      siteUrl: (process.env.LINEAGE_SITE_URL || "").replace(/\/+$/, "") || null,
    };
  }

  configure(o: Partial<Erc8004Options>) {
    this.opts = { ...this.opts, ...o };
    return this;
  }

  /** Base URLs: the API (Core /v1 or site /api) and the site's pages (null without a site). */
  private bases(origin: string) {
    const site = this.opts.siteUrl;
    return { api: site ? `${site}/api` : `${origin.replace(/\/+$/, "")}/v1`, web: site };
  }

  private profile(id: string) {
    const a = this.core.agentView(id) as ReturnType<Core["agentView"]>;
    let soul: { doc: any; digest: string; seq: number } | null = null;
    try {
      if (a.kind === "launched") soul = soulsOf(this.core).view(id) as any;
    } catch {
      soul = null;
    }
    const short = id.slice(0, 8);
    const persona = soul?.doc?.persona;
    const name: string = persona?.name ?? (a.kind === "launched" ? `Lineage agent ${short}` : `Lineage verifier ${short}`);
    const role =
      a.kind === "launched"
        ? `An authoring agent on Lineage${a.target_repo ? ` working on ${a.target_repo}` : ""}: it proposes changes that count only after independent bonded replays reproduce them.`
        : "A verifier on Lineage: it replays other agents' candidates under bond and commit-reveal.";
    const description = persona ? `${persona.tagline} ${persona.backstory} ${role}` : role;
    const login: string | null = soul?.doc?.identity?.github_login ?? null;
    return { a, soul, name, description, login };
  }

  /** GET /v1/agents/:id/registration.json: the ERC-8004 agent registration file. */
  registration(id: string, origin: string) {
    const { a, soul, name, description, login } = this.profile(id);
    const { api, web } = this.bases(origin);
    const links = linksOf(this.core).verified(id);
    const did = `did:pkh:${this.opts.chain}:${id}`;
    const services: { name: string; endpoint: string; version?: string }[] = [];
    if (web) services.push({ name: "web", endpoint: `${web}/agents/${id}` });
    services.push({ name: "A2A", endpoint: `${api}/agents/${id}/card`, version: A2A_PROTOCOL_VERSION });
    services.push({ name: "DID", endpoint: did, version: "v1" });
    services.push({ name: "lineage", endpoint: `${api}/agents/${id}`, version: "v1" });
    for (const l of links) if (l.service !== "github-genesis") services.push({ name: l.service === "github" ? "GitHub" : "domain", endpoint: l.url, version: "lineage-link-v1" });
    const revoked = a.identity?.revoked === true;
    return {
      type: ERC8004_TYPE,
      name,
      description,
      // GitHub's avatar for the agent's verified (or soul-named) account; otherwise the site's mark
      image: login ? `https://github.com/${login}.png` : web ? `${web}/favicon.svg` : PLACEHOLDER_IMAGE,
      services,
      x402Support: false,
      active: !revoked, // false only while the owner has revoked its signing key (Core then refuses it)
      registrations: [
        {
          agentId: id,
          agentRegistry: `${this.opts.chain}:${this.opts.registryProgram}`,
          agentAccount: agentPda(this.opts.registryProgram, id),
        },
      ],
      supportedTrust: ["crypto-economic", "lineage-replay"],
      lineage: {
        profile_digest: soul?.digest ?? null,
        profile_seq: soul?.seq ?? null,
        links: links.map((l) => ({ service: l.service, handle: l.handle, proof_url: l.proof_url, verified_at: l.verified_at })),
        records: `${api}/agents/${id}/records`,
        credential: `${api}/agents/${id}/credential`,
      },
    };
  }

  /** GET /v1/agents/:id/card: an A2A AgentCard (protocol 0.3.0) describing the agent's public surface. */
  card(id: string, origin: string) {
    const { a, soul, name, description, login } = this.profile(id);
    const { api, web } = this.bases(origin);
    const links = linksOf(this.core).verified(id);
    const launched = a.kind === "launched";
    return {
      protocolVersion: A2A_PROTOCOL_VERSION,
      name,
      description,
      // Lineage agents take no A2A tasks; the URL is the agent's read-only record in Core
      url: `${api}/agents/${id}`,
      preferredTransport: "HTTP+JSON",
      version: String(soul?.seq ?? 0),
      provider: { organization: "Lineage (placeholder name)", url: web ?? api },
      ...(login ? { iconUrl: `https://github.com/${login}.png` } : {}),
      ...(web ? { documentationUrl: `${web}/manual` } : {}),
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [
        launched
          ? { id: "lineage-author", name: "Author", description: "Proposes changes to its target repository; a change counts only after independent replays reproduce its measured effect.", tags: ["code", "performance", "verification"] }
          : { id: "lineage-verify", name: "Verify", description: "Replays candidates under bond with commit-reveal.", tags: ["verification", "replay"] },
      ],
      supportsAuthenticatedExtendedCard: false,
      lineage: {
        agent: id,
        kind: a.kind,
        registry: { chain: this.opts.chain, program: this.opts.registryProgram, account: agentPda(this.opts.registryProgram, id) },
        signing_key: a.identity?.signing_key ?? id,
        profile_digest: soul?.digest ?? null,
        registration: `${api}/agents/${id}/registration.json`,
        links: links.map((l) => ({ service: l.service, handle: l.handle, url: l.url, proof_url: l.proof_url, verified_at: l.verified_at })),
      },
    };
  }
}
