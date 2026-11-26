// Sheet, frame and animation operations (task 3.2). Hand-computed cases on a small manifest; every result is also run through the
// real manifest validator so an operation can never produce something the schema refuses.
import { describe, expect, it } from "vitest";
import { validateManifest } from "../project/manifests";
import type { AnimationsManifest } from "../project/manifests/types";
import {
  addAnimation, addFrame, addSheet, addSheetWithFrames, animationsUsingFrame, appendToSequence, DEFAULT_GRID, duplicateSheetFrame, moveFrame, moveInSequence,
  nextFrameId, removeAnimation, removeFromSequence, removeSheet, removeSheetFrame, renameSheetFrame, reorderSheetFrame, resizeFrame, resliceSheet,
  resliceSheetWithFrames, setAnimationKind, setFps, setFrameRect, setHold, setLoop, type Result, type SheetImage,
} from "./edit";

const img: SheetImage = { id: "asset-0001", kind: "image", width: 64, height: 32 };
const empty = (): AnimationsManifest => ({ schema: "monstera.studio.animations", version: 1, sheets: [], animations: [] });
const grid = { frameWidth: 16, frameHeight: 16, columns: 4, rows: 2, margin: 0, spacing: 0 };
function ok(r: Result<AnimationsManifest>): AnimationsManifest {
  if (!r.ok) throw new Error(r.error);
  const v = validateManifest("animations", r.value);
  if (!v.ok) throw new Error(`invalid manifest: ${v.issues[0]?.message}`);
  return r.value;
}
const err = (r: Result<AnimationsManifest>): string => (r.ok ? "expected a refusal" : r.error);
const withSheet = () => ok(addSheet(empty(), "sheet-1", img, grid));
const withAnim = () => ok(addAnimation(withSheet(), "anim-1", "sheet-1", "star"));

describe("sheets", () => {
  it("slices a grid into row-major frames and keeps sheets sorted", () => {
    const m = ok(addSheet(withSheet(), "sheet-0", img, { ...grid, columns: 2, rows: 1 }));
    expect(m.sheets.map((s) => s.id)).toEqual(["sheet-0", "sheet-1"]);
    const s = m.sheets[1];
    expect(s?.frames).toHaveLength(8);
    expect(s?.frames[5]).toEqual({ id: "f5", x: 16, y: 16, w: 16, h: 16 });
    expect(s?.assetId).toBe("asset-0001");
  });
  it("refuses a grid outside the image with the exact reason, a bad or used id, and a non-image", () => {
    expect(err(addSheet(empty(), "sheet-1", img, { ...grid, columns: 5 }))).toBe("grid is 80px wide, image is 64px");
    expect(err(addSheet(empty(), "sheet-1", img, { ...grid, frameWidth: 0 }))).toBe("frameWidth must be at least 1");
    expect(err(addSheet(withSheet(), "sheet-1", img, grid))).toMatch(/already exists/);
    expect(err(addSheet(empty(), "Bad Id", img, grid))).toMatch(/invalid sheet id/);
    expect(err(addSheet(empty(), "sheet-1", { ...img, kind: "audio" }, grid))).toMatch(/not an image/);
    expect(DEFAULT_GRID.columns).toBe(1);
  });
  it("re-slices, but not when an animation would lose a frame it uses", () => {
    const m = withAnim();
    const bigger = ok(resliceSheet(m, "sheet-1", img, { ...grid, frameWidth: 8, frameHeight: 8, columns: 8, rows: 4 }));
    expect(bigger.sheets[0]?.frames).toHaveLength(32);
    const withF7 = ok(appendToSequence(m, "anim-1", "f7"));
    expect(err(resliceSheet(withF7, "sheet-1", img, { ...grid, columns: 2, rows: 1 }))).toMatch(/animation "anim-1" uses frame "f7"/);
    expect(err(resliceSheet(m, "sheet-1", img, { ...grid, columns: 9 }))).toMatch(/wide/);
  });
  it("deleting a sheet is blocked while an animation is on it", () => {
    expect(err(removeSheet(withAnim(), "sheet-1"))).toBe('sheet "sheet-1" is used by animation anim-1');
    expect(ok(removeSheet(withSheet(), "sheet-1")).sheets).toEqual([]);
    expect(err(removeSheet(empty(), "nope"))).toMatch(/no sheet/);
  });
});

describe("frames", () => {
  it("adds, moves and resizes in whole pixels inside the image", () => {
    let m = ok(addFrame(withSheet(), "sheet-1", { x: 3, y: 5, w: 10, h: 7 }, img));
    expect(m.sheets[0]?.frames.at(-1)).toEqual({ id: "f8", x: 3, y: 5, w: 10, h: 7 });
    m = ok(moveFrame(m, "sheet-1", "f8", 54, 25, img));
    expect(m.sheets[0]?.frames.at(-1)).toEqual({ id: "f8", x: 54, y: 25, w: 10, h: 7 });
    m = ok(resizeFrame(m, "sheet-1", "f8", 10, 7, img));
    expect(err(moveFrame(m, "sheet-1", "f8", 55, 25, img))).toMatch(/image is 64x32/);
    expect(err(resizeFrame(m, "sheet-1", "f8", 11, 7, img))).toMatch(/ends at 65,32/);
    expect(err(resizeFrame(m, "sheet-1", "f8", 0, 7, img))).toMatch(/at least 1/);
    expect(err(moveFrame(m, "sheet-1", "f8", -1, 0, img))).toMatch(/0 or more/);
    expect(err(moveFrame(m, "sheet-1", "f8", 1.5, 0, img))).toMatch(/whole pixels/);
    expect(err(addFrame(m, "sheet-1", { x: 0, y: 0, w: 1, h: 1.2 }, img))).toMatch(/whole pixels/);
    expect(err(moveFrame(m, "sheet-1", "nope", 0, 0, img))).toMatch(/no frame/);
  });
  it("a new frame id never takes a number at or below the highest one", () => {
    expect(nextFrameId([{ id: "f0", x: 0, y: 0, w: 1, h: 1 }, { id: "f9", x: 0, y: 0, w: 1, h: 1 }, { id: "keep", x: 0, y: 0, w: 1, h: 1 }])).toBe("f10");
    expect(nextFrameId([])).toBe("f0");
  });
  it("reorders and duplicates (copy lands after the original)", () => {
    let m = ok(reorderSheetFrame(withSheet(), "sheet-1", 0, 2));
    expect(m.sheets[0]?.frames.slice(0, 3).map((f) => f.id)).toEqual(["f1", "f2", "f0"]);
    m = ok(duplicateSheetFrame(m, "sheet-1", 0));
    expect(m.sheets[0]?.frames.slice(0, 2).map((f) => f.id)).toEqual(["f1", "f8"]);
    expect(m.sheets[0]?.frames[1]).toMatchObject({ x: 16, y: 0, w: 16, h: 16 });
    expect(err(reorderSheetFrame(m, "sheet-1", 0, 99))).toMatch(/out of range/);
    expect(err(duplicateSheetFrame(m, "sheet-1", 99))).toMatch(/no frame/);
  });
  it("removing an unused frame works; a used frame is blocked, naming the animation", () => {
    const m = withAnim(); // anim-1 uses f0
    expect(animationsUsingFrame(m, "sheet-1", "f0")).toEqual(["anim-1"]);
    expect(animationsUsingFrame(m, "sheet-1", "f1")).toEqual([]);
    expect(ok(removeSheetFrame(m, "sheet-1", "f1")).sheets[0]?.frames).toHaveLength(7);
    expect(err(removeSheetFrame(m, "sheet-1", "f0"))).toBe('frame "f0" is used by animation anim-1');
  });
  it("confirmed removal drops the entries from every sequence, but never leaves an animation empty", () => {
    let m = ok(appendToSequence(withAnim(), "anim-1", "f1"));
    m = ok(removeSheetFrame(m, "sheet-1", "f0", true));
    expect(m.animations[0]?.sequence).toEqual([{ frameId: "f1", holdFrames: 1 }]);
    expect(m.sheets[0]?.frames.some((f) => f.id === "f0")).toBe(false);
    expect(err(removeSheetFrame(m, "sheet-1", "f1", true))).toMatch(/animation "anim-1" would be left with no frames/);
  });
});

describe("animations", () => {
  it("creates one with defaults, sorted by id, on a sheet with frames only", () => {
    const m = ok(addAnimation(withAnim(), "anim-0", "sheet-1", "player"));
    expect(m.animations.map((a) => a.id)).toEqual(["anim-0", "anim-1"]);
    expect(m.animations[1]).toEqual({ id: "anim-1", sheetId: "sheet-1", kindRef: "star", fps: 8, loop: "loop", sequence: [{ frameId: "f0", holdFrames: 1 }] });
    expect(err(addAnimation(withAnim(), "anim-1", "sheet-1", "star"))).toMatch(/already exists/);
    expect(err(addAnimation(withSheet(), "anim-1", "nope", "star"))).toMatch(/no sheet/);
    expect(err(addAnimation(withSheet(), "anim-1", "sheet-1", "Bad"))).toMatch(/invalid kind/);
    const noFrames = { ...withSheet(), sheets: [{ ...withSheet().sheets[0]!, frames: [] }] };
    expect(err(addAnimation(noFrames, "anim-1", "sheet-1", "star"))).toMatch(/has no frames/);
  });
  it("fps is 1 to 60, loop is once, loop or pingpong, kind must look like a kind id", () => {
    const m = withAnim();
    expect(ok(setFps(m, "anim-1", 60)).animations[0]?.fps).toBe(60);
    expect(ok(setFps(m, "anim-1", 1)).animations[0]?.fps).toBe(1);
    for (const bad of [0, 61, 2.5, Number.NaN]) expect(err(setFps(m, "anim-1", bad))).toMatch(/1 to 60/);
    for (const mode of ["once", "loop", "pingpong"]) expect(ok(setLoop(m, "anim-1", mode)).animations[0]?.loop).toBe(mode);
    expect(err(setLoop(m, "anim-1", "bounce"))).toMatch(/once, loop, pingpong/);
    expect(ok(setAnimationKind(m, "anim-1", "bat")).animations[0]?.kindRef).toBe("bat");
    expect(err(setAnimationKind(m, "anim-1", "1bad"))).toMatch(/invalid kind/);
    expect(err(setFps(m, "nope", 5))).toMatch(/no animation/);
  });
  it("edits the sequence: append (repeats allowed), move, hold 1 to 60, remove but never the last", () => {
    let m = ok(appendToSequence(withAnim(), "anim-1", "f2"));
    m = ok(appendToSequence(m, "anim-1", "f0"));
    expect(m.animations[0]?.sequence.map((e) => e.frameId)).toEqual(["f0", "f2", "f0"]);
    m = ok(moveInSequence(m, "anim-1", 2, 0));
    expect(m.animations[0]?.sequence.map((e) => e.frameId)).toEqual(["f0", "f0", "f2"]);
    m = ok(setHold(m, "anim-1", 1, 60));
    expect(m.animations[0]?.sequence[1]).toEqual({ frameId: "f0", holdFrames: 60 });
    for (const bad of [0, 61, 1.5]) expect(err(setHold(m, "anim-1", 1, bad))).toMatch(/1 to 60/);
    expect(err(setHold(m, "anim-1", 9, 2))).toMatch(/no entry/);
    expect(err(appendToSequence(m, "anim-1", "f99"))).toMatch(/not in sheet/);
    expect(err(moveInSequence(m, "anim-1", 0, 9))).toMatch(/out of range/);
    m = ok(removeFromSequence(m, "anim-1", 0));
    m = ok(removeFromSequence(m, "anim-1", 0));
    expect(err(removeFromSequence(m, "anim-1", 0))).toBe("an animation needs at least one frame");
  });
  it("removes an animation and never mutates its input", () => {
    const m = withAnim();
    const before = JSON.stringify(m);
    expect(ok(removeAnimation(m, "anim-1")).animations).toEqual([]);
    ok(setFps(m, "anim-1", 30)); ok(appendToSequence(m, "anim-1", "f1")); ok(removeSheetFrame(m, "sheet-1", "f3"));
    expect(JSON.stringify(m)).toBe(before);
    expect(err(removeAnimation(m, "nope"))).toMatch(/no animation/);
  });
});

describe("manual & selective slicing helpers", () => {
  it("addSheetWithFrames and resliceSheetWithFrames keep only selected frames and guard animation references", () => {
    const subset = [{ id: "f0", x: 0, y: 0, w: 16, h: 16 }, { id: "f2", x: 32, y: 0, w: 16, h: 16 }];
    const m = ok(addSheetWithFrames(empty(), "sheet-1", img, grid, subset));
    expect(m.sheets[0]?.frames.map((f) => f.id)).toEqual(["f0", "f2"]);
    expect(err(addSheetWithFrames(empty(), "sheet-1", img, grid, []))).toMatch(/select at least one frame/);
    const withA = ok(addAnimation(m, "anim-1", "sheet-1", "player"));
    expect(err(resliceSheetWithFrames(withA, "sheet-1", img, grid, [{ id: "f2", x: 32, y: 0, w: 16, h: 16 }]))).toMatch(/uses frame "f0"/);
    const updated = ok(resliceSheetWithFrames(withA, "sheet-1", img, grid, [{ id: "f0", x: 0, y: 0, w: 16, h: 16 }]));
    expect(updated.sheets[0]?.frames).toHaveLength(1);
  });

  it("setFrameRect updates position and size in bounds, and renameSheetFrame updates animation sequences", () => {
    const m = ok(addAnimation(withSheet(), "anim-1", "sheet-1", "player"));
    const moved = ok(setFrameRect(m, "sheet-1", "f0", { x: 4, y: 4, w: 20, h: 20 }, img));
    expect(moved.sheets[0]?.frames[0]).toEqual({ id: "f0", x: 4, y: 4, w: 20, h: 20 });
    expect(err(setFrameRect(m, "sheet-1", "f0", { x: 60, y: 0, w: 10, h: 10 }, img))).toMatch(/image is 64x32/);
    const renamed = ok(renameSheetFrame(moved, "sheet-1", "f0", "idle-0"));
    expect(renamed.sheets[0]?.frames[0]?.id).toBe("idle-0");
    expect(renamed.animations[0]?.sequence[0]?.frameId).toBe("idle-0");
    expect(err(renameSheetFrame(renamed, "sheet-1", "idle-0", "f1"))).toMatch(/already exists/);
    expect(err(renameSheetFrame(renamed, "sheet-1", "idle-0", "1bad"))).toMatch(/2–32 lowercase/);
  });
});
