// Test-only: writes ZIP archives with every field under the test's control, including the ones buildZip refuses to write
// (hostile names, links, lying sizes, DEFLATE data). Production code never imports this.
import { deflateRawSync } from "node:zlib";
import { crc32 } from "./zip";

export interface RawEntry {
  name: string;
  /** The real, uncompressed content. */
  plain?: Uint8Array;
  method?: 0 | 8;
  /** Overrides of what the headers claim. */
  size?: number;
  comp?: number;
  crc?: number;
  mode?: number;
  madeBy?: number;
  flags?: number;
  /** Name in the local header when it differs from the central one. */
  localName?: string;
}

const enc = new TextEncoder();

export function rawZip(entries: RawEntry[], opts: { comment?: Uint8Array } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const plain = e.plain ?? new Uint8Array(0);
    const method = e.method ?? 0;
    const payload = method === 8 ? new Uint8Array(deflateRawSync(plain)) : plain;
    const size = e.size ?? plain.length;
    const comp = e.comp ?? payload.length;
    const crc = e.crc ?? crc32(plain);
    const name = enc.encode(e.name);
    const lname = enc.encode(e.localName ?? e.name);
    const flags = e.flags ?? 0x0800;
    const local = new Uint8Array(30 + lname.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, flags, true); lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, comp, true); lv.setUint32(22, size, true); lv.setUint16(26, lname.length, true);
    local.set(lname, 30);
    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, e.madeBy ?? ((3 << 8) | 20), true); cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true); cv.setUint16(10, method, true); cv.setUint32(16, crc, true); cv.setUint32(20, comp, true);
    cv.setUint32(24, size, true); cv.setUint16(28, name.length, true);
    cv.setUint32(38, (((e.mode ?? 0o100644) << 16) >>> 0), true); cv.setUint32(42, offset, true);
    c.set(name, 46);
    parts.push(local, payload);
    central.push(c);
    offset += local.length + payload.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const comment = opts.comment ?? new Uint8Array(0);
  const end = new Uint8Array(22 + comment.length);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, comment.length, true);
  end.set(comment, 22);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
