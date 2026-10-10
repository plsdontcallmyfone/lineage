// config/swap.json is bundled into the wallet (Bun JSON import), see swap.ts.
declare module "*/config/swap.json" {
  const value: unknown;
  export default value;
}
