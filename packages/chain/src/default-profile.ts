// The repository's default network profile as a page may see it (browser-safe: the two config files
// are bundled, nothing is read at run time). It is what a page shows and builds against before
// /chain/config answers: config/profile.json `network` (mainnet) with the deployed mainnet
// deployment's overlay (`mainnet_deployment`), the same selection profile-node.ts makes on a service
// with no environment variable set. No RPC URL is in either file.
import raw from "../../../config/profile.json" with { type: "json" };
import mainnetTest from "../../../config/mainnet-test/profile.json" with { type: "json" };
import { publicProfile, resolveProfileConfig, selectProfile, type NetworkProfile, type PublicProfile } from "./profile.ts";

/** The overlay files a bundle carries, by the path config/profile.json `mainnet_deployments` names. */
const OVERLAYS: Record<string, unknown> = { "config/mainnet-test/profile.json": mainnetTest };

/** The default profile for `network` (the config's own `network` when absent), with no environment read. */
export function defaultProfile(network?: "devnet" | "mainnet"): NetworkProfile {
  const cfg = resolveProfileConfig(raw, {
    network: network ?? null,
    readOverlay: (f) => {
      if (!(f in OVERLAYS)) throw new Error(`mainnet_deployments names ${f}, which packages/chain/src/default-profile.ts does not bundle: import it there`);
      return OVERLAYS[f];
    },
  });
  return selectProfile(cfg, network ?? null);
}

/** What a page starts on, before /chain/config answers: the repository's default profile (mainnet). */
export const DEFAULT_PUBLIC_PROFILE: PublicProfile = publicProfile(defaultProfile());
