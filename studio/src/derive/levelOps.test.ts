import { describe, expect, it } from "vitest";
import { pumpkinDoc, xrefManifests } from "../project/xref.testkit";
import type { LevelsManifest } from "../project/manifests";
import { addLevel, addPlacement, addStep, addWave, duplicateLevel, freeId, moveLevel, removeLevel, removePlacement, removeStep, removeWave, renameLevel, setPlacement, setStep, setWave, slug, type LevelOpResult } from "./levelOps";

const deepFreeze = <T,>(v: T): T => {
  if (v !== null && typeof v === "object") { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
  return v;
};
const fresh = () => deepFreeze(xrefManifests());
const ok = (r: LevelOpResult): LevelsManifest => { if (!r.ok) throw new Error(r.reason); return r.levels; };
const ids = (m: LevelsManifest) => m.levels.map((l) => l.id);
const orders = (m: LevelsManifest) => m.levels.map((l) => l.order);

describe("ids", () => {
  it("slug and freeId follow the manifest id pattern", () => {
    expect(slug("Dusk Run!", "level")).toBe("dusk-run");
    expect(slug("9 lives", "level")).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
    expect(slug("", "level")).toBe("level");
    expect(freeId("a".repeat(40), new Set(["a".repeat(32)]))).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
    expect(freeId("x-y", new Set(["x-y", "x-y-2"]))).toBe("x-y-3");
  });
});
describe("add, duplicate, move", () => {
  it("adds levels with unique ids and increasing order until the 32-level cap", () => {
    let m = fresh().levels;
    for (let i = 0; i < 40; i++) {
      const r = addLevel(m, "Same name");
      if (m.levels.length >= 32) { expect(r.ok).toBe(false); continue; }
      m = ok(r);
    }
    expect(m.levels).toHaveLength(32);
    expect(new Set(ids(m)).size).toBe(32);
    expect(orders(m)).toEqual([...orders(m)].sort((a, b) => a - b));
  });
  it("refuses an empty name and does not touch the input", () => {
    const m = fresh().levels;
    expect(addLevel(m, "  ")).toMatchObject({ ok: false });
  });
  it("duplicate copies deeply, lands after its source and keeps order unique and sorted", () => {
    const m = fresh().levels;
    const n = ok(duplicateLevel(m, "level-1"));
    expect(ids(n)).toEqual(["level-1", "level-1-copy", "level-2"]);
    expect(new Set(orders(n)).size).toBe(3);
    expect(n.levels[1]?.placements).toEqual(m.levels[0]?.placements);
    expect(n.levels[1]?.placements).not.toBe(m.levels[0]?.placements);
    expect(ids(ok(duplicateLevel(n, "level-1")))).toContain("level-1-copy-2");
    expect(duplicateLevel(m, "nope")).toMatchObject({ ok: false });
  });
  it("move swaps neighbours, keeps the array sorted, and refuses at the ends", () => {
    const m = fresh().levels;
    const n = ok(moveLevel(m, "level-2", -1));
    expect(ids(n)).toEqual(["level-2", "level-1"]);
    expect(orders(n)).toEqual(orders(m));
    expect(moveLevel(m, "level-1", -1)).toMatchObject({ ok: false });
    expect(moveLevel(m, "level-2", 1)).toMatchObject({ ok: false });
  });
});
describe("removeLevel", () => {
  it("is blocked for the active level and names the reference", () => {
    const m = xrefManifests();
    m.project = { ...m.project, derivation: { levels: true, gameplay: false, activeLevel: "level-1" } };
    const r = removeLevel(pumpkinDoc(), m, "level-1");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toContain("project: active level"); expect(r.references).toHaveLength(1); }
  });
  it("removes another level, leaving a gap in order that stays valid", () => {
    const m = fresh();
    const n = ok(removeLevel(pumpkinDoc(), m, "level-1"));
    expect(ids(n)).toEqual(["level-2"]);
    expect(removeLevel(pumpkinDoc(), m, "ghost")).toMatchObject({ ok: false });
  });
  it("an id is free again after deletion (the manifest keeps no id counter)", () => {
    const m = fresh();
    const n = ok(removeLevel(pumpkinDoc(), m, "level-2"));
    expect(ids(ok(addLevel(n, "Level 2")))).toContain("level-2");
  });
});
describe("editing one level", () => {
  it("placements: add, set, remove", () => {
    let m = fresh().levels;
    m = ok(addPlacement(m, "level-1", "star"));
    const added = m.levels[0]?.placements.at(-1);
    expect(added).toMatchObject({ kind: "star", x: 0, y: 0, controlled: false });
    m = ok(setPlacement(m, "level-1", added!.id, { x: 65536, y: 131072 }));
    expect(m.levels[0]?.placements.at(-1)).toMatchObject({ x: 65536, y: 131072 });
    m = ok(removePlacement(m, "level-1", added!.id));
    expect(m.levels[0]?.placements.some((p) => p.id === added!.id)).toBe(false);
    expect(setPlacement(m, "level-1", "ghost", { x: 1 })).toMatchObject({ ok: false });
  });
  it("waves: ids and streams stay unique, ranges are checked by the manifest rules", () => {
    let m = fresh().levels;
    m = ok(addWave(m, "level-2", "star"));
    m = ok(addWave(m, "level-2", "star"));
    const w = m.levels[1]!.waves;
    expect(new Set(w.map((x) => x.id)).size).toBe(w.length);
    expect(new Set(w.map((x) => x.stream)).size).toBe(w.length);
    const r = setWave(m, "level-2", w.at(-1)!.id, { xMin: 10, xMax: 5 });
    expect(r).toMatchObject({ ok: false });
    expect(setWave(m, "level-2", w.at(-1)!.id, { intervalTicks: 0 })).toMatchObject({ ok: false });
  });
  it("a wave used by a difficulty step cannot be removed; removing the step frees it", () => {
    let m = fresh().levels;
    const wave = m.levels[0]!.waves[0]!;
    m = ok(addStep(m, "level-1", wave.id));
    const step = m.levels[0]!.difficulty.at(-1)!;
    expect(step.atTick).toBeGreaterThan(wave.startTick);
    const blocked = removeWave(m, "level-1", wave.id);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain(step.id);
    m = ok(setStep(m, "level-1", step.id, { intervalTicks: 7 }));
    m = ok(removeStep(m, "level-1", step.id));
    expect(m.levels[0]!.difficulty.some((d) => d.id === step.id)).toBe(false);
    if (!m.levels[0]!.difficulty.some((d) => d.waveId === wave.id)) {
      m = ok(removeWave(m, "level-1", wave.id));
      expect(m.levels[0]!.waves.some((w) => w.id === wave.id)).toBe(false);
    }
  });
  it("a step may not start before its wave", () => {
    const m = fresh().levels;
    const wave = m.levels[0]!.waves[0]!;
    const withStep = ok(addStep(m, "level-1", wave.id));
    const step = withStep.levels[0]!.difficulty.at(-1)!;
    expect(setStep(withStep, "level-1", step.id, { atTick: wave.startTick })).toMatchObject({ ok: false });
  });
  it("rename trims and refuses empty names", () => {
    const m = fresh().levels;
    expect(ok(renameLevel(m, "level-1", "  Dawn "))?.levels[0]?.name).toBe("Dawn");
    expect(renameLevel(m, "level-1", "")).toMatchObject({ ok: false });
  });
  it("an unsupported extra field makes the manifest refuse the edit", () => {
    const m = fresh().levels;
    const r = setPlacement(m, "level-1", m.levels[0]!.placements[0]!.id, { winScore: 5 } as never);
    expect(r).toMatchObject({ ok: false });
  });
});
