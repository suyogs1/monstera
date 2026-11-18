import { describe, expect, it } from "vitest";
import type { VariantCheck } from "../derive/variants";
import { exportable, levelPackEntries, levelPackZip, levelVariantPath } from "./levelPack";

const v = (levelId: string, over: Partial<VariantCheck> = {}): VariantCheck => ({
  levelId, status: "valid", stage: null, issues: [], canonicalText: `{"id":"${levelId}"}\n`, sha256: "a".repeat(64),
  oracle: { ticks: 600, hash: "0".repeat(16), ms: 1 }, deterministic: true, ...over,
});
/** STORED-entry reader: local file headers in order. */
function read(zip: Uint8Array): { path: string; text: string }[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out: { path: string; text: string }[] = [];
  let at = 0;
  while (dv.getUint32(at, true) === 0x04034b50) {
    const size = dv.getUint32(at + 18, true), nameLen = dv.getUint16(at + 26, true), extraLen = dv.getUint16(at + 28, true);
    const path = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLen));
    const start = at + 30 + nameLen + extraLen;
    out.push({ path, text: new TextDecoder().decode(zip.subarray(start, start + size)) });
    at = start + size;
  }
  return out;
}
describe("level pack", () => {
  it("writes exact paths with the validated canonical bytes, sorted by id", () => {
    const zip = levelPackZip([v("level-2"), v("level-1")]);
    expect(read(zip)).toEqual([
      { path: "studio-pack/derived/levels/level-1/monstera.spec.json", text: '{"id":"level-1"}\n' },
      { path: "studio-pack/derived/levels/level-2/monstera.spec.json", text: '{"id":"level-2"}\n' },
    ]);
    expect(levelVariantPath("a-b")).toBe("studio-pack/derived/levels/a-b/monstera.spec.json");
  });
  it("is byte-identical for the same input", () => {
    expect(Array.from(levelPackZip([v("level-1"), v("level-2")]))).toEqual(Array.from(levelPackZip([v("level-2"), v("level-1")])));
  });
  it("leaves out refused, nondeterministic and text-less variants and writes nothing else", () => {
    const set = [v("one-ok"), v("bad-eng", { status: "refused", stage: "engine", canonicalText: null }), v("flaky", { deterministic: false }), v("empty", { canonicalText: null })];
    expect(exportable(set).map((c) => c.levelId)).toEqual(["one-ok"]);
    expect(levelPackEntries(set).map((e) => e.path)).toEqual(["studio-pack/derived/levels/one-ok/monstera.spec.json"]);
    expect(read(levelPackZip(set))).toHaveLength(1);
  });
  it("refuses to build an archive when no variant is valid", () => {
    expect(() => levelPackZip([v("x1", { status: "refused", canonicalText: null })])).toThrow(/nothing to export/);
  });
});
