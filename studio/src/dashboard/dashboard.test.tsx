// Task 1.3 Dashboard. Views are rendered to markup and read; the project operations run through the REAL Session, controller and
// ProjectStore on fake-indexeddb with a fake engine (create from a template, edit, reload, switch, rename, duplicate, delete).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { drain, harness, type Harness } from "../app/session.testkit";
import type { Verdict } from "../badge/badge";
import type { NativeIndex } from "../badge/nativeApps";
import type { CatalogEntry } from "../project/catalog";
import { STORE_BLOBS, STORE_PROJECTS } from "../project/idb";
import type { ProjectRecord } from "../project/record";
import { memoryMarker, newFactory, pumpkinText, rawAll } from "../project/testkit";
import { png } from "../assets/fixtures.testkit";
import { copyName, deleteWarning, determinismLine, evidenceLine, projectRows, validationLine, type LiveProject, type ProjectRow } from "./model";
import { CreateView, ProjectListView, StatusCards } from "./views";

// ---------------------------------------------------------------- views and wording
const SHA_A = "a".repeat(64), SHA_B = "b".repeat(64);
const INDEX: NativeIndex = {
  evidenceDir: "docs/evidence/x", scope: "x",
  games: [{ id: "pumpkin-blaster", specPath: "p", specSha256: SHA_A, label: "SIMULATOR-TESTED", platforms: [] }],
};
const entry = (over: Partial<Extract<CatalogEntry, { state: "ok" }>> = {}): CatalogEntry => ({
  state: "ok", projectKey: "k1", name: "Alpha", projectId: "pumpkin-blaster", specSha256: SHA_A, writeSeq: 1, targets: ["android", "ios"], populated: [], ...over,
});
const live = (over: Partial<LiveProject> = {}): LiveProject => ({
  projectKey: "k2", name: "Beta", projectId: "pumpkin-blaster", sha256: SHA_B, targets: ["android"], manifests: null,
  validation: { text: "Valid. The engine accepts this specification.", tone: "ok" }, ...over,
});
const props = (rows: ProjectRow[], extra: Partial<Parameters<typeof ProjectListView>[0]> = {}) => ({
  rows, listError: null, busyKey: null, notice: null, onOpen: () => undefined, onRename: () => undefined, onDuplicate: () => undefined, onDelete: () => undefined, ...extra,
});

describe("project rows and wording", () => {
  it("the open project uses live facts and the others say what the saved text is", () => {
    const rows = projectRows([entry(), entry({ projectKey: "k2", name: "Beta" })], live({ validation: { text: "2 issues to fix.", tone: "bad" } }), INDEX);
    const a = rows.find((r) => r.projectKey === "k1"), b = rows.find((r) => r.projectKey === "k2");
    expect(a).toMatchObject({ isOpen: false, sha256: SHA_A });
    expect(a?.validation.text).toBe("Valid when saved. Checked again when opened.");
    expect(b).toMatchObject({ isOpen: true, sha256: SHA_B });
    expect(b?.validation.text).toBe("2 issues to fix.");
  });
  it("shows the open project even when it is not stored yet", () => {
    const rows = projectRows([], live(), INDEX);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectKey: "k2", isOpen: true });
  });
  it("native evidence is bound to the exact hash: the same id with another hash is not evidence", () => {
    expect(evidenceLine(INDEX, SHA_A, "pumpkin-blaster")).toMatchObject({ tone: "ok", text: expect.stringContaining("SIMULATOR-TESTED") });
    const other = evidenceLine(INDEX, SHA_B, "pumpkin-blaster");
    expect(other.text).toMatch(/^None for this specification\. Evidence exists for pumpkin-blaster, but for a different specification\./);
    expect(other.tone).toBe("pending");
    expect(evidenceLine(INDEX, null, null).text).toBe("None for this specification.");
  });
  it("an unreadable record is a row with its reason", () => {
    const [r] = projectRows([{ state: "unreadable", projectKey: "bad", name: null, message: "writeSeq must be a non-negative integer" }], null, INDEX);
    expect(r).toMatchObject({ projectKey: "bad", name: "bad", unreadable: "writeSeq must be a non-negative integer", projectId: null });
  });
  it("determinism and validation lines never say MATCH or valid without the facts", () => {
    expect(determinismLine({ kind: "not-run" }).text).toMatch(/^Not run/);
    expect(determinismLine({ kind: "stale" } as unknown as Verdict).tone).toBe("pending");
    expect(validationLine({ validation: null, revision: 1, validatedRevision: 0 }).tone).toBe("pending");
    expect(validationLine({ validation: { ok: true } as never, revision: 2, validatedRevision: 1 }).tone).toBe("pending");
    expect(validationLine({ validation: { ok: false, issues: [{}, {}] } as never, revision: 1, validatedRevision: 1 }).text).toBe("2 issues to fix.");
    expect(validationLine({ validation: { ok: false, issues: [{}] } as never, revision: 1, validatedRevision: 1 }).text).toBe("1 issue to fix.");
  });
  it("the delete warning names the project, what is lost, and that it cannot be undone", () => {
    const w = deleteWarning({ name: "Alpha", projectId: "x", isOpen: false, unreadable: null, populated: [{ module: "assets", detail: "3 assets" }, { module: "levels", detail: "2 levels" }] });
    expect(w).toContain('"Alpha"');
    expect(w).toContain("3 assets");
    expect(w).toContain("2 levels");
    expect(w).toContain("imported asset file");
    expect(w).toContain("cannot be undone");
    expect(deleteWarning({ name: "Alpha", projectId: "x", isOpen: true, unreadable: null, populated: [] })).toContain("opens another project");
    expect(deleteWarning({ name: "Bad", projectId: null, isOpen: false, unreadable: "broken", populated: [] })).toContain("cannot be read");
  });
  it("a copy name fits the 80 character limit", () => {
    expect(copyName("Alpha")).toBe("Alpha copy");
    expect(copyName("x".repeat(80))).toHaveLength(80);
  });
});

describe("project list view", () => {
  const rows = projectRows([entry({ populated: [{ module: "assets", detail: "2 assets" }] }), { state: "unreadable", projectKey: "bad", name: "Broken", message: "no" }], live(), INDEX);
  const html = renderToStaticMarkup(<ProjectListView {...props(rows)} />);
  it("says the projects exist only in this browser and that bundles are not available", () => {
    expect(html).toContain('data-testid="browser-only"');
    expect(html).toContain("only in this browser");
    expect(html).toContain("not available yet");
    expect(html).not.toMatch(/Export bundle|Import bundle/);
  });
  it("shows id, targets, hash, engine check, evidence and populated modules for a project", () => {
    expect(html).toContain("pumpkin-blaster");
    expect(html).toContain("android, ios");
    expect(html).toContain(SHA_A.slice(0, 12));
    expect(html).toContain("Valid when saved");
    expect(html).toContain("SIMULATOR-TESTED");
    expect(html).toContain("Assets (2 assets)");
    expect(html).toContain("Empty: no assets");
  });
  it("marks the open project and offers Open only for the others", () => {
    expect(html).toContain('data-testid="project-k2"');
    expect(html).toMatch(/data-testid="project-k2" data-open="true"/);
    expect(html).toContain('data-testid="project-open-k1"');
    expect(html).not.toContain('data-testid="project-open-k2"');
  });
  it("an unreadable project offers only Delete", () => {
    expect(html).toContain('data-testid="project-delete-bad"');
    expect(html).not.toContain('data-testid="project-open-bad"');
    expect(html).not.toContain('data-testid="project-rename-bad"');
    expect(html).not.toContain('data-testid="project-duplicate-bad"');
    expect(html).toContain("kept unchanged");
  });
  it("shows a read error and the empty state without pretending", () => {
    const err = renderToStaticMarkup(<ProjectListView {...props([], { listError: "Storage is not open." })} />);
    expect(err).toContain('role="alert"');
    expect(err).toContain("Storage is not open.");
    expect(err).not.toContain("No project is stored yet");
    expect(renderToStaticMarkup(<ProjectListView {...props([])} />)).toContain("No project is stored yet");
  });
  it("create offers templates and a specification file", () => {
    const c = renderToStaticMarkup(<CreateView templates={[{ id: "pumpkin-blaster", label: "pumpkin-blaster", group: "official" }]} busy={false} onCreate={() => undefined} onImportFile={() => undefined} />);
    expect(c).toContain('data-testid="create-template"');
    expect(c).toContain("monstera.spec.json");
    expect(c).toContain('type="file"');
  });
});

describe("status cards", () => {
  const cards = renderToStaticMarkup(<StatusCards
    name="Alpha" projectKey="k1" projectId="pumpkin-blaster" sha256={SHA_A} storageStatus="Project: saved" persistence="Saved in this browser only."
    validation={{ text: "Valid.", tone: "ok" }} determinism={{ text: "Not run for this draft.", tone: "pending" }} evidence={evidenceLine(INDEX, SHA_A, "pumpkin-blaster")}
    populated={[{ module: "levels", detail: "2 levels" }]} links={{ validation: "v", determinism: "d", evidence: "e" }} />);
  it("has the five cards and storage", () => {
    for (const id of ["validation", "hash", "determinism", "evidence", "modules", "storage"]) expect(cards).toContain(`data-testid="status-${id}"`);
    expect(cards).toContain(SHA_A);
    expect(cards).toContain("Levels: 2 levels");
    expect(cards).toContain("Not run for this draft.");
  });
  it("a hash that does not exist is not invented", () => {
    const none = renderToStaticMarkup(<StatusCards
      name="A" projectKey="k" projectId={null} sha256={null} storageStatus="s" persistence="p" validation={{ text: "x", tone: "bad" }}
      determinism={{ text: "y", tone: "pending" }} evidence={{ text: "z", tone: "pending" }} populated={[]} links={{ validation: null, determinism: null, evidence: null }} />);
    expect(none).toContain("not available while the engine has not accepted");
    expect(none).toContain("No module has data yet.");
  });
});

// ---------------------------------------------------------------- operations through the real controller
async function boot(factory = newFactory()): Promise<{ h: Harness; factory: IDBFactory }> {
  const h = harness({ marker: memoryMarker(), factory });
  await h.session.start();
  await drain(h);
  return { h, factory };
}
const view = (h: Harness) => h.session.project.getState();
const actions = (h: Harness) => h.session.project.actions;
const lives = (h: Harness): unknown => ((h.session.store.getState().doc as { game: { runtime: { lives: unknown } } }).game.runtime.lives);
const names = async (h: Harness): Promise<string[]> => {
  const r = await actions(h).listProjects();
  if (!r.ok) throw new Error(r.message);
  return r.entries.map((e) => (e.state === "ok" ? e.name : `!${e.projectKey}`)).sort();
};
const keyOf = async (h: Harness, name: string): Promise<string> => {
  const r = await actions(h).listProjects();
  if (!r.ok) throw new Error(r.message);
  const e = r.entries.find((x) => x.state === "ok" && x.name === name);
  if (!e) throw new Error(`no project ${name}`);
  return e.projectKey;
};

describe("A3 first half: create from a template, edit, save, reload", () => {
  it("a reload restores the identical project, and a second template project does not disturb it", async () => {
    const { h, factory } = await boot();
    const firstKey = view(h).projectKey as string;
    h.session.store.set(["game", "runtime", "lives"], 7);
    await drain(h);
    expect(view(h).status).toBe("saved");
    const storedBefore = ((await rawAll(factory, STORE_PROJECTS)) as ProjectRecord[]).find((r) => r.projectKey === firstKey) as ProjectRecord;
    expect(storedBefore.specText).not.toBe(pumpkinText);
    // reload
    const again = await boot(factory);
    expect(view(again.h).projectKey).toBe(firstKey);
    expect(lives(again.h)).toBe(7);
    expect(view(again.h).manifests).toEqual(view(h).manifests);
    // the Dashboard's "create from template" path
    await again.h.session.project.flush();
    await again.h.session.loadTemplate("pumpkin-blaster");
    await drain(again.h);
    expect(view(again.h).projectKey).not.toBe(firstKey);
    expect(lives(again.h)).not.toBe(7);
    const records = (await rawAll(factory, STORE_PROJECTS)) as ProjectRecord[];
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.projectKey === firstKey)).toEqual(storedBefore);
  });
});

describe("open", () => {
  it("switches projects without losing either one, and keeps saving the right project", async () => {
    const { h } = await boot();
    const a = view(h).projectKey as string;
    h.session.store.set(["game", "runtime", "lives"], 7);
    await drain(h);
    await h.session.loadTemplate("pumpkin-blaster");
    await drain(h);
    const b = view(h).projectKey as string;
    expect(b).not.toBe(a);
    expect(await actions(h).openProject(a)).toEqual({ ok: true });
    await drain(h);
    expect(view(h)).toMatchObject({ projectKey: a, status: "saved", canUndo: false });
    expect(lives(h)).toBe(7);
    h.session.store.set(["game", "runtime", "lives"], 8);
    await drain(h);
    expect(view(h).status).toBe("saved");
    expect(await actions(h).openProject(b)).toEqual({ ok: true });
    await drain(h);
    expect(lives(h)).not.toBe(8);
    expect(await actions(h).openProject(a)).toEqual({ ok: true });
    await drain(h);
    expect(lives(h)).toBe(8);
  });
  it("refuses to leave edits the engine rejected unless they are discarded on purpose", async () => {
    const { h } = await boot();
    const a = view(h).projectKey as string;
    await h.session.loadTemplate("pumpkin-blaster");
    await drain(h);
    h.engine.invalid = (t) => t.includes('"lives":99');
    h.session.store.set(["game", "runtime", "lives"], 99);
    await drain(h);
    expect(view(h).dirty).toBe(true);
    const r = await actions(h).openProject(a);
    expect(r).toMatchObject({ ok: false });
    expect(view(h).projectKey).not.toBe(a);
    expect(await actions(h).openProject(a, { discardMemory: true })).toEqual({ ok: true });
    await drain(h);
    expect(view(h)).toMatchObject({ projectKey: a, dirty: false });
  });
});

describe("rename", () => {
  it("renames the open project through the normal save, and a stored one directly", async () => {
    const { h } = await boot();
    const a = view(h).projectKey as string;
    await h.session.loadTemplate("pumpkin-blaster");
    await drain(h);
    const b = view(h).projectKey as string;
    expect(await actions(h).renameProject(b, "  Second  ")).toEqual({ ok: true });
    await drain(h);
    expect(view(h)).toMatchObject({ name: "Second", status: "saved" });
    expect(await actions(h).renameProject(a, "First")).toEqual({ ok: true });
    expect(await names(h)).toEqual(["First", "Second"]);
    expect(view(h).projectKey).toBe(b);
  });
  it("refuses an empty, over-long or control-character name and changes nothing", async () => {
    const { h } = await boot();
    const k = view(h).projectKey as string;
    const before = await names(h);
    for (const bad of ["", "   ", "x".repeat(81), "a\tb"]) expect(await actions(h).renameProject(k, bad)).toMatchObject({ ok: false });
    expect(await names(h)).toEqual(before);
  });
});

describe("duplicate", () => {
  it("copies a project with its asset bytes, keeps the specification unchanged and does not open the copy", async () => {
    const { h, factory } = await boot();
    const a = view(h).projectKey as string;
    const bytes = png(8, 8);
    const imp = await actions(h).importAsset({
      fileName: "a.png", bytes, category: "sprite",
      provenance: { origin: "user-owned", author: "me", license: "proprietary-owned", source: "", tool: "", model: "", promptSha256: "", acquiredOn: "", notes: "" },
    });
    expect(imp).toMatchObject({ ok: true });
    await drain(h);
    const r = await actions(h).duplicateProject(a, "Copy of it");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(view(h).projectKey).toBe(a);
    const records = (await rawAll(factory, STORE_PROJECTS)) as ProjectRecord[];
    const orig = records.find((x) => x.projectKey === a) as ProjectRecord, copy = records.find((x) => x.projectKey === r.projectKey) as ProjectRecord;
    expect(copy).toMatchObject({ name: "Copy of it", projectId: orig.projectId, specText: orig.specText, specSha256: orig.specSha256 });
    expect(copy.manifests).toEqual(orig.manifests);
    const blobs = (await rawAll(factory, STORE_BLOBS)) as { projectKey: string }[];
    expect(blobs.map((b) => b.projectKey).sort()).toEqual([a, r.projectKey].sort());
    expect(await actions(h).openProject(r.projectKey)).toEqual({ ok: true });
    await drain(h);
    expect([...((await actions(h).assetBytes("asset-0001")) ?? [])]).toEqual([...bytes]);
  });
  it("refuses while the open project has edits storage has not seen", async () => {
    const { h } = await boot();
    h.engine.invalid = (t) => t.includes('"lives":99');
    h.session.store.set(["game", "runtime", "lives"], 99);
    await drain(h);
    expect(await actions(h).duplicateProject(view(h).projectKey as string, "x")).toMatchObject({ ok: false });
    expect(await names(h)).toHaveLength(1);
  });
});

describe("delete", () => {
  it("deletes a stored project that is not open, with its asset bytes", async () => {
    const { h, factory } = await boot();
    const a = view(h).projectKey as string;
    expect(await actions(h).importAsset({
      fileName: "a.png", bytes: png(8, 8), category: "sprite",
      provenance: { origin: "user-owned", author: "me", license: "proprietary-owned", source: "", tool: "", model: "", promptSha256: "", acquiredOn: "", notes: "" },
    })).toMatchObject({ ok: true });
    await drain(h);
    await h.session.loadTemplate("pumpkin-blaster");
    await drain(h);
    expect(await h.session.deleteProject(a)).toEqual({ ok: true });
    expect(((await rawAll(factory, STORE_PROJECTS)) as ProjectRecord[]).map((r) => r.projectKey)).not.toContain(a);
    expect(await rawAll(factory, STORE_BLOBS)).toHaveLength(0);
  });
  it("deleting the open project opens another stored project first", async () => {
    const { h } = await boot();
    const a = view(h).projectKey as string;
    await h.session.loadTemplate("pumpkin-blaster");
    await drain(h);
    const b = view(h).projectKey as string;
    expect(await h.session.deleteProject(b)).toEqual({ ok: true });
    await drain(h);
    expect(view(h).projectKey).toBe(a);
    expect(await names(h)).toHaveLength(1);
  });
  it("deleting the only project leaves a new template project, never an empty app", async () => {
    const { h, factory } = await boot();
    const a = view(h).projectKey as string;
    expect(await h.session.deleteProject(a)).toEqual({ ok: true });
    await drain(h);
    expect(view(h).projectKey).not.toBe(a);
    expect(view(h).status).toBe("saved");
    expect(((await rawAll(factory, STORE_PROJECTS)) as ProjectRecord[]).map((r) => r.projectKey)).toEqual([view(h).projectKey]);
  });
  it("the controller itself refuses to delete the open project", async () => {
    const { h } = await boot();
    expect(await actions(h).deleteProject(view(h).projectKey as string)).toMatchObject({ ok: false });
    expect(await names(h)).toHaveLength(1);
  });
  it("the key of a deleted project is not reused for a new one", async () => {
    const { h } = await boot();
    const a = view(h).projectKey as string;
    expect(await h.session.deleteProject(a)).toEqual({ ok: true });
    await drain(h);
    const created = await keyOf(h, view(h).name as string);
    expect(created).not.toBe(a);
  });
});
