// PNG encoder for the native sprite atlas (spec v5, contract section 10). Writes exactly what the engine accepts
// (tools/monstera/monstera/atlas.py): signature, IHDR, IDAT, IEND, 8-bit RGBA, no interlacing, standard filtering. Nothing
// here checks the result: the engine's own validator does, through the apply path (apply.ts). Pure apart from `deflate`,
// which is injected so tests and the browser can supply their own compressor.
import { crc32 } from "../../export/zip";

export interface RgbaImage { width: number; height: number; data: Uint8ClampedArray | Uint8Array }
/** zlib-wrapped deflate (RFC 1950), as PNG's IDAT requires. */
export type Deflate = (raw: Uint8Array) => Promise<Uint8Array>;

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** The browser's (and Node's) CompressionStream("deflate"), which emits a zlib stream. */
export const streamDeflate: Deflate = async (raw) => {
  const stream = new Blob([raw.slice()]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Scanlines with one filter byte each. Per row the cheaper of None, Sub and Up (sum of absolute signed bytes) is used. */
export function filterScanlines(img: RgbaImage): Uint8Array {
  const stride = img.width * 4;
  const out = new Uint8Array(img.height * (stride + 1));
  const cost = (row: Uint8Array): number => { let s = 0; for (const b of row) s += b < 128 ? b : 256 - b; return s; };
  for (let y = 0; y < img.height; y++) {
    const cur = img.data.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? img.data.subarray((y - 1) * stride, y * stride) : null;
    const none = Uint8Array.from(cur);
    const sub = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) sub[i] = (cur[i]! - (i >= 4 ? cur[i - 4]! : 0)) & 255;
    const candidates: [number, Uint8Array][] = [[0, none], [1, sub]];
    if (up) { const d = new Uint8Array(stride); for (let i = 0; i < stride; i++) d[i] = (cur[i]! - up[i]!) & 255; candidates.push([2, d]); }
    let best = candidates[0]!;
    for (const c of candidates) if (cost(c[1]) < cost(best[1])) best = c;
    out[y * (stride + 1)] = best[0];
    out.set(best[1], y * (stride + 1) + 1);
  }
  return out;
}

/** An 8-bit RGBA PNG of the image. Throws only for a buffer that does not match its declared size. */
export async function encodePng(img: RgbaImage, deflate: Deflate = streamDeflate): Promise<Uint8Array> {
  if (!Number.isSafeInteger(img.width) || !Number.isSafeInteger(img.height) || img.width < 1 || img.height < 1) throw new Error("image size must be positive whole pixels");
  if (img.data.length !== img.width * img.height * 4) throw new Error("pixel buffer does not match the image size");
  const ihdr = Uint8Array.from([...u32(img.width), ...u32(img.height), 8, 6, 0, 0, 0]);
  const idat = await deflate(filterScanlines(img));
  const parts = [SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Standard base64 with padding and no line breaks (the schema's pattern). */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=") + (i + 2 < bytes.length ? B64[n & 63]! : "=");
  }
  return s;
}

export function fromBase64(text: string): Uint8Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return null;
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
