// Task 9.1 (A3): a project bundle exported from one Session imports into another as an identical project; refusals change nothing.
import { describe, expect, it } from "vitest";
import { png } from "../assets/fixtures.testkit";
import { exportBundle, importBundle } from "../export/bundle";
import { rawZip } from "../export/zip.testkit";
import { memoryMarker, newFactory } from "../project/testkit";
import type { Provenance } from "../project/manifests";
import { drain, harness, type Harness } from "./session.testkit";

const prov: Provenance = { origin: "user-owned", author: "me", license: "proprietary-owned", source: "", tool: "", model: "", promptSha256: "", acquiredOn: "", notes: "" };
async function boot(): Promise<Harness> {
  const h = harness({ marker: memoryMarker(), factory: newFactory() });
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
