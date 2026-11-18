import { describe, expect, it } from "vitest";
import type { OracleCheck } from "../engine/protocol";
import { stableText } from "../project/record";
import { pumpkinDoc, xrefManifests } from "../project/xref.testkit";
import type { Json } from "../schema/schema";
import { ORACLE_SEED, ORACLE_TICKS, type ApplyEngine } from "./apply";
import { Engine } from "./testEngine";
import { checkAllVariants, checkVariant, compileVariant } from "./variants";

const deepFreeze = <T,>(v: T): T => {
  if (v !== null && typeof v === "object") { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
  return v;
};
const levels = () => xrefManifests().levels;
const without = (doc: Json): string => {
  const d = JSON.parse(JSON.stringify(doc));
  d.game.runtime.initialEntities = null;
  d.game.runtime.spawners = null;
  return stableText(d);
};
/** Counts concurrent engine calls and can make the oracle disagree between runs. */
class Spy extends Engine {
  inflight = 0; maxInflight = 0; oracleRuns = 0; flip = false; seeds: number[] = []; tickCounts: number[] = [];
  override async validateDraft(text: string) {
    this.inflight++; this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try { await new Promise((r) => setImmediate(r)); return await super.validateDraft(text); } finally { this.inflight--; }
  }
  override async oracleCheck(text: string, seed: number, ticks: number): Promise<OracleCheck> {
    this.inflight++; this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      await new Promise((r) => setImmediate(r));
      this.seeds.push(seed); this.tickCounts.push(ticks);
      const r = await super.oracleCheck(text, seed, ticks);
      this.oracleRuns++;
      return this.flip && r.ok && this.oracleRuns % 2 === 0 ? { ...r, hash: "f".repeat(16) } : r;
    } finally { this.inflight--; }
  }
}

describe("compileVariant", () => {
  it("replaces exactly initialEntities and spawners; the input is not modified", () => {
    const doc = deepFreeze(pumpkinDoc());
    const m = deepFreeze(levels());
    for (const level of m.levels) {
      const v = compileVariant(doc, m, level.id);
      if (!v.ok) throw new Error(JSON.stringify(v.issues));
      expect(without(v.spec)).toBe(without(doc));
      const rt = (v.spec as { game: { runtime: { spawners: unknown[]; initialEntities: unknown[] } } }).game.runtime;
      expect(rt.spawners).toHaveLength(level.waves.length + level.difficulty.length);
      expect(rt.initialEntities).toHaveLength(level.placements.length);
    }
  });
  it("compiling twice gives identical text; an unknown level is a compile issue", () => {
    const doc = pumpkinDoc();
    const a = compileVariant(doc, levels(), "level-2"), b = compileVariant(doc, levels(), "level-2");
    expect(a.ok && b.ok && stableText(a.spec) === stableText(b.spec)).toBe(true);
    expect(compileVariant(doc, levels(), "ghost")).toMatchObject({ ok: false, issues: [{ code: "unknown-level" }] });
  });
});
describe("checkVariant", () => {
  it("a valid level is validated by the engine, oracle-checked twice with the bounded seed, and deterministic", async () => {
    const e = new Spy();
    const r = await checkVariant(pumpkinDoc(), levels(), "level-1", e);
    expect(r).toMatchObject({ levelId: "level-1", status: "valid", stage: null, deterministic: true, oracle: { ticks: ORACLE_TICKS } });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(r.canonicalText as string).game.runtime.spawners.length).toBeGreaterThan(0);
    expect(e.seeds).toEqual([ORACLE_SEED, ORACLE_SEED]);
    expect(e.tickCounts).toEqual([ORACLE_TICKS, ORACLE_TICKS]);
  });
  it("two runs of the same level have the same canonical text", async () => {
    const a = await checkVariant(pumpkinDoc(), levels(), "level-2", new Engine());
    const b = await checkVariant(pumpkinDoc(), levels(), "level-2", new Engine());
    expect(a.canonicalText).toBe(b.canonicalText);
    expect(a.sha256).toBe(b.sha256);
  });
  it("an engine-rejected level is refused with the level field path", async () => {
    const e = new Engine();
    e.forceIssues = [{ path: "$.game.runtime.spawners[0].xMin", code: "semantic.spawn-range", message: "m" }];
    const r = await checkVariant(pumpkinDoc(), levels(), "level-1", e);
    expect(r).toMatchObject({ status: "refused", stage: "engine", canonicalText: null, deterministic: false });
    expect(r.issues[0]).toMatchObject({ source: "levels", path: ["levels", 0, "waves", 0, "xMin"] });
  });
  it("an oracle failure refuses the level", async () => {
    const e = new Engine();
    e.failOracle = "boom";
    expect(await checkVariant(pumpkinDoc(), levels(), "level-1", e)).toMatchObject({ status: "refused", stage: "oracle" });
  });
  it("a result that differs between two identical runs is nondeterministic and has no exportable text", async () => {
    const e = new Spy();
    e.flip = true;
    const r = await checkVariant(pumpkinDoc(), levels(), "level-1", e);
    expect(r).toMatchObject({ status: "refused", stage: "nondeterministic", canonicalText: null, deterministic: false });
  });
  it("a compile issue is reported before the engine is asked", async () => {
    const e = new Spy();
    const m = levels();
    const bad = { ...m, levels: m.levels.map((l, i) => (i === 0 ? { ...l, waves: l.waves.map((w) => ({ ...w, kind: "no-such-kind" })) } : l)) };
    const r = await checkVariant(pumpkinDoc(), bad, "level-1", e);
    expect(r).toMatchObject({ status: "refused", stage: "compile" });
    expect(e.oracleRuns).toBe(0);
  });
});
describe("checkAllVariants", () => {
  it("checks levels one after the other, never concurrently, in manifest order", async () => {
    const e = new Spy();
    const progress: number[] = [];
    const all = await checkAllVariants(pumpkinDoc(), levels(), e, { onProgress: (d) => progress.push(d) });
    expect(all.map((r) => r.levelId)).toEqual(["level-1", "level-2"]);
    expect(all.every((r) => r.status === "valid")).toBe(true);
    expect(e.maxInflight).toBe(1);
    expect(progress).toEqual([1, 2]);
  });
  it("an abort stops before the next level", async () => {
    const c = new AbortController();
    const all = await checkAllVariants(pumpkinDoc(), levels(), new Engine() as ApplyEngine, { signal: c.signal, onProgress: () => c.abort() });
    expect(all).toHaveLength(1);
  });
  it("never calls anything that could commit: the document is not modified", async () => {
    const doc = deepFreeze(pumpkinDoc());
    const before = stableText(doc);
    await checkAllVariants(doc, deepFreeze(levels()), new Engine());
    expect(stableText(doc)).toBe(before);
  });
});
