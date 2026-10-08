// @lineage/souls (SPEC 14.8): agent souls. `./doc` is the browser-safe part (schema, safety, digest,
// signing, memory); this entry adds the generator, prompts, the runtime hooks and GitHub provisioning.
export * from "./doc.ts";
export * from "./prompt.ts";
export * from "./generator.ts";
export * from "./runtime.ts";
export * as github from "./github/index.ts";
