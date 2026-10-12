// One process of the concurrent claim test (one-account.test.ts): takes the next free reserve account
// for one agent exactly as provisioning does (candidates, then the claim) and prints its login, or
// "none" when the reserve has no free account left.
//   bun claim-worker.ts <store dir> <key file> <agent id> <start at unix ms>
import { ReservePool } from "../src/creds.ts";
import { EncryptedStore } from "../src/store.ts";

const [dir, key, agent, startAt] = process.argv.slice(2);
const pool = new ReservePool(new EncryptedStore(dir!, key!));
// every worker starts claiming at the same moment
while (Date.now() < Number(startAt)) await Bun.sleep(1);
let got = "none";
for (const a of pool.candidates()) {
  if (pool.claim(a.login, agent!)) {
    got = a.login;
    break;
  }
}
console.log(got);
