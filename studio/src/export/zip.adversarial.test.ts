// Adversarial regression tests for buildZip (workflow wf_d86b541f4b210b32). Each case fails on the reviewed code.
import { describe, expect, it } from "vitest";
import { buildZip, unsafePath, type ZipEntry } from "./zip";

const e = (path: string, mode = 0o644): ZipEntry => ({ path, data: new TextEncoder().encode("x"), mode });

describe("buildZip: entries that would collide or break extraction", () => {
  it("rejects two names that encode to the same UTF-8 bytes (lone surrogates)", () => {
    expect(() => buildZip([e("p/\ud800"), e("p/\ud801")])).toThrow(/duplicate|unsafe/);
  });
  it("rejects a path that is both a file and a directory prefix, in either order", () => {
    expect(() => buildZip([e("p/a"), e("p/a/b")])).toThrow(/conflict|duplicate|unsafe/);
    expect(() => buildZip([e("p/a/b"), e("p/a")])).toThrow(/conflict|duplicate|unsafe/);
  });
  it("rejects a name longer than the 16-bit length field instead of writing a corrupt archive", () => {
    expect(() => buildZip([e("p/" + "a".repeat(70000))])).toThrow();
  });
  it("rejects names that differ only by Unicode normalization (NFC vs NFD)", () => {
    expect(() => buildZip([e("p/\u00e9"), e("p/e\u0301")])).toThrow(/duplicate/);
  });
});

describe("unsafePath: names that are not a plain relative path on every OS", () => {
  it.each([
    ["colon after the first segment (NTFS alternate data stream / drive)", "p/a.txt:evil"],
    ["colon in a middle segment", "p/C:/x"],
    ["C1 control character", "p/a\u0085b"],
    ["Windows reserved device name", "p/CON"],
    ["reserved device name with extension", "p/nul.txt"],
    ["segment ending in a dot", "p/a./b"],
    ["segment ending in a space", "p/a /b"],
  ])("%s", (_name, path) => {
    expect(unsafePath(path)).not.toBeNull();
  });
});

describe("buildZip: modes", () => {
  it("accepts only permission bits (no setuid, setgid or sticky)", () => {
    expect(() => buildZip([e("p/x", 0o4755)])).toThrow(/mode/);
    expect(() => buildZip([e("p/x", 0o1777)])).toThrow(/mode/);
  });
});
