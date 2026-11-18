// Content sniffing (design section 8, task 2.1). The type is decided only by bytes: file name and declared MIME are
// ignored. Allowlist: PNG, JPEG, WebP, GIF, WAV, OGG, MP3. Anything else (SVG, HTML, unknown) is refused.
// Images: dimensions are read from the header without decoding. Each format must be structurally complete and must
// not carry trailing data, which refuses truncated files and polyglots. Every path returns a refusal, never throws.
import { checkAddLimits, checkDimensions, MAX_FILE_BYTES, type LibraryUsage } from "./limits";

export type AssetType = "png" | "jpeg" | "webp" | "gif" | "wav" | "ogg" | "mp3";
export type AssetKind = "image" | "audio";

export interface SniffedAsset {
  readonly ok: true;
  readonly type: AssetType;
  readonly kind: AssetKind;
  readonly mime: string;
  readonly width?: number;
  readonly height?: number;
}
export interface SniffRefusal {
  readonly ok: false;
  readonly reason: string;
}
export type SniffResult = SniffedAsset | SniffRefusal;

const MIME: Record<AssetType, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
};

const refuse = (reason: string): SniffRefusal => ({ ok: false, reason });
const ascii = (b: Uint8Array, at: number, s: string): boolean => {
  if (at < 0 || at + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};
const u16be = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number): number => u16le(b, at) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number): number => (u16be(b, at) * 65536 + u16be(b, at + 2)) >>> 0;
const u32le = (b: Uint8Array, at: number): number => (u16le(b, at) + u16le(b, at + 2) * 65536) >>> 0;

type Parsed = { readonly width?: number; readonly height?: number } | string;
const image = (type: AssetType, p: Parsed): SniffResult => {
  if (typeof p === "string") return refuse(p);
  const w = p.width ?? 0;
  const h = p.height ?? 0;
  const d = checkDimensions(w, h);
  if (!d.ok) return refuse(d.reason);
  return { ok: true, type, kind: "image", mime: MIME[type], width: w, height: h };
};
const audio = (type: AssetType, err: string | null): SniffResult => (err ? refuse(err) : { ok: true, type, kind: "audio", mime: MIME[type] });

function parsePng(b: Uint8Array): Parsed {
  if (b.length < 33 || !ascii(b, 12, "IHDR") || u32be(b, 8) !== 13) return "png: missing IHDR";
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  let at = 8;
  let idat = false;
  while (at + 12 <= b.length) {
    const len = u32be(b, at);
    const end = at + 12 + len;
    if (end > b.length) return "png: truncated chunk";
    if (ascii(b, at + 4, "IDAT")) idat = true;
    if (ascii(b, at + 4, "IEND")) {
      if (len !== 0) return "png: malformed IEND";
      if (end !== b.length) return "png: data after IEND";
      return idat ? { width, height } : "png: no image data";
    }
    at = end;
  }
  return "png: truncated (no IEND)";
}

function parseJpeg(b: Uint8Array): Parsed {
  if (b.length < 4 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return "jpeg: missing end marker";
  let at = 2;
  let dims: { width: number; height: number } | null = null;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return "jpeg: bad marker";
    const m = b[at + 1] ?? 0;
    if (m === 0xff) {
      at++;
      continue;
    }
    if (m === 0xd9) return "jpeg: end marker before image data";
    const len = u16be(b, at + 2);
    if (len < 2 || at + 2 + len > b.length) return "jpeg: truncated segment";
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof && !dims) {
      if (len < 8) return "jpeg: short frame header";
      dims = { height: u16be(b, at + 5), width: u16be(b, at + 7) };
    }
    if (m === 0xda) return dims ?? "jpeg: scan before frame header";
    at += 2 + len;
  }
  return "jpeg: truncated";
}

function parseGif(b: Uint8Array): Parsed {
  if (b.length < 14) return "gif: truncated";
  const width = u16le(b, 6);
  const height = u16le(b, 8);
  let at = 13;
  const flags = b[10] ?? 0;
  if (flags & 0x80) at += 3 * (1 << ((flags & 7) + 1));
  const skipSub = (): boolean => {
    while (at < b.length) {
      const n = b[at] ?? 0;
      at += 1 + n;
      if (n === 0) return at <= b.length;
    }
    return false;
  };
  let frames = 0;
  while (at < b.length) {
    const t = b[at];
    if (t === 0x3b) return at + 1 !== b.length ? "gif: data after trailer" : frames > 0 ? { width, height } : "gif: no frames";
    if (t === 0x21) {
      at += 2;
      if (!skipSub()) return "gif: truncated extension";
    } else if (t === 0x2c) {
      if (at + 10 > b.length) return "gif: truncated image";
      const f = b[at + 9] ?? 0;
      at += 10;
      if (f & 0x80) at += 3 * (1 << ((f & 7) + 1));
      at += 1;
      if (!skipSub()) return "gif: truncated image data";
      frames++;
    } else return "gif: bad block";
  }
  return "gif: missing trailer";
}

function parseWebp(b: Uint8Array): Parsed {
  if (b.length < 30 || u32le(b, 4) + 8 !== b.length) return "webp: bad or truncated RIFF size";
  if (ascii(b, 12, "VP8X")) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (ascii(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return "webp: bad lossless signature";
    const v = u32le(b, 21);
    return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, "VP8 ")) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return "webp: bad lossy signature";
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  return "webp: unknown chunk";
}

function parseWav(b: Uint8Array): string | null {
  if (b.length < 44 || u32le(b, 4) + 8 !== b.length) return "wav: bad or truncated RIFF size";
  let at = 12;
  let fmt = false;
  while (at + 8 <= b.length) {
    const len = u32le(b, at + 4);
    const end = at + 8 + len + (len & 1);
    if (ascii(b, at, "fmt ")) fmt = len >= 16;
    if (ascii(b, at, "data")) return fmt && at + 8 + len <= b.length ? null : "wav: missing fmt or truncated data";
    if (end > b.length) return "wav: truncated chunk";
    at = end;
  }
  return "wav: no data chunk";
}

function parseOgg(b: Uint8Array): string | null {
  if (b.length < 28 || b[4] !== 0 || (b[5] ?? 0) & 0xf8) return "ogg: bad page header";
  const segs = b[26] ?? 0;
  const first = 27 + segs;
  const known = ascii(b, first, "\x01vorbis") || ascii(b, first, "OpusHead") || ascii(b, first, "\x7fFLAC") || ascii(b, first, "\x80theora");
  if (!known) return "ogg: unknown stream";
  let at = 0;
  while (at < b.length) {
    if (!ascii(b, at, "OggS") || at + 27 > b.length) return "ogg: broken page";
    const n = b[at + 26] ?? 0;
    if (at + 27 + n > b.length) return "ogg: truncated page";
    let body = 0;
    for (let i = 0; i < n; i++) body += b[at + 27 + i] ?? 0;
    at += 27 + n + body;
    if (at > b.length) return "ogg: truncated page";
  }
  return null;
}

function mp3Frame(b: Uint8Array, at: number): boolean {
  if (at + 4 > b.length || b[at] !== 0xff || ((b[at + 1] ?? 0) & 0xe0) !== 0xe0) return false;
  const h1 = b[at + 1] ?? 0;
  const h2 = b[at + 2] ?? 0;
  return ((h1 >> 3) & 3) !== 1 && ((h1 >> 1) & 3) === 1 && h2 >> 4 !== 15 && h2 >> 4 !== 0 && ((h2 >> 2) & 3) !== 3;
}
function parseMp3(b: Uint8Array): string | null {
  let at = 0;
  if (ascii(b, 0, "ID3")) {
    if (b.length < 10 || (b[6] ?? 0) & 0x80 || (b[7] ?? 0) & 0x80 || (b[8] ?? 0) & 0x80 || (b[9] ?? 0) & 0x80) return "mp3: bad ID3 header";
    at = 10 + (((b[6] ?? 0) << 21) | ((b[7] ?? 0) << 14) | ((b[8] ?? 0) << 7) | (b[9] ?? 0));
  }
  return mp3Frame(b, at) ? null : "mp3: no audio frame";
}

/** Decide the type of `bytes` from content alone. Refuses unknown, malformed, truncated and over-limit input. */
export function sniffAsset(bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) return refuse("empty file");
  if (bytes.length > MAX_FILE_BYTES) return refuse(`file exceeds ${MAX_FILE_BYTES} bytes`);
  try {
    if (ascii(bytes, 0, "\x89PNG\r\n\x1a\n")) return image("png", parsePng(bytes));
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return image("jpeg", parseJpeg(bytes));
    if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return image("gif", parseGif(bytes));
    if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return image("webp", parseWebp(bytes));
    if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return audio("wav", parseWav(bytes));
    if (ascii(bytes, 0, "OggS")) return audio("ogg", parseOgg(bytes));
    if (ascii(bytes, 0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return audio("mp3", parseMp3(bytes));
  } catch {
    return refuse("unreadable file");
  }
  return refuse("unsupported or unrecognised file type");
}

/** Sniff and apply the project limits in one step. Nothing is accepted unless both pass. */
export function vetAsset(bytes: Uint8Array, usage: LibraryUsage): SniffResult {
  const lim = checkAddLimits(usage, bytes.length);
  if (!lim.ok) return refuse(lim.reason);
  return sniffAsset(bytes);
}
