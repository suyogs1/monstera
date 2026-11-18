// Task 2.3: assigning an asset to a kind through the real ProjectController. The reference index shows the link, the kind
// cannot be deleted while linked, and the kind card looks up the linked image (no preview substitution).
import { describe, expect, it } from "vitest";
import { linkedImage, planAssign } from "../assets/assign";
import { drain, harness, type Harness } from "../app/session.testkit";
import { memoryMarker, newFactory } from "./testkit";
import { xrefManifests } from "./xref.testkit";
async function boot(): Promise<Harness> {
  const h = harness({ marker: memoryMarker(), factory: newFactory() });
  await h.session.start();
  await drain(h);
  const fx = xrefManifests();
  for (const n of ["assets", "animations", "levels", "gameplay"] as const) expect(h.session.project.actions.commitManifest(n, fx[n] as never)).toMatchObject({ ok: true });
  await drain(h);
  return h;
}
const assets = (h: Harness) => { const a = h.session.project.getState().manifests?.assets; if (!a) throw new Error("no assets"); return a; };
const KINDS = ["bat", "bullet", "star", "gem"];
const assetRefs = (h: Harness, kind: string) => h.session.project.actions.xrefIndex().referencesToKind(kind).filter((r) => r.manifest === "assets");
describe("planAssign", () => {
  const m = xrefManifests().assets;
  it("stores a sorted list without duplicates and leaves other assets alone", () => {
    const r = planAssign(m, "asset-0001", ["star", "gem", "star"], KINDS);
    expect(r.ok && r.manifest.assets[0]?.kindRefs).toEqual(["gem", "star"]);
    expect(r.ok && r.manifest.assets[1]).toEqual(m.assets[1]);
    expect(r.ok && r.manifest.nextSeq).toBe(m.nextSeq);
  });
  it("refuses an unknown asset or an unknown kind and can clear the links", () => {
    expect(planAssign(m, "asset-9999", ["star"], KINDS)).toMatchObject({ ok: false });
    expect(planAssign(m, "asset-0001", ["nope"], KINDS)).toMatchObject({ ok: false, reason: expect.stringContaining("nope") });
    const cleared = planAssign(m, "asset-0002", [], KINDS);
    expect(cleared.ok && cleared.manifest.assets[1]?.kindRefs).toEqual([]);
  });
  it("linkedImage picks the first linked image and ignores audio", () => {
    const linked = planAssign(m, "asset-0001", ["star"], KINDS);
    if (!linked.ok) throw new Error("plan failed");
    expect(linkedImage(linked.manifest, "star")?.id).toBe("asset-0001");
    expect(linkedImage(m, "bat")).toBeNull(); // bat is linked to the audio asset only
    expect(linkedImage(undefined, "star")).toBeNull();
    expect(linkedImage(m, "")).toBeNull();
  });
});
describe("assign through the controller", () => {
  it("shows the link in the reference index, blocks deleting the kind, and allows it again after unlinking", async () => {
    const h = await boot();
    const c = h.session.project.actions;
    expect(assetRefs(h, "gem")).toEqual([]);
    const plan = planAssign(assets(h), "asset-0001", [...(assets(h).assets[0]?.kindRefs ?? []), "gem"], KINDS);
    if (!plan.ok) throw new Error(plan.reason);
    expect(c.commitManifest("assets", plan.manifest, "kinds-asset-0001")).toMatchObject({ ok: true });
    const refs = assetRefs(h, "gem");
    expect(refs).toHaveLength(1);
    expect(refs[0]?.label).toContain("asset-0001");
    const blocked = c.removeKind("gem");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.references.some((r) => r.manifest === "assets")).toBe(true);
    const unlink = planAssign(assets(h), "asset-0001", (assets(h).assets[0]?.kindRefs ?? []).filter((k) => k !== "gem"), KINDS);
    if (!unlink.ok) throw new Error(unlink.reason);
    expect(c.commitManifest("assets", unlink.manifest, "kinds-asset-0001")).toMatchObject({ ok: true });
    expect(assetRefs(h, "gem")).toEqual([]);
  });
  it("is one undo step", async () => {
    const h = await boot();
    const c = h.session.project.actions;
    const before = assets(h).assets[0]?.kindRefs;
    const plan = planAssign(assets(h), "asset-0001", ["gem"], KINDS);
    if (!plan.ok) throw new Error(plan.reason);
    c.commitManifest("assets", plan.manifest, "kinds-asset-0001");
    expect(assets(h).assets[0]?.kindRefs).toEqual(["gem"]);
    expect(c.undo()).toBe(true);
    expect(assets(h).assets[0]?.kindRefs).toEqual(before);
  });
});
