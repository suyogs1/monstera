import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileLevel, MAX_SPAWNERS_PER_LEVEL, type CompileIssue, type CompileResult } from "./levels";

const repo = join(__dirname, "..", "..", "..");
const read = (p: string): string => readFileSync(p, "utf8");
const levelsText = read(join(repo, "studio", "src", "project", "manifests", "fixtures", "levels.valid.json"));
const specText = read(join(repo, "spec", "samples", "lantern-run", "monstera.spec.json"));
const golden = (n: string): any => JSON.parse(read(join(__dirname, "fixtures", `compiled.${n}.golden.json`)));
const levels = (): any => JSON.parse(levelsText);
const spec = (): any => JSON.parse(specText);

const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
  return v;
};
const fail = (r: CompileResult): CompileIssue[] => {
  if (r.ok) throw new Error("expected the compile to fail");
  return r.issues;
};
const ok = (r: CompileResult) => {
  if (!r.ok) throw new Error(`expected success, got ${r.issues.map((i) => `${i.code}@${i.path.join(".")}`).join("; ")}`);
  return r;
};
const at = (r: CompileResult) => fail(r).map((i) => `${i.source}:${i.code}@${i.path.join(".")}`);
/** Compiles level-1 after a mutation of a fresh manifest copy. */
const withLevels = (mutate: (m: any) => void, id = "level-1", base: unknown = spec()) => {
  const m = levels();
  mutate(m);
  return compileLevel(m, base, id);
};
const wave = (over: Record<string, unknown> = {}) => ({
  id: "wv", stream: "sw", kind: "wisp", startTick: 0, intervalTicks: 1, xMin: 0, xMax: 1, yMin: 0, yMax: 1, vx: 0, vy: 0, ...over,
});
const step = (over: Record<string, unknown> = {}) => ({ id: "st", waveId: "wv", stream: "sd", atTick: 1, intervalTicks: 1, vx: 0, vy: 0, ...over });
const place = (i: number) => ({ id: `p${i}`.padEnd(3, "x"), kind: "keeper", x: 0, y: 0, vx: 0, vy: 0, controlled: false });
const unique = (prefix: string, i: number) => `${prefix}-${i.toString(36).padStart(2, "0")}`;

describe("golden output", () => {
  it.each(["level-1", "level-2"])("%s equals its pinned golden output", (id) => {
    expect(JSON.parse(JSON.stringify(compileLevel(levels(), spec(), id)))).toEqual({ ok: true, ...golden(id) });
  });
  it("serializes goldens with the spec's key order", () => {
    const r = ok(compileLevel(levels(), spec(), "level-1"));
    expect(Object.keys(r.spawners[0] ?? {})).toEqual(["stream", "kind", "startTick", "intervalTicks", "xMin", "xMax", "yMin", "yMax", "vx", "vy"]);
    expect(Object.keys(r.initialEntities[0] ?? {})).toEqual(["kind", "x", "y", "vx", "vy", "controlled"]);
  });
  it("names source-object paths and exposes no property-level path fields", () => {
    const r = ok(compileLevel(levels(), spec(), "level-1")) as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["entitySourcePaths", "initialEntities", "levelId", "ok", "spawnerSourcePaths", "spawners"]);
    expect(r["entityPaths"]).toBeUndefined();
    expect(r["spawnerPaths"]).toBeUndefined();
    const sp = r["spawnerSourcePaths"] as (string | number)[][];
    expect(sp.map((p) => p.length)).toEqual([4, 4, 4]); // levels, index, section, index: an object, never a property name
    expect(sp[2]).toEqual(["levels", 0, "difficulty", 0]);
    expect((r["entitySourcePaths"] as (string | number)[][])[0]).toEqual(["levels", 0, "placements", 0]);
  });  it("level-1 reproduces the pointers of the Lantern Run spec exactly", () => {
    const r = ok(compileLevel(levels(), spec(), "level-1"));
    expect(r.initialEntities).toEqual(spec().game.runtime.initialEntities);
    expect(r.spawners).toEqual(spec().game.runtime.spawners);
  });
});

describe("determinism and purity", () => {
  it("returns identical output for identical input, in any call order", () => {
    const a = JSON.stringify(compileLevel(levels(), spec(), "level-1"));
    compileLevel(levels(), spec(), "level-2");
    expect(JSON.stringify(compileLevel(levels(), spec(), "level-1"))).toBe(a);
    expect(compileLevel(levels(), spec(), "level-1")).toEqual(compileLevel(levels(), spec(), "level-1"));
  });
  it("accepts deeply frozen inputs and leaves them unchanged", () => {
    const m = deepFreeze(levels());
    const s = deepFreeze(spec());
    const before = [JSON.stringify(m), JSON.stringify(s)];
    ok(compileLevel(m, s, "level-1"));
    fail(compileLevel(m, s, "missing"));
    expect([JSON.stringify(m), JSON.stringify(s)]).toEqual(before);
  });
  it("returns fresh objects: editing the output cannot change the inputs", () => {
    const m = levels();
    const s = spec();
    const r = ok(compileLevel(m, s, "level-1"));
    r.initialEntities[0]!.x = 1;
    r.spawners[0]!.kind = "changed";
    r.entitySourcePaths[0]!.push("x");
    expect(m).toEqual(levels());
    expect(s).toEqual(spec());
    expect(ok(compileLevel(m, s, "level-1")).initialEntities[0]?.x).toBe(32112640);
  });
  it("ignores everything in the base spec except kinds and maxEntities", () => {
    const s = spec();
    s.game.runtime.initialEntities = []; s.game.runtime.spawners = []; s.game.runtime.lives = 9; s.extra = "x";
    expect(compileLevel(levels(), s, "level-1")).toEqual(compileLevel(levels(), spec(), "level-1"));
  });
  it("normalizes negative zero", () => {
    const r = ok(withLevels((m) => { m.levels[0].placements[0].vx = -0; m.levels[0].waves[0].yMax = -0; }));
    expect(Object.is(r.initialEntities[0]?.vx, 0)).toBe(true);
    expect(Object.is(r.spawners[0]?.yMax, 0)).toBe(true);
  });
});

describe("engine validation (the real Python engine)", () => {
  const dir = mkdtempSync(join(tmpdir(), "monstera-levels-"));
  const run = (candidate: string[], file: string): string =>
    execFileSync(candidate[0] as string, [...candidate.slice(1), join(repo, "tools", "monstera", "monstera.py"), "validate", file, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const engine = (file: string): { valid: boolean; issues: { path: string; code: string }[] } => {
    const candidates = [["python3"], ["python"], ["py", "-3"]];
    for (const c of candidates) {
      try { return JSON.parse(run(c, file)); } catch (e: any) {
        if (e?.stdout) { try { return JSON.parse(String(e.stdout)); } catch { /* try the next interpreter */ } }
      }
    }
    throw new Error("no Python 3.10+ interpreter could run tools/monstera/monstera.py");
  };
  const compiledSpec = (id: string, m: unknown = levels()) => {
    const r = ok(compileLevel(m, spec(), id));
    const s = spec();
    s.game.runtime.initialEntities = r.initialEntities;
    s.game.runtime.spawners = r.spawners;
    return s;
  };
  const verdict = (s: unknown, name: string) => {
    const f = join(dir, `${name}.json`);
    writeFileSync(f, JSON.stringify(s, null, 2));
    return engine(f);
  };
  it("validates the compiled Lantern Run level-1 and level-2 specs", () => {
    expect(verdict(compiledSpec("level-1"), "l1")).toMatchObject({ valid: true, issues: [] });
    expect(verdict(compiledSpec("level-2"), "l2")).toMatchObject({ valid: true, issues: [] });
  });
  it("the compiled level-1 spec is the committed Lantern Run spec", () => {
    expect(compiledSpec("level-1")).toEqual(spec());
  });
  it("a boundary level (all limits, extreme values, difficulty chain) validates", () => {
    const s = spec();
    s.game.runtime.maxEntities = 1024;
    const m = levels();
    const lv = m.levels[0];
    lv.placements = Array.from({ length: 64 }, (_, i) => ({ ...place(i), id: unique("p", i), kind: i % 2 ? "lantern" : "keeper", x: i % 2 ? 2147483647 : -2147483648, vy: -2147483648 }));
    lv.waves = Array.from({ length: 32 }, (_, i) => wave({ id: unique("w", i), stream: unique("sw", i), kind: "lantern", startTick: i === 0 ? 0 : 1000000, intervalTicks: i === 0 ? 1 : 1000000, xMin: 0, xMax: 1000, yMin: -5, yMax: 0 }));
    lv.difficulty = Array.from({ length: 32 }, (_, i) => step({ id: unique("d", i), waveId: unique("w", i), stream: unique("sd", i), atTick: 1000000, intervalTicks: 1000000 }));
    lv.waves.forEach((w: any, i: number) => { if (i > 0) w.startTick = 999999; });
    const r = ok(compileLevel(m, s, "level-1"));
    expect(r.spawners).toHaveLength(MAX_SPAWNERS_PER_LEVEL);
    s.game.runtime.initialEntities = r.initialEntities;
    s.game.runtime.spawners = r.spawners;
    expect(verdict(s, "boundary")).toMatchObject({ valid: true, issues: [] });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("difficulty steps", () => {
  it("compiles a step to one extra spawner that reuses the wave's kind and ranges", () => {
    const r = ok(compileLevel(levels(), spec(), "level-1"));
    const wisps = r.spawners[1]!;
    const late = r.spawners[2]!;
    expect({ ...late, stream: wisps.stream, startTick: wisps.startTick, intervalTicks: wisps.intervalTicks, vx: wisps.vx, vy: wisps.vy }).toEqual(wisps);
    expect(late).toMatchObject({ stream: "wisps-late", startTick: 1200, intervalTicks: 100, vy: 458752 });
    expect(r.spawners[1]).toEqual(wisps); // the wave itself keeps running; a step does not edit or stop it
  });
  it("places every wave before every step, each in manifest order", () => {
    const r = ok(withLevels((m) => {
      const lv = m.levels[0];
      lv.difficulty = [step({ id: "a-step", waveId: "wisps", stream: "sa", atTick: 500 }), step({ id: "b-step", waveId: "lanterns", stream: "sb", atTick: 400 })];
    }));
    expect(r.spawners.map((s) => s.stream)).toEqual(["lanterns", "wisps", "sa", "sb"]);
    expect(r.spawners.map((s) => s.kind)).toEqual(["lantern", "wisp", "wisp", "lantern"]);
    expect(r.spawnerSourcePaths[3]).toEqual(["levels", 0, "difficulty", 1]);
  });
  it("supports several steps on one wave", () => {
    const r = ok(withLevels((m) => {
      m.levels[0].difficulty = [step({ id: "s1", waveId: "wisps", stream: "x1", atTick: 300 }), step({ id: "s2", waveId: "wisps", stream: "x2", atTick: 900 })];
    }));
    expect(r.spawners.filter((s) => s.kind === "wisp")).toHaveLength(3);
  });
  it("accepts a step one tick after its wave and at the 1,000,000 limit", () => {
    ok(withLevels((m) => { m.levels[0].waves = [wave({ startTick: 5 })]; m.levels[0].difficulty = [step({ atTick: 6 })]; }));
    ok(withLevels((m) => { m.levels[0].waves = [wave()]; m.levels[0].difficulty = [step({ atTick: 1000000 })]; }));
  });
  it("rejects a step at or before its wave start, past the limit, or on an unknown wave", () => {
    const one = (d: Record<string, unknown>, w: Record<string, unknown> = {}) => at(withLevels((m) => { m.levels[0].waves = [wave(w)]; m.levels[0].difficulty = [step(d)]; }));
    expect(one({ atTick: 5 }, { startTick: 5 })).toContain("levels:before-wave@levels.0.difficulty.0.atTick");
    expect(one({ atTick: 1000001 })).toContain("levels:maximum@levels.0.difficulty.0.atTick");
    expect(one({ waveId: "nope" })).toEqual(["levels:unknown-wave@levels.0.difficulty.0.waveId"]);
    expect(one({ atTick: 0 })).toContain("levels:minimum@levels.0.difficulty.0.atTick");
  });
  it("rejects a step stream that repeats a wave stream", () => {
    expect(at(withLevels((m) => { m.levels[0].difficulty[0].stream = "wisps"; }))).toEqual(["levels:duplicate-stream@levels.0.difficulty.0.stream"]);
  });
});

describe("limits", () => {
  const max = (n: number) => { const s = spec(); s.game.runtime.maxEntities = n; return s; };
  it("accepts exactly maxEntities placements and rejects one more, at the placements field", () => {
    const fill = (n: number) => (m: any) => { m.levels[0].placements = Array.from({ length: n }, (_, i) => ({ ...place(i), id: unique("p", i) })); };
    ok(withLevels(fill(64), "level-1", max(64)));
    expect(at(withLevels(fill(64), "level-1", max(63)))).toEqual(["levels:entity-cap@levels.0.placements"]);
    ok(withLevels(fill(1), "level-1", max(1)));
    expect(at(withLevels(fill(2), "level-1", max(1)))).toEqual(["levels:entity-cap@levels.0.placements"]);
  });
  it("rejects more than 64 placements, 32 waves or 32 steps as schema limits", () => {
    const many = (n: number, f: (i: number) => object) => Array.from({ length: n }, (_, i) => f(i));
    expect(at(withLevels((m) => { m.levels[0].placements = many(65, (i) => ({ ...place(i), id: unique("p", i) })); }, "level-1", max(1024)))[0]).toMatch(/^levels:.*@levels\.0\.placements/);
    expect(at(withLevels((m) => { m.levels[0].waves = many(33, (i) => wave({ id: unique("w", i), stream: unique("s", i) })); }))[0]).toMatch(/^levels:.*@levels\.0\.waves/);
    expect(at(withLevels((m) => { m.levels[0].difficulty = many(33, (i) => step({ id: unique("d", i), stream: unique("t", i) })); }))[0]).toMatch(/^levels:.*@levels\.0\.difficulty/);
  });
  it("accepts 32 waves plus 32 steps (64 spawners) at their limits", () => {
    const r = ok(withLevels((m) => {
      m.levels[0].waves = Array.from({ length: 32 }, (_, i) => wave({ id: unique("w", i), stream: unique("s", i) }));
      m.levels[0].difficulty = Array.from({ length: 32 }, (_, i) => step({ id: unique("d", i), stream: unique("t", i), waveId: unique("w", i) }));
    }));
    expect(r.spawners).toHaveLength(64);
  });
  it.each([
    ["startTick", -1], ["startTick", 1000001], ["intervalTicks", 0], ["intervalTicks", 1000001],
    ["xMin", -2147483649], ["xMax", 2147483648], ["yMin", 1.5], ["vy", Number.NaN], ["vx", Number.POSITIVE_INFINITY],
  ])("rejects wave %s = %s at its field", (field, value) => {
    const issues = fail(withLevels((m) => { m.levels[0].waves[0][field] = value; }));
    expect(issues.some((i) => i.path.join(".") === `levels.0.waves.0.${field}` && i.source === "levels")).toBe(true);
  });
  it.each([
    ["startTick", 0], ["startTick", 1000000], ["intervalTicks", 1], ["intervalTicks", 1000000], ["xMin", -2147483648], ["xMax", 2147483647],
  ])("accepts wave %s = %s", (field, value) => {
    ok(withLevels((m) => {
      const w = m.levels[0].waves[0];
      w.xMin = -2147483648; w.xMax = 2147483647; w[field] = value;
    }));
  });
  it("rejects an inverted spawn range at xMax / yMax", () => {
    expect(at(withLevels((m) => { m.levels[0].waves[0].xMax = -1; m.levels[0].waves[0].yMax = -9000000; }))).toEqual([
      "levels:range@levels.0.waves.0.xMax", "levels:range@levels.0.waves.0.yMax"]);
  });
  it("rejects placement coordinates outside int32", () => {
    expect(fail(withLevels((m) => { m.levels[0].placements[0].x = 2147483648; })).map((i) => i.path.join("."))).toContain("levels.0.placements.0.x");
  });
});

describe("unsupported shapes", () => {
  it.each([
    ["waves", 0, "count"], ["waves", 0, "endTick"], ["waves", 0, "stopTick"], ["waves", 0, "maxSpawns"], ["waves", 0, "duration"],
    ["difficulty", 0, "endsAtTick"],
  ])("rejects %s[%i].%s as unsupported, with its path", (section, i, key) => {
    const issues = fail(withLevels((m) => { m.levels[0][section as string][i as number][key as string] = 10; }));
    expect(issues).toEqual([expect.objectContaining({ source: "levels", code: "unsupported-field", path: ["levels", 0, section, i, key] })]);
    expect(issues[0]?.message).toContain("E3");
  });
  it.each(["winScore", "winCondition", "lives", "next", "nextLevel", "selectable"])("rejects a per-level %s", (key) => {
    expect(at(withLevels((m) => { m.levels[0][key] = 1; }))).toEqual([`levels:unsupported-field@levels.0.${key}`]);
  });
  it("rejects other unknown properties generically, never silently dropping them", () => {
    expect(at(withLevels((m) => { m.levels[0].waves[0].color = "red"; }))).toEqual(["levels:additional@levels.0.waves.0.color"]);
    expect(at(withLevels((m) => { m.extra = 1; }))).toEqual(["levels:additional@extra"]);
  });
  describe("unsupported-field explanations are context-aware", () => {
    const SPAWN = ["count", "maxSpawns", "endTick", "stopTick", "endsAtTick", "duration"];
    const LEVEL = ["winScore", "winCondition", "lives", "next", "nextLevel", "selectable"];
    const put = (target: (m: any) => any, key: string) => at(withLevels((m) => { target(m)[key] = 10; }));
    const contexts: [string, (m: any) => any, string[]][] = [
      ["a level object", (m) => m.levels[0], LEVEL],
      ["a wave", (m) => m.levels[0].waves[0], SPAWN],
      ["a difficulty step", (m) => m.levels[0].difficulty[0], SPAWN],
    ];
    const everywhere: [string, (m: any) => any, string][] = [
      ["a level object", (m) => m.levels[0], "levels.0"],
      ["a wave", (m) => m.levels[0].waves[0], "levels.0.waves.0"],
      ["a difficulty step", (m) => m.levels[0].difficulty[0], "levels.0.difficulty.0"],
      ["a placement", (m) => m.levels[0].placements[0], "levels.0.placements.0"],
      ["the manifest root", (m) => m, ""],
    ];
    it.each(contexts)("explains the relevant names on %s", (_n, target, names) => {
      for (const key of names) {
        const issues = fail(withLevels((m) => { target(m)[key] = 10; }));
        expect(issues, key).toHaveLength(1);
        expect(issues[0], key).toMatchObject({ code: "unsupported-field", source: "levels" });
        expect(issues[0]?.message, key).toContain("E3");
      }
    });
    it.each(everywhere)("gives the other context's names on %s only the generic issue", (name, target, prefix) => {
      const foreign = name === "a level object" ? SPAWN : name === "a wave" || name === "a difficulty step" ? LEVEL : [...SPAWN, ...LEVEL];
      for (const key of foreign) {
        const issues = fail(withLevels((m) => { target(m)[key] = 10; }));
        expect(issues, `${name}.${key}`).toEqual([{ source: "levels", code: "additional", path: [...(prefix ? prefix.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : []), key], message: `unknown property "${key}"` }]);
        expect(issues[0]?.message).not.toContain("E3");
      }
    });
    it("uses the second level's index in the context decision", () => {
      expect(put((m) => m.levels[1], "lives")).toEqual(["levels:unsupported-field@levels.1.lives"]);
      expect(put((m) => m.levels[1].waves[0], "lives")).toEqual(["levels:additional@levels.1.waves.0.lives"]);
    });
    it("still rejects a context-matching name that is not an unknown property (a real field keeps its own issue)", () => {
      expect(at(withLevels((m) => { m.levels[0].waves[0].startTick = -1; }))).toEqual(["levels:minimum@levels.0.waves.0.startTick"]);
    });
  });  it("does not treat inherited names as unsupported-field", () => {
    const issues = fail(withLevels((m) => { m.levels[0].toString = 1; }));
    expect(issues[0]?.code).toBe("additional");
  });
  it("rejects a string where a number belongs, and a missing field", () => {
    expect(at(withLevels((m) => { m.levels[0].waves[0].vy = "5"; }))[0]).toBe("levels:type@levels.0.waves.0.vy");
    expect(at(withLevels((m) => { delete m.levels[0].waves[0].xMax; }))[0]).toBe("levels:required@levels.0.waves.0.xMax");
  });
});

describe("invalid references and selection", () => {
  it("rejects an unknown kind on a placement and on a wave, naming the field", () => {
    expect(at(withLevels((m) => { m.levels[0].placements[0].kind = "ghost"; }))).toEqual(["levels:unknown-kind@levels.0.placements.0.kind"]);
    expect(at(withLevels((m) => { m.levels[0].waves[1].kind = "ghost"; }))).toEqual(["levels:unknown-kind@levels.0.waves.1.kind"]);
  });
  it("reports every bad reference in one pass, in manifest order", () => {
    expect(at(withLevels((m) => { m.levels[0].placements[0].kind = "a"; m.levels[0].waves[0].kind = "b"; m.levels[0].waves[1].kind = "c"; }))).toEqual([
      "levels:unknown-kind@levels.0.placements.0.kind", "levels:unknown-kind@levels.0.waves.0.kind", "levels:unknown-kind@levels.0.waves.1.kind"]);
  });
  it("lists the defined kinds in the message", () => {
    expect(fail(withLevels((m) => { m.levels[0].waves[0].kind = "ghost"; }))[0]?.message).toContain("keeper, lantern, wisp");
  });
  it("points at the second level by index", () => {
    expect(at(withLevels((m) => { m.levels[1].waves[0].kind = "ghost"; }, "level-2"))).toEqual(["levels:unknown-kind@levels.1.waves.0.kind"]);
  });
  it("rejects an unknown, empty or non-string level id with a request path", () => {
    for (const id of ["nope", "", "level-1 ", "LEVEL-1", "__proto__", "constructor"]) {
      expect(at(compileLevel(levels(), spec(), id))).toEqual(["request:unknown-level@levelId"]);
    }
    expect(at(compileLevel(levels(), spec(), undefined as unknown as string))).toEqual(["request:unknown-level@levelId"]);
  });
  it("does not let an invalid sibling level be compiled around: the manifest must be valid", () => {
    expect(at(withLevels((m) => { m.levels[1].waves[0].xMax = -5; }, "level-1"))).toEqual(["levels:range@levels.1.waves.0.xMax"]);
  });
  it("rejects duplicate ids, orders and out-of-order levels at their fields", () => {
    expect(at(withLevels((m) => { m.levels[1].id = "level-1"; }))).toContain("levels:duplicate-id@levels.1.id");
    expect(at(withLevels((m) => { m.levels[1].order = 1; }))).toContain("levels:duplicate-order@levels.1.order");
  });
});

describe("hostile and malformed input", () => {
  it.each([null, undefined, 0, "levels", [], true, {}])("rejects manifest %j without throwing", (bad) => {
    expect(fail(compileLevel(bad, spec(), "level-1")).every((i) => i.source === "levels")).toBe(true);
  });
  it("rejects a wrong schema name and a newer version", () => {
    expect(at(withLevels((m) => { m.schema = "monstera.studio.gameplay"; }))).toEqual(["levels:wrong-schema@schema"]);
    expect(at(withLevels((m) => { m.version = 2; }))).toEqual(["levels:newer-version@version"]);
  });
  it("rejects a manifest that carries a __proto__ key", () => {
    const m = JSON.parse(levelsText.replace('"levels": [', '"__proto__": {}, "levels": ['));
    expect(compileLevel(m, spec(), "level-1").ok).toBe(false);
  });
  it.each([
    ["null", null, []],
    ["array", [], []],
    ["no game", {}, ["game"]],
    ["no runtime", { game: {} }, ["game", "runtime"]],
    ["maxEntities zero", { game: { runtime: { maxEntities: 0, kinds: [] } } }, ["game", "runtime", "maxEntities"]],
    ["maxEntities float", { game: { runtime: { maxEntities: 1.5, kinds: [] } } }, ["game", "runtime", "maxEntities"]],
    ["kinds not array", { game: { runtime: { maxEntities: 4, kinds: {} } } }, ["game", "runtime", "kinds"]],
    ["kind without id", { game: { runtime: { maxEntities: 4, kinds: [{ id: "a" }, {}] } } }, ["game", "runtime", "kinds", 1, "id"]],
  ])("rejects a malformed base spec (%s) with its path", (_n, base, path) => {
    const issues = fail(compileLevel(levels(), base, "level-1"));
    expect(issues).toEqual([expect.objectContaining({ source: "base-spec", code: "bad-base-spec", path })]);
  });
  it("an empty kinds list makes every reference unknown", () => {
    const s = spec(); s.game.runtime.kinds = [];
    expect(fail(compileLevel(levels(), s, "level-1")).every((i) => i.code === "unknown-kind")).toBe(true);
  });
  it("accepts a level with no placements, no waves and no steps", () => {
    const r = ok(withLevels((m) => { m.levels[0].placements = []; m.levels[0].waves = []; m.levels[0].difficulty = []; }));
    expect(r.initialEntities).toEqual([]);
    expect(r.spawners).toEqual([]);
  });
});
