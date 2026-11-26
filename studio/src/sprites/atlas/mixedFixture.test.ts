// The committed mixed-size artwork fixture (docs/evidence/mixed-size-atlas/monstera.spec.json).
//
// Six source crops of different sizes (one wider than 128 px, one 200 px wide) with transparent borders are normalized by the real
// buildAtlas into 48x48 cells. The resulting atlas is larger than the old 24 KiB base64 limit, so the fixture also exercises the
// 1 MiB limit. The monstera.yml Android and iOS jobs generate, verify, compile and (iOS) launch this exact spec, so the platforms
// decode what Studio normalizes. This test fails when the committed spec no longer equals what Studio builds.
// Rewrite after a deliberate change: MONSTERA_WRITE_MIXED_FIXTURE=1 npx vitest --run src/sprites/atlas/mixedFixture.test.ts, then
// `monstera format` the file.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAtlas } from "./build";
import { LIMITS } from "./atlas.testkit";

const repo = join(__dirname, "..", "..", "..", "..");
const base = join(repo, "docs", "evidence", "atlas-native-proof", "monstera.spec.json");
const fixture = join(repo, "docs", "evidence", "mixed-size-atlas", "monstera.spec.json");

const CROPS = [
  { id: "hero-wide", x: 0, y: 0, w: 160, h: 140 },
  { id: "step-a", x: 160, y: 0, w: 48, h: 24 },
  { id: "step-b", x: 160, y: 24, w: 32, h: 32 },
  { id: "step-c", x: 160, y: 56, w: 64, h: 40 },
  { id: "banner", x: 0, y: 140, w: 200, h: 96 },
  { id: "badge", x: 200, y: 140, w: 100, h: 100 },
];
const SHEET = { id: "mixed", frames: CROPS, grid: { frameWidth: 32, frameHeight: 32, columns: 6, rows: 1, margin: 0, spacing: 0 } };
const WIDTH = 300;
const HEIGHT = 240;

/** Deterministic artwork: a 4 px transparent border inside every crop, pseudo-random opaque pixels elsewhere (hardly compressible). */
function artwork(): Uint8Array {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  let s = 0x2545f491;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 24);
  for (const c of CROPS) {
    for (let y = c.y + 4; y < c.y + c.h - 4; y++) {
      for (let x = c.x + 4; x < c.x + c.w - 4; x++) data.set([next(), next(), next(), 255], (y * WIDTH + x) * 4);
    }
  }
  return data;
}

describe("mixed-size artwork fixture", { timeout: 60_000 }, () => {
  it("equals what Studio builds from the six crops, and needs the 1 MiB atlas limit", async () => {
    const built = await buildAtlas({ width: WIDTH, height: HEIGHT, data: artwork() }, SHEET, LIMITS, {
      normalization: { cellWidth: 48, cellHeight: 48, fit: "contain", scaling: "nearest" },
    });
    if (!built.ok) throw new Error(built.error);
    expect(built.normalized).toBe(true);
    expect(built.atlas).toMatchObject({ frameWidth: 48, frameHeight: 48, columns: 6, rows: 1 });
    expect(built.atlas.png.length).toBeGreaterThan(24576);
    expect(built.atlas.png.length).toBeLessThanOrEqual(LIMITS.maxPngBase64);

    const spec = JSON.parse(readFileSync(base, "utf8"));
    spec.project.id = "mixed-atlas";
    spec.project.displayName = "Mixed Atlas";
    spec.project.identifier = "app.monstera.mixedatlas";
    spec.game.atlas = built.atlas;
    const sprites: Record<string, { frames: number[]; ticksPerFrame: number }> = {
      keeper: { frames: [0], ticksPerFrame: 1 },
      lantern: { frames: [4], ticksPerFrame: 1 },
      wisp: { frames: [1, 2, 3, 5], ticksPerFrame: 6 },
    };
    for (const k of spec.game.runtime.kinds) k.sprite = sprites[k.id as string] ?? k.sprite;

    if (process.env.MONSTERA_WRITE_MIXED_FIXTURE === "1") writeFileSync(fixture, JSON.stringify(spec, null, 2) + "\n");
    const committed = JSON.parse(readFileSync(fixture, "utf8"));
    expect(committed.game.atlas).toEqual(spec.game.atlas);
    expect(committed.game.runtime.kinds.map((k: { id: string; sprite: unknown }) => [k.id, k.sprite])).toEqual(
      spec.game.runtime.kinds.map((k: { id: string; sprite: unknown }) => [k.id, k.sprite])
    );
    expect(committed.project).toEqual(spec.project);
  });
});
