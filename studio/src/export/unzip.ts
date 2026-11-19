// Hardened ZIP reader for bundle import (task 1.5). Reads the central directory only, never trusts a size, offset or name:
// every entry is checked BEFORE it is inflated (path, layout, declared sizes, ratio, overlap), inflation is bounded by the
// declared size, and the CRC-32 of the result must match. Nothing is written anywhere; the caller gets entries or a
// refusal, never a partial result. STORED and DEFLATE only; ZIP64, encryption, symlinks and multi-disk are refused.
import { crc32, unsafePath } from "./zip";

export const MAX_ENTRIES = 2000;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_RATIO = 100;

export type ZipRefusal =
  | "malformed" | "unsupported" | "too-many-entries" | "unsafe-path" | "duplicate" | "symlink"
  | "outside-layout" | "too-large" | "bomb" | "ratio" | "checksum";

export interface ReadEntry { path: string; data: Uint8Array }
export type ZipReadResult = { ok: true; entries: ReadEntry[] } | { ok: false; code: ZipRefusal; message: string };

/** Decides per entry: a byte limit for its uncompressed size, or a reason why the entry is outside the allowed layout. */
export type EntryPolicy = (path: string) => { max: number } | { reason: string };

class Refuse extends Error {
  constructor(readonly code: ZipRefusal, message: string) { super(message); }
}
const no = (code: ZipRefusal, message: string): never => { throw new Refuse(code, message); };

const FATAL = new TextDecoder("utf-8", { fatal: true });

/** Bounded raw-DEFLATE inflate: never produces more than `expected` bytes and must produce exactly that many. */
async function inflate(comp: Uint8Array, expected: number, path: string): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const fed = writer.write(comp.slice()).then(() => writer.close()).catch(() => undefined);
  const reader = ds.readable.getReader();
  const out = new Uint8Array(expected);
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.length > expected) {
        await reader.cancel().catch(() => undefined);
        return no("bomb", `'${path}' inflates past its declared size of ${expected} bytes`);
      }
      out.set(value, n);
      n += value.length;
    }
  } catch (e) {
    if (e instanceof Refuse) throw e;
    return no("malformed", `'${path}' has a corrupt DEFLATE stream`);
  }
  await fed;
  if (n !== expected) return no("malformed", `'${path}' inflates to ${n} bytes, not the declared ${expected}`);
  return out;
}

/** Reads a ZIP. Async only because inflate is. Throws nothing: every failure is a refusal result. */
export async function readZip(bytes: Uint8Array, policy: EntryPolicy): Promise<ZipReadResult> {
  try {
    return { ok: true, entries: await read(bytes, policy) };
  } catch (e) {
    if (e instanceof Refuse) return { ok: false, code: e.code, message: e.message };
    return { ok: false, code: "malformed", message: "the archive could not be read" };
  }
}

async function read(bytes: Uint8Array, policy: EntryPolicy): Promise<ReadEntry[]> {
  if (bytes.length < 22) return no("malformed", "not a ZIP archive (too short)");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  // The end record must be the last 22 bytes: a trailing comment is where a second, hidden archive would live.
  if (v.getUint32(eocd, true) !== 0x06054b50) return no("malformed", "no end-of-archive record at the end of the file (a comment or trailing data is not accepted)");
  if (v.getUint16(eocd + 20, true) !== 0) return no("malformed", "an archive comment is not accepted");
  if (v.getUint16(eocd + 4, true) !== 0 || v.getUint16(eocd + 6, true) !== 0) return no("unsupported", "multi-disk archives are not supported");
  const count = v.getUint16(eocd + 10, true);
  if (v.getUint16(eocd + 8, true) !== count) return no("malformed", "entry counts disagree");
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return no("unsupported", "ZIP64 is not supported");
  if (count > MAX_ENTRIES) return no("too-many-entries", `${count} entries exceeds the limit of ${MAX_ENTRIES}`);
  if (cdOffset + cdSize !== eocd) return no("malformed", "the central directory does not end where the end record begins");

  interface Pending { path: string; method: number; comp: number; size: number; crc: number; local: number; max: number }
  const pending: Pending[] = [];
  const seen = new Set<string>();
  let at = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || v.getUint32(at, true) !== 0x02014b50) return no("malformed", "bad central directory entry");
    const madeBy = v.getUint16(at + 4, true);
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const comp = v.getUint32(at + 20, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    const disk = v.getUint16(at + 34, true);
    const ext = v.getUint32(at + 38, true);
    const local = v.getUint32(at + 42, true);
    const next = at + 46 + nameLen + extraLen + commentLen;
    if (next > eocd) return no("malformed", "central directory entry runs past the directory");
    let path: string;
    try { path = FATAL.decode(bytes.subarray(at + 46, at + 46 + nameLen)); } catch { return no("unsafe-path", "an entry name is not valid UTF-8"); }
    at = next;
    if (disk !== 0) return no("unsupported", "multi-disk archives are not supported");
    if (comp === 0xffffffff || size === 0xffffffff || local === 0xffffffff) return no("unsupported", "ZIP64 is not supported");
    if (flags & 0x41) return no("unsupported", `'${path}' is encrypted`);

    // File type from the Unix mode (made by Unix) or the DOS directory bit; a link is refused outright.
    const unix = madeBy >> 8 === 3;
    const type = unix ? (ext >>> 16) & 0o170000 : 0;
    if (unix && type !== 0 && type !== 0o100000 && type !== 0o040000) return no("symlink", `'${path}' is a link or special file`);
    const isDir = path.endsWith("/") || type === 0o040000 || (!unix && (ext & 0x10) !== 0);
    const bare = path.endsWith("/") ? path.slice(0, -1) : path;
    const why = unsafePath(bare);
    if (why) return no("unsafe-path", `unsafe archive path '${path}': ${why}`);
    if (isDir) {
      if (size !== 0) return no("malformed", `directory entry '${path}' carries data`);
      continue; // directories carry no content; files below are judged by their own full path
    }
    if (type === 0o040000) return no("malformed", `'${path}' is marked as a directory`);

    const key = path.normalize("NFC").toLowerCase();
    if (seen.has(key)) return no("duplicate", `duplicate archive path '${path}'`);
    seen.add(key);
    const rule = policy(path);
    if ("reason" in rule) return no("outside-layout", `'${path}' is outside the bundle layout: ${rule.reason}`);
    if (method !== 0 && method !== 8) return no("unsupported", `'${path}' uses compression method ${method}`);
    if (method === 0 && comp !== size) return no("malformed", `'${path}' is stored but its sizes differ`);
    if (size > rule.max) return no("too-large", `'${path}' is ${size} bytes, over its limit of ${rule.max}`);
    total += size;
    if (total > MAX_TOTAL_BYTES) return no("too-large", `the archive expands to more than ${MAX_TOTAL_BYTES} bytes`);
    if (size > 0 && (comp === 0 || size / comp > MAX_RATIO)) return no("ratio", `'${path}' has a compression ratio over ${MAX_RATIO}:1`);
    pending.push({ path, method, comp, size, crc, local, max: rule.max });
  }
  if (at !== eocd) return no("malformed", "unexpected data after the last central directory entry");

  // Data ranges must be inside the file, before the central directory, and may not overlap (zip quines and shared data).
  // All of this is decided before any entry is inflated.
  const ranges: { start: number; end: number }[] = [];
  const located: { p: Pending; start: number; end: number }[] = [];
  for (const p of pending) {
    if (p.local + 30 > cdOffset || v.getUint32(p.local, true) !== 0x04034b50) return no("malformed", `'${p.path}' has no local header at its offset`);
    const nl = v.getUint16(p.local + 26, true);
    const el = v.getUint16(p.local + 28, true);
    let lname: string;
    try { lname = FATAL.decode(bytes.subarray(p.local + 30, p.local + 30 + nl)); } catch { return no("malformed", `'${p.path}' local name is not valid UTF-8`); }
    if (lname !== p.path) return no("malformed", `'${p.path}' local header names a different file`);
    const start = p.local + 30 + nl + el;
    const end = start + p.comp;
    if (end > cdOffset) return no("malformed", `'${p.path}' data runs past the central directory`);
    ranges.push({ start: p.local, end });
    located.push({ p, start, end });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]!.start < ranges[i - 1]!.end) return no("malformed", "entries overlap in the file");

  const out: ReadEntry[] = [];
  let inflated = 0;
  for (const { p, start, end } of located) {
    const raw = bytes.subarray(start, end);
    const data = p.method === 0 ? raw.slice() : await inflate(raw, p.size, p.path);
    inflated += data.length;
    if (inflated > MAX_TOTAL_BYTES) return no("bomb", "the archive expands past the total size limit");
    if (crc32(data) !== p.crc) return no("checksum", `'${p.path}' does not match its CRC-32`);
    out.push({ path: p.path, data });
  }
  return out;
}
