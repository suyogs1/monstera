// Level actions through the real ProjectController (Session, DraftStore, shared history, ProjectStore on fake-indexeddb).
import { describe, expect, it } from "vitest";
import { drain, harness, type Harness } from "../app/session.testkit";
import { addLevel, duplicateLevel } from "../derive/levelOps";
import { STORE_PROJECTS } from "./idb";
import type { ProjectRecord } from "./record";
import { sameValue } from "./record";
import { memoryMarker, newFactory, rawAll } from "./testkit";
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
const manifests = (h: Harness) => h.session.project.getState().manifests!;
const levelIds = (h: Harness) => manifests(h).levels.levels.map((l) => l.id);

describe("level actions", () => {
  it("setLevels is one undo step, is persisted, and undo restores the manifest", async () => {
    const { h, factory } = await boot();
    const c = h.session.project.actions;
    const before = manifests(h);
    const next = addLevel(before.levels, "Third");
    if (!next.ok) throw new Error(next.reason);
    expect(c.setLevels(next.levels, "add")).toEqual({ ok: true, changed: true });
    expect(levelIds(h)).toEqual(["level-1", "level-2", "third"]);
    await drain(h);
    const [rec] = (await rawAll(factory, STORE_PROJECTS)) as ProjectRecord[];
    expect(JSON.stringify(rec?.manifests)).toContain("third");
    expect(c.undo()).toBe(true);
    expect(levelIds(h)).toEqual(["level-1", "level-2"]);
    expect(c.redo()).toBe(true);
    expect(levelIds(h)).toEqual(["level-1", "level-2", "third"]);
  });
  it("editing a level never touches the draft document", async () => {
    const { h } = await boot();
    const doc = h.session.store.getState().doc;
    const rev = h.session.store.getState().revision;
    const r = duplicateLevel(manifests(h).levels, "level-2");
    if (!r.ok) throw new Error(r.reason);
    h.session.project.actions.setLevels(r.levels);
    expect(h.session.store.getState().doc).toBe(doc);
    expect(h.session.store.getState().revision).toBe(rev);
  });
  it("a refused action leaves manifests and history untouched", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    expect(c.setLevelDerivation(true, "level-1")).toMatchObject({ ok: true });
    const m = manifests(h);
    const undoable = h.session.project.getState().canUndo;
    const r = c.removeLevel("level-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("project: active level");
    expect(c.setActiveLevel("ghost")).toMatchObject({ ok: false });
    expect(c.removeLevel("ghost")).toMatchObject({ ok: false });
    expect(manifests(h)).toBe(m);
    expect(h.session.project.getState().canUndo).toBe(undoable);
  });
  it("removes a level that is not active, as one undo step", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    c.setLevelDerivation(true, "level-1");
    const before = manifests(h);
    expect(c.removeLevel("level-2")).toEqual({ ok: true, changed: true });
    expect(levelIds(h)).toEqual(["level-1"]);
    expect(c.undo()).toBe(true);
    expect(sameValue(manifests(h), before)).toBe(true);
  });
  it("the active level needs derivation on, and the switch is an explicit separate action", async () => {
    const { h } = await boot();
    const c = h.session.project.actions;
    expect(c.setActiveLevel("level-2")).toMatchObject({ ok: false });
    expect(manifests(h).project.derivation).toMatchObject({ levels: false, activeLevel: "" });
    expect(c.setLevelDerivation(true, "level-2")).toMatchObject({ ok: true });
    expect(manifests(h).project.derivation).toMatchObject({ levels: true, activeLevel: "level-2" });
    expect(c.setActiveLevel("level-1")).toMatchObject({ ok: true });
    expect(manifests(h).project.derivation.activeLevel).toBe("level-1");
    expect(c.setLevelDerivation(false)).toMatchObject({ ok: true });
    expect(manifests(h).project.derivation).toMatchObject({ levels: false, activeLevel: "" });
  });
});
