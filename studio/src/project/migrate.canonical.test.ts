// Increment D: the migration stores the ENGINE's canonical text (through the injected canonicalize), never the legacy
// docText, and refuses without writing anything when the engine cannot supply it.
import { describe, expect, it } from "vitest";
import { openDb, STORE_META, STORE_PROJECTS } from "./idb";
import { LEGACY_KEY, LEGACY_PROJECT_KEY, MIGRATION_META_KEY, migrateLegacyDraft, readLegacyDraft, type CanonicalSpec, type MigrationRuntime } from "./migrate";
import { parseManifest } from "./manifests";
import { ACTIVE_KEY, sha256Hex, type ProjectRecord } from "./record";
import { baseline, manifestsFor, newFactory, pumpkinText, rawAll, rawGet, readOnlyStorage } from "./testkit";

const compact = JSON.stringify(JSON.parse(pumpkinText));
const raw = JSON.stringify({ version: 1, docText: compact, baseline });
type Canon = MigrationRuntime["canonicalize"];

/** What the engine would return for the compact text: the real canonical pumpkin text and its real hash. */
const engineCanon: Canon = async (t) => (t === compact ? { canonicalText: pumpkinText, sha256: await sha256Hex(pumpkinText), runtime: { lives: 5, winScore: 1000 } } : null);

const rt = (canonicalize: Canon, defaults: MigrationRuntime["defaultManifests"] = ({ projectId }) => manifestsFor(projectId)) => ({
  legacy: readOnlyStorage({ [LEGACY_KEY]: raw }), canonicalize, sha256: sha256Hex, now: () => 1, defaultManifests: defaults,
});
const state = async (f: IDBFactory) => ({
  records: (await rawAll(f, STORE_PROJECTS)) as ProjectRecord[],
  flag: await rawGet(f, STORE_META, MIGRATION_META_KEY),
  active: await rawGet(f, STORE_META, ACTIVE_KEY),
});

describe("canonical legacy migration", () => {
  it("stores the canonical text; record hash and both project-manifest hashes are the canonical hash; legacy key and baseline untouched", async () => {
    const f = newFactory();
    const seen: { specText: string; specSha256: string; runtime: unknown }[] = [];
    const r = rt(engineCanon, (ctx) => {
      seen.push({ specText: ctx.specText, specSha256: ctx.specSha256, runtime: ctx.runtime });
      const m = manifestsFor(ctx.projectId);
      return { ...m, project: { ...m.project, spec: { ...m.project.spec, baseSha256: ctx.specSha256, currentSha256: ctx.specSha256 } } };
    });
    expect(await migrateLegacyDraft(await openDb(f), r)).toEqual({ status: "migrated", projectKey: LEGACY_PROJECT_KEY, resumed: false });
    const canonicalSha = await sha256Hex(pumpkinText);
    const { records, flag, active } = await state(f);
    expect(records).toHaveLength(1);
    const rec = records[0] as ProjectRecord;
    expect(rec.specText).toBe(pumpkinText);
    expect(rec.specText).not.toBe(compact);
    expect(rec.specSha256).toBe(canonicalSha);
    expect(rec.specSha256).not.toBe(await sha256Hex(compact));
    const pm = parseManifest("project", rec.manifests.project);
    expect(pm.ok && pm.value.spec).toEqual({ path: "monstera.spec.json", baseSha256: canonicalSha, currentSha256: canonicalSha });
    expect(rec.baseline).toEqual(baseline);
    expect(flag).toBeDefined();
    expect(active).toEqual({ key: ACTIVE_KEY, value: LEGACY_PROJECT_KEY });
    // the defaults provider got the canonical text, its hash and the runtime of the same validated document
    expect(seen).toEqual([{ specText: pumpkinText, specSha256: canonicalSha, runtime: { lives: 5, winScore: 1000 } }]);
    expect(r.legacy.getItem(LEGACY_KEY)).toBe(raw);
    expect(r.legacy.writes).toEqual([]);
  });

  it.each([
    ["canonicalize returns null (engine rejects)", async () => null],
    ["canonicalize throws (engine error)", async () => { throw new Error("worker crashed"); }],
    ["the engine hash differs from the hash of its canonical text", async (): Promise<CanonicalSpec> => ({ canonicalText: pumpkinText, sha256: "f".repeat(64), runtime: { lives: 5, winScore: 1000 } })],
    ["the engine returns an empty canonical text", async (): Promise<CanonicalSpec> => ({ canonicalText: "", sha256: await sha256Hex(""), runtime: null })],
    ["the canonical text has no project.id", async (): Promise<CanonicalSpec> => ({ canonicalText: "{}\n", sha256: await sha256Hex("{}\n"), runtime: null })],
  ])("refuses when %s: nothing is written and the legacy draft stays", async (_name, canonicalize) => {
    const f = newFactory();
    const r = rt(canonicalize as Canon);
    const result = await migrateLegacyDraft(await openDb(f), r);
    expect(result).toMatchObject({ status: "refused", reason: "canonicalization-failed" });
    expect(await state(f)).toEqual({ records: [], flag: undefined, active: undefined });
    expect(r.legacy.getItem(LEGACY_KEY)).toBe(raw);
    expect(r.legacy.writes).toEqual([]);
  });

  it("readLegacyDraft refuses the same way (the memory-only path), so no snapshot is invented", async () => {
    expect(await readLegacyDraft(rt(async () => null))).toMatchObject({ status: "refused", reason: "canonicalization-failed" });
    const ok = await readLegacyDraft(rt(engineCanon));
    expect(ok.status === "recovered" && ok.snapshot.specText).toBe(pumpkinText);
  });

  it("a missing runtime in the validated document refuses (inputs-unavailable) instead of inventing lives", async () => {
    const noRuntime: Canon = async (t) => ({ ...(await engineCanon(t)) as CanonicalSpec, runtime: null });
    const { migrationDefaultManifests } = await import("./defaults");
    const runtime = { ...rt(noRuntime), defaultManifests: migrationDefaultManifests({ engine: { gitCommit: "e".repeat(40) }, runtimeOf: () => null }) };
    const f = newFactory();
    expect(await migrateLegacyDraft(await openDb(f), runtime)).toMatchObject({ status: "refused", reason: "inputs-unavailable" });
    expect(await state(f)).toEqual({ records: [], flag: undefined, active: undefined });
  });
});
