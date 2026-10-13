// Preload for a service of this tree that runs against the local fork of mainnet (bun --preload):
// Date.now() follows the FORK's chain time. A warped test validator's clock is hours away from the
// wall clock and runs at its own pace, and the market indexer prices a trade with the dollar reading
// taken at the trade's block time, so on a fork its own clock has to be the chain's. Never loaded on
// a server: only scripts/mainnet/graduation-fork.ts passes it, with FORK_CLOCK_RPC (a 127.0.0.1 URL)
// and FORK_CLOCK_START_MS (the chain time when the service was started).
const url = process.env.FORK_CLOCK_RPC ?? "", start = Number(process.env.FORK_CLOCK_START_MS ?? "");
if (!url.startsWith("http://127.0.0.1:") || !Number.isFinite(start) || start <= 0) throw new Error("fork-clock.ts is for a local fork only: set FORK_CLOCK_RPC and FORK_CLOCK_START_MS");
const real = Date.now.bind(Date);
let base = start, at = real(), last = start;
const call = async (method: string, params: unknown[]) => ((await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result?: number }).result;
const timer = setInterval(async () => {
  try {
    const slot = await call("getSlot", [{ commitment: "confirmed" }]);
    const t = typeof slot === "number" ? await call("getBlockTime", [slot]) : undefined;
    if (typeof t === "number") { base = t * 1000; at = real(); }
  } catch { /* keep the last reading */ }
}, 1000);
(timer as { unref?: () => void }).unref?.();
// between two readings the clock moves on by at most a second, and it never goes back
Date.now = () => (last = Math.max(last, base + Math.min(real() - at, 999)));
