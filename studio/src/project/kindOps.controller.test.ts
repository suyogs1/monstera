// Kind rename and delete through the real ProjectController (Session, DraftStore, shared history, ProjectStore on
// fake-indexeddb, a fake engine). The project is the real Pumpkin Blaster spec with manifests that reference its kinds.
import { describe, expect, it } from "vitest";
import { drain, harness, type Harness } from "../app/session.testkit";
import { addKind } from "../draft/ops";
import { getAt } from "../draft/path";
import { STORE_PROJECTS } from "./idb";
import type { ProjectRecord } from "./record";
import { sameValue } from "./record";
import { memoryMarker, newFactory, rawAll } from "./testkit";
import { buildXrefIndex } from "./xref";
import { xrefManifests } from "./xref.testkit";
async function boot(factory = newFactory()): Promise<{ h: Harness; factory: IDBFactory }> {
  const h = harness({ marker: memoryMarker(), factory });
  await h.session.start();
  await drain(h);
  const c = h.session.project.actions;
  const fx = xrefManifests();
  for (const n of ["assets", "animations", "levels", "gameplay"] as const) expect(c.commitManifest(n, fx[n] as never)).toMatchObject({ ok: true });
  await drain(h);
  return { h, factory };
}
const doc = (h: Harness) => h.session.store.getState().doc;
const manifests = (h: Harness) => h.session.project.getState().manifests;
const spawnerKinds = (h: Harness): unknown[] => (getAt(doc(h), ["game", "runtime", "spawners"]) as { kind: string }[]).map((s) => s.kind);
const snap = (h: Harness) => ({ doc: doc(h), manifests: manifests(h) });
const same = (a: ReturnType<typeof snap>, b: ReturnType<typeof snap>): boolean => sameValue(a.doc, b.doc) && sameValue(a.manifests, b.manifests);
describe("project-wide kind rename through the controller", () => {
  it("rewrites spec and every manifest as one change, validates, and is persisted", async () => {
    const { h, factory } = await boot();
    const c = h.session.project.actions;
    const r = c.renameKind("star", "gem");
    expect(r).toMatchObject({ ok: true, changed: true, updated: { spec: 1, total: 5 } });
    expect(spawnerKinds(h)).toContain("gem");
    expect(spawnerKinds(h)).not.toContain("star");
    const m = manifests(h);
    expect(getAt(m as never, ["animations", "animations", 0, "kindRef"])).toBe("gem");
    expect(c.xrefIndex().referencesToKind("star")).toEqual([]);
    expect(c.xrefIndex().referencesToKind("gem")).toHaveLength(5);
    await drain(h);
    expect(h.session.project.getState().status).toBe("saved");
    const [rec] = (await rawAll(factory, STORE_PROJECTS)) as ProjectRecord[];
    expect(rec?.specText).toContain('"gem"');
    expect(rec?.specText).not.toContain('"star"');
    const texts = Object.values(rec?.manifests ?? {}).join("");
    expect(texts).not.toContain('"star"');
    expect(texts).toContain('"gem"');
  });
  it("is one history entry: a single undo restores spec and manifests, a single redo reapplies both", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const before = snap(h);
    c.renameKind("star", "gem");
    const after = snap(h);
    expect(same(before, after)).toBe(false);
    expect(c.undo()).toBe(true);
    expect(same(snap(h), before)).toBe(true);
    expect(c.xrefIndex().referencesToKind("star")).toHaveLength(5);
    expect(c.redo()).toBe(true);
    expect(same(snap(h), after)).toBe(true);
    expect(c.xrefIndex().referencesToKind("gem")).toHaveLength(5);
    expect(c.undo()).toBe(true);
    expect(same(snap(h), before)).toBe(true);
    await drain(h);
    expect(h.session.project.getState().status).toBe("saved");
  });
  it("two renames in a row are two undo steps (they do not coalesce)", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const start = snap(h);
    c.renameKind("star", "gem");
    const mid = snap(h);
    c.renameKind("gem", "jewel");
    c.undo();
    expect(same(snap(h), mid)).toBe(true);
    c.undo();
    expect(same(snap(h), start)).toBe(true);
  });
  it("is atomic: a manifest that would become invalid refuses the whole rename and changes nothing", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const m = manifests(h);
    if (!m) throw new Error("no manifests");
    // an existing (dangling) collectible already pairs the collector with the id "gem": renaming star to gem would duplicate that pair
    expect(c.commitManifest("gameplay", { ...m.gameplay, collectibles: [...m.gameplay.collectibles, { id: "gem-pickup", kind: "gem", collectorKind: "player", points: 5, despawn: true }] })).toMatchObject({ ok: true });
    await drain(h);
    const before = snap(h), revision = h.session.store.getState().revision, depth = h.session.project.getState();
    const r = c.renameKind("star", "gem");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/gameplay manifest invalid/);
    expect(snap(h).doc).toBe(before.doc);
    expect(snap(h).manifests).toBe(before.manifests);
    expect(h.session.store.getState().revision).toBe(revision);
    expect(h.session.project.getState()).toMatchObject({ canUndo: depth.canUndo, canRedo: depth.canRedo, dirty: depth.dirty });
    expect(c.undo()).toBe(true); // the one entry that exists is the gameplay commit, not a half-done rename
    expect(getAt(manifests(h) as never, ["gameplay", "collectibles", 1, "id"])).toBeUndefined();
    expect(spawnerKinds(h)).toContain("star");
  });
  it("refuses unknown, taken and empty ids and leaves history alone", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const before = snap(h);
    for (const [a, b] of [["ghost", "x"], ["star", "bat"], ["star", ""]] as const) expect(c.renameKind(a, b).ok).toBe(false);
    expect(c.renameKind("star", "star")).toMatchObject({ ok: true, changed: false });
    expect(snap(h).doc).toBe(before.doc);
    expect(snap(h).manifests).toBe(before.manifests);
  });
});
describe("project-wide kind delete through the controller", () => {
  it("is blocked while any manifest refers to the kind and lists module and path", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const before = snap(h);
    const r = c.removeKind("star");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.references.map((e) => `${e.module} ${e.pathText}`)).toEqual([
      "designer $.game.runtime.spawners[3].kind", "assets assets:$.assets[0].kindRefs[0]", "sprites animations:$.animations[0].kindRef",
      "levels levels:$.levels[0].waves[0].kind", "gameplay gameplay:$.collectibles[0].kind",
    ]);
    expect(snap(h).doc).toBe(before.doc);
    expect(snap(h).manifests).toBe(before.manifests);
  });
  it("is blocked by a manifest link alone, then allowed once the link is removed (and undoable)", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const added = addKind(doc(h) as never);
    h.session.store.replace(added.doc);
    const m = manifests(h);
    if (!m) throw new Error("no manifests");
    const withLink = { ...m.assets, assets: m.assets.assets.map((a, i) => (i === 0 ? { ...a, kindRefs: [added.id, ...a.kindRefs].sort() } : a)) };
    expect(c.commitManifest("assets", withLink)).toMatchObject({ ok: true });
    const blocked = c.removeKind(added.id);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.references.map((e) => e.pathText)).toEqual([expect.stringMatching(/^assets:\$\.assets\[0\]\.kindRefs\[\d\]$/)]);
    expect(c.commitManifest("assets", m.assets)).toMatchObject({ ok: true });
    const before = snap(h);
    expect(c.removeKind(added.id)).toEqual({ ok: true });
    expect((getAt(doc(h), ["game", "runtime", "kinds"]) as { id: string }[]).map((k) => k.id)).not.toContain(added.id);
    expect(c.undo()).toBe(true);
    expect(same(snap(h), before)).toBe(true);
    expect((getAt(doc(h), ["game", "runtime", "kinds"]) as { id: string }[]).map((k) => k.id)).toContain(added.id);
    await drain(h);
  });
});
describe("controller cross-reference and validation views", () => {
  it("the index follows edits and undo; validateProject reports a dangling manifest reference with its module and path", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const first = c.xrefIndex();
    expect(c.xrefIndex()).toBe(first); // cached while nothing changed
    const m = manifests(h);
    if (!m) throw new Error("no manifests");
    c.commitManifest("animations", { ...m.animations, animations: m.animations.animations.map((a) => ({ ...a, kindRef: "ghost" })) });
    expect(c.xrefIndex()).not.toBe(first);
    await drain(h);
    const v = c.validateProject();
    expect(v.issues.filter((i) => i.source === "xref").map((i) => [i.module, i.pathText])).toEqual([["sprites", "animations:$.animations[0].kindRef"]]);
    c.undo();
    expect(c.validateProject().issues.filter((i) => i.source === "xref")).toEqual([]);
  });
});
/** Number of undo steps available (walks to the bottom and back, leaving the project as it was). */
const undoDepth = (h: Harness): number => {
  const c = h.session.project.actions;
  let n = 0;
  while (c.undo()) n++;
  for (let i = 0; i < n; i++) c.redo();
  return n;
};
describe("the new kind id is validated by the controller, not the UI", () => {
  it.each(["Gem", "GEM", "gem_1", "gem!", "gem id", "1gem", "-gem", "a".repeat(33), "a".repeat(64)])("rejects %j and leaves spec, manifests, revision and history unchanged", async (bad) => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const before = snap(h), revision = h.session.store.getState().revision, depth = undoDepth(h);
    const view = h.session.project.getState();
    const r = c.renameKind("star", bad); // star is referenced by the spec and by every manifest that can refer to a kind
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("is not a valid kind id");
    expect(snap(h).doc).toBe(before.doc);
    expect(snap(h).manifests).toBe(before.manifests);
    expect(h.session.store.getState().revision).toBe(revision);
    expect(undoDepth(h)).toBe(depth);
    expect(h.session.project.getState()).toMatchObject({ canUndo: view.canUndo, canRedo: view.canRedo, dirty: view.dirty });
    expect(c.xrefIndex().referencesToKind("star")).toHaveLength(5);
  });
  it("still accepts a valid id of the maximum length, and keeps unknown-source, duplicate and no-op behaviour", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    expect(c.renameKind("ghost", "Bad Id")).toEqual({ ok: false, reason: "no kind 'ghost'" });
    expect(c.renameKind("star", "bat")).toEqual({ ok: false, reason: "'bat' is already a kind id" });
    expect(c.renameKind("star", "star")).toMatchObject({ ok: true, changed: false });
    expect(c.renameKind("star", "a" + "b".repeat(31))).toMatchObject({ ok: true, changed: true });
  });
});
describe("controller cache freshness for spec edits and project replacement", () => {
  const fresh = (h: Harness) => {
    const c = h.session.project.actions;
    const d = doc(h), m = manifests(h);
    const index = c.xrefIndex();
    return { current: index.isCurrent(d, m), sameAsFreshBuild: JSON.stringify(index.entries) === JSON.stringify(buildXrefIndex(d, m).entries), index };
  };
  it("a direct spec edit (DraftStore.set) rebuilds the index", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const first = c.xrefIndex();
    expect(first.referencesToKind("ember").map((e) => e.type)).toEqual(["spec.collision.a", "spec.spawner.kind"]);
    h.session.store.set(["game", "runtime", "spawners", 2, "kind"], "star"); // spawner 3 used ember
    const after = fresh(h);
    expect(after.current && after.sameAsFreshBuild).toBe(true);
    expect(after.index).not.toBe(first);
    expect(after.index.referencesToKind("ember").map((e) => e.type)).toEqual(["spec.collision.a"]);
    expect(after.index.referencesToKind("star").some((e) => e.pathText === "$.game.runtime.spawners[2].kind")).toBe(true);
    expect(first.referencesToKind("ember")).toHaveLength(2); // the earlier index is not altered
    c.undo(); // undoing the spec edit
    const undone = fresh(h);
    expect(undone.current && undone.sameAsFreshBuild).toBe(true);
    expect(undone.index.referencesToKind("ember")).toHaveLength(2);
  });
  it("project replacement (reset, template load) never serves the previous project's index", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    const before = fresh(h);
    expect(before.index.entries.some((e) => e.manifest === "levels")).toBe(true);
    await h.session.reset();
    await drain(h);
    const afterReset = fresh(h);
    expect(afterReset.current && afterReset.sameAsFreshBuild).toBe(true);
    expect(afterReset.index).not.toBe(before.index);
    await h.session.loadTemplate("pumpkin-blaster"); // a new project with default manifests: no manifest holds references
    await drain(h);
    const afterLoad = fresh(h);
    expect(afterLoad.current && afterLoad.sameAsFreshBuild).toBe(true);
    expect(afterLoad.index).not.toBe(afterReset.index);
    expect(afterLoad.index.entries.every((e) => e.manifest === "spec" || e.manifest === "gameplay" || e.manifest === "project")).toBe(true);
    expect(c.xrefIndex()).toBe(afterLoad.index);
  });
});