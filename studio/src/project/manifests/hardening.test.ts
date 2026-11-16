// Regression tests for the ChatGPT review of e66baf8 (findings P1 additionalProperties, P1 proposal JSON, P2 size, P2 asset
// ids, P2 license). Each describe names the finding it pins.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allocateAssetId, assetSeq, formatAssetId, MAX_ASSET_SEQ, removeAsset } from "./assetIds";
import { compileSchema, validate } from "./schema";
import { MAX_JSON_BYTES, parseStrictJson, utf8Length } from "./strictJson";
import { MANIFEST_NAMES, parseManifest, serializeManifest, validateManifest, type AssetsManifest, type Issue, type ManifestName } from "./index";

const fixture = (n: string): any => JSON.parse(readFileSync(join(__dirname, "fixtures", `${n}.valid.json`), "utf8"));
const codes = (r: { ok: boolean; issues?: Issue[] }) => (r.ok ? [] : (r.issues ?? []).map((i) => `${i.code}@${i.path.join(".")}`));

describe("P1: undeclared keys are rejected even when they are inherited Object.prototype names", () => {
  // One nested object per manifest, so the check is proven at depth as well as at the root.
  const nested: Record<ManifestName, (m: any) => any> = {
    project: (m) => m.spec, assets: (m) => m.assets[0].provenance, animations: (m) => m.sheets[0].grid, levels: (m) => m.levels[0].waves[0],
    gameplay: (m) => m.lives, integrations: (m) => m.backend.services, proposal: (m) => m.ops[0],
  };
  const where: Record<ManifestName, string> = {
    project: "spec", assets: "assets.0.provenance", animations: "sheets.0.grid", levels: "levels.0.waves.0",
    gameplay: "lives", integrations: "backend.services", proposal: "ops.0",
  };
  const NAMES = ["toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"];
  for (const n of MANIFEST_NAMES) {
    it(`${n}: root and nested`, () => {
      for (const k of NAMES) {
        const root = fixture(n); root[k] = 1;
        expect(codes(validateManifest(n, root))).toEqual([`additional@${k}`]);
        const deep = fixture(n); nested[n](deep)[k] = 1;
        expect(codes(validateManifest(n, deep))).toEqual([`additional@${where[n]}.${k}`]);
      }
    });
    it(`${n}: imported text with such keys is rejected by parseManifest`, () => {
      const text = JSON.stringify({ ...fixture(n), toString: "x", hasOwnProperty: 1 });
      expect(codes(parseManifest(n, text)).sort()).toEqual(["additional@hasOwnProperty", "additional@toString"]);
    });
  }
  it("own keys named constructor or __proto__ on an already parsed object are rejected too", () => {
    const withProto = JSON.parse('{"__proto__": 1, "constructor": 2}');
    const m = { ...fixture("gameplay"), ...withProto };
    Object.defineProperty(m, "__proto__", { value: 1, enumerable: true, configurable: true, writable: true });
    const found = codes(validateManifest("gameplay", m));
    expect(found).toContain("additional@constructor");
    expect(found).toContain("additional@__proto__");
  });
  it("the strict reader still stops constructor and __proto__ before validation", () => {
    expect(codes(parseManifest("gameplay", '{"constructor":1}'))).toEqual(["forbidden-key@"]);
  });
  it("a schema may declare a property named like an inherited name, and it is then required and checked", () => {
    const s = compileSchema({ type: "object", additionalProperties: false, required: ["toString"], properties: { toString: { type: "integer" } } });
    expect(validate({ toString: 1 }, s)).toEqual([]);
    expect(validate({}, s).map((i) => i.code)).toEqual(["required"]);
    expect(validate({ toString: "x" }, s).map((i) => i.code)).toEqual(["type"]);
  });
  it("a $ref to an inherited name is an unknown definition, not a hit on Object.prototype", () => {
    for (const name of ["toString", "constructor", "hasOwnProperty"]) {
      expect(() => compileSchema({ type: "object", additionalProperties: false, required: ["a"], properties: { a: { $ref: `#/$defs/${name}` } }, $defs: {} })).toThrow(/unknown definition/);
    }
  });
});

describe("P1: proposal values go through the strict JSON reader", () => {
  const bad = (value: string) => {
    const m = fixture("proposal"); m.ops[0].value = value;
    const r = validateManifest("proposal", m);
    return r.ok ? ["accepted"] : r.issues.map((i) => `${i.code}@${i.path.join(".")}: ${i.message}`);
  };
  it("rejects duplicate keys, floats, exponents and forbidden keys", () => {
    expect(bad('{"a":1,"a":2}')[0]).toMatch(/^value@ops\.0\.value: .*duplicate-key/);
    expect(bad("1.5")[0]).toMatch(/float/);
    expect(bad("1.0")[0]).toMatch(/float/);
    expect(bad("1e3")[0]).toMatch(/float/);
    expect(bad('{"x":[2E+2]}')[0]).toMatch(/float/);
    expect(bad('{"__proto__":{"x":1}}')[0]).toMatch(/forbidden-key/);
    expect(bad('{"a":{"constructor":1}}')[0]).toMatch(/forbidden-key/);
    expect(bad('[{"prototype":1}]')[0]).toMatch(/forbidden-key/);
  });
  it("rejects excessive nesting and unsafe integers, and still rejects non-JSON", () => {
    expect(bad("[".repeat(40) + "]".repeat(40))[0]).toMatch(/too-deep/);
    expect(bad("[".repeat(5000))[0]).toMatch(/too-deep/);
    expect(bad("9007199254740993")[0]).toMatch(/integer-range/);
    expect(bad("not json")[0]).toMatch(/syntax/);
    expect(bad("{'a':1}")[0]).toMatch(/syntax/);
    expect(bad("[1,]")[0]).toMatch(/syntax/);
  });
  it("keeps valid values working: integers, strings, booleans, null, arrays and nested objects", () => {
    for (const v of ["262144", "-5", '"text"', "true", "null", "[1,2,3]", '{"a":{"b":[1,{"c":false}]}}']) {
      const m = fixture("proposal"); m.ops[0].value = v;
      expect(codes(validateManifest("proposal", m)), v).toEqual([]);
    }
    const nest = "[".repeat(30) + "]".repeat(30);
    const m = fixture("proposal"); m.ops[0].value = nest;
    expect(codes(validateManifest("proposal", m))).toEqual([]);
  });
  it("shares the one reader: no second JSON parser is used for proposal values", () => {
    const src = readFileSync(join(__dirname, "checks.ts"), "utf8");
    expect(src).not.toMatch(/JSON\.parse/);
    expect(src).toMatch(/parseStrictJson/);
  });
});

describe("P2: the size limit is a UTF-8 byte limit on both paths", () => {
  const doc = (chars: number, ch: string) => `"${ch.repeat(chars)}"`;
  it("utf8Length counts bytes like TextEncoder, including surrogate pairs and lone surrogates", () => {
    for (const s of ["", "abc", "é", "€", "𝄞", "a€𝄞é", "\ud800", "x\udc00y", "\ud83d\ude00\ud83d"]) {
      expect(utf8Length(s), JSON.stringify(s)).toBe(new TextEncoder().encode(s).length);
    }
  });
  it("rejects a string whose character count is under the limit but whose UTF-8 size is over it", () => {
    const two = doc(MAX_JSON_BYTES / 2, "é"); // 4,194,304 characters, 8,388,610 bytes
    expect(two.length).toBeLessThan(MAX_JSON_BYTES);
    const r = parseStrictJson(two);
    expect(r.ok ? "ok" : r.issue.code).toBe("too-large");
    const three = doc(Math.floor(MAX_JSON_BYTES / 3) + 1, "€");
    expect(three.length).toBeLessThan(MAX_JSON_BYTES);
    expect(parseStrictJson(three).ok).toBe(false);
    const four = doc(Math.floor(MAX_JSON_BYTES / 4) + 1, "𝄞"); // surrogate pairs: 2 UTF-16 units, 4 bytes each
    expect(parseStrictJson(four).ok).toBe(false);
  });
  it("accepts a multibyte document that is exactly at the byte limit and rejects one byte more", () => {
    const atLimit = doc((MAX_JSON_BYTES - 2) / 2, "é");
    expect(utf8Length(atLimit)).toBe(MAX_JSON_BYTES);
    expect(parseStrictJson(atLimit).ok).toBe(true);
    const shorter = doc((MAX_JSON_BYTES - 2) / 2 - 1, "é").slice(0, -1) + "a" + '"'; // one byte under the limit
    expect(utf8Length(shorter)).toBe(MAX_JSON_BYTES - 1);
    expect(parseStrictJson(shorter).ok).toBe(true);
    const over = atLimit.slice(0, -1) + "a" + '"'; // one byte over the limit
    expect(utf8Length(over)).toBe(MAX_JSON_BYTES + 1);
    const r = parseStrictJson(over);
    expect(r.ok ? "ok" : r.issue.code).toBe("too-large");
  });
  it("the same text as bytes is judged by the same limit (Uint8Array path stays strict)", () => {
    const over = new TextEncoder().encode(doc(MAX_JSON_BYTES / 2, "é"));
    expect(over.length).toBeGreaterThan(MAX_JSON_BYTES);
    expect(codes(parseManifest("levels", over))).toEqual(["too-large@"]);
    expect(codes(parseManifest("levels", doc(MAX_JSON_BYTES / 2, "é")))).toEqual(["too-large@"]);
  });
  it("ordinary multibyte content is unaffected", () => {
    expect(parseStrictJson('{"name":"Lantern — Nacht ☾ 𝄞"}')).toEqual({ ok: true, value: { name: "Lantern — Nacht ☾ 𝄞" } });
  });
});

describe("P2: asset id allocation rule", () => {
  const base = (): AssetsManifest => fixture("assets");
  const withIds = (ids: string[], nextSeq: number): AssetsManifest => {
    const m = base();
    const template = m.assets[0] as AssetsManifest["assets"][number];
    m.assets = ids.map((id) => ({ ...template, id, file: `${id}.png`, kindRefs: [] }));
    m.nextSeq = nextSeq;
    return m;
  };
  it("formats and reads generated ids", () => {
    expect(formatAssetId(1)).toBe("asset-0001");
    expect(formatAssetId(12345)).toBe("asset-12345");
    expect(assetSeq("asset-0007")).toBe(7);
    expect(assetSeq("asset-12345")).toBe(12345);
    for (const id of ["asset-hand", "asset-007", "asset-00005", "asset-1234567", "Asset-0001", "asset-0001a"]) expect(assetSeq(id), id).toBeNull();
  });
  it("rejects a nextSeq that would collide with an existing generated id", () => {
    expect(codes(validateManifest("assets", withIds(["asset-0001", "asset-0002"], 3)))).toEqual([]);
    expect(codes(validateManifest("assets", withIds(["asset-0001", "asset-0002"], 2)))).toEqual(["seq-too-low@nextSeq"]);
    expect(codes(validateManifest("assets", withIds(["asset-0001", "asset-0002"], 1)))).toEqual(["seq-too-low@nextSeq", "seq-too-low@nextSeq"]);
    expect(codes(validateManifest("assets", withIds(["asset-0005"], 3)))).toEqual(["seq-too-low@nextSeq"]); // gap below an existing id
    expect(codes(validateManifest("assets", withIds(["asset-0005"], 6)))).toEqual([]);
    expect(codes(validateManifest("assets", withIds(["asset-12345"], 12345)))).toEqual(["seq-too-low@nextSeq"]);
  });
  it("a count-based nextSeq is no longer enough, and a legitimate gap is allowed", () => {
    // two assets, nextSeq 3 would have passed the old count rule, but asset-0009 needs nextSeq 10
    expect(codes(validateManifest("assets", withIds(["asset-0003", "asset-0009"], 3)))).not.toEqual([]);
    expect(codes(validateManifest("assets", withIds(["asset-0003", "asset-0009"], 10)))).toEqual([]);
  });
  it("ids that are not in generated form do not take part in the counter", () => {
    expect(codes(validateManifest("assets", withIds(["asset-hand", "asset-sheet"], 1)))).toEqual([]);
  });
  it("deletion keeps the counter, so a freed id is not handed out again", () => {
    let m = base();
    const seen = new Set(m.assets.map((a) => a.id));
    for (let i = 0; i < 50; i++) {
      const { id, nextSeq } = allocateAssetId(m);
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
      const template = m.assets[0] as AssetsManifest["assets"][number];
      m = { ...m, nextSeq, assets: [...m.assets, { ...template, id, file: `${id}.png`, kindRefs: [] }] };
      if (i % 3 === 0) m = removeAsset(m, id); // delete what was just added
      if (i % 7 === 0 && m.assets.length > 1) m = removeAsset(m, (m.assets[1] as { id: string }).id);
      m = { ...m, assets: [...m.assets].sort((a, b) => (a.id < b.id ? -1 : 1)) };
      expect(codes(validateManifest("assets", m)), `after step ${i}`).toEqual([]);
    }
    expect(m.nextSeq).toBe(base().nextSeq + 50);
  });
  it("removeAsset never lowers nextSeq, even when the removed asset had the highest suffix", () => {
    const m = base();
    const gone = removeAsset(m, "asset-0002");
    expect(gone.nextSeq).toBe(m.nextSeq);
    expect(allocateAssetId(gone).id).toBe("asset-0003");
    expect(codes(validateManifest("assets", gone))).toEqual([]);
  });
  it("import preserves the stored counter: serialize and parse after a deletion keep nextSeq", () => {
    const gone = removeAsset(base(), "asset-0002");
    const r = parseManifest("assets", serializeManifest("assets", gone));
    expect(r.ok && r.value.nextSeq).toBe(3);
  });
  it("cannot reconstruct deleted-id history: a lowered but still non-colliding counter is accepted (documented limit)", () => {
    const m = withIds(["asset-0001"], 2); // pretend asset-0002 was deleted before and the counter was edited down
    expect(codes(validateManifest("assets", m))).toEqual([]);
    expect(readFileSync(join(__dirname, "assetIds.ts"), "utf8")).toMatch(/cannot be detected/);
  });
  it("the counter stops at the schema maximum instead of producing an invalid manifest", () => {
    const m = base(); m.nextSeq = MAX_ASSET_SEQ;
    expect(() => allocateAssetId(m)).toThrow(/exhausted/);
  });
});

describe("P2: provenance license is an SPDX identifier or expression, or proprietary-owned (shape only)", () => {
  const lic = (value: string) => {
    const m = fixture("assets"); m.assets[0].provenance.license = value;
    return codes(validateManifest("assets", m));
  };
  it("accepts SPDX-shaped ids and expressions, LicenseRef and proprietary-owned", () => {
    for (const v of ["MIT", "Apache-2.0", "CC-BY-4.0", "CC0-1.0", "GPL-3.0-or-later", "MIT OR Apache-2.0", "GPL-2.0-only WITH Classpath-exception-2.0", "LicenseRef-studio-pack", "proprietary-owned"]) {
      expect(lic(v), v).toEqual([]);
    }
  });
  it("rejects free text, shell-like text, markup, padding and combinations with proprietary-owned", () => {
    for (const v of ["", "free to use", "MIT;rm -rf", "<script>", "(MIT)", " MIT", "MIT ", "MIT  OR Apache-2.0", "MIT OR", "a".repeat(101)]) {
      expect(lic(v), JSON.stringify(v)).not.toEqual([]);
    }
    expect(lic("proprietary-owned OR MIT")).toEqual(["license@assets.0.provenance.license"]);
  });
  it("the schema states what Studio does not verify", () => {
    const text = readFileSync(join(__dirname, "..", "..", "..", "schemas", "assets.schema.json"), "utf8");
    expect(text).toMatch(/does not verify the identifier against the SPDX list/);
    expect(text).toMatch(/that the user owns the asset/);
  });
});