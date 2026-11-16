import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileSchema, SchemaLoadError } from "./schema";
import { decodeUtf8Strict, parseStrictJson } from "./strictJson";
import {
  MANIFEST_NAMES, parseManifest, schemaFor, serializeManifest, validateManifest,
  type Issue, type ManifestName,
} from "./index";

const here = __dirname;
const fixtureText = (n: string) => readFileSync(join(here, "fixtures", `${n}.valid.json`), "utf8");
const fixture = (n: string): any => JSON.parse(fixtureText(n));
const repo = join(here, "..", "..", "..", "..");
const codes = (r: { ok: boolean; issues?: Issue[] }) => (r.ok ? [] : (r.issues ?? []).map((i) => `${i.code}@${i.path.join(".")}`));

/** Applies a mutation to a deep copy of a fixture and validates it. */
function mutated(name: ManifestName, mutate: (m: any) => void) {
  const m = fixture(name);
  mutate(m);
  return codes(validateManifest(name, m));
}

describe("shipped schemas", () => {
  it("every schema loads under the engine's discipline", () => {
    for (const n of MANIFEST_NAMES) expect(schemaFor(n).title).toMatch(/^Studio/);
  });
  it("rejects what the engine would reject at load", () => {
    const base = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "integer" } } };
    expect(() => compileSchema(base)).not.toThrow();
    expect(() => compileSchema({ ...base, oneOf: [] })).toThrow(SchemaLoadError); // unsupported keyword
    expect(() => compileSchema({ ...base, additionalProperties: true })).toThrow(/additionalProperties/);
    expect(() => compileSchema({ ...base, properties: { a: { type: "integer" }, b: { type: "integer" } } })).toThrow(/required/);
    expect(() => compileSchema({ ...base, properties: { a: { $ref: "#/$defs/nope" } } })).toThrow(/unknown definition/);
    expect(() => compileSchema({ ...base, properties: { a: { type: "number" } } })).toThrow(/unsupported type/);
    expect(() => compileSchema({ ...base, properties: { a: { type: "array", items: { type: "integer" } } } })).toThrow(/maxItems/);
  });
});

describe("valid fixtures", () => {
  for (const n of MANIFEST_NAMES) {
    it(`${n}: parses, and the file is already canonical (golden)`, () => {
      const text = fixtureText(n);
      const r = parseManifest(n, text);
      expect(codes(r)).toEqual([]);
      if (r.ok) {
        expect(serializeManifest(n, r.value as never)).toBe(text);
        const again = parseManifest(n, serializeManifest(n, r.value as never));
        expect(again.ok && JSON.stringify(again.value)).toBe(JSON.stringify(r.value));
      }
      expect(text.endsWith("\n")).toBe(true);
      expect(text.includes("\r")).toBe(false);
    });
  }
  it("canonicalization puts keys in schema order whatever the input order", () => {
    const reversed = Object.fromEntries(Object.entries(fixture("gameplay")).reverse());
    const r = validateManifest("gameplay", reversed);
    expect(r.ok).toBe(true);
    if (r.ok) expect(serializeManifest("gameplay", r.value)).toBe(fixtureText("gameplay"));
  });
  it("refuses to serialize an invalid manifest", () => {
    const m = fixture("gameplay"); m.lives.start = 0;
    expect(() => serializeManifest("gameplay", m)).toThrow(/cannot serialize/);
  });
});

describe("the Lantern Run fixtures match the canonical v4 spec", () => {
  const spec = JSON.parse(readFileSync(join(repo, "spec", "samples", "lantern-run", "monstera.spec.json"), "utf8"));
  const rt = spec.game.runtime;
  it("project hash binds to the real spec file", async () => {
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(readFileSync(join(repo, "spec", "samples", "lantern-run", "monstera.spec.json"))).digest("hex");
    expect(fixture("project").spec.baseSha256).toBe(sha);
    expect(fixture("project").projectId).toBe(spec.project.id);
  });
  it("level 1 describes exactly the spec's placements and spawners", () => {
    const l = fixture("levels").levels[0];
    const fromWaves = [...l.waves, ...l.difficulty.map((d: any) => {
      const w = l.waves.find((x: any) => x.id === d.waveId);
      return { ...w, stream: d.stream, startTick: d.atTick, intervalTicks: d.intervalTicks, vx: d.vx, vy: d.vy };
    })].map(({ id: _id, ...w }: any) => w);
    const key = (s: any) => s.stream;
    expect([...fromWaves].sort((a, b) => key(a).localeCompare(key(b)))).toEqual([...rt.spawners].sort((a: any, b: any) => key(a).localeCompare(key(b))));
    expect(l.placements.map(({ id: _id, ...p }: any) => p)).toEqual(rt.initialEntities);
  });
  it("gameplay fixture reproduces the spec's lives, win score and collisions", () => {
    const g = fixture("gameplay");
    expect(g.lives.start).toBe(rt.lives);
    expect(g.score.winScore).toBe(rt.winScore);
    const rows = [
      ...g.collectibles.map((c: any) => ({ a: c.kind, b: c.collectorKind, despawnA: c.despawn, despawnB: false, score: c.points, lives: 0 })),
      ...g.enemies.map((e: any) => ({ a: e.kind, b: e.targetKind, despawnA: e.despawnEnemy, despawnB: false, score: 0, lives: -e.livesLost })),
    ];
    expect(rows).toEqual(rt.collisions);
  });
  it("Studio ranges equal the canonical spec schema's ranges (no silent drift)", () => {
    const gs = JSON.parse(readFileSync(join(repo, "spec", "schema", "game.schema.json"), "utf8"));
    const ps = JSON.parse(readFileSync(join(repo, "spec", "schema", "project.schema.json"), "utf8"));
    const sp = gs.properties.runtime.properties.spawners.items.properties;
    const sl = JSON.parse(readFileSync(join(repo, "studio", "schemas", "levels.schema.json"), "utf8"));
    const lw = sl.properties.levels.items.properties.waves.items.properties;
    expect(sl.$defs.kindId.pattern).toBe(gs.$defs.kindId.pattern);
    expect(sl.$defs.fixed.minimum).toBe(gs.$defs.fixed.minimum);
    expect(sl.$defs.fixed.maximum).toBe(gs.$defs.fixed.maximum);
    expect(sl.$defs.tick.maximum).toBe(sp.startTick.maximum);
    expect(lw.intervalTicks.minimum).toBe(sp.intervalTicks.minimum);
    expect(lw.intervalTicks.maximum).toBe(sp.intervalTicks.maximum);
    const sg = JSON.parse(readFileSync(join(repo, "studio", "schemas", "gameplay.schema.json"), "utf8"));
    const rtp = gs.properties.runtime.properties;
    expect([sg.properties.lives.properties.start.minimum, sg.properties.lives.properties.start.maximum]).toEqual([rtp.lives.minimum, rtp.lives.maximum]);
    expect(sg.properties.score.properties.winScore.maximum).toBe(rtp.winScore.maximum);
    const col = rtp.collisions.items.properties;
    expect(sg.properties.collectibles.items.properties.points.maximum).toBe(col.score.maximum);
    expect(sg.properties.enemies.items.properties.livesLost.maximum).toBe(-col.lives.minimum);
    const sj = JSON.parse(readFileSync(join(repo, "studio", "schemas", "project.schema.json"), "utf8"));
    expect(sj.$defs.slug.pattern).toBe(ps.properties.id.pattern);
    expect([sj.$defs.slug.minLength, sj.$defs.slug.maxLength]).toEqual([ps.properties.id.minLength, ps.properties.id.maxLength]);
  });
});

describe("envelope and schema violations", () => {
  for (const n of MANIFEST_NAMES) {
    it(`${n}: missing, extra, wrong-envelope and newer-version are rejected with a path`, () => {
      expect(mutated(n, (m) => { delete m.version; })).toContain("required@version");
      expect(mutated(n, (m) => { m.surprise = 1; })).toContain("additional@surprise");
      expect(mutated(n, (m) => { m.schema = "monstera.studio.other"; })).toEqual(["wrong-schema@schema"]);
      expect(mutated(n, (m) => { m.version = 2; })).toEqual(["newer-version@version"]);
      expect(mutated(n, (m) => { m.version = 0; })).toEqual(["const@version"]);
    });
  }
  it("wrong types and ranges name the exact path", () => {
    expect(mutated("gameplay", (m) => { m.lives.start = 100; })).toEqual(["maximum@lives.start"]);
    expect(mutated("gameplay", (m) => { m.lives.start = "3"; })).toEqual(["type@lives.start"]);
    expect(mutated("gameplay", (m) => { m.lives.start = 1.5; })).toEqual(["type@lives.start"]);
    expect(mutated("gameplay", (m) => { m.planned = ["health"]; })).toEqual(["maxItems@planned"]);
    expect(mutated("levels", (m) => { m.levels[0].waves[0].vx = 2147483648; })).toEqual(["maximum@levels.0.waves.0.vx"]);
    expect(mutated("levels", (m) => { m.levels[0].waves[0].kind = "Wisp"; })).toEqual(["pattern@levels.0.waves.0.kind"]);
    expect(mutated("assets", (m) => { m.assets[0].mime = "image/svg+xml"; })).toEqual(["enum@assets.0.mime"]);
    expect(mutated("assets", (m) => { m.assets[0].bytes = 5242881; })).toEqual(["maximum@assets.0.bytes"]);
    expect(mutated("assets", (m) => { m.assets[0].width = 4097; })).toEqual(["maximum@assets.0.width"]);
    expect(mutated("assets", (m) => { m.assets[0].file = "../evil.png"; })).toEqual(["pattern@assets.0.file"]);
    expect(mutated("assets", (m) => { m.assets[0].file = ".hidden"; })).toEqual(["pattern@assets.0.file"]);
    expect(mutated("assets", (m) => { m.assets[0].provenance.license = ""; })).toEqual(["minLength@assets.0.provenance.license", "pattern@assets.0.provenance.license"]);
    expect(mutated("animations", (m) => { m.animations[0].fps = 61; })).toEqual(["maximum@animations.0.fps"]);
    expect(mutated("animations", (m) => { m.animations[0].loop = "bounce"; })).toEqual(["enum@animations.0.loop"]);
    expect(mutated("integrations", (m) => { m.monetization.mode = "production"; })).toEqual(["enum@monetization.mode"]);
    expect(mutated("integrations", (m) => { m.backend.status = "live"; })).toEqual(["const@backend.status"]);
    expect(mutated("project", (m) => { m.spec.baseSha256 = "ABC"; })).toEqual(["pattern@spec.baseSha256"]);
  });
  it("a manifest must be an object", () => {
    expect(codes(validateManifest("levels", []))).toEqual(["type@"]);
    expect(codes(validateManifest("levels", null))).toEqual(["type@"]);
  });
});

describe("internal checks", () => {
  it("duplicate and unsorted ids", () => {
    expect(mutated("assets", (m) => { m.assets[1].id = "asset-0001"; })).toContain("duplicate-id@assets.1.id");
    expect(mutated("assets", (m) => { m.assets.reverse(); })).toContain("not-sorted@assets.1");
    expect(mutated("levels", (m) => { m.levels[1].order = 1; })).toContain("duplicate-order@levels.1.order");
    expect(mutated("levels", (m) => { m.levels[0].waves[1].id = "lanterns"; })).toContain("duplicate-id@levels.0.waves.1.id");
  });
  it("asset consistency and provenance", () => {
    expect(mutated("assets", (m) => { m.nextSeq = 2; })).toEqual(["seq-too-low@nextSeq"]); // asset-0002 exists
    expect(mutated("assets", (m) => { m.assets[0].mime = "audio/wav"; })).toContain("kind-mime@assets.0.mime");
    expect(mutated("assets", (m) => { m.assets[1].category = "sprite"; })).toEqual(["kind-category@assets.1.category"]);
    expect(mutated("assets", (m) => { m.assets[0].width = 0; })).toContain("dimensions@assets.0.width");
    expect(mutated("assets", (m) => { m.assets[1].provenance.model = ""; })).toEqual(["provenance@assets.1.provenance.tool"]);
    expect(mutated("assets", (m) => { m.assets[0].provenance.promptSha256 = "a".repeat(64); })).toEqual(["provenance@assets.0.provenance.promptSha256"]);
    expect(mutated("assets", (m) => { m.assets[0].kindRefs = ["wisp", "lantern"]; })).toEqual(["not-sorted@assets.0.kindRefs.1"]);
  });
  it("animation references", () => {
    expect(mutated("animations", (m) => { m.animations[0].sequence[1].frameId = "f9"; })).toEqual(["unknown-frame@animations.0.sequence.1.frameId"]);
    expect(mutated("animations", (m) => { m.animations[0].sheetId = "nope"; })).toEqual(["unknown-sheet@animations.0.sheetId"]);
    expect(mutated("animations", (m) => { m.animations[0].sequence = []; })).toEqual(["empty-sequence@animations.0.sequence"]);
    expect(mutated("animations", (m) => { m.sheets[0].frames[1].id = "f0"; })).toContain("duplicate-id@sheets.0.frames.1.id");
  });
  it("level references and ranges", () => {
    expect(mutated("levels", (m) => { m.levels[0].difficulty[0].waveId = "nope"; })).toEqual(["unknown-wave@levels.0.difficulty.0.waveId"]);
    expect(mutated("levels", (m) => { m.levels[0].difficulty[0].atTick = 180; })).toEqual(["before-wave@levels.0.difficulty.0.atTick"]);
    expect(mutated("levels", (m) => { m.levels[0].waves[0].xMin = 70000000; })).toEqual(["range@levels.0.waves.0.xMax"]);
    expect(mutated("levels", (m) => { m.levels[0].difficulty[0].stream = "wisps"; })).toEqual(["duplicate-stream@levels.0.difficulty.0.stream"]);
  });
  it("gameplay pair conflicts", () => {
    expect(mutated("gameplay", (m) => { m.enemies[0].kind = "lantern"; m.enemies[0].targetKind = "keeper"; })).toEqual(["duplicate-pair@enemies.0.kind"]);
  });
  it("integrations", () => {
    expect(mutated("integrations", (m) => { m.monetization.placements[1].rewardAmount = 0; })).toEqual(["reward@monetization.placements.1.rewardKind"]);
    expect(mutated("integrations", (m) => { m.monetization.placements[0].rewardKind = "life"; })).toEqual(["reward@monetization.placements.0.rewardKind"]);
    expect(mutated("integrations", (m) => { m.backend.configFiles.reverse(); })).toEqual(["not-sorted@backend.configFiles.1"]);
  });
  it("project derivation consistency", () => {
    expect(mutated("project", (m) => { m.derivation.levels = true; })).toEqual(["required-when-derived@derivation.activeLevel"]);
    expect(mutated("project", (m) => { m.derivation.activeLevel = "level-1"; })).toEqual(["set-while-off@derivation.activeLevel"]);
    expect(mutated("project", (m) => { m.spec.currentSha256 = "b".repeat(64); })).toEqual(["hash-mismatch@spec.currentSha256"]);
    expect(mutated("project", (m) => { m.derived.inputsSha256 = "c".repeat(64); })).toEqual(["set-while-off@derived.inputsSha256"]);
    expect(mutated("project", (m) => { m.derivation.gameplay = true; m.modules = ["levels"]; m.spec.currentSha256 = "d".repeat(64); })).toEqual(["module-missing@derivation.gameplay"]);
    expect(mutated("project", (m) => { m.modules = ["levels", "assets"]; })).toEqual(["not-sorted@modules.1"]);
    expect(mutated("project", (m) => { m.modules = ["assets", "assets"]; })).toEqual(["not-sorted@modules.1"]);
  });
  it("proposals are data only", () => {
    expect(mutated("proposal", (m) => { m.ops[0].value = "not json"; })).toEqual(["value@ops.0.value"]);
    expect(mutated("proposal", (m) => { m.ops[1].value = "1"; })).toEqual(["value@ops.1.value"]);
    expect(mutated("proposal", (m) => { m.ops[0].path = "/a/__proto__/b"; })).toEqual(["forbidden-key@ops.0.path"]);
    expect(mutated("proposal", (m) => { m.ops[0].path = "levels/0"; })).toEqual(["pattern@ops.0.path"]);
  });
});

describe("strict JSON reader (hostile input)", () => {
  const bad = (text: string) => { const r = parseStrictJson(text); return r.ok ? "ok" : r.issue.code; };
  it("rejects duplicate keys, forbidden keys, floats and trailing data", () => {
    expect(bad('{"a":1,"a":2}')).toBe("duplicate-key");
    expect(bad('{"__proto__":{}}')).toBe("forbidden-key");
    expect(bad('{"x":{"constructor":1}}')).toBe("forbidden-key");
    expect(bad('{"prototype":1}')).toBe("forbidden-key");
    expect(bad('{"a":1.0}')).toBe("float");
    expect(bad('{"a":1e3}')).toBe("float");
    expect(bad('{"a":9007199254740993}')).toBe("integer-range");
    expect(bad('{"a":1} x')).toBe("syntax");
    expect(bad('{"a":1,}')).toBe("syntax");
    expect(bad('[1,]')).toBe("syntax");
    expect(bad('{"a":01}')).toBe("syntax");
    expect(bad('{"a":"x\ty"}')).toBe("syntax");
    expect(bad('{"a":"\\x"}')).toBe("syntax");
    expect(bad('{"a":')).toBe("syntax");
    expect(bad("")).toBe("syntax");
  });
  it("rejects a BOM, invalid UTF-8 and excessive nesting or size", () => {
    expect(bad("\ufeff{}")).toBe("bom");
    const d1 = decodeUtf8Strict(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
    expect(d1.ok ? "ok" : d1.issue.code).toBe("bom");
    const d2 = decodeUtf8Strict(new Uint8Array([0x7b, 0xff, 0x7d]));
    expect(d2.ok ? "ok" : d2.issue.code).toBe("invalid-utf8");
    expect(bad("[".repeat(34) + "]".repeat(34))).toBe("too-deep");
    expect(bad("[".repeat(10000))).toBe("too-deep");
    const big = decodeUtf8Strict(new Uint8Array(8 * 1024 * 1024 + 1));
    expect(big.ok ? "ok" : big.issue.code).toBe("too-large");
  });
  it("accepts ordinary documents and unicode escapes, and -0 becomes 0", () => {
    expect(parseStrictJson('{"a":[1,-2,0,-0],"b":"\\u00e9\\n","c":null,"d":true}')).toEqual({ ok: true, value: { a: [1, -2, 0, 0], b: "é\n", c: null, d: true } });
  });
  it("parseManifest reports reader errors with the same shape", () => {
    expect(codes(parseManifest("levels", '{"schema":"monstera.studio.levels","version":1,"levels":[],"levels":[]}'))).toEqual(["duplicate-key@"]);
    expect(codes(parseManifest("levels", new Uint8Array([0xff])))).toEqual(["invalid-utf8@"]);
    expect(codes(parseManifest("levels", '{"schema":"monstera.studio.levels","version":1,"levels":[{"x":1.5}]}'))).toEqual(["float@"]);
  });
  it("a parsed __proto__-free object has no inherited surprises", () => {
    const r = parseStrictJson('{"a":{"b":1}}');
    expect(r.ok && Object.getPrototypeOf((r.value as any).a)).toBe(Object.prototype);
    expect(({} as any).b).toBeUndefined();
  });
});

