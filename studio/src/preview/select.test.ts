import { describe, expect, it } from "vitest";
import type { EngineEvent, PreviewFrame, PreviewSnapshot, PreviewStart } from "../engine/protocol";
import { PreviewController, type PreviewEngine } from "./controller";
import { event } from "./input";
import { Layout } from "./presentation";
import { hitTest, Selection } from "./select";

const R = 65536;
// World 100x100 units in a 200x240 view: HUD 40 px, scale 2, world rectangle (0,40)-(200,240).
const L = new Layout(200, 240, 100, 100);
const kinds = [{ width: 10 * R, height: 10 * R }, { width: 20 * R, height: 20 * R }];
/** entities: [id, kind, x, y, vx, vy, controlled] in world units */
const snap = (ents: number[][], alpha = 0): PreviewSnapshot => ({
  tick: 1, score: 0, lives: 1, ended: false, alpha, ticks: 1, ms: 0,
  entities: ents.flatMap(([id, k, x, y, vx = 0, vy = 0]) => [id!, k!, x! * R, y! * R, vx! * R, vy! * R, 0]),
});
const at = (wx: number, wy: number) => [L.world.x + wx * L.scale, L.world.y + wy * L.scale] as const;

describe("hit-testing the preview (what is drawn is what is clicked)", () => {
  it("layout assumed by these cases", () => { expect(L.scale).toBe(2); expect(L.world).toEqual({ x: 0, y: 40, w: 200, h: 200 }); });
  it("an entity is hit inside its box and not outside it", () => {
    const s = snap([[1, 0, 10, 10]]);
    expect(hitTest(s, kinds, L, ...at(15, 15))).toBe(0);
    expect(hitTest(s, kinds, L, ...at(25, 25))).toBeNull();
  });
  it("empty space selects nothing", () => expect(hitTest(snap([]), kinds, L, ...at(50, 50))).toBeNull());
  it("overlapping entities: the one drawn last (on top) wins", () => {
    const s = snap([[1, 1, 10, 10], [2, 0, 15, 15]]);
    expect(hitTest(s, kinds, L, ...at(17, 17))).toBe(0);
    expect(hitTest(snap([[2, 0, 15, 15], [1, 1, 10, 10]]), kinds, L, ...at(17, 17))).toBe(1);
  });
  it("only the visible part of an entity that sticks out of the world counts", () => {
    const s = snap([[1, 1, -10, 50]]); // spans x -10..10: half outside on the left
    expect(hitTest(s, kinds, L, ...at(5, 55))).toBe(1);
    expect(hitTest(s, kinds, L, ...at(-5, 55))).toBeNull(); // left of the world rectangle: letterbox
  });
  it("an entity entirely outside the world is never hit, and the HUD bar never hits", () => {
    expect(hitTest(snap([[1, 0, 120, 10]]), kinds, L, ...at(125, 15))).toBeNull();
    expect(hitTest(snap([[1, 1, 0, -15]]), kinds, L, ...at(5, -5))).toBeNull(); // y < world.y: the HUD
  });
  it("the box is the interpolated one the canvas draws", () => {
    const s = snap([[1, 0, 10, 10, 20, 0]], R / 2); // alpha 0.5: drawn 10 units to the right
    expect(hitTest(s, kinds, L, ...at(22, 15))).toBe(0);
    expect(hitTest(s, kinds, L, ...at(12, 15))).toBeNull();
  });
  it("selection notifies once per change", () => {
    const sel = new Selection();
    let n = 0;
    sel.subscribe(() => n++);
    sel.set("bat", "preview"); sel.set("bat", "preview"); sel.set("bat", "editor"); sel.set(null, "preview");
    expect(n).toBe(3);
    expect(sel.getState().kindId).toBeNull();
  });
});

class CountingEngine implements PreviewEngine {
  frames: number[] = [];
  async previewStart(_t: string, seed: number): Promise<PreviewStart> {
    return { ok: true, session: 1, sha256: "a".repeat(64), seed, snapshot: { tick: 0, score: 0, lives: 1, ended: false, alpha: 0, ticks: 0, entities: [], ms: 0 } };
  }
  async previewFrame(session: number, nanos: number, _e: EngineEvent[]): Promise<PreviewFrame> {
    this.frames.push(nanos);
    return { ok: true, session, snapshot: { tick: 1, score: 0, lives: 1, ended: false, alpha: 0, ticks: 1, entities: [], ms: 0 } };
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("inspect hold never feeds the engine", () => {
  it("no frames and no input while held; the first frame after Resume has zero elapsed time", async () => {
    let now = 0;
    const eng = new CountingEngine();
    const c = new PreviewController(eng, () => now);
    c.restart("{}", { seed: 1 });
    await flush();
    c.tick(); await flush();
    now += 16; c.tick(); await flush();
    expect(eng.frames.length).toBe(2);
    c.hold(true);
    for (let i = 0; i < 100; i++) { now += 16; expect(c.tick()).toBe(false); }
    c.submit([event("tap")]);
    await flush();
    expect(eng.frames.length).toBe(2);
    expect(c.getState().held).toBe(true);
    c.hold(false);
    now += 5000; c.tick(); await flush();
    expect(eng.frames.at(-1)).toBe(0);
  });
});
