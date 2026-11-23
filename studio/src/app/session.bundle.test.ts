// Task 9.1 (A3): a project bundle exported from one Session imports into another as an identical project; refusals change nothing.
import { describe, expect, it, vi } from "vitest";
import { png } from "../assets/fixtures.testkit";
import { exportBundle, importBundle } from "../export/bundle";
import { rawZip } from "../export/zip.testkit";
import { STORE_BLOBS } from "../project/idb";
import { memoryMarker, newFactory, rawAll, readOnlyStorage } from "../project/testkit";
import type { Provenance } from "../project/manifests";
import { drain, harness, type Harness } from "./session.testkit";

const prov: Provenance = { origin: "user-owned", author: "me", license: "proprietary-owned", source: "", tool: "", model: "", promptSha256: "", acquiredOn: "", notes: "" };
async function boot(deps: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = harness({ marker: memoryMarker(), factory: newFactory(), ...deps });
  await h.session.start();
  await drain(h);
  return h;
}
const snapshot = (h: Harness) => ({ doc: JSON.stringify(h.session.store.getState().doc), manifests: JSON.stringify(h.session.project.getState().manifests), key: h.session.project.getState().projectKey });

describe("project bundle through the Session (A3)", () => {
  it("a bundle exported from one browser imports as an identical project, and re-exports byte for byte", async () => {
    const a = await boot();
    const added = await a.session.project.actions.importAsset({ fileName: "hero.png", bytes: png(32, 32), category: "sprite", provenance: prov });
    expect(added).toMatchObject({ ok: true });
    await drain(a);
    const out = await a.session.exportBundleBytes();
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const b = await boot();
    const before = snapshot(b);
    const r = await b.session.importBundleBytes(out.bytes, "pumpkin-bundle.zip");
    expect(r).toEqual({ ok: true });
    await drain(b);
    const after = snapshot(b);
    expect(after.key).not.toBe(before.key);
    expect(after.doc).toBe(snapshot(a).doc);
    expect(after.manifests).toBe(snapshot(a).manifests);
    const id = b.session.project.getState().manifests?.assets.assets[0]?.id ?? "";
    expect(await b.session.project.assetBytes(id)).toEqual(await a.session.project.assetBytes(id));
    const again = await b.session.exportBundleBytes();
    expect(again.ok && again.bytes).toEqual(out.bytes);
  });

  it("a hostile archive is refused and the open project is unchanged", async () => {
    const h = await boot();
    const before = snapshot(h);
    const r = await h.session.importBundleBytes(rawZip([{ name: "../x", plain: new Uint8Array([1]) }]), "evil.zip");
    expect(r.ok).toBe(false);
    expect(snapshot(h)).toEqual(before);
  });

  it("a bundle whose manifest holds a credential-looking string is refused and nothing is stored", async () => {
    const a = await boot();
    await a.session.project.actions.importAsset({ fileName: "hero.png", bytes: png(32, 32), category: "sprite", provenance: prov });
    await drain(a);
    const out = await a.session.exportBundleBytes();
    if (!out.ok) throw new Error(out.message);
    const parsed = await importBundle(out.bytes);
    if (!parsed.ok) throw new Error(parsed.message);
    const m = parsed.project.manifests;
    const tainted = { ...m, assets: { ...m.assets, assets: m.assets.assets.map((x) => ({ ...x, provenance: { ...x.provenance, notes: "AKIAIOSFODNN7EXAMPLE" } })) } };
    const bad = exportBundle({ ...parsed.project, manifests: tainted });
    const b = await boot();
    const before = snapshot(b);
    const r = await b.session.importBundleBytes(bad, "bad.zip");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("credential");
    expect(snapshot(b)).toEqual(before);
  });
});

describe("bundle import without IndexedDB (memory-only)", () => {
  const bundleWithAsset = async (): Promise<{ bytes: Uint8Array; id: string; asset: Uint8Array }> => {
    const a = await boot();
    const added = await a.session.project.actions.importAsset({ fileName: "hero.png", bytes: png(32, 32), category: "sprite", provenance: prov });
    expect(added).toMatchObject({ ok: true });
    await drain(a);
    const out = await a.session.exportBundleBytes();
    if (!out.ok) throw new Error(out.message);
    const id = a.session.project.getState().manifests?.assets.assets[0]?.id ?? "";
    return { bytes: out.bytes, id, asset: (await a.session.project.assetBytes(id)) ?? new Uint8Array() };
  };
  it("keeps the imported asset bytes for the session, reports memory-only, and re-exports the bundle byte for byte", async () => {
    const src = await bundleWithAsset();
    const b = await boot({ factory: null, legacy: readOnlyStorage({}) });
    expect(b.session.project.getState().status).toBe("memory-only");
    expect(await b.session.importBundleBytes(src.bytes, "pumpkin-bundle.zip")).toEqual({ ok: true });
    await drain(b);
    const s = b.session.project.getState();
    expect(s.status).toBe("memory-only"); // never claimed saved
    expect(s.detail.lastSavedAt).toBeNull();
    expect(s.manifests?.assets.assets.map((x) => x.id)).toEqual([src.id]);
    expect(await b.session.project.assetBytes(src.id)).toEqual(src.asset);
    const again = await b.session.exportBundleBytes();
    expect(again.ok && again.bytes).toEqual(src.bytes);
  });
  it("in IndexedDB mode the imported bytes are persisted: they are readable from storage, not only from the cache", async () => {
    const src = await bundleWithAsset();
    const b = await boot();
    expect(await b.session.importBundleBytes(src.bytes, "pumpkin-bundle.zip")).toEqual({ ok: true });
    await drain(b);
    const key = b.session.project.getState().projectKey ?? "";
    expect(await b.session.projects.getBlob(key, src.id)).toEqual(src.asset);
    const again = await b.session.exportBundleBytes();
    expect(again.ok && again.bytes).toEqual(src.bytes);
  });
  it("a second asset that cannot be stored undoes the first: no blob of the failed import stays, and the open project is unchanged", async () => {
    const a = await boot();
    for (const [name, w] of [["hero.png", 32], ["foe.png", 16]] as const) {
      expect(await a.session.project.actions.importAsset({ fileName: name, bytes: png(w, w), category: "sprite", provenance: prov })).toMatchObject({ ok: true });
    }
    await drain(a);
    const out = await a.session.exportBundleBytes();
    if (!out.ok) throw new Error(out.message);
    expect(a.session.project.getState().manifests?.assets.assets).toHaveLength(2);

    const factory = newFactory();
    const b = await boot({ factory });
    const before = snapshot(b);
    const blobKeys = async (): Promise<string[]> => ((await rawAll(factory, STORE_BLOBS)) as { projectKey: string; assetId: string }[]).map((r) => `${r.projectKey}/${r.assetId}`);
    expect(await blobKeys()).toEqual([]);

    // The real putBlob writes the first asset; the second one fails. pruneBlobs is NOT mocked: the real cleanup must run.
    const real = b.session.projects.putBlob.bind(b.session.projects);
    const keys = new Set<string>();
    let calls = 0;
    let firstWasStored = false;
    vi.spyOn(b.session.projects, "putBlob").mockImplementation(async (key, id, bytes) => {
      keys.add(key);
      if (++calls === 2) {
        firstWasStored = (await blobKeys()).length === 1; // the first asset really is in IndexedDB at this point
        return { ok: false, message: "the asset bytes could not be stored: quota" };
      }
      return real(key, id, bytes);
    });
    const r = await b.session.importBundleBytes(out.bytes, "two.zip");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Your project was not changed");
    expect(calls).toBe(2);
    expect(firstWasStored).toBe(true);
    expect(keys.size).toBe(1); // one generated project key for the whole attempt
    expect(await blobKeys()).toEqual([]); // nothing of the failed import remains under it, or anywhere
    expect(snapshot(b)).toEqual(before);
    await drain(b);
    expect(snapshot(b)).toEqual(before);
    expect(await blobKeys()).toEqual([]);
  });
});