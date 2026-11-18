// Component tests (static markup) for the sheet and animation editors, routing, and the editors against the real
// ProjectController: edits persist, validate as manifests, undo, and an asset a sheet uses cannot be deleted.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { drain, harness } from "../app/session.testkit";
import { isEditable, resolveHash } from "../app/router";
import { memoryMarker, newFactory } from "../project/testkit";
import { validateManifest } from "../project/manifests";
import { xrefManifests } from "../project/xref.testkit";
import { AnimationEditor } from "./AnimationEditor";
import { addFrame, appendToSequence, removeSheetFrame } from "./edit";
import { SheetEditor } from "./SheetEditor";

const noop = () => undefined;
const fx = () => xrefManifests();

describe("sheet editor", () => {
  const render = (selectedId: string | null) => {
    const m = fx();
    return renderToStaticMarkup(<SheetEditor animations={m.animations} images={m.assets.assets.filter((a) => a.kind === "image")} selectedId={selectedId} onSelect={noop} apply={noop} preview={<i data-testid="p" />} />);
  };
  it("lists sheets and offers the grid form for a new one, with every grid field", () => {
    const html = render(null);
    expect(html).toContain('data-testid="sheet-row-sheet-lantern"');
    expect(html).toContain('data-testid="sheet-create"');
    for (const k of ["frameWidth", "frameHeight", "columns", "rows", "margin", "spacing"]) expect(html).toContain(`data-testid="grid-${k}"`);
    expect(html).not.toContain('data-testid="frame-list"');
  });
  it("the selected sheet shows its frame list with per-frame position, size, order, duplicate and remove controls", () => {
    const html = render("sheet-lantern");
    expect(html).toContain('data-testid="frame-list"');
    for (const id of ["f0", "f1", "f2"]) for (const a of ["up", "down", "duplicate", "remove"]) expect(html).toContain(`data-testid="frame-${a}-${id}"`);
    expect(html).toContain('aria-label="f1 x"');
    expect(html).toContain('aria-label="f1 height"');
    expect(html).toContain('data-testid="frame-add-submit"');
    expect(html).toContain('data-testid="sheet-delete"');
    expect(html).toContain('data-testid="p"');
    expect(html).toMatch(/Prototype\./);
  });
});

describe("animation editor", () => {
  const render = (selectedId: string | null, kindIds = ["star", "bat"]) => {
    const m = fx();
    return renderToStaticMarkup(<AnimationEditor animations={m.animations} kindIds={kindIds} selectedId={selectedId} onSelect={noop} apply={noop} />);
  };
  it("shows the sequence with hold, order and loop mode controls for the selected animation", () => {
    const html = render("lantern-glow");
    expect(html).toContain('data-testid="animation-fps"');
    expect(html).toContain('data-testid="animation-loop"');
    for (const v of ["once", "loop", "pingpong"]) expect(html).toContain(`value="${v}"`);
    for (let i = 0; i < 3; i++) for (const a of ["hold", "up", "down", "remove"]) expect(html).toContain(`data-testid="sequence-${a}-${i}"`);
    expect(html).toContain('data-testid="sequence-add"');
  });
  it("says what is missing instead of offering a broken form", () => {
    expect(render(null, [])).toContain("no entity kinds");
    const m = fx();
    expect(renderToStaticMarkup(<AnimationEditor animations={{ ...m.animations, sheets: [], animations: [] }} kindIds={["star"]} selectedId={null} onSelect={noop} apply={noop} />)).toContain("Create a sheet first.");
  });
});

describe("routing", () => {
  it("the sprites module is editable and #/sprites opens the editor", () => {
    expect(isEditable("sprites")).toBe(true);
    expect(resolveHash("#/sprites").route).toMatchObject({ kind: "section", module: "sprites", sectionId: "sprites" });
    expect(resolveHash("#/sprites").canonical).toBe("#/sprites/editor");
  });
});

describe("through the project controller", () => {
  async function boot() {
    const factory = newFactory();
    const h = harness({ marker: memoryMarker(), factory });
    await h.session.start();
    await drain(h);
    const m = fx();
    for (const n of ["assets", "animations", "levels", "gameplay"] as const) expect(h.session.project.actions.commitManifest(n, m[n] as never)).toMatchObject({ ok: true });
    await drain(h);
    return h;
  }
  const state = (h: Awaited<ReturnType<typeof boot>>) => h.session.project.getState().manifests;
  it("a frame and a sequence entry are committed, validate against the schema, save and undo", async () => {
    const h = await boot();
    const c = h.session.project.actions;
    const image = state(h)?.assets.assets[0];
    if (!image) throw new Error("no image asset");
    const a0 = state(h)?.animations;
    if (!a0) throw new Error("no animations");
    const added = addFrame(a0, "sheet-lantern", { x: 0, y: 32, w: 32, h: 32 }, image);
    if (!added.ok) throw new Error(added.error);
    expect(c.commitManifest("animations", added.value, "animations.frames")).toMatchObject({ ok: true, changed: true });
    const seq = appendToSequence(added.value, "lantern-glow", "f3");
    if (!seq.ok) throw new Error(seq.error);
    expect(c.commitManifest("animations", seq.value, "animations.lantern-glow.sequence")).toMatchObject({ ok: true });
    await drain(h);
    expect(h.session.project.getState().status).toBe("saved");
    expect(validateManifest("animations", state(h)?.animations).ok).toBe(true);
    expect(state(h)?.animations.animations[0]?.sequence).toHaveLength(4);
    c.undo(); c.undo();
    expect(state(h)?.animations.sheets[0]?.frames).toHaveLength(3);
  });
  it("the manifest refuses what an operation would never produce (a sequence frame missing from the sheet)", async () => {
    const h = await boot();
    const a = state(h)?.animations;
    if (!a) throw new Error("no animations");
    const used = removeSheetFrame(a, "sheet-lantern", "f1");
    expect(used.ok).toBe(false);
    const bad = { ...a, sheets: [{ ...a.sheets[0]!, frames: a.sheets[0]!.frames.filter((f) => f.id !== "f1") }] };
    expect(h.session.project.actions.commitManifest("animations", bad, "x")).toMatchObject({ ok: false });
  });
  it("an asset used by a sheet cannot be deleted", async () => {
    const h = await boot();
    const r = h.session.project.actions.deleteAsset("asset-0001");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/sheet 'sheet-lantern'/);
  });
});
