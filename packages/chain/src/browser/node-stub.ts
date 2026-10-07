// Browser stand-in for `node:fs`, `node:path` and `node:os`: the key-file helpers of tx.ts exist in
// the bundle but refuse to run. A page never reads or writes key files.
const unavailable = (name: string) => () => {
  throw new Error(`${name} is not available in the browser`);
};
export const chmodSync = unavailable("fs.chmodSync");
export const existsSync = unavailable("fs.existsSync");
export const mkdirSync = unavailable("fs.mkdirSync");
export const readFileSync = unavailable("fs.readFileSync");
export const writeFileSync = unavailable("fs.writeFileSync");
export const appendFileSync = unavailable("fs.appendFileSync");
export const dirname = (p: string) => p.replace(/\/[^/]*$/, "") || "/";
export const join = (...p: string[]) => p.join("/").replace(/\/+/g, "/");
export const homedir = unavailable("os.homedir");
export const tmpdir = unavailable("os.tmpdir");
export default { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, dirname, join, homedir, tmpdir };
