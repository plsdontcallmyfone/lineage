// Side-effect import for a script that is devnet by construction (it drives the devnet deployment:
// scripts/devnet/**, the devnet proofs and end-to-end runs). The repository's default network is
// mainnet (config/profile.json), so such a script pins its own process, and every service it spawns,
// to devnet here instead of relying on the default. Import it first:
//
//   import "../../packages/chain/src/devnet-process.ts";
//
// It refuses to run when the environment already selects another network.
const set = process.env.UNITS_NETWORK ?? process.env.LINEAGE_NETWORK;
if (set && set.trim() && set.trim() !== "devnet") throw new Error(`this script is devnet only, and UNITS_NETWORK is ${set}`);
process.env.UNITS_NETWORK = "devnet";
export {};
