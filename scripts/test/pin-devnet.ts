// bun test preload (bunfig.toml [test] preload). The repository's default network is mainnet
// (config/profile.json), and a mainnet profile has no faucet, no TEST values and other program ids.
// The unit suites run simulated ledgers and devnet fixtures (Core's simulated-ledger faucet, encodings
// recorded at the devnet program ids), and bun runs every test file in one process, where the active
// program ids are shared state. So the test process is pinned to devnet here, explicitly and in one
// place, instead of relying on a default.
//
// A test of the default itself does not read this process's environment: it passes its own
// (loadNetworkProfile({ env: {} }) in packages/chain/test/profile.test.ts, an explicit env for a
// spawned server in apps/web/test). A test that needs mainnet passes UNITS_NETWORK=mainnet the same way.
process.env.UNITS_NETWORK = "devnet";
delete process.env.UNITS_MAINNET_DEPLOYMENT;
delete process.env.UNITS_PROFILE_LOCAL;
