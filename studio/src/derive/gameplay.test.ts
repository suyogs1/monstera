import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileGameplay, type GameplayCompileResult, type GameplayIssue } from "./gameplay";

const repo = join(__dirname, "..", "..", "..");
const read = (p: string): string => readFileSync(p, "utf8");
const gameplayText = read(join(repo, "studio", "src", "project", "manifests", "fixtures", "gameplay.valid.json"));
const specText = read(join(repo, "spec", "samples", "lantern-run", "monstera.spec.json"));
const golden = (): any => JSON.parse(read(join(__dirname, "fixtures", "compiled.gameplay.golden.json")));
const gameplay = (): any => JSON.parse(gameplayText);
const spec = (): any => JSON.parse(specText);

const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
  return v;
};
const fail = (r: GameplayCompileResult): GameplayIssue[] => {
  if (r.ok) throw new Error("expected the compile to fail");
  return r.issues;
};
const ok = (r: GameplayCompileResult) => {
  if (!r.ok) throw new Error(`expected success, got ${r.issues.map((i) => `${i.code}@${i.path.join(".")}`).join("; ")}`);
  return r;
};
const at = (r: GameplayCompileResult) => fail(r).map((i) => `${i.source}:${i.code}@${i.path.join(".")}`);
const withGameplay = (mutate: (m: any) => void, designerRows: unknown = [], base: unknown = spec()) => {
  const m = gameplay();
  mutate(m);
  return compileGameplay(m, base, designerRows);
};

describe("golden output", () => {
  it("equals the pinned golden output", () => {
    expect(JSON.parse(JSON.stringify(compileGameplay(gameplay(), spec(), [])))).toEqual({ ok: true, ...golden() });
  });
  it("serializes rows with the spec's key order", () => {
    const r = ok(compileGameplay(gameplay(), spec(), []));
    expect(Object.keys(r.collisions[0] ?? {})).toEqual(["a", "b", "despawnA", "despawnB", "score", "lives"]);
  });
  it("names the source object of every row and nothing finer", () => {
    const r = ok(compileGameplay(gameplay(), spec(), []));
    expect(r.collisionSourcePaths).toEqual([["collectibles", 0], ["enemies", 0]]);
  });
});

describe("reproduces the Lantern Run sample", () => {
  it("fed the sample's parameters, lives, winScore and the collision table are the sample's", () => {
    const rt = spec().game.runtime;
    const r = ok(compileGameplay(gameplay(), spec(), []));
    expect(r.lives).toBe(rt.lives);
    expect(r.winScore).toBe(rt.winScore);
    expect(r.collisions).toEqual(rt.collisions);
  });
});

describe("collision-pair conflicts with Designer-owned rows", () => {
  const row = (a: string, b: string) => ({ a, b, despawnA: false, despawnB: false, score: 0, lives: 0 });
  it("reports a collectible on the same pair", () => {
    expect(at(compileGameplay(gameplay(), spec(), [row("lantern", "keeper")]))).toEqual(["gameplay:collision-conflict@collectibles.0.kind"]);
  });
  it("reports an enemy on the same pair", () => {
    expect(at(compileGameplay(gameplay(), spec(), [row("wisp", "keeper")]))).toEqual(["gameplay:collision-conflict@enemies.0.kind"]);
  });
  it("treats the mirrored pair as the same pair", () => {
    expect(at(compileGameplay(gameplay(), spec(), [row("keeper", "lantern")]))).toEqual(["gameplay:collision-conflict@collectibles.0.kind"]);
  });
  it("names the Designer row in the message and reports every conflict", () => {
    const r = compileGameplay(gameplay(), spec(), [row("x", "y"), row("lantern", "keeper"), row("wisp", "keeper")]);
    expect(at(r)).toEqual(["gameplay:collision-conflict@collectibles.0.kind", "gameplay:collision-conflict@enemies.0.kind"]);
    expect(fail(r)[0]?.message).toContain("collisions[1]");
  });
  it("does not conflict on other pairs, including a Designer row with the same kinds in other roles", () => {
    expect(ok(compileGameplay(gameplay(), spec(), [row("lantern", "wisp")])).collisions).toHaveLength(2);
  });
  it("rejects malformed Designer rows", () => {
    expect(at(compileGameplay(gameplay(), spec(), "no"))).toEqual(["designer-rows:bad-designer-rows@"]);
    expect(at(compileGameplay(gameplay(), spec(), [{ a: 1, b: "x" }]))).toEqual(["designer-rows:bad-designer-rows@0"]);
  });
});

describe("manifest and base spec issues", () => {
  it("returns manifest validation issues with their paths", () => {
    expect(at(withGameplay((m) => { m.lives.start = 0; }))).toHaveLength(1);
  });
  it("names planned fields as unsupported on the root only", () => {
    const r = withGameplay((m) => { m.health = { start: 3 }; m.powerUps = []; m.progression = {}; });
    expect(at(r)).toEqual(["gameplay:unsupported-field@health", "gameplay:unsupported-field@powerUps", "gameplay:unsupported-field@progression"]);
    expect(fail(r)[0]?.message).toContain("planned");
    expect(at(withGameplay((m) => { m.lives.health = 1; }))).toEqual(["gameplay:additional@lives.health"]);
  });
  it("rejects a non-empty planned list", () => {
    expect(fail(withGameplay((m) => { m.planned = ["health"]; }))[0]?.source).toBe("gameplay");
  });
  it("rejects a duplicate pair inside the manifest", () => {
    const r = withGameplay((m) => { m.enemies[0].kind = "lantern"; m.enemies[0].targetKind = "keeper"; });
    expect(fail(r).map((i) => i.code)).toContain("duplicate-pair");
  });
  it("reports unknown kinds with the defined ones", () => {
    const r = withGameplay((m) => { m.collectibles[0].kind = "nope"; m.enemies[0].targetKind = "ghost"; });
    expect(at(r)).toEqual(["gameplay:unknown-kind@collectibles.0.kind", "gameplay:unknown-kind@enemies.0.targetKind"]);
    expect(fail(r)[0]?.message).toContain("keeper, lantern, wisp");
  });
  it("reports a bad base spec", () => {
    expect(at(compileGameplay(gameplay(), {}, []))).toEqual(["base-spec:bad-base-spec@game"]);
    expect(at(compileGameplay(gameplay(), { game: { runtime: { kinds: [{}] } } }, []))).toEqual(["base-spec:bad-base-spec@game.runtime.kinds.0.id"]);
  });
  it("compiles empty modules to no rows", () => {
    const r = ok(withGameplay((m) => { m.collectibles = []; m.enemies = []; m.lives.start = 99; m.score.winScore = 0; }));
    expect(r).toMatchObject({ lives: 99, winScore: 0, collisions: [] });
  });
});

describe("determinism and purity", () => {
  it("returns identical output for identical input", () => {
    const a = JSON.stringify(compileGameplay(gameplay(), spec(), []));
    expect(JSON.stringify(compileGameplay(gameplay(), spec(), []))).toBe(a);
  });
  it("does not modify frozen inputs", () => {
    const g = deepFreeze(gameplay()), s = deepFreeze(spec()), d = deepFreeze([{ a: "x", b: "y", despawnA: false, despawnB: false, score: 0, lives: 0 }]);
    expect(compileGameplay(g, s, d).ok).toBe(true);
    expect(g).toEqual(gameplay());
    expect(s).toEqual(spec());
  });
  it("result shares no object with the inputs", () => {
    const g = gameplay();
    const r = ok(compileGameplay(g, spec(), []));
    r.collisions[0]!.score = 999;
    expect(g.collectibles[0].points).toBe(10);
  });
  it("emits no negative zero (livesLost 0 gives lives 0)", () => {
    const r = ok(withGameplay((m) => { m.enemies[0].livesLost = 0; }));
    expect(Object.is(r.collisions[1]?.lives, 0)).toBe(true);
  });
});

describe("engine validation (the real Python engine)", () => {
  const dir = mkdtempSync(join(tmpdir(), "monstera-gameplay-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (candidate: string[], file: string): string =>
    execFileSync(candidate[0] as string, [...candidate.slice(1), join(repo, "tools", "monstera", "monstera.py"), "validate", file, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const engine = (file: string): { valid: boolean; issues: { path: string; code: string }[] } => {
    for (const c of [["python3"], ["python"], ["py", "-3"]]) {
      try { return JSON.parse(run(c, file)); } catch (e: any) {
        if (e?.stdout) { try { return JSON.parse(String(e.stdout)); } catch { /* try the next interpreter */ } }
      }
    }
    throw new Error("no Python 3.10+ interpreter could run tools/monstera/monstera.py");
  };
  const verdict = (s: unknown, name: string) => {
    const f = join(dir, `${name}.json`);
    writeFileSync(f, JSON.stringify(s, null, 2));
    return engine(f);
  };
  const compiledSpec = (m: unknown) => {
    const r = ok(compileGameplay(m, spec(), []));
    const s = spec();
    s.game.runtime.lives = r.lives;
    s.game.runtime.winScore = r.winScore;
    s.game.runtime.collisions = r.collisions;
    return s;
  };
  it("validates the compiled Lantern Run spec, which is the committed spec", () => {
    const s = compiledSpec(gameplay());
    expect(verdict(s, "lantern")).toMatchObject({ valid: true, issues: [] });
    expect(s).toEqual(spec());
  });
  it("validates a boundary manifest (extreme values, no rows)", () => {
    const m = gameplay();
    m.lives.start = 99;
    m.score.winScore = 1000000;
    m.collectibles[0].points = -1000000;
    m.enemies[0].livesLost = 1000;
    expect(verdict(compiledSpec(m), "boundary")).toMatchObject({ valid: true, issues: [] });
    m.collectibles = []; m.enemies = []; m.lives.start = 1; m.score.winScore = 0;
    expect(verdict(compiledSpec(m), "empty")).toMatchObject({ valid: true, issues: [] });
  });
});
