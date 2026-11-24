// The shared world drawing draws a kind's atlas frame (the rule of contract section 10) and falls back to the glyph or colour box.
import { describe, expect, it } from "vitest";
import { RAW } from "./select";
import { drawEntityBox, displayOfDoc, type AtlasMeta, type Kind } from "./worldDraw";

const atlas: AtlasMeta = { png: "", frameWidth: 8, frameHeight: 4, columns: 3, rows: 2 };
const kind: Kind = { id: "bat", color: "#ff0000", glyph: "", effect: "none", width: 2 * RAW, height: 2 * RAW, sprite: { frames: [4, 1], ticksPerFrame: 3 } };

describe("drawEntityBox with a sprite", () => {
  it("falls back to the colour box while the atlas image has not loaded (no DOM here)", () => {
    const calls: string[] = [];
    const ctx = { fillRect: () => calls.push("fillRect"), drawImage: () => calls.push("drawImage"), set fillStyle(_v: string) {} } as unknown as CanvasRenderingContext2D;
    drawEntityBox(ctx, kind, { x: 0, y: 0, w: 10, h: 10 }, 0, atlas);
    expect(calls).toEqual(["fillRect"]);
  });
  it("a spec's display carries the atlas and each kind's sprite only when they exist", () => {
    const base = { project: { displayName: "n" }, game: { orientation: "landscape", world: { width: 1, height: 1 }, input: { scheme: "tap", swipeSpeed: 1 }, palette: {}, hud: {}, screens: {} } };
    const k = { id: "a", color: "#000000", glyph: "", effect: "none", width: 1, height: 1 };
    const none = displayOfDoc({ ...base, game: { ...base.game, atlas: { png: "", frameWidth: 1, frameHeight: 1, columns: 1, rows: 1 }, runtime: { kinds: [{ ...k, sprite: { frames: [], ticksPerFrame: 1 } }] } } });
    expect(none.atlas).toBeUndefined();
    expect(none.kinds[0]!.sprite).toBeUndefined();
    const some = displayOfDoc({ ...base, game: { ...base.game, atlas: { png: "AAAA", frameWidth: 2, frameHeight: 2, columns: 1, rows: 1 }, runtime: { kinds: [{ ...k, sprite: { frames: [0], ticksPerFrame: 4 } }] } } });
    expect(some.atlas).toMatchObject({ png: "AAAA", frameWidth: 2 });
    expect(some.kinds[0]!.sprite).toEqual({ frames: [0], ticksPerFrame: 4 });
  });
});
