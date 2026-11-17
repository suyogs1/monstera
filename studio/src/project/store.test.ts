import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IdbError, openDb, STORE_BLOBS, STORE_META, STORE_PROJECTS, type IdbConnection } from "./idb";
import { MANIFEST_NAMES, serializeManifest } from "./manifests";
import { buildRecord, sha256Hex, type ProjectRecord } from "./record";
import { EVICTION_HINT, MARKER_KEY, ProjectStore, type ProjectStoreDeps, type ProjectStoreStatus } from "./store";
import {
  baseline, edited, instrumentedOpen, manifestsFor, memoryMarker, newFactory, pumpkinText, rawAll, rawGet, rawOpen, rawPut, readOnlyStorage,
  snapshot, type Hooks,
} from "./testkit";
import { LEGACY_KEY } from "./migrate";

const nodeSha = (t: string): string => createHash("sha256").update(t).digest("hex");
const mk = (factory: IDBFactory | null, extra: Partial<ProjectStoreDeps> = {}): ProjectStore => new ProjectStore({ factory, now: () => 1000, ...extra });
const rwCounter = (): { hooks: Hooks; count: () => number } => {
  let n = 0;
  return { hooks: { onTransaction: (_names, mode) => { if (mode === "readwrite") n++; } }, count: () => n };
};
const record = async (key = "p1"): Promise<ProjectRecord> => buildRecord(snapshot(key), 1, sha256Hex);
const statuses = (s: ProjectStore): ProjectStoreStatus[] => { const out: ProjectStoreStatus[] = []; s.subscribe(() => out.push(s.getState().status)); return out; };

describe("round trip, hash and canonical bytes", () => {
  it("saves spec text, baseline and manifests as one record and reads them back exactly", async () => {
    const factory = newFactory();
    const a = mk(factory);
    await a.open();
    expect(a.getState().status).toBe("unsaved");
    expect(await a.save(snapshot())).toBe("saved");
    const raw = (await rawGet(factory, STORE_PROJECTS, "p1")) as ProjectRecord;
    expect(Object.keys(raw).sort()).toEqual(["baseline", "format", "manifests", "name", "projectId", "projectKey", "specSha256", "specText", "writeSeq"]);
    expect(raw.format).toBe(1);
    expect(raw.writeSeq).toBe(1);
    expect(raw.specText).toBe(pumpkinText);
    expect(raw.specSha256).toBe(nodeSha(pumpkinText));
    expect(raw.baseline).toEqual(baseline);
    for (const n of MANIFEST_NAMES) expect(raw.manifests[n]).toBe(serializeManifest(n, manifestsFor("pumpkin-blaster")[n] as never));
    expect(await rawGet(factory, STORE_META, "activeProjectKey")).toEqual({ key: "activeProjectKey", value: "p1" });

    const b = mk(factory);
    await b.open();
    expect(b.getState().status).toBe("saved");
    const p = b.getState().project;
    expect(p?.specText).toBe(pumpkinText);
    expect(p?.baseline).toEqual(baseline);
    expect(p?.manifests).toEqual(manifestsFor("pumpkin-blaster"));
    expect(p?.projectId).toBe("pumpkin-blaster");
  });

  it("stores the same bytes for the same snapshot, and increments writeSeq", async () => {
    const factory = newFactory();
    const s = mk(factory);
    await s.open();
    await s.save(snapshot());
    const first = (await rawGet(factory, STORE_PROJECTS, "p1")) as ProjectRecord;
    await s.save(snapshot());
    const second = (await rawGet(factory, STORE_PROJECTS, "p1")) as ProjectRecord;
    expect(second.writeSeq).toBe(2);
    expect({ ...second, writeSeq: 1 }).toEqual(first);
  });

  it("computes the hash before the transaction opens and reports saved only after the commit", async () => {
    const factory = newFactory();
    const log: string[] = [];
    const s = mk(factory, {
      sha256: async (t) => { log.push("sha"); return sha256Hex(t); },
      openConnection: instrumentedOpen({ onTransaction: (_n, m) => log.push(`tx:${m}`), onEnd: (e, m) => log.push(`end:${e}:${m}`) }),
    });
    await s.open();
    log.length = 0;
    const seen: string[] = [];
    s.subscribe(() => seen.push(`${s.getState().status}@${log.join("|")}`));
    await s.save(snapshot());
    expect(log).toEqual(["sha", "tx:readwrite", "end:complete:readwrite"]);
    expect(seen).toEqual(["unsaved@", "saving@", "saved@sha|tx:readwrite|end:complete:readwrite"]);
  });

  it("serializes writes: one in flight, later snapshots coalesce into the next write", async () => {
    const factory = newFactory();
    const c = rwCounter();
    const s = mk(factory, { openConnection: instrumentedOpen(c.hooks) });
    await s.open();
    const a = s.save(edited(1));
    const b = s.save(edited(2));
    const last = s.save(edited(3));
    expect(await a).toBe("saved");
    await Promise.all([b, last]);
    expect(c.count()).toBe(2);
    const raw = (await rawGet(factory, STORE_PROJECTS, "p1")) as ProjectRecord;
    expect(raw.writeSeq).toBe(2);
    expect(raw.specText).toBe(edited(3).specText);
    expect(s.getState().status).toBe("saved");
  });
});

describe("atomicity and consistency", () => {
  it("a failure injected mid-save leaves the previous record intact, keeps memory, and retry succeeds", async () => {
    const factory = newFactory();
    let fail = false;
    const s = mk(factory, { openConnection: instrumentedOpen({ onCall: (store, method, mode) => { if (fail && store === STORE_META && method === "put" && mode === "readwrite") throw new Error("boom"); } }) });
    await s.open();
    await s.save(snapshot());
    const before = await rawGet(factory, STORE_PROJECTS, "p1");
    fail = true;
    const seen = statuses(s);
    expect(await s.save(edited(4))).toBe("failed");
    expect(seen).not.toContain("saved");
    expect(await rawGet(factory, STORE_PROJECTS, "p1")).toEqual(before);
    expect(s.getState().project?.specText).toBe(edited(4).specText);
    expect(s.getState().detail.reason).toBe("error");
    expect(s.getState().detail.actions).toContain("retrySave");
    fail = false;
    expect(await s.retrySave()).toBe("saved");
    expect(((await rawGet(factory, STORE_PROJECTS, "p1")) as ProjectRecord).writeSeq).toBe(2);
    expect(s.getState().detail.lastSavedAt).toBe(1000);
  });

  it("refuses to save a snapshot whose spec project.id differs from the project id (nothing written)", async () => {
    const factory = newFactory();
    const s = mk(factory);
    await s.open();
    const bad = { ...snapshot(), projectId: "other", manifests: manifestsFor("other") };
    expect(await s.save(bad)).toBe("failed");
    expect(s.getState().detail.reason).toBe("invalid-snapshot");
    expect(s.getState().detail.issues.map((i) => i.code)).toEqual(["project-id-mismatch"]);
    expect(await rawAll(factory, STORE_PROJECTS)).toEqual([]);
    expect(s.getState().project).toEqual(bad);
  });

  it("a stored record whose projectId differs from spec project.id is quarantined, not rewritten", async () => {
    const factory = newFactory();
    const rec = { ...(await record()), projectId: "other" };
    await rawPut(factory, STORE_PROJECTS, rec);
    const s = mk(factory);
    await s.open();
    expect(s.getState().status).toBe("quarantined");
    expect(s.getState().detail.issues.map((i) => i.code)).toContain("project-id-mismatch");
    expect(await rawAll(factory, STORE_PROJECTS)).toEqual([rec]);
  });
});

describe("multi-tab conflict", () => {
  it("pauses on a stale writeSeq, writes nothing, and resumes only after an explicit reload", async () => {
    const factory = newFactory();
    const a = mk(factory);
    await a.open();
    await a.save(snapshot());
    const c = rwCounter();
    const b = mk(factory, { openConnection: instrumentedOpen(c.hooks) });
    await b.open();
    expect(b.getState().status).toBe("saved");
    await a.save(edited(1)); // tab A moves the record to writeSeq 2
    const stored = await rawGet(factory, STORE_PROJECTS, "p1");
    expect(await b.save(edited(5))).toBe("conflict");
    expect(await rawGet(factory, STORE_PROJECTS, "p1")).toEqual(stored);
    expect(b.getState().detail.reason).toBe("conflict");
    expect(b.getState().detail.actions).toEqual(["reloadFromStorage", "retryOpen", "exportRecovery"]);
    const attempts = c.count();
    expect(await b.save(edited(6))).toBe("conflict"); // still paused, no write attempt at all
    expect(c.count()).toBe(attempts);
    expect(await rawGet(factory, STORE_PROJECTS, "p1")).toEqual(stored);
    expect(b.exportRecovery()).toContain(JSON.stringify(edited(6).specText).slice(-40, -1)); // mine is exported first
    await b.reloadFromStorage();
    expect(b.getState().status).toBe("saved");
    expect(b.getState().project?.specText).toBe(edited(1).specText);
    expect(await b.save(edited(7))).toBe("saved");
    expect(((await rawGet(factory, STORE_PROJECTS, "p1")) as ProjectRecord).writeSeq).toBe(3);
  });

  it("a record created by another tab under the same key is a conflict, not an overwrite", async () => {
    const factory = newFactory();
    const b = mk(factory);
    await b.open();
    const theirs = await record();
    await rawPut(factory, STORE_PROJECTS, theirs);
    expect(await b.save(snapshot())).toBe("conflict");
    expect(await rawGet(factory, STORE_PROJECTS, "p1")).toEqual(theirs);
  });
});

describe("newer formats are read-only and unchanged", () => {
  it("a record with a newer format is preserved, refuses edits and exports its raw fields", async () => {
    const factory = newFactory();
    const future = { format: 2, projectKey: "p1", specText: "future spec", baseline: { x: 1 }, manifests: { project: "future manifest" }, extra: [1, 2] };
    await rawPut(factory, STORE_PROJECTS, future);
    const c = rwCounter();
    const s = mk(factory, { openConnection: instrumentedOpen(c.hooks) });
    await s.open();
    expect(s.getState().status).toBe("read-only");
    expect(s.getState().detail.reason).toBe("format-newer");
    expect(await s.save(snapshot())).toBe("read-only");
    expect(c.count()).toBe(0);
    expect(await rawAll(factory, STORE_PROJECTS)).toEqual([future]);
    expect(await rawAll(factory, STORE_META)).toEqual([]);
    expect(s.recoveryJson()).toEqual({ format: 1, kind: "monstera.studio.recovery", specText: "future spec", baseline: { x: 1 }, manifests: { project: "future manifest" } });
  });

  it("an existing database with a newer version is opened without an upgrade and nothing is written", async () => {
    const factory = newFactory();
    const db = await rawOpen(factory, 2, (d) => {
      d.createObjectStore(STORE_PROJECTS, { keyPath: "projectKey" });
      d.createObjectStore(STORE_BLOBS, { keyPath: ["projectKey", "assetId"] });
      d.createObjectStore(STORE_META, { keyPath: "key" });
      d.createObjectStore("extra", { keyPath: "id" });
    });
    db.close();
    await rawPut(factory, "extra", { id: 1, v: "x" });
    await rawPut(factory, STORE_PROJECTS, await record());
    const before = await rawAll(factory, STORE_PROJECTS);
    const legacy = readOnlyStorage({ [LEGACY_KEY]: "{}" });
    const c = rwCounter();
    const s = mk(factory, { openConnection: instrumentedOpen(c.hooks), migration: { legacy, defaultManifests: () => manifestsFor("x") } });
    await s.open();
    expect(s.getState().status).toBe("read-only");
    expect(s.getState().detail.reason).toBe("database-newer");
    expect(s.getState().project?.specText).toBe(pumpkinText); // readable
    expect(await s.save(edited(2))).toBe("read-only");
    expect(c.count()).toBe(0);
    expect(legacy.reads).toEqual([]);
    expect(s.getState().migration).toBeNull();
    const check = await rawOpen(factory);
    expect(check.version).toBe(2);
    expect([...check.objectStoreNames].sort()).toEqual(["blobs", "extra", "meta", "projects"]);
    check.close();
    expect(await rawAll(factory, STORE_PROJECTS)).toEqual(before);
    expect(await rawAll(factory, STORE_META)).toEqual([]);
    expect(await rawAll(factory, "extra")).toEqual([{ id: 1, v: "x" }]);
  });
});

describe("quarantine", () => {
  const base = async (): Promise<ProjectRecord> => record();
  const cases: [string, () => Promise<unknown>, string][] = [
    ["hash mismatch", async () => ({ ...(await base()), specText: pumpkinText + " " }), "hash-mismatch"],
    ["corrupt manifest", async () => { const r = await base(); return { ...r, manifests: { ...r.manifests, gameplay: "{bad" } }; }, "manifest-invalid"],
    ["unknown shape", async () => ({ projectKey: "p1", format: 1, name: 5 }), "bad-field"],
    ["no format", async () => ({ projectKey: "p1", foo: 1 }), "bad-format"],
    ["unparseable spec", async () => ({ ...(await base()), specText: "not json", specSha256: nodeSha("not json") }), "spec-unparseable"],
  ];
  it.each(cases)("%s: the raw record stays, writes are refused, recovery carries the stored fields", async (_n, make, code) => {
    const factory = newFactory();
    const bad = await make();
    await rawPut(factory, STORE_PROJECTS, bad);
    const c = rwCounter();
    const s = mk(factory, { openConnection: instrumentedOpen(c.hooks) });
    await s.open();
    expect(s.getState().status).toBe("quarantined");
    expect(s.getState().detail.issues.map((i) => i.code)).toContain(code);
    expect(await s.save(snapshot())).toBe("quarantined");
    expect(c.count()).toBe(0);
    expect(await rawAll(factory, STORE_PROJECTS)).toEqual([bad]);
    const r = s.recoveryJson();
    const o = bad as { specText?: unknown; manifests?: Record<string, unknown> };
    expect(r?.specText).toBe(typeof o.specText === "string" ? o.specText : null);
    expect(r?.manifests).toEqual(Object.fromEntries(Object.entries(o.manifests ?? {}).filter(([, v]) => typeof v === "string").sort()));
    expect(Object.keys(r ?? {}).sort()).toEqual(["baseline", "format", "kind", "manifests", "specText"]);
    const again = mk(factory);
    await again.open();
    expect(again.exportRecovery()).toBe(s.exportRecovery()); // stable bytes
  });
});

describe("storage failures", () => {
  it("quota: never reported saved, memory kept, the next success returns to saved", async () => {
    const factory = newFactory();
    let full = false;
    const s = mk(factory, { openConnection: instrumentedOpen({ onCall: (st, m, mode) => { if (full && st === STORE_PROJECTS && m === "put" && mode === "readwrite") throw new DOMException("full", "QuotaExceededError"); } }) });
    await s.open();
    await s.save(snapshot());
    full = true;
    const seen = statuses(s);
    expect(await s.save(edited(3))).toBe("failed");
    expect(seen).not.toContain("saved");
    expect(s.getState().detail.reason).toBe("quota");
    expect(s.getState().detail.error?.kind).toBe("quota");
    expect(s.getState().project?.specText).toBe(edited(3).specText);
    expect(((await rawGet(factory, STORE_PROJECTS, "p1")) as ProjectRecord).specText).toBe(pumpkinText);
    full = false;
    expect(await s.save(edited(3))).toBe("saved");
    expect(s.getState().detail.reason).toBeNull();
  });

  it("a transaction abort is a failed state with a retry action", async () => {
    const factory = newFactory();
    let abort = true;
    const s = mk(factory, { openConnection: instrumentedOpen({ onCall: (st, m, mode) => { if (abort && st === STORE_PROJECTS && m === "put" && mode === "readwrite") throw new DOMException("x", "AbortError"); } }) });
    await s.open();
    expect(await s.save(snapshot())).toBe("failed");
    expect(s.getState().detail.reason).toBe("abort");
    expect(await rawAll(factory, STORE_PROJECTS)).toEqual([]);
    abort = false;
    expect(await s.retrySave()).toBe("saved");
  });

  it("IndexedDB unavailable (null or missing factory): memory-only, permanent, no pretence of saving", async () => {
    for (const s of [mk(null), new ProjectStore({})]) {
      await s.open();
      expect(s.getState().status).toBe("memory-only");
      expect(await s.save(snapshot())).toBe("memory-only");
      expect(s.getState().project?.specText).toBe(pumpkinText);
      await s.retryOpen();
      expect(s.getState().status).toBe("memory-only");
      expect(s.exportRecovery()).not.toBeNull();
    }
  });

  it("blocked open is a visible state; retryOpen is the explicit action", async () => {
    const factory = newFactory();
    let calls = 0;
    const s = mk(factory, {
      openConnection: async (f, n, o) => {
        if (calls++ === 0) throw new IdbError({ kind: "blocked", name: "BlockedError", message: "blocked", cause: undefined });
        return openDb(f, n, o);
      },
    });
    await s.open();
    expect(s.getState().status).toBe("failed");
    expect(s.getState().detail.reason).toBe("blocked");
    expect(s.getState().detail.actions).toEqual(["retryOpen"]);
    expect(await s.save(snapshot())).toBe("failed"); // kept in memory, nothing to write to
    expect(s.getState().project?.specText).toBe(pumpkinText);
    await s.retryOpen();
    expect(s.getState().status).toBe("unsaved");
    expect(await s.save(snapshot())).toBe("saved");
  });

  it("versionchange from another tab closes the store, refuses writes, and reopening finds the newer database read-only", async () => {
    const factory = newFactory();
    const c = rwCounter();
    const s = mk(factory, { openConnection: instrumentedOpen(c.hooks) });
    await s.open();
    await s.save(snapshot());
    const other = await rawOpen(factory, 2);
    other.close();
    expect(s.getState().status).toBe("closed");
    expect(s.getState().detail.reason).toBe("versionchange");
    const before = c.count();
    expect(await s.save(edited(9))).toBe("closed");
    expect(c.count()).toBe(before);
    expect(s.getState().project?.specText).toBe(edited(9).specText);
    await s.retryOpen();
    expect(s.getState().status).toBe("read-only");
    expect(s.getState().detail.reason).toBe("database-newer");
  });

  it("an abnormal close moves the store to closed and refuses writes until retryOpen", async () => {
    const factory = newFactory();
    let conn: IdbConnection | undefined;
    const s = mk(factory, { openConnection: async (f, n, o) => (conn = await openDb(f, n, o)) });
    await s.open();
    await s.save(snapshot());
    (conn?.db.onclose as (e: Event) => void)(new Event("close"));
    expect(s.getState().status).toBe("closed");
    expect(s.getState().detail.reason).toBe("abnormal-close");
    expect(await s.save(edited(2))).toBe("closed");
    expect(((await rawGet(factory, STORE_PROJECTS, "p1")) as ProjectRecord).writeSeq).toBe(1);
    await s.retryOpen();
    expect(s.getState().status).toBe("saved");
    expect(await s.save(edited(2))).toBe("saved");
  });
});

describe("storage API and eviction hint", () => {
  it("persistence and estimate are reported honestly and never throw", async () => {
    expect(await mk(null).requestPersistence()).toBe("unavailable");
    expect(await mk(null).estimate()).toBe("unknown");
    expect(await mk(null, { storage: {} }).requestPersistence()).toBe("unavailable");
    expect(await mk(null, { storage: { persist: async () => true } }).requestPersistence()).toBe("granted");
    expect(await mk(null, { storage: { persist: async () => false } }).requestPersistence()).toBe("not-granted");
    expect(await mk(null, { storage: { persist: async () => { throw new Error("no"); } } }).requestPersistence()).toBe("rejected");
    expect(await mk(null, { storage: { estimate: async () => ({ usage: 5, quota: 100 }) } }).estimate()).toEqual({ usage: 5, quota: 100 });
    expect(await mk(null, { storage: { estimate: async () => ({}) } }).estimate()).toBe("unknown");
    expect(await mk(null, { storage: { estimate: async () => { throw new Error("no"); } } }).estimate()).toBe("unknown");
  });

  it("the marker is written after a commit; an empty database with a marker gives a hedged hint", async () => {
    const factory = newFactory();
    const marker = memoryMarker();
    const a = mk(factory, { marker });
    await a.open();
    expect(a.getState().hint).toBeNull();
    expect(marker.value).toBeNull(); // nothing committed yet
    await a.save(snapshot());
    expect(marker.value).toBe("1");
    const b = mk(factory, { marker });
    await b.open();
    expect(b.getState().hint).toBeNull(); // projects exist
    const c = mk(newFactory(), { marker }); // a database that lost its data
    await c.open();
    expect(c.getState().hint).toBe(EVICTION_HINT);
    expect(EVICTION_HINT).toMatch(/\bmay have cleared\b/);
    expect(EVICTION_HINT).toMatch(/best-effort/);
    expect(EVICTION_HINT).not.toMatch(/\b(was|were) (deleted|cleared)\b/);
    expect(c.getState().status).toBe("unsaved");
  });

  it("a throwing marker never breaks reading or saving", async () => {
    const marker = { getItem: (): string | null => { throw new Error("denied"); }, setItem: (): void => { throw new Error("denied"); } };
    const s = mk(newFactory(), { marker });
    await s.open();
    expect(s.getState().hint).toBeNull();
    expect(await s.save(snapshot())).toBe("saved");
    expect(MARKER_KEY).toBe("monstera.studio.projects-seen.v1");
  });
});

describe("migration inside the store", () => {
  const draft = JSON.stringify({ version: 1, docText: pumpkinText, baseline });
  it("migrates before loading; a failed migration keeps the legacy draft in memory and writes nothing until retry", async () => {
    const factory = newFactory();
    const legacy = readOnlyStorage({ [LEGACY_KEY]: draft });
    let tamper = true;
    const s = mk(factory, {
      migration: { legacy, defaultManifests: ({ projectId }) => manifestsFor(projectId) },
      openConnection: instrumentedOpen({ tamperGet: (st, r, mode) => (tamper && st === STORE_PROJECTS && mode === "readonly" ? { ...(r as object), name: "tampered" } : r) }),
    });
    await s.open();
    expect(s.getState().status).toBe("failed");
    expect(s.getState().detail.reason).toBe("migration");
    expect(s.getState().project?.specText).toBe(pumpkinText);
    expect(await s.save(edited(1))).toBe("failed");
    expect(((await rawAll(factory, STORE_PROJECTS)) as ProjectRecord[]).map((r) => r.writeSeq)).toEqual([1]);
    tamper = false;
    await s.retryOpen();
    expect(s.getState().status).toBe("saved");
    expect(s.getState().migration).toEqual({ status: "migrated", projectKey: "legacy-draft-v1", resumed: true });
    expect(s.getState().project?.specText).toBe(pumpkinText);
    expect(legacy.writes).toEqual([]);
  });
});
