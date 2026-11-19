// Adversarial regression tests for buildZip (workflow wf_d86b541f4b210b32). Each case fails on the reviewed code.
import { describe, expect, it } from "vitest";
import { importBundle, SPEC_PATH } from "./bundle";
import { MAX_ENTRIES, readZip } from "./unzip";
import { buildZip, unsafePath, type ZipEntry } from "./zip";
import { rawZip, type RawEntry } from "./zip.testkit";

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

// Task 1.5: one test per hostile class on the READ side (importBundle / readZip). Each archive is built by hand because
// buildZip refuses to write them. Every case must be refused with its own code and must return no project.
describe("importBundle: hostile archives", () => {
  const body = new TextEncoder().encode("{}");
  const entry = (name: string, more: Partial<RawEntry> = {}): RawEntry => ({ name, plain: body, ...more });
  const refused = async (zip: Uint8Array, code: string) => {
    const r = await importBundle(zip);
    expect(r).toMatchObject({ ok: false, code });
    expect("project" in r).toBe(false);
  };

  it("zip-slip: a name that climbs out of the pack", async () => {
    await refused(rawZip([entry("../evil.json")]), "unsafe-path");
    await refused(rawZip([entry("studio-pack/../../evil.json")]), "unsafe-path");
  });
  it("absolute path, backslash and drive letter", async () => {
    await refused(rawZip([entry("/etc/passwd")]), "unsafe-path");
    await refused(rawZip([entry("studio-pack\\x.json")]), "unsafe-path");
    await refused(rawZip([entry("C:/x.json")]), "unsafe-path");
  });
  it("a symlink entry", async () => {
    await refused(rawZip([entry(SPEC_PATH, { mode: 0o120777 })]), "symlink");
  });
  it("a name outside the bundle layout", async () => {
    await refused(rawZip([entry("android/app/Main.kt")]), "outside-layout");
    await refused(rawZip([entry("studio-pack/assets/asset-0001")]), "outside-layout");
  });
  it("duplicate entries, exact and by case or normalization", async () => {
    await refused(rawZip([entry(SPEC_PATH), entry(SPEC_PATH)]), "duplicate");
    await refused(rawZip([entry(SPEC_PATH), entry("MONSTERA.spec.json")]), "duplicate");
  });
  it("too many entries", async () => {
    const many = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => entry(`studio-pack/assets/a${i}/f.png`));
    await refused(rawZip(many), "too-many-entries");
  });
  it("a bomb: DEFLATE data that inflates past its declared size", async () => {
    const big = new Uint8Array(2 * 1024 * 1024);
    await refused(rawZip([{ name: SPEC_PATH, plain: big, method: 8, size: 4096 }]), "bomb");
  });
  it("a declared size over the per-entry limit, and declared sizes over the total", async () => {
    await refused(rawZip([{ name: "studio-pack/assets/a/f.png", plain: body, method: 8, size: 6 * 1024 * 1024, comp: 100000 }]), "too-large");
    const total = Array.from({ length: 14 }, (_, i) => ({ name: `studio-pack/assets/a${i}/f.png`, plain: body, method: 8 as const, size: 5 * 1024 * 1024, comp: 1024 * 1024 }));
    await refused(rawZip(total), "too-large");
  });
  it("a compression ratio over 100:1", async () => {
    await refused(rawZip([{ name: SPEC_PATH, plain: new Uint8Array(1024 * 1024), method: 8 }]), "ratio");
  });
  it("an entry whose data does not match its CRC-32", async () => {
    await refused(rawZip([entry(SPEC_PATH, { crc: 1 })]), "checksum");
  });
  it("a local header that names another file than the central directory", async () => {
    await refused(rawZip([entry(SPEC_PATH, { localName: "studio-pack/project.json" })]), "malformed");
  });
  it("a trailing archive comment (where a second archive could hide)", async () => {
    await refused(rawZip([entry(SPEC_PATH)], { comment: new Uint8Array(8) }), "malformed");
  });
  it("an encrypted entry", async () => {
    await refused(rawZip([entry(SPEC_PATH, { flags: 0x0801 })]), "unsupported");
  });
  it("input that is not a ZIP", async () => {
    await refused(new Uint8Array(100), "malformed");
    await refused(new Uint8Array(3), "malformed");
  });
  it("readZip alone refuses without producing entries", async () => {
    const r = await readZip(rawZip([entry("../x")]), () => ({ max: 10 }));
    expect(r.ok).toBe(false);
    expect("entries" in r).toBe(false);
  });
});