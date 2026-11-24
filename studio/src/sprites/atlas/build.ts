// Builds the project's one native atlas (spec v5, contract section 10) from a sheet of the animations manifest.
//
// The sheet's frames, in manifest order, become atlas frames 0..n-1 on a tight grid (frame n at column n mod columns, row
// n div columns), so "frame index" in a kind's sprite is the position in the sheet's frame list. The pixels are copied
// exactly (no scaling, no resampling). The numeric limits come from the engine's schema (atlasLimits), never from constants
// here; whether the finished atlas is a valid one is decided by the engine in apply.ts, not by this file.
import type { Sheet } from "../../project/manifests/types";
import type { SchemaModel } from "../../schema/schema";
import { encodePng, streamDeflate, toBase64, type Deflate, type RgbaImage } from "./png";

export interface AtlasLimits {
  maxFrameWidth: number; maxFrameHeight: number; maxColumns: number; maxRows: number;
  /** Longest base64 text of game.atlas.png. */
  maxPngBase64: number;
  /** Most frames one kind's sprite may name. */
  maxSpriteFrames: number;
  maxTicksPerFrame: number;
}
type FieldReader = Pick<SchemaModel, "field">;

/** The atlas limits as the engine's schema states them; null when the schema does not state one (then nothing is built). */
export function atlasLimits(schema: FieldReader): AtlasLimits | null {
  const f = (p: string) => schema.field(p);
  const n = (v: number | undefined) => (typeof v === "number" ? v : null);
  const parts = {
    maxFrameWidth: n(f("game.atlas.frameWidth")?.maximum), maxFrameHeight: n(f("game.atlas.frameHeight")?.maximum),
    maxColumns: n(f("game.atlas.columns")?.maximum), maxRows: n(f("game.atlas.rows")?.maximum),
    maxPngBase64: n(f("game.atlas.png")?.maxLength), maxSpriteFrames: n(f("game.runtime.kinds[].sprite.frames")?.maxItems),
    maxTicksPerFrame: n(f("game.runtime.kinds[].sprite.ticksPerFrame")?.maximum),
  };
  return Object.values(parts).some((v) => v === null) ? null : (parts as AtlasLimits);
}

/** The value of game.atlas. */
export interface AtlasValue { png: string; frameWidth: number; frameHeight: number; columns: number; rows: number }
export type AtlasBuild =
  | { ok: true; atlas: AtlasValue; pngBytes: number; /** Sheet frame id for each atlas frame index. */ frameIds: string[] }
  | { ok: false; error: string };

const fail = (error: string): AtlasBuild => ({ ok: false, error });

/** Grid shape for `count` frames: the sheet's own column count when it fits its frames exactly, otherwise as wide as allowed. */
export function atlasGrid(sheet: Pick<Sheet, "frames" | "grid">, maxColumns: number): { columns: number; rows: number } {
  const count = sheet.frames.length;
  const own = sheet.grid.columns;
  const exact = own >= 1 && own <= maxColumns && count === own * sheet.grid.rows;
  const columns = exact ? own : Math.min(count, maxColumns);
  return { columns, rows: Math.ceil(count / columns) };
}

export async function buildAtlas(image: RgbaImage, sheet: Pick<Sheet, "id" | "frames" | "grid">, limits: AtlasLimits, deflate: Deflate = streamDeflate): Promise<AtlasBuild> {
  const frames = sheet.frames;
  if (frames.length === 0) return fail(`sheet "${sheet.id}" has no frames`);
  const first = frames[0]!;
  const odd = frames.find((f) => f.w !== first.w || f.h !== first.h);
  if (odd) return fail(`the atlas needs frames of one size: frame ${first.id} is ${first.w}x${first.h} but ${odd.id} is ${odd.w}x${odd.h}`);
  if (first.w > limits.maxFrameWidth || first.h > limits.maxFrameHeight) {
    return fail(`frames are ${first.w}x${first.h} pixels; the atlas allows at most ${limits.maxFrameWidth}x${limits.maxFrameHeight}`);
  }
  if (image.data.length !== image.width * image.height * 4) return fail("the decoded image does not match its size");
  const outside = frames.find((f) => f.x < 0 || f.y < 0 || f.x + f.w > image.width || f.y + f.h > image.height);
  if (outside) return fail(`frame ${outside.id} lies outside the ${image.width}x${image.height} image`);
  const { columns, rows } = atlasGrid(sheet, limits.maxColumns);
  if (rows > limits.maxRows) return fail(`${frames.length} frames need ${rows} rows of ${columns}; the atlas allows ${limits.maxColumns} columns and ${limits.maxRows} rows (${limits.maxColumns * limits.maxRows} frames)`);
  const width = columns * first.w, height = rows * first.h;
  const data = new Uint8Array(width * height * 4);
  frames.forEach((f, n) => {
    const ox = (n % columns) * first.w, oy = Math.floor(n / columns) * first.h;
    for (let y = 0; y < f.h; y++) {
      const from = ((f.y + y) * image.width + f.x) * 4;
      data.set(image.data.subarray(from, from + f.w * 4), ((oy + y) * width + ox) * 4);
    }
  });
  const png = await encodePng({ width, height, data }, deflate);
  const text = toBase64(png);
  if (text.length > limits.maxPngBase64) {
    return fail(`the atlas PNG is ${text.length} characters of base64 (${png.length} bytes); the specification allows ${limits.maxPngBase64}. Use fewer or smaller frames, or simpler artwork`);
  }
  return { ok: true, atlas: { png: text, frameWidth: first.w, frameHeight: first.h, columns, rows }, pngBytes: png.length, frameIds: frames.map((f) => f.id) };
}
