// Asset import, delete and persistence through the real ProjectController (Session, DraftStore, shared history, ProjectStore on
// fake-indexeddb, a fake engine). Covers: secure import end to end (wrong extension, SVG, missing license, limits), ids that are
// never reused (also across delete and undo), delete protection from the cross-reference index, and byte persistence.
import { describe, expect, it } from "vitest";
import { jpeg, png, svg, txt, u8, wav } from "../assets/fixtures.testkit";
import type { ImportInput } from "../assets/import";
import { drain, harness, type Harness } from "../app/session.testkit";
import { STORE_BLOBS, STORE_PROJECTS } from "./idb";
import type { Provenance } from "./manifests";
import type { ProjectRecord } from "./record";
import { memoryMarker, newFactory, rawAll } from "./testkit";
import { xrefManifests } from "./xref.testkit";
const prov = (over: Partial<Provenance> = {}): Provenance => ({
  origin: "user-owned", author: "me", license: "proprietary-owned", source: "", tool: "", model: "", promptSha256: "", acquiredOn: "", notes: "", ...over,
});
const imp = (bytes: Uint8Array, over: Partial<ImportInput> = {}): ImportInput => ({ fileName: "a.png", bytes, category: "sprite", provenance: prov(), ...over });
async function boot(factory = newFactory(), seed = true): Promise<{ h: Harness; factory: IDBFactory }> {
  const h = harness({ marker: memoryMarker(), factory });
  await h.session.start();
  await drain(h);
  if (seed) {
    const fx = xrefManifests();
    for (const n of ["assets", "animations", "levels", "gameplay"] as const) expect(h.session.project.actions.commitManifest(n, fx[n] as never)).toMatchObject({ ok: true });
    await drain(h);
  }
  return { h, factory };
}
const assets = (h: Harness) => h.session.project.getState().manifests?.assets;
const blobs = async (f: IDBFactory) => (await rawAll(f, STORE_BLOBS)) as { projectKey: string; assetId: string; size: number; bytes: ArrayBuffer }[];
describe("importAsset through the controller", () => {
  it("stores the manifest entry and the bytes, reports saved, and returns the bytes from memory", async () => {
    const { h, factory } = await boot();
    const c = h.session.project.actions;
    const bytes = png(32, 16);
    const r = await c.importAsset(imp(bytes, { fileName: "hero.png", provenance: prov({ license: "CC0-1.0" }) }));
    expect(r).toMatchObject({ ok: true, id: "asset-0003", persisted: true });
    expect(assets(h)?.nextSeq).toBe(4);
    expect(assets(h)?.assets.find((a) => a.id === "asset-0003")).toMatchObject({ file: "hero.png", width: 32, height: 16, bytes: bytes.length, provenance: { license: "CC0-1.0" } });
    await drain(h);
    expect(h.session.project.getState().status).toBe("saved");
    const [rec] = (await rawAll(factory, STORE_PROJECTS)) as ProjectRecord[];
    expect(rec?.manifests.assets).toContain("asset-0003");
    const stored = await blobs(factory);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ assetId: "asset-0003", size: bytes.length });
    expect([...new Uint8Array(stored[0]?.bytes ?? new ArrayBuffer(0))]).toEqual([...bytes]);
    expect([...((await c.assetBytes("asset-0003")) ?? [])]).toEqual([...bytes]);
  });
  it("persists across a restart: a new session on the same storage reads the bytes back", async () => {
    const { h, factory } = await boot();
    const bytes = jpeg(8, 8);
    await h.session.project.actions.importAsset(imp(bytes, { fileName: "bg.jpg", category: "background" }));
    await drain(h);
    const { h: h2 } = await boot(factory, false);
    expect(assets(h2)?.assets.map((a) => a.id)).toContain("asset-0003");
    expect([...((await h2.session.project.actions.assetBytes("asset-0003")) ?? [])]).toEqual([...bytes]);
  });
  it("refuses a missing license: no manifest change, no stored bytes, no history entry", async () => {
    const { h, factory } = await boot();
    const c = h.session.project.actions;
    const before = JSON.stringify(assets(h));
    const r = await c.importAsset(imp(png(2, 2), { provenance: prov({ license: "" }) }));
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? "" : r.reason).toMatch(/license is required/i);
    expect(JSON.stringify(assets(h))).toBe(before);
    expect(await blobs(factory)).toEqual([]);
    expect(await c.assetBytes("asset-0003")).toBeNull();
  });
  it("wrong extension end to end: content decides type; an SVG or HTML payload named .png is refused", async () => {
    const { h, factory } = await boot();
    const c = h.session.project.actions;
    const ok = await c.importAsset(imp(jpeg(10, 6), { fileName: "photo.png", declaredMime: "image/png" }));
    expect(ok).toMatchObject({ ok: true });
    if (!ok.ok) return;
    expect(ok.notices[0]).toMatch(/\.png.*JPEG/);
    expect(assets(h)?.assets.find((a) => a.id === ok.id)).toMatchObject({ mime: "image/jpeg", file: "photo.jpg", width: 10, height: 6 });
    const before = JSON.stringify(assets(h));
    for (const bytes of [svg(), u8(txt("<!doctype html><script>alert(1)</script>")), u8(txt("MZ\x90\x00"))]) {
      expect(await c.importAsset(imp(bytes, { fileName: "safe.png", declaredMime: "image/png" }))).toMatchObject({ ok: false });
    }
    expect(JSON.stringify(assets(h))).toBe(before);
    expect(await blobs(factory)).toHaveLength(1);
  });
  it("refuses a category that does not match the content (audio named .png as a sprite)", async () => {
    const { h } = await boot();
    const r = await h.session.project.actions.importAsset(imp(wav(), { fileName: "evil.png", declaredMime: "image/png", category: "sprite" }));
    expect(r.ok).toBe(false);
    expect(assets(h)?.assets).toHaveLength(2);
  });
  it("serializes concurrent imports and gives each its own id", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const rs = await Promise.all([c.importAsset(imp(png(1, 1))), c.importAsset(imp(png(2, 2))), c.importAsset(imp(png(3, 3)))]);
    expect(rs.map((r) => (r.ok ? r.id : "x"))).toEqual(["asset-0003", "asset-0004", "asset-0005"]);
    expect(assets(h)?.nextSeq).toBe(6);
  });
});
describe("ids are never reused", () => {
  it("after a delete, after an undone import, and across redo", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const a = await c.importAsset(imp(png(1, 1)));
    expect(a).toMatchObject({ ok: true, id: "asset-0003" });
    expect(c.deleteAsset("asset-0003")).toEqual({ ok: true });
    expect(assets(h)?.nextSeq).toBe(4);
    const b = await c.importAsset(imp(png(2, 2)));
    expect(b).toMatchObject({ ok: true, id: "asset-0004" });
    expect(c.undo()).toBe(true); // undoes the second import
    expect(assets(h)?.assets.map((x) => x.id)).not.toContain("asset-0004");
    expect(assets(h)?.nextSeq).toBe(5); // lifted back: the undone import's id stays spent
    const d = await c.importAsset(imp(png(3, 3)));
    expect(d).toMatchObject({ ok: true, id: "asset-0005" });
  });
  it("keeps the bytes of an undone delete available", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const bytes = png(5, 5);
    await c.importAsset(imp(bytes));
    c.deleteAsset("asset-0003");
    expect(c.undo()).toBe(true);
    expect(assets(h)?.assets.map((x) => x.id)).toContain("asset-0003");
    expect([...((await c.assetBytes("asset-0003")) ?? [])]).toEqual([...bytes]);
  });
});
describe("deleteAsset protection", () => {
  it("refuses an asset an animation sheet uses, lists the reference, and changes nothing", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const before = JSON.stringify(assets(h));
    const r = c.deleteAsset("asset-0001");
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.references).toHaveLength(1);
    expect(r.references[0]).toMatchObject({ manifest: "animations", targetType: "asset", targetId: "asset-0001" });
    expect(r.reason).toContain("asset-0001");
    expect(JSON.stringify(assets(h))).toBe(before);
  });
  it("deletes an unreferenced asset, keeps nextSeq, and refuses an unknown id", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    expect(c.deleteAsset("asset-0002")).toEqual({ ok: true });
    expect(assets(h)?.assets.map((a) => a.id)).toEqual(["asset-0001"]);
    expect(assets(h)?.nextSeq).toBe(3);
    expect(c.deleteAsset("asset-0099")).toMatchObject({ ok: false });
  });
});
describe("orphaned bytes", () => {
  it("are pruned when a project is loaded; bytes of listed assets are kept", async () => {
    const { h, factory } = await boot();
    await h.session.project.actions.importAsset(imp(png(1, 1)));
    await h.session.project.actions.importAsset(imp(png(2, 2)));
    h.session.project.actions.deleteAsset("asset-0004");
    await drain(h);
    expect((await blobs(factory)).map((b) => b.assetId).sort()).toEqual(["asset-0003", "asset-0004"]);
    await boot(factory, false);
    await new Promise((r) => setTimeout(r, 20));
    expect((await blobs(factory)).map((b) => b.assetId)).toEqual(["asset-0003"]);
  });
});
