import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DraftStore, type Baseline } from "../draft/store";
import type { BadgeCheck, BadgeScenario, DraftValidation } from "../engine/protocol";
import type { Json } from "../schema/schema";
import { BadgeRunner, verdict, type BadgeEngine, type BadgeRun, type DraftView } from "./badge";
import { changedPaths, classifyPath, DISPLAY_ONLY_PATTERNS, summarizeChanges } from "./classify";
import { nativeEvidence, type ConformanceReport } from "./native";
import { setAt, toPattern } from "../draft/path";

const repo = join(__dirname, "..", "..", "..");
const SHA = "a".repeat(64);
const OTHER = "b".repeat(64);
const scenarios = (n: number): BadgeScenario[] => Array.from({ length: n }, (_, i) => ({
  file: `spec/scenarios/p/s${i}.scenario.json`, name: `s${i}`, ticks: 10, frameDriven: i === 0, checkpoints: 11,
  recordedSpecPath: "apps/p/monstera.spec.json", recordedSpecSha256: SHA,
}));
const match = (s: BadgeScenario, sha = SHA): BadgeCheck => ({ status: "match", file: s.file, draftSha256: sha, checkpoints: 11, divergentCheckpoints: 0, ms: 1 });
const diverge = (s: BadgeScenario, tick: number): BadgeCheck => ({
  status: "diverged", file: s.file, draftSha256: SHA, checkpoints: 11, divergentCheckpoints: 3, ms: 1, firstDivergentIndex: tick, firstDivergentTick: tick,
  expected: { tick, hash: "1", observe: { score: 0 } }, actual: { tick, hash: "2", observe: { score: 10 } },
});
const run = (sc: BadgeScenario[], results: BadgeCheck[], phase: BadgeRun["phase"] = "done"): BadgeRun =>
  ({ sha256: SHA, revision: 1, origin: { templateId: "p", path: "apps/p/monstera.spec.json", basis: "template" }, scenarios: sc, results, phase, startedAt: 0, ms: 5 });
const fresh: DraftView = { revision: 1, validatedRevision: 1, ok: true, sha256: SHA };

describe("verdict: only a complete, all-matching run for this exact SHA-256 is MATCH", () => {
  const sc = scenarios(4);
  it("all applicable goldens match", () => expect(verdict(run(sc, sc.map((s) => match(s))), fresh).kind).toBe("match"));
  it("one matching scenario out of four is not MATCH", () => expect(verdict(run(sc, [match(sc[0]!)]), fresh).kind).toBe("error"));
  it("a running run reports progress, never MATCH", () => {
    expect(verdict(run(sc, [match(sc[0]!)], "running"), fresh)).toEqual({ kind: "running", done: 1, total: 4 });
  });
  it("first divergent scenario and tick are reported, in scenario order", () => {
    const v = verdict(run(sc, [match(sc[0]!), diverge(sc[1]!, 72), diverge(sc[2]!, 5), match(sc[3]!)]), fresh);
    expect(v.kind).toBe("diverged");
    if (v.kind !== "diverged") return;
    expect(v.scenario.name).toBe("s1");
    expect(v.first.firstDivergentTick).toBe(72);
    expect(v.divergedScenarios).toBe(2);
  });
  it("stale as soon as the draft changes, before validation finishes", () => {
    const r = run(sc, sc.map((s) => match(s)));
    expect(verdict(r, { ...fresh, revision: 2 }).kind).toBe("stale");
    expect(verdict(r, { revision: 2, validatedRevision: 2, ok: true, sha256: OTHER }).kind).toBe("stale");
  });
  it("an edit that returns to the same SHA-256 shows the bound result again", () => {
    expect(verdict(run(sc, sc.map((s) => match(s))), { revision: 3, validatedRevision: 3, ok: true, sha256: SHA }).kind).toBe("match");
  });
  it("an invalid current draft is never MATCH", () => {
    expect(verdict(run(sc, sc.map((s) => match(s))), { ...fresh, ok: false }).kind).toBe("stale");
  });
  it("an invalid or failing scenario result is never MATCH, even with other matches", () => {
    const invalid: BadgeCheck = { status: "invalid", file: sc[0]!.file, draftSha256: null, message: "2 validation issue(s)" };
    expect(verdict(run(sc, [invalid]), fresh).kind).toBe("invalid");
    const error: BadgeCheck = { status: "error", file: sc[3]!.file, draftSha256: null, message: "KeyError" };
    expect(verdict(run(sc, [match(sc[0]!), match(sc[1]!), diverge(sc[2]!, 1), error]), fresh).kind).toBe("error");
  });
  it("a result bound to another SHA-256 is an error, not a match", () => {
    expect(verdict(run(sc, [...sc.slice(0, 3).map((s) => match(s)), match(sc[3]!, OTHER)]), fresh).kind).toBe("error");
  });
  it("results out of scenario order are an error", () => {
    expect(verdict(run(sc, [...sc].reverse().map((s) => match(s))), fresh).kind).toBe("error");
  });
  it("a cancelled run is stale", () => expect(verdict(run(sc, [match(sc[0]!)], "cancelled"), fresh).kind).toBe("stale"));
  it("no goldens is its own state", () => expect(verdict(run([], []), fresh).kind).toBe("no-goldens"));
  it("no run", () => expect(verdict(null, fresh).kind).toBe("not-run"));
});

const valid = (sha: string): DraftValidation => ({ ok: true, parsed: true, issues: [], sha256: sha, canonicalText: `{"sha":"${sha}"}` });
const baseline: Baseline = { label: "p", templateId: "p", group: "official", canonicalText: '{"project":{"id":"p"}}', sha256: SHA,
  origin: { templateId: "p", path: "apps/p/monstera.spec.json", basis: "template", canonicalText: '{"project":{"id":"p"}}' } };

class FakeEngine implements BadgeEngine {
  calls: string[] = [];
  onCheck: (file: string) => void = () => {};
  constructor(private readonly list: BadgeScenario[], private readonly fail: string | null = null) {}
  async badgeScenarios(path: string) { this.calls.push(`list ${path}`); return this.list; }
  async badgeCheck(text: string, file: string): Promise<BadgeCheck> {
    this.calls.push(`check ${file}`);
    this.onCheck(file);
    if (file === this.fail) throw new Error("worker crashed");
    return match(this.list.find((s) => s.file === file)!, (JSON.parse(text) as { sha: string }).sha);
  }
}

describe("BadgeRunner", () => {
  const ready = () => { const st = new DraftStore(undefined); st.load({ a: 1 }, baseline, valid(SHA)); return st; };

  it("runs every applicable golden of the baseline project, one call each, and binds the SHA-256", async () => {
    const st = ready();
    const eng = new FakeEngine(scenarios(3));
    const r = new BadgeRunner(eng, st);
    await r.start();
    expect(eng.calls).toEqual(["list apps/p/monstera.spec.json", ...scenarios(3).map((s) => `check ${s.file}`)]);
    const s = st.getState();
    expect(verdict(r.getState(), { revision: s.revision, validatedRevision: s.validatedRevision, ok: true, sha256: SHA }).kind).toBe("match");
  });

  it("refuses to start for an invalid or not yet validated draft", async () => {
    const st = new DraftStore(undefined);
    st.load({ a: 1 }, baseline, { ...valid(SHA), ok: false });
    const eng = new FakeEngine(scenarios(2));
    await new BadgeRunner(eng, st).start();
    st.load({ a: 1 }, baseline, null);
    await new BadgeRunner(eng, st).start();
    expect(eng.calls).toEqual([]);
  });

  it("an edit during the run stops it between scenarios and the result is stale", async () => {
    const st = ready();
    const eng = new FakeEngine(scenarios(4));
    eng.onCheck = (f) => { if (f.endsWith("s1.scenario.json")) st.set(["a"], 2); };
    const r = new BadgeRunner(eng, st);
    await r.start();
    expect(r.getState()?.phase).toBe("cancelled");
    expect(r.getState()?.results.length).toBe(2);
    const s = st.getState();
    expect(verdict(r.getState(), { revision: s.revision, validatedRevision: s.validatedRevision, ok: true, sha256: SHA }).kind).toBe("stale");
  });

  it("an engine exception becomes an error result, never a match", async () => {
    const st = ready();
    const sc = scenarios(3);
    const r = new BadgeRunner(new FakeEngine(sc, sc[1]!.file), st);
    await r.start();
    expect(verdict(r.getState(), { revision: 1, validatedRevision: 1, ok: true, sha256: SHA }).kind).toBe("error");
  });

  it("an import with no known origin runs no goldens and reports NO GOLDENS, whatever its project.id says", async () => {
    const st = new DraftStore(undefined);
    st.load({ project: { id: "pumpkin-blaster" } }, { ...baseline, templateId: null, group: "import", origin: null }, valid(SHA));
    const eng = new FakeEngine(scenarios(3));
    const r = new BadgeRunner(eng, st);
    await r.start();
    expect(eng.calls).toEqual([]);
    expect(verdict(r.getState(), { ...fresh, originPath: null }).kind).toBe("no-goldens");
  });
  it("changing the origin after a run makes the result stale", async () => {
    const st = ready();
    const r = new BadgeRunner(new FakeEngine(scenarios(2)), st);
    await r.start();
    expect(verdict(r.getState(), { ...fresh, originPath: "apps/p/monstera.spec.json" }).kind).toBe("match");
    expect(verdict(r.getState(), { ...fresh, originPath: "spec/samples/q/monstera.spec.json" }).kind).toBe("stale");
    expect(verdict(r.getState(), { ...fresh, originPath: null }).kind).toBe("stale");
  });
});

describe("classification (explains, never decides)", () => {
  const pumpkin = JSON.parse(readFileSync(join(repo, "apps/pumpkin-blaster/monstera.spec.json"), "utf8")) as Json;

  it("frozen spec v4 display-only fields are display", () => {
    for (const p of [["project", "displayName"], ["game", "palette", "accent"], ["game", "hud", "lifeGlyph"], ["game", "screens", "winTitle"],
      ["game", "runtime", "kinds", 3, "glyph"], ["game", "runtime", "kinds", 0, "effect"], ["game", "runtime", "kinds", 1, "color"]]) {
      expect(classifyPath(p)).toBe("display");
    }
  });
  it("R5.2 simulation fields are behaviour", () => {
    for (const p of [["game", "runtime", "spawners", 0, "intervalTicks"], ["game", "runtime", "kinds", 0, "width"], ["game", "runtime", "kinds"],
      ["game", "runtime", "collisions", 1, "score"], ["game", "input", "dragGain"], ["game", "input", "tapKind"], ["game", "runtime", "lives"],
      ["game", "runtime", "winScore"], ["game", "world", "width"], ["game", "simulation", "tickRate"], ["game", "runtime", "initialEntities", 0, "x"]]) {
      expect(classifyPath(p)).toBe("behaviour");
    }
  });
  it("fields the oracle does not read are other (the same set tests/test_presentation.py deletes)", () => {
    for (const p of [["game", "genre"], ["game", "orientation"], ["game", "targetFps"], ["game", "input", "scheme"], ["project", "id"],
      ["project", "platforms", "android", "minSdk"], ["specVersion"]]) {
      expect(classifyPath(p)).toBe("other");
    }
  });
  it("every display-only pattern exists in a real template", () => {
    const leaves = new Set<string>();
    const walk = (v: Json, at: (string | number)[]) => {
      if (v !== null && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x as Json, [...at, Array.isArray(v) ? Number(k) : k]));
      else leaves.add(toPattern(at));
    };
    walk(pumpkin, []);
    for (const p of DISPLAY_ONLY_PATTERNS) expect(leaves.has(p)).toBe(true);
  });
  it("changed paths and their classes", () => {
    let d = setAt(pumpkin, ["game", "palette", "accent"], "#000000");
    d = setAt(d, ["game", "runtime", "lives"], 9);
    const s = summarizeChanges(pumpkin, d);
    expect(s.display).toEqual([["game", "palette", "accent"]]);
    expect(s.behaviour).toEqual([["game", "runtime", "lives"]]);
    expect(changedPaths(pumpkin, pumpkin)).toEqual([]);
  });
});

describe("native conformance evidence is matched by exact SHA-256 only", () => {
  const reports: ConformanceReport[] = [
    { file: "docs/evidence/g3-conformance/pumpkin-blaster.report.json", specSha256: SHA, verdict: "pass", platforms: [], scenarios: [] },
    { file: "docs/evidence/g2-conformance/monstera-sample.report.json", specSha256: OTHER, verdict: "pass", platforms: [], scenarios: [] },
  ];
  it("shown for the exact SHA-256", () => expect(nativeEvidence(reports, SHA, "pumpkin-blaster").exact.map((r) => r.file)).toEqual([reports[0]!.file]));
  it("not shown for any other SHA-256 of the same game, which is listed as a different specification", () => {
    const e = nativeEvidence(reports, "c".repeat(64), "pumpkin-blaster");
    expect(e.exact).toEqual([]);
    expect(e.otherSpecsOfProject.map((r) => r.file)).toEqual([reports[0]!.file]);
  });
  it("nothing for an invalid draft (no SHA) or a game without reports (Lantern Run)", () => {
    expect(nativeEvidence(reports, null, "pumpkin-blaster").exact).toEqual([]);
    expect(nativeEvidence(reports, "c".repeat(64), "lantern-run")).toEqual({ exact: [], otherSpecsOfProject: [] });
  });
});
