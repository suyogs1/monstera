import { describe, expect, it } from "vitest";
import type { CompiledEntity, CompiledSpawner } from "../derive/levels";
import { Layout } from "./presentation";
import { RAW } from "./select";
import { displayOf, drawEntityBox, drawLevelWorld, placementBox, spawnerBand, withAlpha, type Display, type Kind } from "./worldDraw";

/** Records every call and property assignment of the canvas context in order. */
function recorder() {
  const calls: string[] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get: (t, p: string) => (p in t ? t[p] : (...a: unknown[]) => { calls.push(`${p}(${a.map((x) => (typeof x === "number" ? Math.round(x * 100) / 100 : String(x))).join(",")})`); }),
    set: (t, p: string, v) => { t[p] = v; calls.push(`${p}=${String(v)}`); return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}
const colorKind: Kind = { id: "block", color: "#ff0000", glyph: "", effect: "none", width: 2 * RAW, height: 2 * RAW };
const glyphKind: Kind = { id: "star", color: "#00ff00", glyph: "*", effect: "pickup", width: 2 * RAW, height: 2 * RAW };
const display: Display = {
  displayName: "T", orientation: "landscape", worldW: 100, worldH: 50, scheme: "drag", swipeSpeed: 1,
  palette: { primary: "#111111", accent: "#222222", background: "#000000" }, hud: { lifeGlyph: "x", scoreLabel: "S" },
  screens: { startHint: "", winTitle: "", loseTitle: "" }, kinds: [colorKind, glyphKind],
};
const L = new Layout(400, 300, 100, 50);
const entity = (kind: string, x: number, y: number): CompiledEntity => ({ kind, x: x * RAW, y: y * RAW, vx: 0, vy: 0, controlled: false });
const spawner = (kind: string): CompiledSpawner => ({ stream: "s", kind, startTick: 0, intervalTicks: 10, xMin: 0, xMax: 10 * RAW, yMin: 0, yMax: 4 * RAW, vx: 0, vy: RAW });

describe("shared world drawing", () => {
  it("a placement is drawn with exactly the calls the preview uses for the same box", () => {
    for (const kind of [colorKind, glyphKind]) {
      const direct = recorder();
      drawEntityBox(direct.ctx, kind, L.toScreen(placementBox(entity(kind.id, 10, 5), kind)));
      const level = recorder();
      drawLevelWorld(level.ctx, L, display, [entity(kind.id, 10, 5)], []);
      expect(direct.calls.length).toBeGreaterThan(0);
      const at = level.calls.join("|").indexOf(direct.calls.join("|"));
      expect(at).toBeGreaterThan(-1);
    }
  });
  it("draws the world frame with the palette and clips to the world rectangle", () => {
    const r = recorder();
    drawLevelWorld(r.ctx, L, display, [], []);
    expect(r.calls).toContain("fillStyle=#000000");
    expect(r.calls).toContain("strokeStyle=#111111");
    expect(r.calls.some((c) => c.startsWith("clip"))).toBe(true);
  });
  it("a spawner is a band over its x/y range plus the size of its kind, with an arrow for its velocity", () => {
    expect(spawnerBand(spawner("block"), colorKind)).toEqual({ x: 0, y: 0, w: 12, h: 6 });
    const r = recorder();
    drawLevelWorld(r.ctx, L, display, [], [spawner("block")]);
    expect(r.calls.some((c) => c.startsWith("fillRect"))).toBe(true);
    expect(r.calls.filter((c) => c.startsWith("lineTo")).length).toBeGreaterThanOrEqual(3);
  });
  it("an unknown kind is skipped, not drawn or thrown", () => {
    const r = recorder();
    expect(() => drawLevelWorld(r.ctx, L, display, [entity("ghost", 1, 1)], [spawner("ghost")])).not.toThrow();
  });
  it("displayOf reads the display fields and withAlpha formats a colour", () => {
    const d = displayOf(JSON.stringify({ project: { displayName: "N" }, game: { orientation: "portrait", world: { width: 3, height: 4 }, input: { scheme: "tap", swipeSpeed: 2 }, palette: display.palette, hud: display.hud, screens: display.screens, runtime: { kinds: [{ ...colorKind, extra: 1 }] } } }));
    expect(d).toMatchObject({ displayName: "N", worldW: 3, worldH: 4, scheme: "tap" });
    expect(d.kinds[0]).toEqual(colorKind);
    expect(withAlpha("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
  });
});
