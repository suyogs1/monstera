// Builds the project's one native atlas (spec v5, contract section 10) from a sheet of the animations manifest.
//
// The sheet's frames, in manifest order, become atlas frames 0..n-1 on a tight grid (frame n at column n mod columns, row
// n div columns), so "frame index" in a kind's sprite is the position in the sheet's frame list. Source frames may have
// arbitrary positive integer dimensions (including >128x128 or mixed sizes); when they differ from the target Spec v5 cell
// size (1..128 px), an explicit normalization step scales/fits them deterministically into uniform cells.
// The numeric limits come from the engine's schema (atlasLimits); whether the finished atlas is valid is decided by the
// engine in apply.ts.
import type { Frame, Sheet } from "../../project/manifests/types";
import type { SchemaModel } from "../../schema/schema";
import { encodePng, streamDeflate, toBase64, type Deflate, type RgbaImage } from "./png";

export interface AtlasLimits {
  maxFrameWidth: number;
  maxFrameHeight: number;
  maxColumns: number;
  maxRows: number;
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
    maxFrameWidth: n(f("game.atlas.frameWidth")?.maximum),
    maxFrameHeight: n(f("game.atlas.frameHeight")?.maximum),
    maxColumns: n(f("game.atlas.columns")?.maximum),
    maxRows: n(f("game.atlas.rows")?.maximum),
    maxPngBase64: n(f("game.atlas.png")?.maxLength),
    maxSpriteFrames: n(f("game.runtime.kinds[].sprite.frames")?.maxItems),
    maxTicksPerFrame: n(f("game.runtime.kinds[].sprite.ticksPerFrame")?.maximum),
  };
  return Object.values(parts).some((v) => v === null) ? null : (parts as AtlasLimits);
}

export type AtlasFitMode = "contain" | "cover" | "stretch";
export type AtlasScalingMode = "nearest" | "bilinear";

export interface AtlasNormalization {
  cellWidth: number;
  cellHeight: number;
  fit: AtlasFitMode;
  scaling: AtlasScalingMode;
}

/** Suggests a valid Spec v5 uniform cell size (clamped to 1..maxFrameWidth/Height) for a sheet's frames. */
export function suggestNormalization(
  frames: readonly Pick<Frame, "w" | "h">[],
  limits: Pick<AtlasLimits, "maxFrameWidth" | "maxFrameHeight">
): AtlasNormalization {
  if (frames.length === 0) {
    return { cellWidth: 32, cellHeight: 32, fit: "contain", scaling: "nearest" };
  }
  let maxW = 1;
  let maxH = 1;
  for (const f of frames) {
    if (f.w > maxW) maxW = f.w;
    if (f.h > maxH) maxH = f.h;
  }
  return {
    cellWidth: Math.max(1, Math.min(maxW, limits.maxFrameWidth)),
    cellHeight: Math.max(1, Math.min(maxH, limits.maxFrameHeight)),
    fit: "contain",
    scaling: "nearest",
  };
}

/** Normalizes one source crop rectangle into a uniform `cellWidth × cellHeight` RGBA buffer. */
export function normalizeFrameRgba(
  image: RgbaImage,
  frame: Pick<Frame, "x" | "y" | "w" | "h">,
  norm: AtlasNormalization
): Uint8Array {
  const { cellWidth: cw, cellHeight: ch, fit, scaling } = norm;
  const out = new Uint8Array(cw * ch * 4);

  // Exact 1:1 copy when source crop already matches target cell size.
  if (frame.w === cw && frame.h === ch) {
    for (let y = 0; y < ch; y++) {
      const from = ((frame.y + y) * image.width + frame.x) * 4;
      out.set(image.data.subarray(from, from + cw * 4), y * cw * 4);
    }
    return out;
  }

  let dw = cw;
  let dh = ch;
  let ox = 0;
  let oy = 0;
  if (fit === "contain") {
    const scale = Math.min(cw / frame.w, ch / frame.h);
    dw = Math.max(1, Math.round(frame.w * scale));
    dh = Math.max(1, Math.round(frame.h * scale));
    ox = Math.floor((cw - dw) / 2);
    oy = Math.floor((ch - dh) / 2);
  } else if (fit === "cover") {
    const scale = Math.max(cw / frame.w, ch / frame.h);
    dw = Math.max(1, Math.round(frame.w * scale));
    dh = Math.max(1, Math.round(frame.h * scale));
    ox = Math.floor((cw - dw) / 2);
    oy = Math.floor((ch - dh) / 2);
  }

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const src = image.data;
  const imgW = image.width;

  for (let dy = 0; dy < ch; dy++) {
    const ly = dy - oy;
    if (ly < 0 || ly >= dh) continue;
    for (let dx = 0; dx < cw; dx++) {
      const lx = dx - ox;
      if (lx < 0 || lx >= dw) continue;
      const dstIdx = (dy * cw + dx) * 4;

      if (scaling === "nearest") {
        const sx = clamp(Math.floor((lx * frame.w) / dw), 0, frame.w - 1);
        const sy = clamp(Math.floor((ly * frame.h) / dh), 0, frame.h - 1);
        const sIdx = ((frame.y + sy) * imgW + (frame.x + sx)) * 4;
        out[dstIdx] = src[sIdx]!;
        out[dstIdx + 1] = src[sIdx + 1]!;
        out[dstIdx + 2] = src[sIdx + 2]!;
        out[dstIdx + 3] = src[sIdx + 3]!;
      } else {
        const fx = clamp(((lx + 0.5) * frame.w) / dw - 0.5, 0, frame.w - 1);
        const fy = clamp(((ly + 0.5) * frame.h) / dh - 0.5, 0, frame.h - 1);
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const x1 = Math.min(x0 + 1, frame.w - 1);
        const y1 = Math.min(y0 + 1, frame.h - 1);
        const tx = fx - x0;
        const ty = fy - y0;

        const w00 = (1 - tx) * (1 - ty);
        const w10 = tx * (1 - ty);
        const w01 = (1 - tx) * ty;
        const w11 = tx * ty;

        const i00 = ((frame.y + y0) * imgW + (frame.x + x0)) * 4;
        const i10 = ((frame.y + y0) * imgW + (frame.x + x1)) * 4;
        const i01 = ((frame.y + y1) * imgW + (frame.x + x0)) * 4;
        const i11 = ((frame.y + y1) * imgW + (frame.x + x1)) * 4;

        const a00 = src[i00 + 3]! * w00;
        const a10 = src[i10 + 3]! * w10;
        const a01 = src[i01 + 3]! * w01;
        const a11 = src[i11 + 3]! * w11;
        const aSum = a00 + a10 + a01 + a11;

        if (aSum <= 0) {
          out[dstIdx] = 0;
          out[dstIdx + 1] = 0;
          out[dstIdx + 2] = 0;
          out[dstIdx + 3] = 0;
        } else {
          out[dstIdx] = Math.round((src[i00]! * a00 + src[i10]! * a10 + src[i01]! * a01 + src[i11]! * a11) / aSum);
          out[dstIdx + 1] = Math.round((src[i00 + 1]! * a00 + src[i10 + 1]! * a10 + src[i01 + 1]! * a01 + src[i11 + 1]! * a11) / aSum);
          out[dstIdx + 2] = Math.round((src[i00 + 2]! * a00 + src[i10 + 2]! * a10 + src[i01 + 2]! * a01 + src[i11 + 2]! * a11) / aSum);
          out[dstIdx + 3] = Math.round(aSum);
        }
      }
    }
  }
  return out;
}

/** The value of game.atlas. */
export interface AtlasValue {
  png: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
}
export type AtlasBuild =
  | {
      ok: true;
      atlas: AtlasValue;
      pngBytes: number;
      /** Sheet frame id for each atlas frame index. */
      frameIds: string[];
      /** Original source frame sizes before normalization. */
      sourceSizes: { id: string; w: number; h: number }[];
      /** True when any source frame differed from the target cell size. */
      normalized: boolean;
    }
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

export interface BuildAtlasOptions {
  normalization?: AtlasNormalization;
  deflate?: Deflate;
}

export async function buildAtlas(
  image: RgbaImage,
  sheet: Pick<Sheet, "id" | "frames" | "grid">,
  limits: AtlasLimits,
  optionsOrDeflate: Deflate | BuildAtlasOptions = streamDeflate
): Promise<AtlasBuild> {
  const deflate = typeof optionsOrDeflate === "function" ? optionsOrDeflate : (optionsOrDeflate.deflate ?? streamDeflate);
  const frames = sheet.frames;
  if (frames.length === 0) return fail(`sheet "${sheet.id}" has no frames`);

  const norm: AtlasNormalization =
    typeof optionsOrDeflate === "object" && optionsOrDeflate.normalization
      ? optionsOrDeflate.normalization
      : suggestNormalization(frames, limits);

  if (!Number.isSafeInteger(norm.cellWidth) || norm.cellWidth < 1 || !Number.isSafeInteger(norm.cellHeight) || norm.cellHeight < 1) {
    return fail("normalized cell width and height must be positive integers");
  }
  if (norm.cellWidth > limits.maxFrameWidth || norm.cellHeight > limits.maxFrameHeight) {
    return fail(`atlas cell size is ${norm.cellWidth}x${norm.cellHeight} pixels; the specification allows at most ${limits.maxFrameWidth}x${limits.maxFrameHeight}`);
  }
  if (image.data.length !== image.width * image.height * 4) return fail("the decoded image does not match its size");
  const outside = frames.find((f) => f.x < 0 || f.y < 0 || f.x + f.w > image.width || f.y + f.h > image.height);
  if (outside) return fail(`frame ${outside.id} lies outside the ${image.width}x${image.height} image`);

  const { columns, rows } = atlasGrid(sheet, limits.maxColumns);
  if (rows > limits.maxRows) {
    return fail(
      `${frames.length} frames need ${rows} rows of ${columns}; the atlas allows ${limits.maxColumns} columns and ${limits.maxRows} rows (${limits.maxColumns * limits.maxRows} frames)`
    );
  }

  const cw = norm.cellWidth;
  const ch = norm.cellHeight;
  const width = columns * cw;
  const height = rows * ch;
  const data = new Uint8Array(width * height * 4);

  let normalized = false;
  frames.forEach((f, n) => {
    if (f.w !== cw || f.h !== ch) normalized = true;
    const cell = normalizeFrameRgba(image, f, norm);
    const ox = (n % columns) * cw;
    const oy = Math.floor(n / columns) * ch;
    for (let y = 0; y < ch; y++) {
      const from = y * cw * 4;
      data.set(cell.subarray(from, from + cw * 4), ((oy + y) * width + ox) * 4);
    }
  });

  const png = await encodePng({ width, height, data }, deflate);
  const text = toBase64(png);
  if (text.length > limits.maxPngBase64) {
    return fail(
      `the atlas PNG is ${text.length} characters of base64 (${png.length} bytes); the specification allows ${limits.maxPngBase64}. Use fewer or smaller frames, or simpler artwork`
    );
  }
  return {
    ok: true,
    atlas: { png: text, frameWidth: cw, frameHeight: ch, columns, rows },
    pngBytes: png.length,
    frameIds: frames.map((f) => f.id),
    sourceSizes: frames.map((f) => ({ id: f.id, w: f.w, h: f.h })),
    normalized,
  };
}
