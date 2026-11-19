// Task 1.7: a refused credential never enters manifests, history, IndexedDB or an export.
import { describe, expect, it } from "vitest";
import { png } from "../assets/fixtures.testkit";
import { drain, harness, type Harness } from "../app/session.testkit";
import { SECRET_SAMPLES } from "../integrations/secrets.testkit";
import { findSecrets } from "../integrations/secrets";
import { exportBundle } from "../export/bundle";
import { DraftStore } from "../draft/store";
import { STORE_BLOBS, STORE_META, STORE_PROJECTS } from "./idb";
import { memoryMarker, newFactory, pumpkinText, rawAll } from "./testkit";
import { xrefManifests } from "./xref.testkit";
async function boot(): Promise<{ h: Harness; factory: IDBFactory }> {
  const factory = newFactory();
  const h = harness({ marker: memoryMarker(), factory });
  await h.session.start();
  await drain(h);
  const fx = xrefManifests();
  for (const n of ["assets", "animations", "levels", "gameplay"] as const) expect(h.session.project.actions.commitManifest(n, fx[n] as never)).toMatchObject({ ok: true });
  await drain(h);
  return { h, factory };
}
const stored = async (f: IDBFactory): Promise<string> =>
  JSON.stringify([await rawAll(f, STORE_PROJECTS), await rawAll(f, STORE_META), (await rawAll(f, STORE_BLOBS)).map((b) => (b as { assetId: string }).assetId)]);
describe("field secret guard through the controller", () => {
  for (const [rule, sample] of Object.entries(SECRET_SAMPLES)) {
    it(`refuses ${rule} in a manifest string: state, history, storage and export stay clean`, async () => {
      const { h, factory } = await boot();
      const c = h.session.project.actions;
      const before = h.session.project.getState().manifests!;
      const bad = structuredClone(before.levels);
      bad.levels[0]!.name = sample;
      const r = c.commitManifest("levels", bad);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.message).toContain(rule); expect(r.message).not.toContain(sample); }
      expect(h.session.project.getState().manifests).toBe(before);
      await drain(h);
      expect(await stored(factory)).not.toContain(sample);
      const state = h.session.project.getState();
      const bytes = exportBundle({ specText: pumpkinText, manifests: state.manifests!, assets: new Map(state.manifests!.assets.assets.map((a) => [a.id, png(8, 8)])) });
      expect(new TextDecoder("latin1").decode(bytes)).not.toContain(sample);
      expect(findSecrets(state.manifests)).toEqual([]);
      // no stuck state: a clean commit afterwards still works
      const ok = structuredClone(before.levels);
      ok.levels[0]!.name = "Renamed";
      expect(c.commitManifest("levels", ok)).toMatchObject({ ok: true, changed: true });
    });
  }
  it("refuses a secret in a project name for rename and duplicate", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const key = h.session.project.getState().projectKey!;
    for (const sample of Object.values(SECRET_SAMPLES)) {
      expect(await c.renameProject(key, sample)).toMatchObject({ ok: false });
      expect(await c.duplicateProject(key, sample)).toMatchObject({ ok: false });
    }
    expect(await c.renameProject(key, "Clean name")).toMatchObject({ ok: true });
  });
  it("refuses an import whose provenance holds a secret, with no manifest change and no stored bytes", async () => {
    const { h, factory } = await boot();
    const c = h.session.project.actions;
    const before = h.session.project.getState().manifests!;
        const r = await c.importAsset({
      fileName: "a.png", bytes: png(32, 16), category: "sprite",
      provenance: { origin: "user-owned", author: "me", license: "proprietary-owned", source: "", tool: "", model: "", promptSha256: "", acquiredOn: "", notes: SECRET_SAMPLES["github-token"]!, },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("credential");
    expect(h.session.project.getState().manifests).toBe(before);
    await drain(h);
    expect(await rawAll(factory, STORE_BLOBS)).toEqual([]);
  });
});
describe("field secret guard on spec edits", () => {
  const store = (): DraftStore => {
    const s = new DraftStore();
    s.replace({ project: { name: "x" } });
    return s;
  };
  it("refuses a secret in set(): state, revision and listeners untouched", () => {
    for (const [rule, sample] of Object.entries(SECRET_SAMPLES)) {
      const s = store();
      const before = s.getState();
      let calls = 0;
      s.subscribe(() => { calls++; });
      expect(s.set(["project", "name"], sample), rule).toBe(false);
      expect(s.getState()).toBe(before);
      expect(calls).toBe(0);
    }
  });
  it("applies a clean set() and returns true", () => {
    const s = store();
    expect(s.set(["project", "name"], "y")).toBe(true);
    expect(s.getState().doc).toEqual({ project: { name: "y" } });
  });
});