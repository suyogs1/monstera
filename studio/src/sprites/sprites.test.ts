import { describe, expect, it } from "vitest";
import { frameIndex } from "./timeline";
import { sliceGrid, frameInBounds, gridExtent } from "./slice";
import { duplicateFrame, removeFrame, reorderFrame, dropFromSequence } from "./frames";
import type { Frame } from "../project/manifests/types";

const seq = (tickRate: number, fps: number, holds: number[], loop: "once" | "loop" | "pingpong", ticks: number[]) =>
  ticks.map((t) => frameIndex(t, tickRate, fps, holds, loop));

describe("frameIndex (hand-computed)", () => {
  // holds [1,2,1] -> 4 slots mapping to entries [0,1,1,2]; tickRate 30, fps 10 -> step = floor(tick/3)
  it("loop, tickRate 30", () => {
    expect(seq(30, 10, [1, 2, 1], "loop", [0, 2, 3, 5, 6, 8, 9, 11, 12, 15, 24])).toEqual([0, 0, 1, 1, 1, 1, 2, 2, 0, 1, 0]);
  });
  it("once clamps to the last slot", () => {
    expect(seq(30, 10, [1, 2, 1], "once", [0, 3, 6, 9, 12, 300])).toEqual([0, 1, 1, 2, 2, 2]);
  });
  it("pingpong: slots 0,1,2,3,2,1,0,1", () => {
    expect(seq(30, 10, [1, 2, 1], "pingpong", [0, 3, 6, 9, 12, 15, 18, 21, 24])).toEqual([0, 1, 1, 2, 1, 1, 0, 1, 1]);
  });
  it("tickRate 60, fps 10: step = floor(tick/6)", () => {
    expect(seq(60, 10, [1, 1, 1], "loop", [0, 5, 6, 11, 12, 17, 18])).toEqual([0, 0, 1, 1, 2, 2, 0]);
  });
  it("tickRate 60, fps 60: one step per tick", () => {
    expect(seq(60, 60, [1, 1, 1], "pingpong", [0, 1, 2, 3, 4, 5])).toEqual([0, 1, 2, 1, 0, 1]);
  });
  it("tickRate 30, fps 8 floors fractional steps", () => {
    // step = floor(tick*8/30): tick 3 -> 0, tick 4 -> 1, tick 8 -> 2
    expect(seq(30, 8, [1, 1, 1, 1], "once", [3, 4, 8, 12])).toEqual([0, 1, 2, 3]);
  });
  it("single frame, pingpong", () => {
    expect(seq(30, 10, [3], "pingpong", [0, 100])).toEqual([0, 0]);
  });
  it("two frames, pingpong period 2", () => {
    expect(seq(30, 30, [1, 1], "pingpong", [0, 1, 2, 3])).toEqual([0, 1, 0, 1]);
  });
  it("rejects bad input", () => {
    expect(() => frameIndex(-1, 30, 10, [1], "loop")).toThrow();
    expect(() => frameIndex(0, 0, 10, [1], "loop")).toThrow();
    expect(() => frameIndex(0, 30, 10, [], "loop")).toThrow();
    expect(() => frameIndex(0, 30, 10, [0], "loop")).toThrow();
  });
});

describe("sliceGrid", () => {
  const g = { frameWidth: 16, frameHeight: 16, columns: 3, rows: 2, margin: 2, spacing: 1 };
  it("computes rectangles with margin and spacing", () => {
    expect(gridExtent(g)).toEqual({ width: 2 + 48 + 2, height: 2 + 32 + 1 });
    const r = sliceGrid(g, 52, 35);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(6);
    expect(r.value[0]).toEqual({ id: "f0", x: 2, y: 2, w: 16, h: 16 });
    expect(r.value[2]).toEqual({ id: "f2", x: 36, y: 2, w: 16, h: 16 });
    expect(r.value[3]).toEqual({ id: "f3", x: 2, y: 19, w: 16, h: 16 });
    expect(r.value.every((f) => frameInBounds(f, 52, 35))).toBe(true);
  });
  it("rejects out-of-bounds grids with the reason", () => {
    expect(sliceGrid(g, 51, 35)).toEqual({ ok: false, error: "grid is 52px wide, image is 51px" });
    expect(sliceGrid(g, 52, 34)).toEqual({ ok: false, error: "grid is 35px high, image is 34px" });
  });
  it("rejects zero size, non-integers and too many frames", () => {
    expect(sliceGrid({ ...g, frameWidth: 0 }, 100, 100).ok).toBe(false);
    expect(sliceGrid({ ...g, columns: 1.5 }, 100, 100).ok).toBe(false);
    expect(sliceGrid({ ...g, margin: -1 }, 100, 100).ok).toBe(false);
    expect(sliceGrid({ frameWidth: 1, frameHeight: 1, columns: 33, rows: 32, margin: 0, spacing: 0 }, 100, 100).ok).toBe(false);
  });
  it("frameInBounds checks the edges", () => {
    expect(frameInBounds({ id: "ab", x: 0, y: 0, w: 10, h: 10 }, 10, 10)).toBe(true);
    expect(frameInBounds({ id: "ab", x: 1, y: 0, w: 10, h: 10 }, 10, 10)).toBe(false);
    expect(frameInBounds({ id: "ab", x: 0, y: 0, w: 0, h: 10 }, 10, 10)).toBe(false);
  });
});

describe("frame ops", () => {
  const f = (id: string, x: number): Frame => ({ id, x, y: 0, w: 8, h: 8 });
  const frames = [f("f0", 0), f("f1", 8), f("f2", 16)];
  it("reorders without mutating", () => {
    const r = reorderFrame(frames, 0, 2);
    expect(r.ok && r.value.map((x) => x.id)).toEqual(["f1", "f2", "f0"]);
    expect(frames.map((x) => x.id)).toEqual(["f0", "f1", "f2"]);
    expect(reorderFrame(frames, 3, 0).ok).toBe(false);
  });
  it("duplicates after the source with a new unused id", () => {
    const r = duplicateFrame(frames, 1, "f1-copy");
    expect(r.ok && r.value.map((x) => x.id)).toEqual(["f0", "f1", "f1-copy", "f2"]);
    expect(r.ok && r.value[2]).toEqual({ ...f("f1-copy", 8) });
    expect(duplicateFrame(frames, 1, "f2").ok).toBe(false);
    expect(duplicateFrame(frames, 1, "X").ok).toBe(false);
    expect(duplicateFrame(frames, 9, "f9").ok).toBe(false);
  });
  it("removes unused frames and blocks used ones", () => {
    const anims = [{ id: "walk", sequence: [{ frameId: "f1" }] }];
    const ok = removeFrame(frames, "f0", anims);
    expect(ok.ok && ok.value.map((x) => x.id)).toEqual(["f1", "f2"]);
    expect(removeFrame(frames, "f1", anims)).toEqual({ ok: false, error: 'frame "f1" is used by animation walk' });
    expect(removeFrame(frames, "zz", anims).ok).toBe(false);
    expect(dropFromSequence([{ frameId: "f1" }, { frameId: "f2" }], "f1")).toEqual([{ frameId: "f2" }]);
  });
});
