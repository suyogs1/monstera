// Minimal ZIP writer (PKWARE APPNOTE 6.3.x): STORED entries (no compression), CRC-32, Unix file modes in the external
// attributes, a fixed DOS timestamp (1980-01-01 00:00) so the same files give the same bytes, the UTF-8 name flag for
// non-ASCII names. No ZIP64: more than 65535 entries or 4 GiB is refused. No dependency (the format part needed here is
// small and fully tested). Archive metadata is not required to match anything (requirement R6.2); contents are.

export interface ZipEntry { path: string; data: Uint8Array; mode: number }

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Windows device names, also with an extension ("nul.txt"): such a file cannot be created on Windows.
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Why a path is not a plain relative archive path that extracts the same on Windows, macOS and Linux, or null. */
export function unsafePath(path: string): string | null {
  if (path === "") return "empty path";
  if (path.includes("\\")) return "backslash";
  if (path.startsWith("/")) return "absolute path";
  if (path.includes(":")) return "colon (drive letter or NTFS stream)";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) return "control character";
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(path)) return "lone surrogate (not encodable as UTF-8)";
  if (path.endsWith("/")) return "directory entry";
  for (const seg of path.split("/")) {
    if (seg === "") return "empty segment";
    if (seg === "." || seg === "..") return `'${seg}' segment`;
    if (/[. ]$/.test(seg)) return "segment ending in a dot or space";
    if (RESERVED.test(seg)) return `reserved Windows name '${seg}'`;
  }
  return null;
}

const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

/** Builds the archive. Throws on an unsafe path, a duplicate path (case-insensitively, so it extracts on every OS),
 *  an invalid mode, or a size that would need ZIP64. */
export function buildZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  if (entries.length > MAX_ENTRIES) throw new Error(`too many entries for a ZIP without ZIP64 (${entries.length})`);
  // Duplicates are compared case-insensitively and after Unicode NFC normalization (case-insensitive or normalizing
  // file systems would merge them). A path may not also be the directory of another path.
  const key = (p: string) => p.normalize("NFC").toLowerCase();
  const files = new Set<string>();
  const dirs = new Set<string>();
  const enc = new TextEncoder();
  const prepared = entries.map((e) => {
    const why = unsafePath(e.path);
    if (why) throw new Error(`unsafe archive path '${e.path}': ${why}`);
    const k = key(e.path);
    if (files.has(k)) throw new Error(`duplicate archive path '${e.path}'`);
    if (dirs.has(k)) throw new Error(`archive path '${e.path}' conflicts with a directory of the same name`);
    const parts = k.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (files.has(dir)) throw new Error(`archive path '${e.path}' conflicts with the file '${dir}'`);
      dirs.add(dir);
    }
    files.add(k);
    if (!Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o777) throw new Error(`invalid mode for '${e.path}' (permission bits only)`);
    if (e.data.length > MAX_SIZE) throw new Error(`'${e.path}' is too large for a ZIP without ZIP64`);
    const name = enc.encode(e.path);
    if (name.length > 0xffff) throw new Error(`archive path is too long (${name.length} bytes)`);
    return { e, name, crc: crc32(e.data), utf8: /[^\x00-\x7f]/.test(e.path) };
  });

  const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01 00:00:00
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const p of prepared) {
    const flags = p.utf8 ? 0x0800 : 0;
    const local = new Uint8Array(30 + p.name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);           // version needed: 2.0
    lv.setUint16(6, flags, true);
    lv.setUint16(8, 0, true);            // method: stored
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, p.crc, true);
    lv.setUint32(18, p.e.data.length, true);
    lv.setUint32(22, p.e.data.length, true);
    lv.setUint16(26, p.name.length, true);
    lv.setUint16(28, 0, true);
    local.set(p.name, 30);

    const central = new Uint8Array(46 + p.name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, (3 << 8) | 20, true); // made by: Unix, 2.0 (so external attributes carry the mode)
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, p.crc, true);
    cv.setUint32(20, p.e.data.length, true);
    cv.setUint32(24, p.e.data.length, true);
    cv.setUint16(28, p.name.length, true);
    cv.setUint16(30, 0, true);           // extra
    cv.setUint16(32, 0, true);           // comment
    cv.setUint16(34, 0, true);           // disk
    cv.setUint16(36, 0, true);           // internal attributes
    cv.setUint32(38, ((0o100000 | p.e.mode) << 16) >>> 0, true); // regular file + permission bits
    cv.setUint32(42, offset, true);
    central.set(p.name, 46);

    locals.push(local, p.e.data);
    centrals.push(central);
    offset += local.length + p.e.data.length;
    if (offset > MAX_SIZE) throw new Error("archive too large for a ZIP without ZIP64");
  }
  const centralSize = centrals.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, prepared.length, true);
  ev.setUint16(10, prepared.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}
