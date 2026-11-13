import { describe, expect, it } from "vitest";
import { buildZip, crc32, unsafePath, type ZipEntry } from "./zip";

const enc = new TextEncoder();

/** Independent reader for the round trip: walks the central directory, then checks each local header and its data. */
function readZip(zip: Uint8Array) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  expect(p + v.getUint32(eocd + 12, true)).toBe(eocd);
  const out: { path: string; data: Uint8Array; mode: number; crc: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const crc = v.getUint32(p + 16, true), size = v.getUint32(p + 20, true), nameLen = v.getUint16(p + 28, true);
    const mode = (v.getUint32(p + 38, true) >>> 16) & 0o7777;
    const local = v.getUint32(p + 42, true);
    const path = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    expect(v.getUint32(local + 14, true)).toBe(crc);
    const lname = v.getUint16(local + 26, true), lextra = v.getUint16(local + 28, true);
    const data = zip.subarray(local + 30 + lname + lextra, local + 30 + lname + lextra + size);
    out.push({ path, data, mode, crc });
    p += 46 + nameLen;
  }
  return out;
}

describe("crc32", () => {
  it("standard check values", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(enc.encode("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });
});

describe("buildZip round trip", () => {
  const binary = Uint8Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) & 0xff);
  const entries: ZipEntry[] = [
    { path: "game/android/gradlew", data: enc.encode("#!/bin/sh\necho hi\n"), mode: 0o755 },
    { path: "game/android/gradle/wrapper/gradle-wrapper.jar", data: binary, mode: 0o644 },
    { path: "game/MONSTERA-MANIFEST.json", data: enc.encode("{}\n"), mode: 0o644 },
    { path: "game/empty.txt", data: new Uint8Array(0), mode: 0o644 },
    { path: "game/ünï/çødé.txt", data: enc.encode("utf-8 name"), mode: 0o600 },
  ];
  const zip = buildZip(entries);
  const back = readZip(zip);

  it("every entry comes back with its path, bytes, mode and CRC, in order", () => {
    expect(back.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    back.forEach((e, i) => {
      expect(Array.from(e.data)).toEqual(Array.from(entries[i]!.data));
      expect(e.mode).toBe(entries[i]!.mode);
      expect(e.crc).toBe(crc32(entries[i]!.data));
    });
  });
  it("binary data is stored byte for byte", () => expect(back[1]!.data.length).toBe(4096));
  it("is deterministic (fixed timestamps)", () => expect(Array.from(buildZip(entries))).toEqual(Array.from(zip)));
  it("non-ASCII names set the UTF-8 flag", () => {
    const v = new DataView(zip.buffer);
    const local = (() => { let p = 0; for (let i = 0; i < 4; i++) p += 30 + v.getUint16(p + 26, true) + v.getUint32(p + 18, true); return p; })();
    expect(v.getUint16(local + 6, true) & 0x0800).toBe(0x0800);
    expect(v.getUint16(6, true) & 0x0800).toBe(0);
  });
});

describe("unsafe and duplicate paths are refused", () => {
  const one = (path: string, mode = 0o644) => () => buildZip([{ path, data: new Uint8Array(1), mode }]);
  it.each([
    ["/etc/passwd", "absolute"], ["../x", "'..' segment"], ["a/../../x", "'..' segment"], ["a/./b", "'.' segment"],
    ["a\\b", "backslash"], ["C:/x", "drive letter"], ["a//b", "empty segment"], ["a/", "directory"], ["", "empty"], ["a\u0000b", "control"],
  ])("%s (%s)", (path) => expect(one(path)).toThrow(/unsafe archive path/));
  it("unsafePath accepts ordinary relative paths", () => {
    expect(unsafePath("pumpkin-blaster/android/app/build.gradle.kts")).toBeNull();
    expect(unsafePath(".kiro/steering/monstera-generated.md")).toBeNull();
  });
  it("duplicates, also differing only in case", () => {
    const d = new Uint8Array(1);
    expect(() => buildZip([{ path: "a/b", data: d, mode: 0o644 }, { path: "a/b", data: d, mode: 0o644 }])).toThrow(/duplicate/);
    expect(() => buildZip([{ path: "a/B", data: d, mode: 0o644 }, { path: "a/b", data: d, mode: 0o644 }])).toThrow(/duplicate/);
  });
  it("invalid modes", () => { expect(one("a", -1)).toThrow(/mode/); expect(one("a", 0o10000)).toThrow(/mode/); expect(one("a", 1.5)).toThrow(/mode/); });
});
