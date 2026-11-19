// Increment D: Session boot, persistence ownership, canonical text, history and save races, with fake-indexeddb and a fake
// engine. Event-ordered: the only clock is ManualSchedule (session.testkit.ts); nothing sleeps on wall time.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DraftStore } from "../draft/store";
import { STORE_META, STORE_PROJECTS } from "../project/idb";
import { LEGACY_KEY, LEGACY_PROJECT_KEY, MIGRATION_META_KEY } from "../project/migrate";
import { parseManifest } from "../project/manifests";
import { ACTIVE_KEY, sameValue, sha256Hex, stableText, type ProjectRecord, type Sha256 } from "../project/record";
import { ProjectStore } from "../project/store";
import {
  baseline, instrumentedOpen, memoryMarker, newFactory, pumpkinText, rawAll, rawGet, rawPut, readOnlyStorage,
} from "../project/testkit";
import { drain, FakeEngine, harness, tick, until, type Harness } from "./session.testkit";
import type { SessionDeps } from "./session";

type Gameish = { game: { runtime: { lives: number; winScore: number } } };
const lives = (h: Harness): number => (h.session.store.getState().doc as unknown as Gameish).game.runtime.lives;
const setLives = (h: Harness, n: number): void => h.session.store.set(["game", "runtime", "lives"], n);
const setWin = (h: Harness, n: number): void => h.session.store.set(["game", "runtime", "winScore"], n);
const records = async (f: IDBFactory): Promise<ProjectRecord[]> => (await rawAll(f, STORE_PROJECTS)) as ProjectRecord[];
const active = async (f: IDBFactory): Promise<unknown> => ((await rawGet(f, STORE_META, ACTIVE_KEY)) as { value?: unknown } | undefined)?.value;
const flag = (f: IDBFactory): Promise<unknown> => rawGet(f, STORE_META, MIGRATION_META_KEY);
const specLives = (r: ProjectRecord): number => (JSON.parse(r.specText) as Gameish).game.runtime.lives;
const projectManifest = (r: ProjectRecord) => {
  const m = parseManifest("project", r.manifests.project);
  if (!m.ok) throw new Error("stored project manifest is invalid");
  return m.value;
};

async function boot(deps: Omit<SessionDeps, "engine" | "schedule"> = {}, engine?: FakeEngine): Promise<Harness> {
  const h = harness({ marker: memoryMarker(), ...deps }, engine);
  await h.session.start();
  await drain(h);
  return h;
}

const legacyRaw = (docText: string, b: unknown = baseline): string => JSON.stringify({ version: 1, docText, baseline: b });
const compact = JSON.stringify(JSON.parse(pumpkinText)); // valid JSON, not the engine's canonical text

describe("fixtures", () => {
  it("the compact legacy text really differs from the canonical text (and from its hash)", async () => {
    expect(compact).not.toBe(pumpkinText);
    expect(await sha256Hex(compact)).not.toBe(await sha256Hex(pumpkinText));
    expect(stableText(JSON.parse(compact))).toBe(pumpkinText); // what the fake engine returns
  });
});

describe("DraftStore no longer persists", () => {
  it("has no storage dependency, no readStored and never touches localStorage", () => {
    expect(DraftStore.length).toBe(0);
    expect("readStored" in new DraftStore()).toBe(false);
    expect("persist" in (new DraftStore() as object)).toBe(false);
  });
});

describe("boot", () => {
  it("first boot: empty database, no legacy draft loads the first template and creates one saved project", async () => {
    const factory = newFactory();
    const legacy = readOnlyStorage({});
    const h = await boot({ factory, legacy });
    expect(h.session.boot.phase).toBe("ready");
    expect(h.session.store.getState().baseline?.templateId).toBe("pumpkin-blaster");
    const [rec, ...rest] = await records(factory);
    expect(rest).toEqual([]);
    expect(rec?.specText).toBe(pumpkinText); // the engine's canonical text, not JSON.stringify
    expect(rec?.specSha256).toBe(await sha256Hex(pumpkinText));
    expect(rec ? projectManifest(rec).spec : null).toMatchObject({ baseSha256: await sha256Hex(pumpkinText), currentSha256: await sha256Hex(pumpkinText) });
    expect(await active(factory)).toBe(rec?.projectKey);
    expect(h.session.project.getState().status).toBe("saved");
    expect(legacy.writes).toEqual([]);
  });

  it("boot with an existing project loads it: identical spec text, baseline and manifests", async () => {
    const factory = newFactory();
    const a = await boot({ factory });
    setLives(a, 7);
    const m = a.session.project.getState().manifests;
    if (!m) throw new Error("no manifests");
    expect(a.session.project.actions.commitManifest("gameplay", { ...m.gameplay, score: { winScore: m.gameplay.score.winScore + 1 } }).ok).toBe(true);
    await drain(a);
    const [saved] = await records(factory);

    const b = await boot({ factory });
    expect(await records(factory)).toHaveLength(1); // no second project
    expect(lives(b)).toBe(7);
    expect(b.session.project.getState().status).toBe("saved");
    expect(b.session.project.getState().dirty).toBe(false);
    expect(b.session.store.getState().validation?.canonicalText).toBe(saved?.specText);
    expect(sameValue(b.session.store.getState().baseline, saved?.baseline)).toBe(true);
    expect(sameValue(b.session.project.getState().manifests?.gameplay, { ...m.gameplay, score: { winScore: m.gameplay.score.winScore + 1 } })).toBe(true);
    expect(b.session.project.getState().canUndo).toBe(false); // history is per session
  });

  it("an engine failure rejects start() and is separate from a storage failure, which never blocks opening", async () => {
    const engine = new FakeEngine();
    engine.failInit = "pyodide down";
    const h = harness({ factory: newFactory() }, engine);
    await expect(h.session.start()).rejects.toThrow("pyodide down");
    expect(h.session.projects.getState().status).toBe("loading"); // storage was never reached

    const s = harness({ factory: newFactory(), projectDeps: { openConnection: async () => { throw new Error("disk exploded"); } } });
    await expect(s.session.start()).resolves.toBeUndefined();
    expect(s.session.boot.phase).toBe("ready");
    expect(s.session.store.getState().doc).not.toBeNull();
    expect(s.session.project.getState().status).toBe("failed");
  });
});

describe("legacy draft: canonical migration end to end", () => {
  it("a compact, non-canonical legacy docText is stored as the ENGINE's canonical text with matching hashes", async () => {
    const factory = newFactory();
    const raw = legacyRaw(compact);
    const legacy = readOnlyStorage({ [LEGACY_KEY]: raw });
    const h = await boot({ factory, legacy });
    const [rec, ...rest] = await records(factory);
    expect(rest).toEqual([]);
    const canonicalSha = await sha256Hex(pumpkinText);
    expect(rec?.projectKey).toBe(LEGACY_PROJECT_KEY);
    expect(rec?.specText).toBe(pumpkinText);
    expect(rec?.specText).not.toBe(compact);
    expect(rec?.specSha256).toBe(canonicalSha);
    expect(rec ? projectManifest(rec).spec : null).toEqual({ path: "monstera.spec.json", baseSha256: canonicalSha, currentSha256: canonicalSha });
    expect(rec?.baseline).toEqual(baseline); // preserved unchanged (it already had an origin)
    expect(await flag(factory)).toBeDefined();
    expect(await active(factory)).toBe(LEGACY_PROJECT_KEY);
    // the live draft is the migrated project, clean
    expect(h.session.store.getState().baseline).toEqual(baseline);
    expect(h.session.project.getState()).toMatchObject({ status: "saved", dirty: false, projectKey: LEGACY_PROJECT_KEY });
    // the legacy value is read only and byte-identical
    expect(legacy.getItem(LEGACY_KEY)).toBe(raw);
    expect(legacy.writes).toEqual([]);
    expect(legacy.reads.every((k) => k === LEGACY_KEY)).toBe(true);
  });

  it("a legacy draft stored without an origin gets its template's origin (the one allowed baseline change)", async () => {
    const { origin: _o, ...old } = baseline;
    void _o;
    const factory = newFactory();
    await boot({ factory, legacy: readOnlyStorage({ [LEGACY_KEY]: legacyRaw(compact, old) }) });
    const [rec] = await records(factory);
    expect(rec?.baseline).toEqual({ ...old, origin: baseline.origin });
  });

  it("engine rejection: no record, no migration flag, no active pointer; the legacy draft stays and is exportable", async () => {
    const factory = newFactory();
    const raw = legacyRaw(compact);
    const legacy = readOnlyStorage({ [LEGACY_KEY]: raw });
    const engine = new FakeEngine();
    engine.reject = (t) => t === compact;
    const h = harness({ factory, legacy, marker: memoryMarker() }, engine);
    await h.session.projects.open(); // the migration alone, before anything else can write
    expect(h.session.projects.getState().migration).toMatchObject({ status: "refused", reason: "canonicalization-failed" });
    expect(h.session.projects.getState().legacy?.status).toBe("refused");
    expect(await records(factory)).toEqual([]);
    expect(await flag(factory)).toBeUndefined();
    expect(await active(factory)).toBeUndefined();
    expect(legacy.getItem(LEGACY_KEY)).toBe(raw);
    const exported = h.session.project.actions.exportRecovery({ legacy: true });
    expect(JSON.parse(exported ?? "null")).toMatchObject({ kind: "monstera.studio.recovery", specText: compact });

    // the app still opens (on the first template); the refused draft is never written, flagged or activated
    await h.session.start();
    await drain(h);
    expect(h.session.boot.phase).toBe("ready");
    expect((await records(factory)).map((r) => r.projectKey)).not.toContain(LEGACY_PROJECT_KEY);
    expect(await flag(factory)).toBeUndefined();
    expect(legacy.writes).toEqual([]);
  });

  it("an engine hash that differs from the hash of its canonical text refuses the migration", async () => {
    const factory = newFactory();
    const engine = new FakeEngine();
    engine.badSha = "f".repeat(64);
    const raw = legacyRaw(compact);
    const h = harness({ factory, legacy: readOnlyStorage({ [LEGACY_KEY]: raw }), marker: memoryMarker() }, engine);
    await h.session.projects.open();
    expect(h.session.projects.getState().migration).toMatchObject({ status: "refused", reason: "canonicalization-failed" });
    expect(await records(factory)).toEqual([]);
    expect(await flag(factory)).toBeUndefined();
    expect(await active(factory)).toBeUndefined();
  });
});

describe("memory-only operation", () => {
  it("IndexedDB unavailable: the legacy draft is recovered into memory (canonical), nothing is claimed saved, export works", async () => {
    const raw = legacyRaw(compact);
    const legacy = readOnlyStorage({ [LEGACY_KEY]: raw });
    const h = await boot({ factory: null, legacy });
    const v = () => h.session.project.getState();
    expect(v().status).toBe("memory-only");
    expect(v().legacy?.status).toBe("recovered");
    expect(h.session.store.getState().validation?.canonicalText).toBe(pumpkinText);
    expect(h.session.store.getState().baseline).toEqual(baseline);
    setLives(h, 7);
    await drain(h);
    expect(v().status).toBe("memory-only");
    expect(v().detail.lastSavedAt).toBeNull();
    const out = JSON.parse(h.session.project.actions.exportRecovery() ?? "null") as { specText: string; manifests: Record<string, string> };
    expect((JSON.parse(out.specText) as Gameish).game.runtime.lives).toBe(7); // the edit, in canonical text
    expect(Object.keys(out.manifests)).toHaveLength(7);
    expect(legacy.getItem(LEGACY_KEY)).toBe(raw);
    expect(legacy.writes).toEqual([]);
  });

  it("no legacy draft: the first template opens in memory and is never reported saved", async () => {
    const h = await boot({ factory: null, legacy: readOnlyStorage({}) });
    expect(h.session.project.getState().status).toBe("memory-only");
    expect(h.session.store.getState().baseline?.templateId).toBe("pumpkin-blaster");
    expect(h.session.project.actions.exportRecovery()).not.toBeNull();
  });

  it("a legacy reader that throws is surfaced as unreadable and the app still opens", async () => {
    const h = await boot({ factory: null, legacy: { getItem: () => { throw new Error("denied"); } } });
    expect(h.session.project.getState().legacy?.status).toBe("unreadable");
    expect(h.session.boot.phase).toBe("ready");
  });
});

describe("IndexedDB conflicts and unsaved edits", () => {
  async function conflicted() {
    const factory = newFactory();
    const a = await boot({ factory });
    const other = new ProjectStore({ factory }); // another tab
    await other.open();
    const p = other.getState().project;
    if (!p) throw new Error("no project");
    expect(await other.save({ ...p, name: "other tab" })).toBe("saved");
    setLives(a, 7);
    await drain(a);
    return { factory, a, original: p };
  }

  it("a second tab wrote: this session enters conflict, keeps its edit and overwrites nothing", async () => {
    const { factory, a } = await conflicted();
    expect(a.session.project.getState().status).toBe("conflict");
    expect(lives(a)).toBe(7);
    const [rec] = await records(factory);
    expect(rec?.name).toBe("other tab");
    expect(specLives(rec as ProjectRecord)).toBe(5);
    const out = JSON.parse(a.session.project.actions.exportRecovery() ?? "null") as { specText: string; stored?: { specText: string } };
    expect((JSON.parse(out.specText) as Gameish).game.runtime.lives).toBe(7); // memory first
  });

  it("reload and retryOpen never discard the unsaved edit; only discardMemory adopts the stored project", async () => {
    const { a } = await conflicted();
    const c = a.session.project.actions;
    expect(await c.reloadFromStorage()).toMatchObject({ ok: false, reason: "unsaved-changes" });
    expect(lives(a)).toBe(7);
    expect(await c.retryOpen()).toEqual({ ok: true });
    expect(lives(a)).toBe(7);
    expect(a.session.project.getState().status).toBe("conflict");
    const both = JSON.parse(c.exportRecovery() ?? "null") as { specText: string; stored?: { specText: string } };
    expect((JSON.parse(both.specText) as Gameish).game.runtime.lives).toBe(7); // memory first
    expect((JSON.parse(both.stored?.specText ?? "{}") as Gameish).game.runtime.lives).toBe(5); // the stored record kept next to it
    expect(await c.reloadFromStorage({ discardMemory: true })).toEqual({ ok: true });
    expect(lives(a)).toBe(5);
    expect(a.session.project.getState()).toMatchObject({ name: "other tab", status: "saved", dirty: false });
  });

  it("a failed write keeps the edit in memory; retryOpen keeps it and the retried write stores it", async () => {
    const factory = newFactory();
    let failing = false;
    const h = await boot({ factory, projectDeps: { openConnection: instrumentedOpen({
      onCall: (store, method, mode) => { if (failing && store === STORE_PROJECTS && method === "get" && mode === "readwrite") throw new Error("disk full-ish"); },
    }) } });
    failing = true;
    setLives(h, 7);
    await drain(h);
    expect(h.session.project.getState().status).toBe("failed");
    expect(lives(h)).toBe(7);
    expect(specLives((await records(factory))[0] as ProjectRecord)).toBe(5);
    failing = false;
    expect(await h.session.project.actions.retryOpen()).toEqual({ ok: true });
    await drain(h);
    expect(h.session.project.getState().status).toBe("saved");
    expect(specLives((await records(factory))[0] as ProjectRecord)).toBe(7);
  });

  it("an edit the engine could not canonicalize is never stored as JSON.stringify output, never 'saved', and blocks retryOpen", async () => {
    const factory = newFactory();
    const engine = new FakeEngine();
    const h = await boot({ factory }, engine);
    engine.reject = (t) => t.includes('"lives":99');
    const seen: string[] = [];
    h.session.project.subscribe(() => seen.push(h.session.project.getState().status));
    setLives(h, 99);
    await drain(h);
    const v = h.session.project.getState();
    expect(v).toMatchObject({ status: "unsaved", gate: "waiting-for-valid-spec", dirty: true });
    expect(seen).not.toContain("saved");
    expect(specLives((await records(factory))[0] as ProjectRecord)).toBe(5);
    expect(await h.session.project.actions.retryOpen()).toMatchObject({ ok: false, reason: "unsaved-invalid-edits" });
    setLives(h, 4);
    await drain(h);
    expect(h.session.project.getState()).toMatchObject({ status: "saved", gate: "idle", dirty: false });
    expect(specLives((await records(factory))[0] as ProjectRecord)).toBe(4);
  });
});

// The real engine canonicalizes every document it can parse, valid or not: an invalid one comes back as
// { ok: false, parsed: true, canonicalText, sha256 }. Canonical text alone must never be treated as a valid spec.
describe("parseable but invalid specs are never persisted or migrated", () => {
  type Runtimeish = { game?: { runtime?: { maxEntities?: number } } };
  const tooMany = (t: string): boolean => {
    try { return ((JSON.parse(t) as Runtimeish).game?.runtime?.maxEntities ?? 0) > 1024; } catch { return false; } // schema maximum 1024
  };
  const invalidEngine = (): FakeEngine => { const e = new FakeEngine(); e.invalid = tooMany; return e; };
  const invalidDoc = (): string => {
    const d = JSON.parse(pumpkinText) as { game: { runtime: { maxEntities: number } } };
    d.game.runtime.maxEntities = 5000;
    return JSON.stringify(d);
  };
  const setMax = (h: Harness, n: number): void => h.session.store.set(["game", "runtime", "maxEntities"], n);

  it("the fake engine answers like the real one: ok false, yet parsed with canonical text and its SHA-256", async () => {
    const v = await invalidEngine().validateDraft(invalidDoc());
    expect(v).toMatchObject({ ok: false, parsed: true });
    expect(v.canonicalText).not.toBeNull();
    expect(v.sha256).toBe(await sha256Hex(v.canonicalText ?? ""));
  });

  it("a legacy draft that parses but is invalid is refused: no record, no migration flag, no active pointer", async () => {
    const factory = newFactory();
    const raw = legacyRaw(invalidDoc());
    const legacy = readOnlyStorage({ [LEGACY_KEY]: raw });
    const h = harness({ factory, legacy, marker: memoryMarker() }, invalidEngine());
    await h.session.projects.open(); // the migration alone
    expect(h.session.projects.getState().migration).toMatchObject({ status: "refused", reason: "canonicalization-failed" });
    expect(await records(factory)).toEqual([]);
    expect(await flag(factory)).toBeUndefined();
    expect(await active(factory)).toBeUndefined();
    expect(JSON.parse(h.session.project.actions.exportRecovery({ legacy: true }) ?? "null")).toMatchObject({ specText: invalidDoc() });
    await h.session.start();
    await drain(h);
    expect((await records(factory)).map((r) => r.projectKey)).not.toContain(LEGACY_PROJECT_KEY);
    expect(await flag(factory)).toBeUndefined();
    expect(legacy.getItem(LEGACY_KEY)).toBe(raw);
    expect(legacy.writes).toEqual([]);
  });

  it("with IndexedDB unavailable the same draft is not recovered as a valid project either", async () => {
    const legacy = readOnlyStorage({ [LEGACY_KEY]: legacyRaw(invalidDoc()) });
    const h = await boot({ factory: null, legacy }, invalidEngine());
    expect(h.session.project.getState().status).toBe("memory-only");
    expect(h.session.project.getState().legacy?.status).toBe("refused");
  });

  it("an edit that makes the spec invalid stays in memory, is never saved, blocks retryOpen, and saves once corrected", async () => {
    const factory = newFactory();
    const h = await boot({ factory }, invalidEngine());
    const before = (await records(factory))[0] as ProjectRecord;
    const seen: string[] = [];
    h.session.project.subscribe(() => seen.push(h.session.project.getState().status));
    setMax(h, 5000);
    await drain(h);
    expect(h.session.store.getState().validation).toMatchObject({ ok: false, parsed: true }); // canonical text present
    expect(h.session.store.getState().validation?.canonicalText).not.toBeNull();
    expect(h.session.project.getState()).toMatchObject({ status: "unsaved", gate: "waiting-for-valid-spec", dirty: true });
    expect(seen).not.toContain("saved");
    expect(await h.session.project.actions.retryOpen()).toMatchObject({ ok: false, reason: "unsaved-invalid-edits" });
    await h.session.project.flush(); // what pagehide does: it must not hand the invalid edit over either
    await drain(h);
    expect(await records(factory)).toEqual([before]); // nothing persisted, byte for byte
    expect(h.session.project.getState().status).toBe("unsaved");
    expect(seen).not.toContain("saved");

    setMax(h, 512); // the user corrects the field; the engine now says ok
    await drain(h);
    expect(h.session.project.getState()).toMatchObject({ status: "saved", gate: "idle", dirty: false });
    const [rec] = await records(factory);
    expect((JSON.parse(rec?.specText ?? "{}") as { game: { runtime: { maxEntities: number } } }).game.runtime.maxEntities).toBe(512);
    expect(rec?.specText).toBe(h.session.store.getState().validation?.canonicalText);
    expect(rec?.specSha256).toBe(await sha256Hex(rec?.specText ?? ""));
    expect(projectManifest(rec as ProjectRecord).spec).toMatchObject({ baseSha256: rec?.specSha256, currentSha256: rec?.specSha256 });
  });

  it("startNewProject refuses an invalid open project", async () => {
    const factory = newFactory();
    const h = await boot({ factory }, invalidEngine());
    setMax(h, 5000);
    await drain(h);
    expect(await h.session.project.actions.startNewProject()).toMatchObject({ ok: false, reason: "invalid-snapshot" });
    expect(await records(factory)).toHaveLength(1);
  });

  it("an invalid imported document can be edited in memory but is not saved until it is valid", async () => {
    const factory = newFactory();
    const h = await boot({ factory }, invalidEngine());
    const before = await records(factory);
    expect(await h.session.importText(invalidDoc(), "broken.json")).toEqual({ ok: true });
    await drain(h);
    expect(h.session.store.getState().baseline?.label).toBe("broken.json");
    expect(h.session.project.getState()).toMatchObject({ status: "unsaved", gate: "waiting-for-valid-spec" });
    expect(await records(factory)).toEqual(before);
    setMax(h, 256);
    await drain(h);
    expect(h.session.project.getState().status).toBe("saved");
    const after = await records(factory);
    expect(after).toHaveLength(before.length + 1);
    expect(after.some((r) => r.name === "broken.json")).toBe(true);
  });
});

// An imported document whose runtime.lives / runtime.winScore break the schema must still open as an editable, unsaved
// draft with its values intact. The bounds come from the real spec schema; the fake engine answers like the real one.
describe("imports with schema-invalid runtime.lives / runtime.winScore", () => {
  type Bound = { minimum: number; maximum: number };
  const gameSchema = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "spec", "schema", "game.schema.json"), "utf8")) as unknown;
  const findBound = (node: unknown, key: string): Bound => {
    const stack: unknown[] = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      if (typeof n !== "object" || n === null) continue;
      const props = (n as { properties?: Record<string, Partial<Bound>> }).properties;
      const b = props?.[key];
      if (props?.["winScore"] && props["lives"] && typeof b?.minimum === "number" && typeof b.maximum === "number") return { minimum: b.minimum, maximum: b.maximum };
      stack.push(...Object.values(n));
    }
    throw new Error(`no schema bounds for runtime.${key}`);
  };
  const LIVES = findBound(gameSchema, "lives");
  const WIN = findBound(gameSchema, "winScore");
  type Rt = { game: { runtime: { lives: number; winScore: number } } };
  const runtimeOf = (t: string): Rt["game"]["runtime"] | null => {
    try { return (JSON.parse(t) as Rt).game.runtime; } catch { return null; }
  };
  const outOfBounds = (t: string): boolean => {
    const r = runtimeOf(t);
    if (!r) return false;
    return r.lives < LIVES.minimum || r.lives > LIVES.maximum || r.winScore < WIN.minimum || r.winScore > WIN.maximum;
  };
  const docWith = (lives: number, winScore: number): string => {
    const d = JSON.parse(pumpkinText) as Rt;
    d.game.runtime.lives = lives;
    d.game.runtime.winScore = winScore;
    return JSON.stringify(d);
  };

  it("uses the real schema bounds", () => {
    expect(LIVES).toEqual({ minimum: 1, maximum: 99 });
    expect(WIN).toEqual({ minimum: 0, maximum: 1000000 });
  });

  it.each([
    ["lives below its minimum", LIVES.minimum - 1, 1000],
    ["lives above its maximum", LIVES.maximum + 1, 1000],
    ["winScore below its minimum", 5, WIN.minimum - 1],
    ["winScore above its maximum", 5, WIN.maximum + 1],
    ["both out of bounds", LIVES.maximum + 1, WIN.minimum - 1],
  ])("%s: opens as an unsaved draft with its values intact, and saves once corrected", async (_n, badLives, badWin) => {
    const factory = newFactory();
    const engine = new FakeEngine();
    engine.invalid = outOfBounds;
    const h = await boot({ factory }, engine);
    const before = await records(factory);
    const seen: string[] = [];
    h.session.project.subscribe(() => seen.push(h.session.project.getState().status));

    expect(await h.session.importText(docWith(badLives, badWin), "imported.json")).toEqual({ ok: true });
    await drain(h);
    const doc = h.session.store.getState().doc as unknown as Rt;
    expect(doc.game.runtime).toMatchObject({ lives: badLives, winScore: badWin }); // nothing clamped or replaced
    expect(h.session.store.getState().baseline?.label).toBe("imported.json");
    const v = h.session.store.getState().validation;
    expect(v).toMatchObject({ ok: false, parsed: true });
    expect(v?.issues.length).toBeGreaterThan(0); // the errors stay visible
    expect(runtimeOf(v?.canonicalText ?? "")).toMatchObject({ lives: badLives, winScore: badWin });
    expect(h.session.project.getState()).toMatchObject({ status: "unsaved", gate: "waiting-for-valid-spec", dirty: true, gameplayProvisional: true });
    expect(await records(factory)).toEqual(before);
    expect(seen).not.toContain("saved");

    setLives(h, 4); // the user corrects the invalid fields; the engine now says ok
    setWin(h, 750);
    await drain(h);
    expect(h.session.store.getState().validation).toMatchObject({ ok: true });
    expect(h.session.project.getState()).toMatchObject({ status: "saved", gate: "idle", dirty: false, gameplayProvisional: false });
    const after = await records(factory);
    expect(after).toHaveLength(before.length + 1);
    const rec = after.find((r) => r.name === "imported.json") as ProjectRecord;
    expect(rec.specText).toBe(h.session.store.getState().validation?.canonicalText);
    expect(runtimeOf(rec.specText)).toMatchObject({ lives: 4, winScore: 750 });
    expect(rec.specSha256).toBe(await sha256Hex(rec.specText));
    expect(projectManifest(rec).spec).toMatchObject({ baseSha256: rec.specSha256, currentSha256: rec.specSha256 });
    // the stored gameplay manifest agrees with the validated spec, not with any initialization value
    const g = parseManifest("gameplay", rec.manifests.gameplay);
    expect(g.ok && g.value).toMatchObject({ lives: { start: 4 }, score: { winScore: 750 }, collectibles: [], enemies: [] });
    expect(projectManifest(rec).derivation.gameplay).toBe(false);
  });

  it("a valid import is unchanged: its own runtime values become the gameplay defaults and it saves at once", async () => {
    const factory = newFactory();
    const engine = new FakeEngine();
    engine.invalid = outOfBounds;
    const h = await boot({ factory }, engine);
    expect(await h.session.importText(docWith(7, 300), "fine.json")).toEqual({ ok: true });
    await drain(h);
    expect(h.session.project.getState()).toMatchObject({ status: "saved", dirty: false });
    expect(h.session.project.getState().manifests?.gameplay).toMatchObject({ lives: { start: 7 }, score: { winScore: 300 } });
    const rec = (await records(factory)).find((r) => r.name === "fine.json") as ProjectRecord;
    const g = parseManifest("gameplay", rec.manifests.gameplay);
    expect(g.ok && g.value).toMatchObject({ lives: { start: 7 }, score: { winScore: 300 } });
  });

  it("a gameplay manifest the user committed while the spec was invalid is kept as committed", async () => {
    const factory = newFactory();
    const engine = new FakeEngine();
    engine.invalid = outOfBounds;
    const h = await boot({ factory }, engine);
    expect(await h.session.importText(docWith(0, 1000), "imported.json")).toEqual({ ok: true });
    await drain(h);
    const m = h.session.project.getState().manifests;
    if (!m) throw new Error("no manifests");
    expect(h.session.project.actions.commitManifest("gameplay", { ...m.gameplay, lives: { start: 9 } })).toEqual({ ok: true, changed: true });
    setLives(h, 4);
    await drain(h);
    expect(h.session.project.getState().status).toBe("saved");
    const rec = (await records(factory)).find((r) => r.name === "imported.json") as ProjectRecord;
    const g = parseManifest("gameplay", rec.manifests.gameplay);
    expect(g.ok && g.value.lives.start).toBe(9);
  });
});

describe("history: spec and manifests as one snapshot", () => {
  it("undo restores doc and manifests together, redo re-applies both, a new edit clears redo, and the result is persisted", async () => {
    const factory = newFactory();
    const h = await boot({ factory });
    const view = () => h.session.project.getState();
    const c = h.session.project.actions;
    const doc0 = h.session.store.getState().doc;
    const m0 = view().manifests;
    if (!m0) throw new Error("no manifests");
    setLives(h, 7);
    const doc1 = h.session.store.getState().doc;
    const m1 = { ...m0.gameplay, score: { winScore: m0.gameplay.score.winScore + 1 } };
    expect(c.commitManifest("gameplay", m1)).toEqual({ ok: true, changed: true });
    const mAfter = view().manifests;
    expect(c.commitManifest("gameplay", m1)).toEqual({ ok: true, changed: false }); // no-op: no entry
    expect(view().canUndo).toBe(true);
    expect(view().canRedo).toBe(false);

    expect(c.undo()).toBe(true); // manifest edit undone, spec edit still there
    expect(view().manifests).toBe(m0);
    expect(h.session.store.getState().doc).toBe(doc1);
    expect(c.undo()).toBe(true); // now the spec edit
    expect(view().manifests).toBe(m0);
    expect(h.session.store.getState().doc).toBe(doc0);
    expect(view().canUndo).toBe(false);
    expect(view().canRedo).toBe(true);
    expect(view().status).toBe("unsaved"); // restored but not yet persisted: never claimed saved
    await drain(h);
    const stored = (await records(factory))[0] as ProjectRecord;
    expect(stored.specText).toBe(pumpkinText); // undo went through validation and a save
    expect(projectManifest(stored).spec.currentSha256).toBe(await sha256Hex(pumpkinText));
    expect(view().status).toBe("saved");

    expect(c.redo()).toBe(true);
    expect(c.redo()).toBe(true);
    expect(h.session.store.getState().doc).toBe(doc1);
    expect(view().manifests?.gameplay).toBe(mAfter?.gameplay);
    expect(c.redo()).toBe(false);
    await drain(h);
    expect(specLives((await records(factory))[0] as ProjectRecord)).toBe(7);

    c.undo();
    expect(view().canRedo).toBe(true);
    setLives(h, 3); // a new edit clears redo
    expect(view().canRedo).toBe(false);
    expect(c.redo()).toBe(false);
  });

  it("coalesces rapid edits of one path into one entry, keeps different paths apart, and stops at 100 entries", async () => {
    const h = await boot();
    const view = () => h.session.project.getState();
    const c = h.session.project.actions;
    for (const n of [6, 7, 8, 9, 10]) setLives(h, n);
    expect(c.undo()).toBe(true);
    expect(lives(h)).toBe(5);
    expect(view().canUndo).toBe(false);
    c.redo();

    setWin(h, 10);
    setLives(h, 2);
    setWin(h, 11);
    let n = 0;
    while (c.undo()) n++;
    expect(n).toBe(4); // lives(6..10), winScore, lives, winScore
    expect(lives(h)).toBe(5);

    const cap = await boot();
    for (let i = 0; i < 120; i++) (i % 2 === 0 ? setLives : setWin)(cap, 100 + i);
    let undone = 0;
    while (cap.session.project.actions.undo()) undone++;
    expect(undone).toBe(100);
  });

  it("an invalid manifest is refused and leaves history and state alone", async () => {
    const h = await boot();
    const m = h.session.project.getState().manifests;
    if (!m) throw new Error("no manifests");
    const r = h.session.project.actions.commitManifest("gameplay", { ...m.gameplay, lives: { start: -1 } });
    expect(r.ok).toBe(false);
    expect(h.session.project.getState().canUndo).toBe(false);
    expect(h.session.project.getState().manifests).toBe(m);
  });

  it("template load, import and reset clear history; a template load is a NEW project and keeps the old record", async () => {
    const factory = newFactory();
    const h = await boot({ factory });
    const view = () => h.session.project.getState();
    const firstKey = view().projectKey;
    setLives(h, 7);
    expect(view().canUndo).toBe(true);
    await h.session.reset();
    expect(view().canUndo).toBe(false);
    expect(view().projectKey).toBe(firstKey); // reset stays in the same project
    expect(lives(h)).toBe(5);
    setLives(h, 8);
    await h.session.loadTemplate("pumpkin-blaster");
    expect(view().canUndo).toBe(false);
    expect(view().projectKey).not.toBe(firstKey);
    await drain(h);
    setLives(h, 9);
    expect(await h.session.importText(compact, "mine.json")).toEqual({ ok: true });
    expect(view().canUndo).toBe(false);
    await drain(h);
    const rs = await records(factory);
    expect(rs).toHaveLength(3); // nothing was overwritten
    const imported = rs.find((r) => r.projectKey === view().projectKey);
    expect(imported?.specText).toBe(pumpkinText); // the import is stored canonical
    expect(imported?.specSha256).toBe(await sha256Hex(pumpkinText));
    expect(imported?.name).toBe("mine.json");
  });

  it("an import whose default manifests cannot be built is refused and the draft is unchanged", async () => {
    const h = await boot();
    const before = h.session.store.getState();
    const noRuntime = JSON.stringify({ project: { id: "x" }, game: {} });
    const r = await h.session.importText(noRuntime, "bad.json");
    expect(r.ok).toBe(false);
    // the reason is carried into the message (it used to be lost and read only ". Your draft was not changed.")
    expect(r.ok === false && r.message).toMatch(/^cannot build default manifests: missing runtime\.lives, runtime\.winScore\. Your draft was not changed\.$/);
    expect(h.session.store.getState()).toBe(before);
  });
});

describe("saving", () => {
  it("a write that finishes for an older revision never marks a newer one saved; the final record is the latest", async () => {
    const factory = newFactory();
    let armed = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const gated: Sha256 = async (t) => {
      if (armed) { armed = false; await gate; }
      return sha256Hex(t);
    };
    const h = await boot({ factory, projectDeps: { sha256: gated } });
    const view = () => h.session.project.getState();
    const step = async () => { h.clock.runDue(); await tick(); await tick(); };

    armed = true;
    setLives(h, 7); // A
    await step(); await until(h, () => view().gate === "scheduled", "A validated");
    await step(); // save timer -> A is handed over and blocked inside the store
    await until(h, () => h.session.projects.getState().status === "saving", "A in flight");
    setLives(h, 8); // B, queued behind A
    await step(); await until(h, () => view().gate === "scheduled", "B validated");
    await step(); await until(h, () => !view().dirty, "B handed to the store");
    setLives(h, 9); // C, not even validated yet
    expect(view()).toMatchObject({ status: "unsaved", gate: "waiting-for-validation", dirty: true });

    const seen: string[] = [];
    h.session.project.subscribe(() => seen.push(view().status));
    release();
    await h.session.project.whenSettled();
    expect(h.session.projects.getState().status).toBe("saved"); // the store committed A then B
    expect(view().status).toBe("unsaved"); // but C is newer and was never stored
    expect(seen).not.toContain("saved");
    const mid = (await records(factory))[0] as ProjectRecord;
    expect(specLives(mid)).toBe(8); // B, not A and not C
    expect(mid.writeSeq).toBe(3); // initial, A, B

    await drain(h);
    const last = (await records(factory))[0] as ProjectRecord;
    expect(specLives(last)).toBe(9);
    expect(last.writeSeq).toBe(4);
    expect(view()).toMatchObject({ status: "saved", dirty: false });
  });

  it("an edit is debounced after its validation; pagehide flushes a validated edit at once (best effort)", async () => {
    const factory = newFactory();
    const h = await boot({ factory });
    const listeners = new Map<string, () => void>();
    const win = { addEventListener: (n: string, f: () => void) => listeners.set(n, f), removeEventListener: () => undefined };
    const doc = { visibilityState: "visible", addEventListener: (n: string, f: () => void) => listeners.set(n, f), removeEventListener: () => undefined };
    h.session.project.attachLifecycle(win as never, doc as never);
    setLives(h, 7);
    h.clock.runDue(); // validation only
    await until(h, () => h.session.project.getState().gate === "scheduled", "validated");
    expect(specLives((await records(factory))[0] as ProjectRecord)).toBe(5); // debounce still pending
    listeners.get("visibilitychange")?.(); // visible: no flush
    await tick();
    expect(specLives((await records(factory))[0] as ProjectRecord)).toBe(5);
    listeners.get("pagehide")?.();
    await h.session.project.whenSettled();
    expect(specLives((await records(factory))[0] as ProjectRecord)).toBe(7);
  });

  it("quarantined storage is never written over by the boot; startNewProject saves the open project as a new one", async () => {
    const factory = newFactory();
    await rawPut(factory, STORE_PROJECTS, { projectKey: "junk", format: 1, junk: true });
    const h = await boot({ factory });
    expect(h.session.project.getState().status).toBe("quarantined");
    expect(await records(factory)).toEqual([{ projectKey: "junk", format: 1, junk: true }]);
    const r = await h.session.project.actions.startNewProject();
    expect(r.ok).toBe(true);
    const rs = await records(factory);
    expect(rs).toHaveLength(2);
    expect(rs.find((x) => x.projectKey === "junk")).toEqual({ projectKey: "junk", format: 1, junk: true });
    expect(await active(factory)).toBe(r.ok ? r.projectKey : null);
    expect(h.session.project.getState().status).toBe("saved");
  });
});

describe("the legacy key is read only on every path", () => {
  it("boot with a legacy draft, edits, undo, import, reset and template load never call setItem/removeItem/clear", async () => {
    const raw = legacyRaw(compact);
    const legacy = readOnlyStorage({ [LEGACY_KEY]: raw });
    const marker = memoryMarker();
    const h = await boot({ factory: newFactory(), legacy, marker });
    setLives(h, 7);
    h.session.project.actions.undo();
    await h.session.importText(compact, "a.json");
    await h.session.reset();
    await h.session.loadTemplate("pumpkin-blaster");
    await drain(h);
    expect(legacy.writes).toEqual([]);
    expect(legacy.getItem(LEGACY_KEY)).toBe(raw);
    expect(marker.value).not.toBeNull(); // the eviction hint marker is the only thing Studio writes to localStorage
  });
});
