// The project catalog on fake-indexeddb: list, rename, duplicate (with asset bytes), delete (with asset bytes and the active
// pointer), activate, and the rules around them (unreadable records are listed and removable, the open project is never
// deleted, a project opened after a switch keeps saving with the right compare-and-swap).
import { describe, expect, it } from "vitest";
import { checkProjectName, MAX_PROJECT_NAME, populatedModules, targetsOf } from "./catalog";
import { STORE_BLOBS, STORE_META, STORE_PROJECTS } from "./idb";
import { ProjectStore } from "./store";
import { edited, manifestsFor, newFactory, pumpkinText, rawAll, rawGet, rawPut, snapshot } from "./testkit";
import type { ProjectRecord } from "./record";

let n = 0;
const mk = (factory: IDBFactory): ProjectStore => new ProjectStore({ factory, now: () => 1000, randomId: () => `id${++n}` });
const bytes = (...v: number[]): Uint8Array => new Uint8Array(v);
async function twoProjects(): Promise<{ factory: IDBFactory; store: ProjectStore }> {
  const factory = newFactory();
  const store = mk(factory);
  await store.open();
  expect(await store.save({ ...snapshot("p1"), name: "Alpha" })).toBe("saved");
  expect(await store.save({ ...snapshot("p2"), name: "Beta" })).toBe("saved");
  return { factory, store };
}
const blobKeys = async (f: IDBFactory): Promise<string[]> => ((await rawAll(f, STORE_BLOBS)) as { projectKey: string; assetId: string }[]).map((b) => `${b.projectKey}/${b.assetId}`).sort();

describe("checkProjectName", () => {
  it("trims, and refuses empty, over-long and control characters", () => {
    expect(checkProjectName("  My game  ")).toEqual({ ok: true, name: "My game" });
    expect(checkProjectName("   ")).toMatchObject({ ok: false });
    expect(checkProjectName("x".repeat(MAX_PROJECT_NAME))).toMatchObject({ ok: true });
    expect(checkProjectName("x".repeat(MAX_PROJECT_NAME + 1))).toMatchObject({ ok: false });
    expect(checkProjectName("a\nb")).toMatchObject({ ok: false });
    expect(checkProjectName("a\u0000b")).toMatchObject({ ok: false });
  });
});

describe("facts read from a stored project", () => {
  it("lists the targets of the specification, and none for unreadable text", () => {
    expect(targetsOf(pumpkinText)).toEqual(expect.arrayContaining(["android", "ios"]));
    expect(targetsOf("not json")).toEqual([]);
    expect(targetsOf('{"project":{"targets":[1,"ios"]}}')).toEqual(["ios"]);
  });
  it("names exactly the modules whose manifests hold data", () => {
    const m = manifestsFor("pumpkin-blaster");
    const empty = {
      ...m,
      assets: { ...m.assets, assets: [] },
      animations: { ...m.animations, sheets: [], animations: [] },
      levels: { ...m.levels, levels: [] },
      gameplay: { ...m.gameplay, collectibles: [], enemies: [] },
      integrations: { ...m.integrations, backend: { ...m.integrations.backend, services: {} }, monetization: { ...m.integrations.monetization, placements: [] } },
      project: { ...m.project, derivation: { ...m.project.derivation, gameplay: false } },
    };
    expect(populatedModules(empty)).toEqual([]);
    expect(populatedModules({ ...empty, levels: m.levels }).map((p) => p.module)).toEqual(m.levels.levels.length > 0 ? ["levels"] : []);
    expect(populatedModules({ ...empty, assets: m.assets }).map((p) => p.module)).toEqual(m.assets.assets.length > 0 ? ["assets"] : []);
    const one = { ...empty, project: { ...empty.project, derivation: { ...empty.project.derivation, gameplay: true } } };
    expect(populatedModules(one)).toEqual([{ module: "gameplay", detail: "0 module rules" }]);
  });
});

describe("listProjects", () => {
  it("lists every stored project with id, hash, targets and the active key", async () => {
    const { store } = await twoProjects();
    const r = await store.listProjects();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.activeKey).toBe("p2");
    expect(r.entries.map((e) => (e.state === "ok" ? e.name : "?"))).toEqual(["Alpha", "Beta"]);
    const a = r.entries[0];
    expect(a).toMatchObject({ state: "ok", projectKey: "p1", projectId: "pumpkin-blaster", writeSeq: 1 });
    if (a?.state === "ok") { expect(a.specSha256).toMatch(/^[0-9a-f]{64}$/); expect(a.targets.length).toBeGreaterThan(0); }
  });
  it("lists an unreadable record with its key and the reason, and never repairs it", async () => {
    const { factory, store } = await twoProjects();
    await rawPut(factory, STORE_PROJECTS, { projectKey: "bad", name: "Broken", format: 1, specText: 5 });
    const r = await store.listProjects();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bad = r.entries.find((e) => e.projectKey === "bad");
    expect(bad).toMatchObject({ state: "unreadable", name: "Broken" });
    expect(bad?.state === "unreadable" && bad.message.length > 0).toBe(true);
    expect(await rawGet(factory, STORE_PROJECTS, "bad")).toEqual({ projectKey: "bad", name: "Broken", format: 1, specText: 5 });
    expect(await store.deleteStored("bad")).toEqual({ ok: true });
    expect(await rawGet(factory, STORE_PROJECTS, "bad")).toBeUndefined();
  });
  it("says why when storage is not available", async () => {
    const store = new ProjectStore({ factory: null });
    await store.open();
    expect(await store.listProjects()).toMatchObject({ ok: false });
  });
});

describe("renameStored", () => {
  it("changes only the name and bumps writeSeq", async () => {
    const { factory, store } = await twoProjects();
    expect(await store.renameStored("p1", "Alpha 2")).toEqual({ ok: true });
    const rec = (await rawGet(factory, STORE_PROJECTS, "p1")) as ProjectRecord;
    expect(rec).toMatchObject({ name: "Alpha 2", writeSeq: 2, specText: pumpkinText });
    expect(((await rawGet(factory, STORE_META, "activeProjectKey")) as { value: string }).value).toBe("p2");
  });
  it("refuses a project that is gone", async () => {
    const { store } = await twoProjects();
    expect(await store.renameStored("nope", "x")).toMatchObject({ ok: false });
  });
});

describe("duplicateStored", () => {
  it("copies the record unchanged under a new key, with its asset bytes, in one step", async () => {
    const { factory, store } = await twoProjects();
    expect(await store.putBlob("p1", "asset-0001", bytes(1, 2, 3))).toMatchObject({ ok: true });
    expect(await store.putBlob("p2", "asset-0001", bytes(9))).toMatchObject({ ok: true });
    const r = await store.duplicateStored("p1", "Alpha copy");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projectKey).not.toBe("p1");
    const copy = (await rawGet(factory, STORE_PROJECTS, r.projectKey)) as ProjectRecord;
    const orig = (await rawGet(factory, STORE_PROJECTS, "p1")) as ProjectRecord;
    expect(copy).toMatchObject({ name: "Alpha copy", writeSeq: 1, specText: orig.specText, specSha256: orig.specSha256, projectId: orig.projectId });
    expect(copy.manifests).toEqual(orig.manifests);
    expect(await blobKeys(factory)).toEqual(["p1/asset-0001", `${r.projectKey}/asset-0001`, "p2/asset-0001"].sort());
    expect([...((await store.getBlob(r.projectKey, "asset-0001")) ?? [])]).toEqual([1, 2, 3]);
    expect(((await rawGet(factory, STORE_META, "activeProjectKey")) as { value: string }).value).toBe("p2");
  });
  it("two copies get two different keys", async () => {
    const { store } = await twoProjects();
    const a = await store.duplicateStored("p1", "A");
    const b = await store.duplicateStored("p1", "B");
    expect(a.ok && b.ok && a.projectKey !== b.projectKey).toBe(true);
  });
  it("refuses an unreadable source and writes nothing", async () => {
    const { factory, store } = await twoProjects();
    await rawPut(factory, STORE_PROJECTS, { projectKey: "bad", name: "Broken" });
    const before = (await rawAll(factory, STORE_PROJECTS)).length;
    expect(await store.duplicateStored("bad", "x")).toMatchObject({ ok: false });
    expect((await rawAll(factory, STORE_PROJECTS)).length).toBe(before);
  });
});

describe("deleteStored", () => {
  it("removes the record and its asset bytes only, and the active pointer when it named the project", async () => {
    const { factory, store } = await twoProjects();
    await store.putBlob("p1", "asset-0001", bytes(1));
    await store.putBlob("p2", "asset-0001", bytes(2));
    expect(await store.activateProject("p1")).toMatchObject({ ok: true });
    expect(await store.activateProject("p2")).toMatchObject({ ok: true });
    expect(await store.deleteStored("p1")).toEqual({ ok: true });
    expect(await rawGet(factory, STORE_PROJECTS, "p1")).toBeUndefined();
    expect(await blobKeys(factory)).toEqual(["p2/asset-0001"]);
    expect(((await rawGet(factory, STORE_META, "activeProjectKey")) as { value: string }).value).toBe("p2");
  });
  it("refuses the project in memory and removes nothing", async () => {
    const { factory, store } = await twoProjects();
    const r = await store.deleteStored("p2");
    expect(r).toMatchObject({ ok: false });
    expect(await rawGet(factory, STORE_PROJECTS, "p2")).toBeDefined();
  });
  it("keeps the active pointer when another project is deleted", async () => {
    const { factory, store } = await twoProjects();
    await store.activateProject("p1");
    expect(await store.deleteStored("p2")).toEqual({ ok: true });
    expect(((await rawGet(factory, STORE_META, "activeProjectKey")) as { value: string }).value).toBe("p1");
    const other = mk(factory);
    await other.open();
    expect(other.getState().project?.projectKey).toBe("p1");
  });
});

describe("deleting the stored active project", () => {
  it("clears the active pointer in the same transaction (a record is never left pointing at nothing)", async () => {
    const { factory, store } = await twoProjects();
    const other = mk(factory);
    await other.open();
    await other.activateProject("p1"); // storage now says p1 is active; `store` still holds p2 in memory
    expect(await store.deleteStored("p1")).toEqual({ ok: true });
    expect(await rawGet(factory, STORE_META, "activeProjectKey")).toBeUndefined();
    const reopened = mk(factory);
    await reopened.open();
    expect(reopened.getState().project?.projectKey).toBe("p2"); // falls back to the first record, as before
  });
});

describe("activateProject", () => {
  it("moves the active pointer and the in-memory project, and the next save is a valid compare-and-swap", async () => {
    const { factory, store } = await twoProjects();
    const r = await store.activateProject("p1");
    expect(r.ok && r.project.projectKey).toBe("p1");
    expect(store.getState()).toMatchObject({ status: "saved", project: { projectKey: "p1" } });
    expect(((await rawGet(factory, STORE_META, "activeProjectKey")) as { value: string }).value).toBe("p1");
    expect(await store.save(edited(2, "p1"))).toBe("saved");
    expect(((await rawGet(factory, STORE_PROJECTS, "p1")) as ProjectRecord).writeSeq).toBe(2);
    const reopened = mk(factory);
    await reopened.open();
    expect(reopened.getState().project?.projectKey).toBe("p1");
  });
  it("refuses an unreadable or missing project and changes nothing", async () => {
    const { factory, store } = await twoProjects();
    await rawPut(factory, STORE_PROJECTS, { projectKey: "bad", name: "Broken" });
    expect(await store.activateProject("bad")).toMatchObject({ ok: false });
    expect(await store.activateProject("nope")).toMatchObject({ ok: false });
    expect(store.getState().project?.projectKey).toBe("p2");
    expect(((await rawGet(factory, STORE_META, "activeProjectKey")) as { value: string }).value).toBe("p2");
  });
});
