// Pure grid slicing for sprite sheets (task 3.1). Integer pixels only; no DOM, no clock.
import type { Frame, Sheet } from "../project/manifests/types";

export type Grid = Sheet["grid"];
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const MAX_FRAMES_PER_SHEET = 1024; // animations.schema.json sheets[].frames.maxItems

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);

/** Pixel size the grid needs: margin + n*size + (n-1)*spacing on each axis (no trailing margin required). */
export function gridExtent(g: Grid): { width: number; height: number } {
  return {
    width: g.margin + g.columns * g.frameWidth + (g.columns - 1) * g.spacing,
    height: g.margin + g.rows * g.frameHeight + (g.rows - 1) * g.spacing,
  };
}

export function frameId(index: number): string {
  return `f${index}`;
}

/** Slice a grid into frames, row-major, ids f0, f1, ... Rejects grids outside the image with the exact reason. */
export function sliceGrid(g: Grid, imageWidth: number, imageHeight: number): Result<Frame[]> {
  const fields: [string, number, number][] = [
    ["frameWidth", g.frameWidth, 1], ["frameHeight", g.frameHeight, 1], ["columns", g.columns, 1],
    ["rows", g.rows, 1], ["margin", g.margin, 0], ["spacing", g.spacing, 0],
  ];
  for (const [name, v, min] of fields) {
    if (!isInt(v)) return { ok: false, error: `${name} must be an integer` };
    if (v < min) return { ok: false, error: `${name} must be at least ${min}` };
  }
  if (!isInt(imageWidth) || imageWidth < 1 || !isInt(imageHeight) || imageHeight < 1) {
    return { ok: false, error: "image width and height must be positive integers" };
  }
  const count = g.columns * g.rows;
  if (count > MAX_FRAMES_PER_SHEET) {
    return { ok: false, error: `grid has ${count} frames, the limit is ${MAX_FRAMES_PER_SHEET}` };
  }
  const { width, height } = gridExtent(g);
  if (width > imageWidth) return { ok: false, error: `grid is ${width}px wide, image is ${imageWidth}px` };
  if (height > imageHeight) return { ok: false, error: `grid is ${height}px high, image is ${imageHeight}px` };
  const frames: Frame[] = [];
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.columns; c++) {
      frames.push({
        id: frameId(r * g.columns + c),
        x: g.margin + c * (g.frameWidth + g.spacing),
        y: g.margin + r * (g.frameHeight + g.spacing),
        w: g.frameWidth,
        h: g.frameHeight,
      });
    }
  }
  return { ok: true, value: frames };
}

/** True when the rectangle is integer, non-empty and inside the image. */
export function frameInBounds(f: Frame, imageWidth: number, imageHeight: number): boolean {
  return [f.x, f.y, f.w, f.h].every(isInt) && f.x >= 0 && f.y >= 0 && f.w >= 1 && f.h >= 1 &&
    f.x + f.w <= imageWidth && f.y + f.h <= imageHeight;
}
