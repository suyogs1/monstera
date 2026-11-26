// Native sprite authoring (spec v5): encoding, frame mapping, assignments and the apply path. Validation is answered by the real
// Python engine (derive/testEngine); the oracle there is a counter, the real oracle runs in atlas.e2e.test.ts.
import { describe, expect, it } from "vitest";
import { Engine } from "../../derive/testEngine";
import type { OracleCheck } from "../../engine/protocol";
import { stableText } from "../../project/record";
import { NEUTRAL_ATLAS } from "../../project/specV5";
import { pumpkinDoc } from "../../project/xref.testkit";
import type { Json } from "../../schema/schema";
import { applyChange, describeIssues, planSpriteApply, spritesOfDoc, type SpriteChange } from "./apply";
import { parseFrames, parseTicksPerFrame, spriteFromAnimation } from "./assign";
import { atlasGrid, atlasLimits, buildAtlas, normalizeFrameRgba, suggestNormalization } from "./build";
import { frameRect, spriteFrameAt } from "./frame";
import { fromBase64, toBase64 } from "./png";
import { colourOf, decodePng, LIMITS, paintedSheet, pixelAt, schemaModel } from "./atlas.testkit";

const neutralChange = (doc: Json): SpriteChange => ({ atlas: { ...NEUTRAL_ATLAS }, sprites: Object.fromEntries(spritesOfDoc(doc).kinds.map((k) => [k.id, { frames: [], ticksPerFrame: 1 }])) });
/** The pumpkin spec with its atlas and every sprite reset to the documented neutral values: a project with nothing authored. */
const blank = (): Json => { const r = applyChange(pumpkinDoc(), neutralChange(pumpkinDoc())); if (!r.ok) throw new Error(r.message); return r.doc; };

describe("limits come from the engine schema", () => {
  it("are read from the schema model, and a schema that lacks one yields none", () => {
    expect(LIMITS).toEqual({ maxFrameWidth: 128, maxFrameHeight: 128, maxColumns: 16, maxRows: 16, maxPngBase64: 1048576, maxSpriteFrames: 4, maxTicksPerFrame: 600 });
    expect(atlasLimits({ field: (p: string) => (p === "game.atlas.png" ? undefined : schemaModel.field(p)) })).toBeNull();
  });
});

describe("buildAtlas", () => {
  it("repacks the sheet's frames in order onto a tight grid and copies every pixel exactly", async () => {
    const { image, sheet } = paintedSheet({ columns: 3, rows: 2, cell: 8, margin: 2, spacing: 1 });
    const r = await buildAtlas(image, sheet, LIMITS);
    if (!r.ok) throw new Error(r.error);
    expect(r.atlas).toMatchObject({ frameWidth: 8, frameHeight: 8, columns: 3, rows: 2 });
    expect(r.frameIds).toEqual(["f0", "f1", "f2", "f3", "f4", "f5"]);
    const png = fromBase64(r.atlas.png);
    expect(png).not.toBeNull();
    const out = decodePng(png!);
    expect([out.width, out.height]).toEqual([24, 16]);
    for (let n = 0; n < 6; n++) {
      const rect = frameRect(r.atlas, n)!;
      for (const [dx, dy] of [[0, 0], [7, 7], [3, 5]]) expect(pixelAt(out, rect.x + dx!, rect.y + dy!)).toEqual(colourOf(n));
    }
    expect(toBase64(png!)).toBe(r.atlas.png);
  });
  it("is deterministic for the same input", async () => {
    const { image, sheet } = paintedSheet({ columns: 2, rows: 2, cell: 16 });
    const a = await buildAtlas(image, sheet, LIMITS), b = await buildAtlas(image, sheet, LIMITS);
    expect(a).toEqual(b);
  });
  it("lays out a sheet whose frame count is not columns x rows on as many columns as the limit allows", () => {
    const sheet = { frames: Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, x: 0, y: 0, w: 4, h: 4 })), grid: { frameWidth: 4, frameHeight: 4, columns: 2, rows: 2, margin: 0, spacing: 0 } };
    expect(atlasGrid(sheet, 16)).toEqual({ columns: 5, rows: 1 });
    expect(atlasGrid(sheet, 3)).toEqual({ columns: 3, rows: 2 });
  });
  it("normalizes mixed-size and >128x128 source crops into uniform <=128x128 Spec v5 cells", async () => {
    const w = 220, h = 160;
    const data = new Uint8Array(w * h * 4);
    // Paint frame 0 (160x140) red in the center and transparent at corners
    for (let y = 10; y < 130; y++) for (let x = 10; x < 150; x++) data.set([220, 40, 40, 255], (y * w + x) * 4);
    // Paint frame 1 (40x20) green at (170, 0)
    for (let y = 0; y < 20; y++) for (let x = 170; x < 210; x++) data.set([40, 200, 80, 255], (y * w + x) * 4);
    const sheet = {
      id: "mixed",
      frames: [
        { id: "big", x: 0, y: 0, w: 160, h: 140 },
        { id: "small", x: 170, y: 0, w: 40, h: 20 },
      ],
      grid: { frameWidth: 32, frameHeight: 32, columns: 2, rows: 1, margin: 0, spacing: 0 },
    };
    const suggested = suggestNormalization(sheet.frames, LIMITS);
    expect(suggested).toEqual({ cellWidth: 128, cellHeight: 128, fit: "contain", scaling: "nearest" });
    const r = await buildAtlas({ width: w, height: h, data }, sheet, LIMITS, { normalization: { cellWidth: 64, cellHeight: 64, fit: "contain", scaling: "nearest" } });
    if (!r.ok) throw new Error(r.error);
    expect(r.normalized).toBe(true);
    expect(r.atlas).toMatchObject({ frameWidth: 64, frameHeight: 64, columns: 2, rows: 1 });
    const out = decodePng(fromBase64(r.atlas.png)!);
    expect([out.width, out.height]).toEqual([128, 64]);
    // Contain preserves aspect ratio of 40x20 -> 64x32 centered vertically (y padding 0..15 is transparent)
    expect(pixelAt(out, 64 + 10, 4)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(out, 64 + 32, 32)).toEqual([40, 200, 80, 255]);
    // Bilinear scaling also produces valid RGBA output
    const bi = normalizeFrameRgba({ width: w, height: h, data }, sheet.frames[0]!, { cellWidth: 32, cellHeight: 32, fit: "contain", scaling: "bilinear" });
    expect(bi.length).toBe(32 * 32 * 4);
  });

  it("refuses with the exact reason: no frames, oversize cell normalization, frames outside the image, too many rows, too large a PNG", async () => {
    const { image, sheet } = paintedSheet({ columns: 2, rows: 1, cell: 8 });
    expect(await buildAtlas(image, { ...sheet, frames: [] }, LIMITS)).toMatchObject({ ok: false, error: expect.stringContaining("has no frames") });
    expect(await buildAtlas(image, sheet, LIMITS, { normalization: { cellWidth: 129, cellHeight: 64, fit: "contain", scaling: "nearest" } })).toMatchObject({ ok: false, error: expect.stringContaining("at most 128x128") });
    const outside = { ...sheet, frames: [{ ...sheet.frames[0]!, x: 12 }] };
    expect(await buildAtlas(image, outside, LIMITS)).toMatchObject({ ok: false, error: expect.stringContaining("outside") });
    const many = { ...sheet, frames: Array.from({ length: 257 }, (_, i) => ({ id: `g${i}`, x: 0, y: 0, w: 8, h: 8 })), grid: { ...sheet.grid, columns: 1, rows: 1 } };
    expect(await buildAtlas(image, many, LIMITS)).toMatchObject({ ok: false, error: expect.stringContaining("17 rows") });
    // Realistic >24 KiB atlas (16 frames of 32x32 incompressible noise, ~65 KiB base64) now succeeds under 1 MiB limit,
    // while exceeding LIMITS.maxPngBase64 is still refused with the schema limit message.
    const n = 32, frames = 16;
    const noise = new Uint8Array(n * frames * n * 4);
    let s = 12345;
    for (let i = 0; i < noise.length; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; noise[i] = s & 255; }
    const sheetN = { id: "noise", frames: Array.from({ length: frames }, (_, i) => ({ id: `f${i}`, x: i * n, y: 0, w: n, h: n })), grid: { frameWidth: n, frameHeight: n, columns: frames, rows: 1, margin: 0, spacing: 0 } };
    const realistic = await buildAtlas({ width: n * frames, height: n, data: noise }, sheetN, LIMITS);
    expect(realistic.ok).toBe(true);
    if (realistic.ok) expect(realistic.atlas.png.length).toBeGreaterThan(24576);
    const overTight = await buildAtlas({ width: n * frames, height: n, data: noise }, sheetN, { ...LIMITS, maxPngBase64: 24576 });
    expect(overTight).toMatchObject({ ok: false, error: expect.stringContaining("the specification allows 24576") });
  });
});

describe("the frame rule", () => {
  it("shows frames[(t div ticksPerFrame) mod count], and nothing for a kind without frames", () => {
    const s = { frames: [2, 3, 5], ticksPerFrame: 4 };
    expect([0, 3, 4, 7, 8, 11, 12, 13].map((t) => spriteFrameAt(s, t))).toEqual([2, 2, 3, 3, 5, 5, 2, 2]);
    expect(spriteFrameAt({ frames: [], ticksPerFrame: 1 }, 5)).toBeNull();
    expect(spriteFrameAt({ frames: [1], ticksPerFrame: 9 }, 1000)).toBe(1);
  });
  it("frame n is at column n mod columns, row n div columns, and only inside the atlas", () => {
    const a = { frameWidth: 8, frameHeight: 4, columns: 3, rows: 2 };
    expect(frameRect(a, 4)).toEqual({ x: 8, y: 4, w: 8, h: 4 });
    expect(frameRect(a, 6)).toBeNull();
  });
});

describe("assignments", () => {
  it("parses a frame list and refuses bad numbers, frames outside the atlas and too many frames", () => {
    expect(parseFrames("0, 1 2", 4, LIMITS)).toEqual({ ok: true, value: [0, 1, 2] });
    expect(parseFrames("", 4, LIMITS)).toEqual({ ok: true, value: [] });
    expect(parseFrames("0, x", 4, LIMITS)).toMatchObject({ ok: false, error: expect.stringContaining('"x"') });
    expect(parseFrames("1.5", 4, LIMITS)).toMatchObject({ ok: false });
    expect(parseFrames("4", 4, LIMITS)).toMatchObject({ ok: false, error: expect.stringContaining("frame 4 does not exist") });
    expect(parseFrames("0", 0, LIMITS)).toMatchObject({ ok: false, error: expect.stringContaining("build one first") });
    expect(parseFrames("0,1,2,3,0", 4, LIMITS)).toMatchObject({ ok: false, error: expect.stringContaining("at most 4") });
  });
  it("bounds ticks per frame", () => {
    expect(parseTicksPerFrame(600, LIMITS)).toEqual({ ok: true, value: 600 });
    for (const bad of [0, 601, 1.5, -1]) expect(parseTicksPerFrame(bad, LIMITS).ok).toBe(false);
  });
  const sheet = { id: "hero", frames: ["f0", "f1", "f2"].map((id, i) => ({ id, x: i * 8, y: 0, w: 8, h: 8 })) };
  it("converts a looping animation: entries map to atlas indices, holds become equal intervals", () => {
    const seq = (holds: number[], ids = ["f2", "f0", "f1"]) => holds.map((h, i) => ({ frameId: ids[i]!, holdFrames: h }));
    expect(spriteFromAnimation({ id: "a", loop: "loop", fps: 10, sequence: seq([1, 1, 1]) }, sheet, 60, LIMITS)).toEqual({ ok: true, value: { frames: [2, 0, 1], ticksPerFrame: 6 } });
    expect(spriteFromAnimation({ id: "a", loop: "loop", fps: 10, sequence: seq([2, 2, 2]) }, sheet, 60, LIMITS)).toEqual({ ok: true, value: { frames: [2, 0, 1], ticksPerFrame: 12 } });
    expect(spriteFromAnimation({ id: "a", loop: "loop", fps: 10, sequence: seq([2, 1]) }, sheet, 60, LIMITS)).toEqual({ ok: true, value: { frames: [2, 2, 0], ticksPerFrame: 6 } });
  });
  it("refuses an animation that cannot be shown exactly", () => {
    const entry = (frameId: string, holdFrames = 1) => ({ frameId, holdFrames });
    expect(spriteFromAnimation({ id: "a", loop: "once", fps: 8, sequence: [entry("f0")] }, sheet, 60, LIMITS)).toMatchObject({ ok: false, error: expect.stringContaining("only loop") });
    expect(spriteFromAnimation({ id: "a", loop: "pingpong", fps: 8, sequence: [entry("f0")] }, sheet, 60, LIMITS)).toMatchObject({ ok: false });
    expect(spriteFromAnimation({ id: "a", loop: "loop", fps: 8, sequence: [entry("f9")] }, sheet, 60, LIMITS)).toMatchObject({ ok: false, error: expect.stringContaining("does not have") });
    expect(spriteFromAnimation({ id: "a", loop: "loop", fps: 8, sequence: [entry("f0"), entry("f1"), entry("f2"), entry("f0"), entry("f1")] }, sheet, 60, LIMITS)).toMatchObject({ ok: false, error: expect.stringContaining("at most 4") });
    expect(spriteFromAnimation({ id: "a", loop: "loop", fps: 1, sequence: [entry("f0", 60), entry("f1", 60)] }, sheet, 60, LIMITS)).toMatchObject({ ok: false, error: expect.stringContaining("most allowed is 600") });
  });
});

describe("planSpriteApply (real engine validation)", () => {
  const author = async (frames = 4) => {
    const { image, sheet } = paintedSheet({ columns: frames, rows: 1, cell: 16 });
    const r = await buildAtlas(image, sheet, LIMITS);
    if (!r.ok) throw new Error(r.error);
    return r.atlas;
  };
  const kinds = (doc: Json) => spritesOfDoc(doc).kinds.map((k) => k.id);

  it("a valid atlas with a still and an animated kind is accepted; only game.atlas and the named sprites differ", async () => {
    const doc = blank();
    const [a, b] = kinds(doc) as [string, string];
    const atlas = await author();
    const before = stableText(doc);
    const r = await planSpriteApply(doc, { atlas, sprites: { [a]: { frames: [0], ticksPerFrame: 1 }, [b]: { frames: [1, 2, 3], ticksPerFrame: 6 } } }, new Engine());
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(stableText(doc)).toBe(before); // the input is never mutated
    const next = spritesOfDoc(r.doc);
    expect(next.atlas).toEqual(atlas);
    expect(next.kinds.find((k) => k.id === a)?.sprite).toEqual({ frames: [0], ticksPerFrame: 1 });
    expect(next.kinds.find((k) => k.id === b)?.sprite).toEqual({ frames: [1, 2, 3], ticksPerFrame: 6 });
    // Everything else is carried through unchanged.
    const strip = (d: Json) => { const c = JSON.parse(stableText(d)); delete c.game.atlas; for (const k of c.game.runtime.kinds) delete k.sprite; return c; };
    expect(strip(r.doc)).toEqual(strip(doc));
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("frames outside the atlas, sprites without an atlas and a third animated kind are refused by the engine with its own messages", async () => {
    const doc = blank();
    const [a, b, c] = kinds(doc) as [string, string, string];
    const atlas = await author();
    const outside = await planSpriteApply(doc, { atlas, sprites: { [a]: { frames: [4], ticksPerFrame: 1 } } }, new Engine());
    expect(outside).toMatchObject({ ok: false, stage: "engine" });
    expect(outside.ok ? "" : outside.message).toMatch(/frame 4 is outside the atlas/);
    const noAtlas = await planSpriteApply(doc, { sprites: { [a]: { frames: [0], ticksPerFrame: 1 } } }, new Engine());
    expect(noAtlas.ok ? "" : noAtlas.message).toMatch(/atlas is empty|game\.atlas\.png is empty/);
    const three = await planSpriteApply(doc, { atlas, sprites: { [a]: { frames: [0, 1], ticksPerFrame: 2 }, [b]: { frames: [1, 2], ticksPerFrame: 2 }, [c]: { frames: [2, 3], ticksPerFrame: 2 } } }, new Engine());
    expect(three).toMatchObject({ ok: false, stage: "engine" });
    expect(three.ok ? [] : describeIssues(three.issues).join("\n")).toMatch(/animat/i);
  });
  it("a PNG of the wrong size for its declared grid is refused by the engine", async () => {
    const doc = blank();
    const atlas = await author();
    const r = await planSpriteApply(doc, { atlas: { ...atlas, columns: atlas.columns + 1 }, sprites: {} }, new Engine());
    expect(r).toMatchObject({ ok: false, stage: "engine" });
    expect(r.ok ? "" : r.message).toMatch(/pixels/);
  });
  it("an unknown kind is refused before the engine is asked", async () => {
    const e = new Engine();
    const r = await planSpriteApply(blank(), { sprites: { nope: { frames: [], ticksPerFrame: 1 } } }, e);
    expect(r).toMatchObject({ ok: false, stage: "precondition", message: expect.stringContaining('"nope"') });
  });
  it("a change that moved the oracle hash is refused and nothing is returned", async () => {
    class Drifting extends Engine {
      override async oracleCheck(text: string, seed: number, ticks: number): Promise<OracleCheck> {
        const r = await super.oracleCheck(text, seed, ticks);
        return r.ok ? { ...r, hash: text.includes('"png": ""') ? "a".repeat(16) : "b".repeat(16) } : r;
      }
    }
    const doc = blank();
    const atlas = await author();
    const r = await planSpriteApply(doc, { atlas, sprites: {} }, new Drifting());
    expect(r).toMatchObject({ ok: false, stage: "oracle", message: expect.stringContaining("altered the simulation") });
  });
  it("an oracle failure is reported with its stage", async () => {
    const e = new Engine();
    e.failOracle = "boom";
    const atlas = await author();
    expect(await planSpriteApply(blank(), { atlas, sprites: {} }, e)).toMatchObject({ ok: false, stage: "oracle", message: "run: boom" });
  });
  it("removing the atlas returns every kind to the neutral sprite", async () => {
    const r = await planSpriteApply(pumpkinDoc(), neutralChange(pumpkinDoc()), new Engine());
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(spritesOfDoc(r.doc).atlas).toEqual(NEUTRAL_ATLAS);
    expect(spritesOfDoc(r.doc).kinds.every((k) => k.sprite?.frames.length === 0)).toBe(true);
  });
});
