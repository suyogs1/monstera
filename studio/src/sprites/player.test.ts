import { describe, expect, it } from "vitest";
import { advance, frameAt, frameSequence, initialPlayer, pause, play, restart, step } from "./player";
import { frameIndex } from "./timeline";
import type { Animation, Sheet } from "../project/manifests/types";

const sheet: Sheet = {
  id: "sheet", assetId: "a1",
  grid: { frameWidth: 8, frameHeight: 8, columns: 3, rows: 1, margin: 0, spacing: 0 },
  frames: [{ id: "f-a", x: 0, y: 0, w: 8, h: 8 }, { id: "f-b", x: 8, y: 0, w: 8, h: 8 }, { id: "f-c", x: 16, y: 0, w: 8, h: 8 }],
};
const anim = (loop: Animation["loop"]): Animation => ({
  id: "walk", sheetId: "sheet", kindRef: "k", fps: 10, loop,
  sequence: [{ frameId: "f-a", holdFrames: 1 }, { frameId: "f-b", holdFrames: 2 }, { frameId: "f-c", holdFrames: 1 }],
});

describe("player matches frameIndex (3.1)", () => {
  for (const tickRate of [30, 60]) for (const loop of ["once", "loop", "pingpong"] as const) {
    it(`${loop} at ${tickRate}`, () => {
      const a = anim(loop);
      const expected: string[] = [];
      const seen: string[] = [];
      for (let t = 0; t <= 200; t++) {
        expected.push(a.sequence[frameIndex(t, tickRate, a.fps, a.sequence, loop)]!.frameId);
        const r = frameAt(a, sheet, tickRate, t);
        if (r.ok) seen.push(r.frame.id);
      }
      expect(seen).toEqual(expected);
      expect(frameSequence(a, tickRate, 0, 200)).toEqual(expected);
    });
  }
  it("hand-computed loop at 30 ticks/s, 10 fps", () => {
    // step = floor(tick/3); slots [a, b, b, c]
    expect(frameSequence(anim("loop"), 30, 0, 14)).toEqual(
      ["f-a", "f-a", "f-a", "f-b", "f-b", "f-b", "f-b", "f-b", "f-b", "f-c", "f-c", "f-c", "f-a", "f-a", "f-a"]);
  });
});

describe("player controls", () => {
  it("play, pause, step and restart", () => {
    let s = play(initialPlayer);
    expect(s.playing).toBe(true);
    s = step(s, 1);
    expect(s).toEqual({ tick: 1, playing: false });
    expect(step(s, -1).tick).toBe(0);
    expect(step(step(s, -1), -1).tick).toBe(0);
    expect(pause(play(s)).playing).toBe(false);
    expect(restart({ tick: 9, playing: true })).toEqual({ tick: 0, playing: true });
  });
  it("advance uses integer ticks and carries the remainder", () => {
    const s = play(initialPlayer);
    const r1 = advance(s, 30, 20, 0); // 33.3ms per tick
    expect(r1.state.tick).toBe(0);
    const r2 = advance(r1.state, 30, 20, r1.carryMs);
    expect(r2.state.tick).toBe(1);
    expect(advance(pause(s), 30, 1000, 0).state.tick).toBe(0);
  });
  it("reports a frame missing from the sheet", () => {
    const a = { ...anim("loop"), sequence: [{ frameId: "gone", holdFrames: 1 }] };
    expect(frameAt(a, sheet, 30, 0)).toEqual({ ok: false, error: 'frame "gone" is not in the sheet' });
  });
});
