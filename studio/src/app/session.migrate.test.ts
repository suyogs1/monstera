// Spec v4 -> v5 migration of existing Studio content (Gate E1). Starts from the real v4 Pumpkin Blaster spec as committed at the
// pre-E1 main (fixtures/pumpkin-blaster.v4.spec.json, SHA-256 08c7a90d...), never from a fixture already turned into v5.
// The fake engine stands in for the v5 engine: it reports any v4 document as parsed but invalid, as `must be 5` does.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { png } from "../assets/fixtures.testkit";
import { exportBundle, importBundle } from "../export/bundle";
import { STORE_BLOBS, STORE_PROJECTS } from "../project/idb";
import { LEGACY_KEY } from "../project/migrate";
import type { ManifestMap, Provenance } from "../project/manifests";
import { sha256Hex, stableText, type ProjectRecord, type ProjectSnapshot } from "../project/record";
import { NEUTRAL_ATLAS, migrateV4Doc } from "../project/specV5";
import { ProjectStore } from "../project/store";
import { instrumentedOpen, manifestsFor, memoryMarker, newFactory, pumpkinText, rawAll, readOnlyStorage } from "../project/testkit";
import type { Json } from "../schema/schema";
import { drain, FakeEngine, harness, type Harness } from "./session.testkit";
import { MIGRATION_NOTICE, type SessionDeps } from "./session";

const V4 = readFileSync(join(__dirname, "..", "project", "fixtures", "pumpkin-blaster.v4.spec.json"), "utf8");
const prov: Provenance = { origin: "user-owned", author: "me", license: "proprietary-owned", source: "", tool: "", model: "", promptSha256: "", acquiredOn: "", notes: "" };
type Doc = { specVersion: number; game: { atlas?: unknown; runtime: { lives: number; kinds: { id: string; sprite?: unknown }[] } } };
const parse = (t: string): Doc => JSON.parse(t) as Doc;
/** The v5 engine: a v4 document parses but fails validation (specVersion must be 5). */
const v5Engine = (): FakeEngine => { const e = new FakeEngine(); e.invalid = (t) => /"specVersion":\s*4\b/.test(t); return e; };
async function boot(deps: Omit<SessionDeps, "engine" | "schedule">, engine = v5Engine()): Promise<Harness> {
  const h = harness({ marker: memoryMarker(), ...deps }, engine);
  await h.session.start();
  await drain(h);
  return h;
}
const records = async (f: IDBFactory): Promise<ProjectRecord[]> => (await rawAll(f, STORE_PROJECTS)) as ProjectRecord[];
const projectManifest = (r: ProjectRecord) => JSON.parse(r.manifests.project) as ManifestMap["project"];

/** A project a pre-E1 Studio stored: v4 spec, a v4 baseline from the template, and one asset with its bytes. */
async function storedV4(factory: IDBFactory, key = "old-project"): Promise<{ sha: string; asset: Uint8Array; assetId: string }> {
  const sha = await sha256Hex(V4);
  const manifests = manifestsFor("pumpkin-blaster");
  manifests.project = { ...manifests.project, spec: { ...manifests.project.spec, baseSha256: sha, currentSha256: sha } };
  const snap: ProjectSnapshot = {
    projectKey: key, name: "My old game", projectId: "pumpkin-blaster", specText: V4, manifests,
    baseline: { label: "pumpkin-blaster", templateId: "pumpkin-blaster", group: "official", canonicalText: V4, sha256: sha,
      origin: { templateId: "pumpkin-blaster", path: "apps/pumpkin-blaster/monstera.spec.json", basis: "template", canonicalText: V4 } },
  };
  const ps = new ProjectStore({ factory });
  await ps.open();
  expect(await ps.save(snap)).toBe("saved");
  const assetId = manifests.assets.assets[0]!.id;
  const asset = png(16, 16);
  expect(await ps.putBlob(key, assetId, asset)).toEqual({ ok: true, persisted: true });
  return { sha, asset, assetId };
}

describe("migrateV4Doc (pure)", () => {
  it("the real v4 spec becomes the shipped v5 spec with neutral atlas and sprites, every other value kept", () => {
    const migrated = migrateV4Doc(JSON.parse(V4) as Json);
    if (!migrated.ok) throw new Error(migrated.reason);
    // The shipped v5 Pumpkin Blaster is this v4 spec plus neutral fields plus its art: undo the art and they must be equal.
    const v5 = parse(pumpkinText);
    v5.game.atlas = { ...NEUTRAL_ATLAS };
    for (const k of v5.game.runtime.kinds) k.sprite = { frames: [], ticksPerFrame: 1 };
    expect(stableText(migrated.doc)).toBe(stableText(v5 as unknown as Json));
    expect(V4).toBe(readFileSync(join(__dirname, "..", "project", "fixtures", "pumpkin-blaster.v4.spec.json"), "utf8")); // input untouched
  });
  it("never guesses: other versions, v5 documents and v4 documents that already carry v5 fields are not migrated", () => {
    const d = JSON.parse(V4) as Doc;
    for (const v of [3, 5, 6, "4"]) expect(migrateV4Doc({ ...d, specVersion: v } as unknown as Json)).toEqual({ ok: false, reason: "not-v4" });
    expect(migrateV4Doc(JSON.parse(pumpkinText) as Json)).toEqual({ ok: false, reason: "not-v4" });
    expect(migrateV4Doc({ ...d, game: { ...d.game, atlas: {} } } as unknown as Json)).toEqual({ ok: false, reason: "shape" });
    expect(migrateV4Doc({ specVersion: 4 } as Json)).toEqual({ ok: false, reason: "shape" });
  });
});

describe("existing IndexedDB projects", () => {
  it("a stored v4 project is upgraded in place: same key, name, assets and manifests; hashes, baseline and origin follow the spec", async () => {
    const factory = newFactory();
    const { sha: oldSha, asset, assetId } = await storedV4(factory);
    const before = (await records(factory)).find((r) => r.projectKey === "old-project")!;
    const b = await boot({ factory });
    expect(b.session.migrationNotice).toBe(MIGRATION_NOTICE);
    const s = b.session.project.getState();
    expect([s.projectKey, s.name, s.status]).toEqual(["old-project", "My old game", "saved"]);
    const after = (await records(factory)).find((r) => r.projectKey === "old-project")!;
    expect(parse(after.specText).specVersion).toBe(5);
    expect(parse(after.specText).game.atlas).toEqual(NEUTRAL_ATLAS);
    const newSha = await sha256Hex(after.specText);
    expect(newSha).not.toBe(oldSha);
    expect(projectManifest(after).spec).toEqual({ path: "monstera.spec.json", baseSha256: newSha, currentSha256: newSha });
    // Every other manifest is byte-identical; the asset bytes are untouched.
    for (const n of Object.keys(before.manifests) as (keyof ProjectRecord["manifests"])[]) if (n !== "project") expect(after.manifests[n], n).toBe(before.manifests[n]);
    expect(await b.session.project.assetBytes(assetId)).toEqual(asset);
    const blobs = (await rawAll(factory, STORE_BLOBS)) as { projectKey: string; assetId: string; bytes: ArrayBuffer }[];
    expect(new Uint8Array(blobs.find((x) => x.projectKey === "old-project" && x.assetId === assetId)!.bytes)).toEqual(asset);
    // Baseline and origin now hold v5 text; the origin is the current template, the basis unchanged.
    expect(parse(after.baseline.canonicalText!).specVersion).toBe(5);
    expect(after.baseline.sha256).toBe(await sha256Hex(after.baseline.canonicalText!));
    expect(after.baseline.origin).toMatchObject({ templateId: "pumpkin-blaster", basis: "template", canonicalText: pumpkinText });
    expect(b.session.store.getState().validation?.ok).toBe(true);
  });
  it("reopening is idempotent: no second migration, the record is unchanged", async () => {
    const factory = newFactory();
    await storedV4(factory);
    await boot({ factory });
    const once = JSON.stringify(await records(factory));
    const c = await boot({ factory });
    expect(c.session.migrationNotice).toBeNull();
    expect(JSON.stringify(await records(factory))).toBe(once);
    expect(c.session.project.getState().projectKey).toBe("old-project");
  });
  it("an existing v5 project is opened unchanged and without a notice", async () => {
    const factory = newFactory();
    await boot({ factory });
    const before = JSON.stringify(await records(factory));
    const again = await boot({ factory });
    expect(again.session.migrationNotice).toBeNull();
    expect(JSON.stringify(await records(factory))).toBe(before);
  });
  it("a storage failure leaves the stored v4 record untouched and the upgraded project in memory, exportable", async () => {
    const factory = newFactory();
    await storedV4(factory);
    const before = JSON.stringify(await records(factory));
    const b = await boot({ factory, projectDeps: { openConnection: instrumentedOpen({
      onCall: (store, method, mode) => { if (store === STORE_PROJECTS && method === "get" && mode === "readwrite") throw new DOMException("quota", "QuotaExceededError"); },
    }) } });
    expect(b.session.project.getState().status).toBe("failed");
    expect(JSON.stringify(await records(factory))).toBe(before); // nothing partial was written
    const recovery = JSON.parse(b.session.project.actions.exportRecovery() ?? "null") as { specText: string };
    expect(parse(recovery.specText).specVersion).toBe(5);
  });
  it("a v4 project whose v5 form the engine refuses is left exactly as stored and opens as before", async () => {
    const factory = newFactory();
    await storedV4(factory);
    const before = JSON.stringify(await records(factory));
    const engine = v5Engine();
    engine.invalid = () => true; // even the v5 form is refused
    const b = await boot({ factory }, engine);
    expect(b.session.migrationNotice).toBeNull();
    expect(JSON.stringify(await records(factory))).toBe(before);
    expect(parse(JSON.stringify(b.session.store.getState().doc)).specVersion).toBe(4);
  });
});

describe("imports", () => {
  it("a direct v4 spec import opens as a v5 project with a v5 baseline", async () => {
    const h = await boot({ factory: newFactory() });
    const r = await h.session.importText(V4, "old.json");
    expect(r).toEqual({ ok: true, migratedFrom: 4 });
    await drain(h);
    const s = h.session.store.getState();
    expect(parse(JSON.stringify(s.doc)).specVersion).toBe(5);
    expect(parse(s.baseline!.canonicalText!).specVersion).toBe(5);
    expect(s.validation?.ok).toBe(true);
    expect(h.session.migrationNotice).toBe(MIGRATION_NOTICE);
  });
  it("a v4 import whose v5 form is invalid is refused and the open project is unchanged", async () => {
    const h = await boot({ factory: newFactory() });
    const key = h.session.project.getState().projectKey;
    const bad = JSON.parse(V4) as Doc;
    bad.game.runtime.lives = 0;
    const engine = h.engine;
    engine.invalid = (t) => /"specVersion":\s*4\b/.test(t) || /"lives":\s*0\b/.test(t);
    const r = await h.session.importText(JSON.stringify(bad), "bad.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/specification v4 file.*not migrated/);
    expect(h.session.project.getState().projectKey).toBe(key);
  });
  it("versions other than 4 are not guessed: a v3 file is imported as written and stays v3", async () => {
    const h = await boot({ factory: newFactory() });
    const v3 = { ...(JSON.parse(V4) as Doc), specVersion: 3 };
    const r = await h.session.importText(JSON.stringify(v3), "v3.json");
    expect(r).toEqual({ ok: true });
    expect(parse(JSON.stringify(h.session.store.getState().doc)).specVersion).toBe(3);
    expect(h.session.migrationNotice).toBeNull();
  });
  it("a v4 bundle passes the bundle checks as written, then opens as v5 with byte-identical assets and rebound hashes", async () => {
    const h = await boot({ factory: newFactory() });
    const asset = png(32, 32);
    expect(await h.session.project.actions.importAsset({ fileName: "hero.png", bytes: asset, category: "sprite", provenance: prov })).toMatchObject({ ok: true });
    await drain(h);
    const state = h.session.project.currentState()!;
    // The same project as a pre-E1 Studio would have exported it: v4 spec, project manifest bound to the v4 hash.
    const oldSha = await sha256Hex(V4);
    const manifests = { ...state.manifests, project: { ...state.manifests.project, spec: { ...state.manifests.project.spec, baseSha256: oldSha, currentSha256: oldSha } } };
    const id = manifests.assets.assets[0]!.id;
    const bytes = exportBundle({ specText: V4, manifests, assets: new Map([[id, asset]]) });
    expect((await importBundle(bytes)).ok).toBe(true); // the integrity checks accept the bundle exactly as written
    const r = await h.session.importBundleBytes(bytes, "old-bundle.zip");
    expect(r).toEqual({ ok: true, migratedFrom: 4 });
    await drain(h);
    const s = h.session.project.getState();
    expect(await h.session.project.assetBytes(id)).toEqual(asset);
    const doc = h.session.store.getState();
    expect(parse(JSON.stringify(doc.doc)).specVersion).toBe(5);
    const newSha = doc.validation!.sha256!;
    expect(s.manifests!.project.spec).toEqual({ path: "monstera.spec.json", baseSha256: newSha, currentSha256: newSha });
    expect(s.manifests!.assets).toEqual(manifests.assets);
  });
});

describe("legacy localStorage draft", () => {
  it("a v4 legacy draft becomes a stored v5 project; the legacy key is never written", async () => {
    const factory = newFactory();
    const raw = JSON.stringify({ version: 1, docText: JSON.stringify(JSON.parse(V4)),
      baseline: { label: "pumpkin-blaster", templateId: "pumpkin-blaster", group: "official", canonicalText: V4, sha256: await sha256Hex(V4) } });
    const legacy = readOnlyStorage({ [LEGACY_KEY]: raw });
    const h = await boot({ factory, legacy });
    expect(h.session.projects.getState().migration?.status).toBe("migrated");
    const [rec] = await records(factory);
    expect(parse(rec!.specText).specVersion).toBe(5);
    expect(parse(rec!.baseline.canonicalText!).specVersion).toBe(5);
    expect(legacy.getItem(LEGACY_KEY)).toBe(raw);
    expect(legacy.writes).toEqual([]);
    expect(h.session.store.getState().validation?.ok).toBe(true);
  });
});
