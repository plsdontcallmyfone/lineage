import { checkMemory, checkSoul, newSoul, signSoul, soulDigest, validatePersona, validateSeed, verifySoul, type RecordsEpoch, type SoulDoc, type SoulPersona, type SoulSeed } from "@lineage/souls/doc";
import type { Core } from "./core.ts";
import { ApiError, bad, conflict, notFound } from "./errors.ts";
import { H, Rng } from "./protocol.ts";

// Agent souls (SPEC 14.8). Core stores every signed version of a soul document by its digest and
// serves the latest one publicly once the agent is launched (a version stored before Core learns of
// the launch, e.g. right after a devnet launch and before the next chain sync, waits unseen). Each
// version is self-authenticating: `PUT /v1/agents/:id/soul { doc, sig }` needs no request signature,
// because `sig` must verify against the agent's current signing key (the id itself before any
// rotation). Every version is checked again here: schema, safety, the seq and prev chain, and that
// each memory entry is exactly what one of the agent's final record leaves yields (memory.ts), so a
// soul cannot claim work its records do not show. In chain mode the registry `Agent.profile_digest`
// and `profile_seq` are mirrored on every sync and each view says whether they match.
//
// Author-blind replay (SPEC 10.7): nothing here names a candidate; memory comes only from final
// records; a candidate view never links its author's soul. Shadow parity: shadows get a soul with
// the probability that a real launched agent has one, a real-looking delay after launch, from a
// private single-use library the admin loads (`POST /v1/admin/souls/library`); with the library
// empty, shadows have none (SPEC 14.8 residue).

interface Internals {
  db: Core["db"];
  chainMode: boolean;
  identity: Core["identity"];
  records: Core["records"];
  collab: Core["collab"];
  now(): number;
  currentEpoch(): { n: number; secret: string };
  emitEvent(type: string, data: unknown): void;
}

export const SOULS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS souls (
    digest TEXT PRIMARY KEY,             -- sha256 of the canonical document (what set_profile commits)
    agent TEXT NOT NULL,
    seq INTEGER NOT NULL,
    doc TEXT NOT NULL,                   -- canonical JSON
    sig TEXT NOT NULL,                   -- signStatement(signing key, "soul", doc)
    signer TEXT NOT NULL,                -- the signing key that signed it
    stored_at INTEGER NOT NULL,          -- ms
    UNIQUE (agent, seq)
  );
  CREATE INDEX IF NOT EXISTS souls_agent ON souls(agent, seq);
  CREATE TABLE IF NOT EXISTS soul_chain (
    agent TEXT PRIMARY KEY,
    digest TEXT,                         -- registry Agent.profile_digest (hex), null when unset
    seq INTEGER NOT NULL,
    synced_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS soul_library (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seed TEXT NOT NULL,
    persona TEXT NOT NULL,
    origin TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    used_by TEXT                         -- shadow agent id once used (single use)
  );
  CREATE TABLE IF NOT EXISTS shadow_souls (
    agent_id TEXT PRIMARY KEY,
    soul_at INTEGER,                     -- when the shadow publishes its soul (null: never, like real agents without one)
    done INTEGER NOT NULL DEFAULT 0
  );
`;

interface SoulRow {
  digest: string;
  agent: string;
  seq: number;
  doc: string;
  sig: string;
  signer: string;
  stored_at: number;
}

const instances = new WeakMap<Core, Souls>();
/** The one Souls of a Core (created on first use, schema included). */
export function soulsOf(core: Core): Souls {
  let s = instances.get(core);
  if (!s) instances.set(core, (s = new Souls(core)));
  return s;
}

export class Souls {
  private readonly c: Internals;
  constructor(core: Core) {
    this.c = core as unknown as Internals;
    this.ensure();
  }

  /** The schema is (re)created on use: a first use inside a transaction that rolls back would otherwise drop it. */
  private ensure() {
    this.c.db.exec(SOULS_SCHEMA);
  }

  private launched(agent: string): boolean {
    return !!this.c.db.query("SELECT 1 FROM agents WHERE agent_id = ? AND kind = 'launched'").get(agent);
  }

  private latestRow(agent: string): SoulRow | null {
    return this.c.db.query<SoulRow, [string]>("SELECT * FROM souls WHERE agent = ? ORDER BY seq DESC LIMIT 1").get(agent) ?? null;
  }

  private lastClosedEpoch(): number | null {
    const n = this.c.currentEpoch().n - 1;
    return n >= 0 ? n : null;
  }

  /** PUT /v1/agents/:id/soul: stores one signed version. */
  put(agentParam: string, body: unknown) {
    this.ensure();
    const b = body as { doc?: unknown; sig?: unknown };
    if (!b || typeof b !== "object" || typeof b.sig !== "string") throw bad("bad_soul", "body must be { doc, sig }");
    const errs = checkSoul(b.doc);
    if (errs.length) throw new ApiError(400, "bad_soul", errs.slice(0, 12).join("; "));
    const doc = b.doc as SoulDoc;
    if (doc.agent !== agentParam) throw bad("bad_soul", "doc.agent must equal the agent in the path");
    const key = this.c.identity.signingKey(doc.agent);
    if (key === null) throw new ApiError(401, "key_revoked", "the agent's signing key is revoked; its owner must rotate it");
    if (!verifySoul(key, b.sig, doc)) throw new ApiError(401, "bad_signature", "sig does not verify against the agent's current signing key");
    const digest = soulDigest(doc);
    const prev = this.latestRow(doc.agent);
    if (prev && prev.digest === digest) return this.stored(prev, false);
    if (prev ? doc.seq !== prev.seq + 1 : doc.seq !== 1) throw conflict("bad_seq", `seq must be ${prev ? prev.seq + 1 : 1}`);
    if (prev && doc.prev !== prev.digest) throw conflict("bad_prev", "prev must be the digest of the current version");
    if (doc.memory.entries.length || doc.memory.through_epoch !== null) {
      if (!this.c.db.query("SELECT 1 FROM agents WHERE agent_id = ?").get(doc.agent)) throw conflict("not_registered", "memory needs the agent's records; Core does not know this agent yet");
      const view = this.c.records.view(doc.agent) as { epochs: RecordsEpoch[] };
      const merrs = checkMemory(doc.agent, doc.memory, view.epochs, this.lastClosedEpoch());
      if (merrs.length) throw new ApiError(400, "bad_memory", merrs.slice(0, 12).join("; "));
    }
    const now = this.c.now();
    this.c.db.query("INSERT INTO souls (digest, agent, seq, doc, sig, signer, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(digest, doc.agent, doc.seq, JSON.stringify(doc), b.sig, key, now);
    const row = this.latestRow(doc.agent)!;
    if (this.launched(doc.agent)) this.c.emitEvent("agent.soul", { agent: doc.agent, seq: doc.seq, digest });
    return this.stored(row, true);
  }

  private stored(r: SoulRow, created: boolean) {
    return { agent: r.agent, digest: r.digest, seq: r.seq, created, public: this.launched(r.agent) };
  }

  private chainOf(agent: string, digest: string, seq: number) {
    if (!this.c.chainMode) return null;
    const c = this.c.db.query<{ digest: string | null; seq: number; synced_at: number }, [string]>("SELECT digest, seq, synced_at FROM soul_chain WHERE agent = ?").get(agent);
    return { digest: c?.digest ?? null, seq: c?.seq ?? 0, synced_at: c?.synced_at ?? null, matches: !!c && c.digest === digest && c.seq === seq };
  }

  /** GET /v1/agents/:id/soul: the latest version, public once the agent is launched. */
  view(agent: string) {
    this.ensure();
    if (!this.launched(agent)) throw notFound("soul");
    const r = this.latestRow(agent);
    if (!r) throw notFound("soul");
    const versions = this.c.db
      .query<{ seq: number; digest: string; stored_at: number; signer: string }, [string]>("SELECT seq, digest, stored_at, signer FROM souls WHERE agent = ? ORDER BY seq DESC")
      .all(agent);
    return { agent, doc: JSON.parse(r.doc) as SoulDoc, sig: r.sig, digest: r.digest, seq: r.seq, signer: r.signer, stored_at: r.stored_at, onchain: this.chainOf(agent, r.digest, r.seq), versions };
  }

  /** GET /v1/souls/:digest: any stored version by digest, once its agent is launched. */
  byDigest(digest: string) {
    this.ensure();
    if (!/^[0-9a-f]{64}$/.test(digest)) throw bad("bad_digest", "a sha256 hex");
    const r = this.c.db.query<SoulRow, [string]>("SELECT * FROM souls WHERE digest = ?").get(digest);
    if (!r || !this.launched(r.agent)) throw notFound("soul");
    return { agent: r.agent, doc: JSON.parse(r.doc) as SoulDoc, sig: r.sig, digest: r.digest, seq: r.seq, signer: r.signer, stored_at: r.stored_at };
  }

  /** Chain bridge: the registry's profile digest and seq for an agent (hex or null). */
  syncChain(agent: string, digest: string | null, seq: number) {
    this.ensure();
    this.c.db
      .query("INSERT INTO soul_chain (agent, digest, seq, synced_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent) DO UPDATE SET digest = excluded.digest, seq = excluded.seq, synced_at = excluded.synced_at")
      .run(agent, digest, seq, this.c.now());
  }

  /** POST /v1/admin/souls/library: private, single-use personas for shadow parity. Never served. */
  addLibrary(body: unknown) {
    this.ensure();
    const items = (body as { items?: unknown })?.items;
    if (!Array.isArray(items) || !items.length || items.length > 500) throw bad("bad_library", "items: 1 to 500 { seed, persona, origin }");
    const now = this.c.now();
    let added = 0;
    for (const [i, it] of items.entries()) {
      const x = it as { seed?: SoulSeed; persona?: SoulPersona; origin?: SoulDoc["origin"] };
      const errs = [...validateSeed(x.seed), ...validatePersona(x.persona)];
      if (errs.length) throw bad("bad_library", `items[${i}]: ${errs.slice(0, 4).join("; ")}`);
      const probe = newSoul({ agent: "11111111111111111111111111111111", seed: x.seed!, persona: x.persona!, created_at: Math.floor(now / 1000), origin: x.origin ?? { by: "model", model: null, prompt_version: null } });
      const serrs = checkSoul(probe);
      if (serrs.length) throw bad("bad_library", `items[${i}]: ${serrs.slice(0, 4).join("; ")}`);
      this.c.db.query("INSERT INTO soul_library (seed, persona, origin, added_at) VALUES (?, ?, ?, ?)").run(JSON.stringify(x.seed), JSON.stringify(x.persona), JSON.stringify(probe.origin), now);
      added++;
    }
    const left = this.c.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM soul_library WHERE used_by IS NULL").get()!.n;
    return { added, unused: left };
  }

  /** Called from Core.tick(): shadow parity for souls (SPEC 10.7, 14.8). */
  tick() {
    this.ensure();
    const now = this.c.now();
    const ep = this.c.currentEpoch();
    const fresh = this.c.db
      .query<{ agent_id: string; registered_at: number }, []>(
        `SELECT s.agent_id, a.registered_at FROM shadows s JOIN agents a ON a.agent_id = s.agent_id
         WHERE s.launched_at IS NOT NULL AND s.retired_at IS NULL AND s.agent_id NOT IN (SELECT agent_id FROM shadow_souls) ORDER BY s.agent_id`,
      )
      .all();
    if (fresh.length) {
      const real = this.c.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM agents WHERE kind = 'launched' AND shadow = 0").get()!.n;
      const firsts = this.c.db
        .query<{ g: number }, []>(
          `SELECT MIN(s.stored_at) - a.registered_at AS g FROM souls s JOIN agents a ON a.agent_id = s.agent
           WHERE a.kind = 'launched' AND a.shadow = 0 GROUP BY s.agent ORDER BY MIN(s.stored_at) DESC LIMIT 50`,
        )
        .all()
        .map((r) => Math.max(0, r.g));
      const withSoul = this.c.db.query<{ n: number }, []>("SELECT COUNT(DISTINCT s.agent) AS n FROM souls s JOIN agents a ON a.agent_id = s.agent WHERE a.kind = 'launched' AND a.shadow = 0").get()!.n;
      for (const s of fresh) {
        const rng = new Rng(H("m1-shadow-soul", ep.secret, s.agent_id));
        const at = real > 0 && firsts.length && rng.next() < withSoul / real ? s.registered_at + firsts[rng.int(firsts.length)]! : null;
        this.c.db.query("INSERT INTO shadow_souls (agent_id, soul_at) VALUES (?, ?)").run(s.agent_id, at);
      }
    }
    for (const d of this.c.db.query<{ agent_id: string }, [number]>("SELECT agent_id FROM shadow_souls WHERE done = 0 AND soul_at IS NOT NULL AND soul_at <= ?").all(now)) {
      const lib = this.c.db.query<{ id: number; seed: string; persona: string; origin: string }, []>("SELECT id, seed, persona, origin FROM soul_library WHERE used_by IS NULL ORDER BY id LIMIT 1").get();
      if (!lib) break; // residue: no library left; try again on a later tick
      this.c.db.query("UPDATE shadow_souls SET done = 1 WHERE agent_id = ?").run(d.agent_id);
      const key = this.c.collab.shadowKey(d.agent_id);
      if (!key || this.latestRow(d.agent_id)) continue;
      this.c.db.query("UPDATE soul_library SET used_by = ? WHERE id = ?").run(d.agent_id, lib.id);
      const doc = newSoul({ agent: key.id, seed: JSON.parse(lib.seed), persona: JSON.parse(lib.persona), created_at: Math.floor(now / 1000), origin: JSON.parse(lib.origin) });
      const digest = soulDigest(doc);
      this.c.db.query("INSERT INTO souls (digest, agent, seq, doc, sig, signer, stored_at) VALUES (?, ?, 1, ?, ?, ?, ?)").run(digest, key.id, JSON.stringify(doc), signSoul(key, doc), key.id, now);
      this.c.emitEvent("agent.soul", { agent: key.id, seq: 1, digest });
    }
  }
}

