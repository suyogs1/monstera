import { describe, expect, it } from "vitest";
import type { Baseline } from "../draft/store";
import { openDb, STORE_META, STORE_PROJECTS, type IdbConnection } from "./idb";
import { LEGACY_KEY, LEGACY_PROJECT_KEY, MIGRATION_META_KEY, migrateLegacyDraft, type MigrationResult, type MigrationRuntime } from "./migrate";
import { MANIFEST_NAMES, serializeManifest } from "./manifests";
import { sha256Hex, type ProjectRecord } from "./record";
import { ProjectStore } from "./store";
import { baseline, manifestsFor, newFactory, pumpkinText, rawAll, rawGet, rawPut, readOnlyStorage, wrapConnection, type Hooks } from "./testkit";

const draft = (docText = pumpkinText, b: unknown = baseline, version: unknown = 1): string => JSON.stringify({ version, docText, baseline: b });
const runtime = (items: Record<string, string>, extra: Partial<Omit<MigrationRuntime, "legacy">> = {}): MigrationRuntime & { legacy: ReturnType<typeof readOnlyStorage> } => ({
  legacy: readOnlyStorage(items), defaultManifests: ({ projectId }) => manifestsFor(projectId), sha256: sha256Hex, now: () => 4242, ...extra,
});
async function connect(factory: IDBFactory, hooks?: Hooks): Promise<IdbConnection> {
  const c = await openDb(factory);
  return hooks ? wrapConnection(c, hooks) : c;
}
const projects = async (f: IDBFactory): Promise<ProjectRecord[]> => (await rawAll(f, STORE_PROJECTS)) as ProjectRecord[];
const flag = (f: IDBFactory): Promise<unknown> => rawGet(f, STORE_META, MIGRATION_META_KEY);

describe("migration success", () => {
  it("creates one identical project, then the flag, and never writes to the legacy storage", async () => {
    const factory = newFactory();
    const raw = draft();
    const rt = runtime({ [LEGACY_KEY]: raw });
    const result = await migrateLegacyDraft(await connect(factory), rt);
    expect(result).toEqual({ status: "migrated", projectKey: LEGACY_PROJECT_KEY, resumed: false });
    const [rec, ...rest] = await projects(factory);
    expect(rest).toEqual([]);
    expect(rec).toEqual({
      format: 1, projectKey: "legacy-draft-v1", name: "pumpkin-blaster", projectId: "pumpkin-blaster", specText: pumpkinText,
      specSha256: await sha256Hex(pumpkinText), baseline, writeSeq: 1,
      manifests: Object.fromEntries(MANIFEST_NAMES.map((n) => [n, serializeManifest(n, manifestsFor("pumpkin-blaster")[n] as never)])),
    });
    expect(await flag(factory)).toEqual({ key: MIGRATION_META_KEY, format: 1, projectKey: "legacy-draft-v1", legacySha256: await sha256Hex(raw), migratedAt: 4242 });
    expect(await rawGet(factory, STORE_META, "activeProjectKey")).toEqual({ key: "activeProjectKey", value: "legacy-draft-v1" });
    expect(rt.legacy.reads).toEqual([LEGACY_KEY]);
    expect(rt.legacy.writes).toEqual([]);
    expect(raw).toBe(draft()); // the legacy value is a plain string we never touched

    const store = new ProjectStore({ factory });
    await store.open();
    expect(store.getState().status).toBe("saved");
    expect(store.getState().project?.specText).toBe(pumpkinText);
    expect(store.getState().project?.baseline).toEqual(baseline);
  });

  it("an old-shape draft without origin is migrated as stored, or back-filled through the injected rule", async () => {
    const { origin: _origin, ...old } = baseline;
    void _origin;
    const f1 = newFactory();
    await migrateLegacyDraft(await connect(f1), runtime({ [LEGACY_KEY]: draft(pumpkinText, old) }));
    const stored = (await projects(f1))[0]?.baseline as Baseline;
    expect("origin" in stored).toBe(false);
    expect(stored).toEqual(old);

    const origin = { templateId: "pumpkin-blaster", path: "apps/pumpkin-blaster/monstera.spec.json", basis: "template" as const, canonicalText: pumpkinText };
    const f2 = newFactory();
    const calls: Baseline[] = [];
    await migrateLegacyDraft(await connect(f2), runtime({ [LEGACY_KEY]: draft(pumpkinText, old) }, { backfillOrigin: async (b) => { calls.push(b); return origin; } }));
    expect((await projects(f2))[0]?.baseline).toEqual({ ...old, origin });
    expect(calls).toEqual([old]);

    const f3 = newFactory();
    await migrateLegacyDraft(await connect(f3), runtime({ [LEGACY_KEY]: draft(pumpkinText, old) }, { backfillOrigin: async () => null }));
    expect((await projects(f3))[0]?.baseline).toEqual({ ...old, origin: null });

    const f4 = newFactory(); // a draft that already has an origin is never back-filled
    await migrateLegacyDraft(await connect(f4), runtime({ [LEGACY_KEY]: draft() }, { backfillOrigin: async () => { throw new Error("must not run"); } }));
    expect((await projects(f4))[0]?.baseline).toEqual(baseline);
  });

  it("repeated boot does not migrate again", async () => {
    const factory = newFactory();
    const rt = runtime({ [LEGACY_KEY]: draft() });
    await migrateLegacyDraft(await connect(factory), rt);
    const first = await projects(factory);
    const again = await migrateLegacyDraft(await connect(factory), runtime({ [LEGACY_KEY]: draft(pumpkinText + " ") }));
    expect(again).toEqual({ status: "skipped", reason: "flag-set" });
    expect(await projects(factory)).toEqual(first);
  });
});

describe("verification and crash safety", () => {
  it("a read-back mismatch sets no flag and returns the legacy draft; the retry creates exactly one project", async () => {
    const factory = newFactory();
    const rt = runtime({ [LEGACY_KEY]: draft() });
    const bad = await connect(factory, { tamperGet: (s, r, mode) => (s === STORE_PROJECTS && mode === "readonly" ? { ...(r as object), specText: "{}" } : r) });
    const result = await migrateLegacyDraft(bad, rt);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.reason).toBe("verification");
    expect(result.legacy.specText).toBe(pumpkinText);
    expect(await flag(factory)).toBeUndefined();
    expect((await projects(factory)).length).toBe(1);
    const retry = await migrateLegacyDraft(await connect(factory), rt);
    expect(retry).toEqual({ status: "migrated", projectKey: LEGACY_PROJECT_KEY, resumed: true });
    expect((await projects(factory)).length).toBe(1);
    expect(await flag(factory)).toBeDefined();
  });

  it("a crash between the record write and the flag is re-verified on the next boot without duplicating or rewriting", async () => {
    const factory = newFactory();
    const rt = runtime({ [LEGACY_KEY]: draft() });
    const crashing = await connect(factory, { onCall: (s, m, mode, args) => { if (s === STORE_META && m === "put" && mode === "readwrite" && (args[0] as { key: string }).key === MIGRATION_META_KEY) throw new Error("crash"); } });
    const first = await migrateLegacyDraft(crashing, rt);
    expect(first.status).toBe("failed");
    expect(await flag(factory)).toBeUndefined();
    const written = await projects(factory);
    expect(written.length).toBe(1);

    let projectWrites = 0;
    const second = await migrateLegacyDraft(await connect(factory, { onCall: (s, m) => { if (s === STORE_PROJECTS && m === "put") projectWrites++; } }), rt);
    expect(second).toEqual({ status: "migrated", projectKey: LEGACY_PROJECT_KEY, resumed: true });
    expect(projectWrites).toBe(0);
    expect(await projects(factory)).toEqual(written);
    expect(await flag(factory)).toBeDefined();
  });

  it("a record that changed after an interrupted migration is never overwritten", async () => {
    const factory = newFactory();
    const rt = runtime({ [LEGACY_KEY]: draft() });
    await migrateLegacyDraft(await connect(factory, { onCall: (s, m, _mode, args) => { if (s === STORE_META && m === "put" && (args[0] as { key: string }).key === MIGRATION_META_KEY) throw new Error("crash"); } }), rt);
    const edited = { ...(await projects(factory))[0], writeSeq: 2, name: "edited later" };
    await rawPut(factory, STORE_PROJECTS, edited);
    const result = await migrateLegacyDraft(await connect(factory), rt);
    expect(result.status === "failed" && result.reason).toBe("record-diverged");
    expect(await projects(factory)).toEqual([edited]);
    expect(await flag(factory)).toBeUndefined();
  });

  it("an unrelated project record is never touched and blocks the migration", async () => {
    const factory = newFactory();
    const other = { format: 1, projectKey: "other", anything: true };
    await rawPut(factory, STORE_PROJECTS, other);
    const rt = runtime({ [LEGACY_KEY]: draft() });
    expect(await migrateLegacyDraft(await connect(factory), rt)).toEqual({ status: "skipped", reason: "projects-exist" });
    expect(await rawAll(factory, STORE_PROJECTS)).toEqual([other]);
    expect(await flag(factory)).toBeUndefined();
    expect(rt.legacy.reads).toEqual([]);
  });

  it("a default-manifest provider that returns an invalid manifest fails without writing", async () => {
    const factory = newFactory();
    const rt = runtime({ [LEGACY_KEY]: draft() }, { defaultManifests: ({ projectId }) => { const m = manifestsFor(projectId); return { ...m, gameplay: { ...m.gameplay, lives: { start: -1 } } }; } });
    const result: MigrationResult = await migrateLegacyDraft(await connect(factory), rt);
    expect(result.status === "failed" && result.reason).toBe("manifests");
    expect(await projects(factory)).toEqual([]);
    expect(await flag(factory)).toBeUndefined();
  });
});

describe("refusal and empty cases", () => {
  const cases: [string, string, string][] = [
    ["corrupt JSON", "{not json", "corrupt-json"],
    ["a JSON array", "[1]", "corrupt-json"],
    ["version 2", draft(pumpkinText, baseline, 2), "unsupported-version"],
    ["version as a string", draft(pumpkinText, baseline, "1"), "unsupported-version"],
    ["missing version", JSON.stringify({ docText: pumpkinText, baseline }), "unsupported-version"],
    ["a non-string docText", JSON.stringify({ version: 1, docText: { project: { id: "x" } }, baseline }), "bad-doc-text"],
    ["a malformed baseline", draft(pumpkinText, { label: 5 }), "bad-baseline"],
    ["a docText that is not JSON", draft("not json"), "bad-spec"],
    ["a docText without project.id", draft("{}"), "bad-spec"],
  ];
  it.each(cases)("refuses %s and leaves everything untouched", async (_n, raw, reason) => {
    const factory = newFactory();
    const rt = runtime({ [LEGACY_KEY]: raw });
    const result = await migrateLegacyDraft(await connect(factory), rt);
    expect(result.status).toBe("refused");
    expect(result.status === "refused" && result.reason).toBe(reason);
    expect(await projects(factory)).toEqual([]);
    expect(await flag(factory)).toBeUndefined();
    expect(rt.legacy.writes).toEqual([]);
    expect(rt.legacy.getItem(LEGACY_KEY)).toBe(raw);
  });

  it("an empty database with no legacy draft reports nothing-to-migrate and writes nothing", async () => {
    const factory = newFactory();
    expect(await migrateLegacyDraft(await connect(factory), runtime({}))).toEqual({ status: "nothing-to-migrate" });
    expect(await projects(factory)).toEqual([]);
    expect(await rawAll(factory, STORE_META)).toEqual([]);
  });

  it("a legacy storage that throws on read is treated as no draft", async () => {
    const rt = { ...runtime({}), legacy: { getItem: (): string | null => { throw new Error("denied"); } } };
    expect(await migrateLegacyDraft(await connect(newFactory()), rt)).toEqual({ status: "nothing-to-migrate" });
  });
});
