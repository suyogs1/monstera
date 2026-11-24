// Helpers for the atlas authoring tests. Imported by tests only.
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SchemaModel } from "../../schema/schema";
import type { Sheet } from "../../project/manifests/types";
import { atlasLimits, type AtlasLimits } from "./build";
import type { RgbaImage } from "./png";

const schemaDir = join(__dirname, "..", "..", "..", "..", "spec", "schema");
export const schemaModel = new SchemaModel(Object.fromEntries(
  ["monstera.spec.schema.json", "project.schema.json", "game.schema.json"].map((n) => [n, readFileSync(join(schemaDir, n), "utf8")])));
export const LIMITS: AtlasLimits = (() => { const l = atlasLimits(schemaModel); if (!l) throw new Error("schema has no atlas limits"); return l; })();

/** A source image whose cell (col,row) of `cell` pixels is one solid colour derived from its index, over a margin/spacing grid. */
export function paintedSheet(opts: { columns: number; rows: number; cell: number; margin?: number; spacing?: number }): { image: RgbaImage; sheet: Pick<Sheet, "id" | "frames" | "grid"> } {
  const { columns, rows, cell } = opts, margin = opts.margin ?? 0, spacing = opts.spacing ?? 0;
  const width = margin + columns * cell + (columns - 1) * spacing, height = margin + rows * cell + (rows - 1) * spacing;
  const data = new Uint8Array(width * height * 4);
  const frames: Sheet["frames"] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
    const n = r * columns + c, x = margin + c * (cell + spacing), y = margin + r * (cell + spacing);
    frames.push({ id: `f${n}`, x, y, w: cell, h: cell });
    for (let yy = 0; yy < cell; yy++) for (let xx = 0; xx < cell; xx++) data.set(colourOf(n), ((y + yy) * width + x + xx) * 4);
  }
  return { image: { width, height, data }, sheet: { id: "hero", frames, grid: { frameWidth: cell, frameHeight: cell, columns, rows, margin, spacing } } };
}
export const colourOf = (n: number): number[] => [(n * 37 + 11) & 255, (n * 91 + 5) & 255, (n * 17 + 200) & 255, 255];

/** Decodes an 8-bit RGBA PNG made by encodePng (filters None, Sub, Up). Independent of the encoder's code. */
export function decodePng(png: Uint8Array): RgbaImage {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  let width = 0, height = 0;
  const idat: Uint8Array[] = [];
  while (at < png.length) {
    const len = dv.getUint32(at), type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") { width = new DataView(body.buffer, body.byteOffset).getUint32(0); height = new DataView(body.buffer, body.byteOffset).getUint32(4); }
    if (type === "IDAT") idat.push(body);
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4, out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i]!;
      const left = i >= 4 ? out[y * stride + i - 4]! : 0, up = y > 0 ? out[(y - 1) * stride + i]! : 0;
      out[y * stride + i] = (f === 0 ? v : f === 1 ? v + left : f === 2 ? v + up : NaN) & 255;
      if (f > 2) throw new Error("unexpected filter");
    }
  }
  return { width, height, data: out };
}
export const pixelAt = (img: RgbaImage, x: number, y: number): number[] => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
