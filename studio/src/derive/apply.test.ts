import { describe, expect, it } from "vitest";
import { drain, harness, type Harness } from "../app/session.testkit";
import { getAt } from "../draft/path";
import { sameValue, sha256Hex, stableText } from "../project/record";
import { memoryMarker } from "../project/testkit";
import { pumpkinDoc, xrefManifests } from "../project/xref.testkit";
import type { Json } from "../schema/schema";
import { applyActiveLevel, derivationState, inputsSha256, planLevelApply, ORACLE_TICKS } from "./apply";
import { Engine } from "./testEngine";
import { lockedBy, POINTER_OWNERS } from "./ownership";
const withDerivation = (activeLevel = "level-1") => {
  const m = xrefManifests();
  m.project = { ...m.project, derivation: { levels: true, gameplay: false, activeLevel } };
  return m;
};
const doc = (): Json => pumpkinDoc();
describe("planLevelApply", () => {
  it("a valid level compiles, validates, runs the oracle and returns the next document", async () => {
    const e = new Engine();
    const r = await planLevelApply(doc(), withDerivation(), e);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(getAt(r.doc, ["game", "runtime", "spawners"])).toHaveLength(r.diff.spawners.after === null ? 0 : (r.diff.spawners.after as unknown[]).length);
    expect(e.calls).toBe(1);
    expect(r.oracle.ticks).toBe(ORACLE_TICKS);
    expect(r.manifests.project.derived.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.manifests.project.spec.currentSha256).toBe(r.sha256);
  });
  it("is refused with a precondition issue while derivation is off", async () => {
    const m = xrefManifests();
    const r = await planLevelApply(doc(), m, new Engine());
    expect(r).toMatchObject({ ok: false, stage: "precondition", issues: [{ code: "derivation-off" }] });
  });
  it("engine issues are mapped to the level field that produced them, and the input is not modified", async () => {
    const m = withDerivation();
    const d = doc();
    const before = stableText(d);
    const e = new Engine();
    const n = m.levels.levels[0]!.placements.length;
    e.forceIssues = [
      { path: "$.game.runtime.spawners[0].xMin", code: "semantic.spawn-range", message: "m" },
      { path: "$.game.runtime.spawners[0].startTick", code: "x", message: "m" },
      { path: `$.game.runtime.initialEntities[${n - 1}].x`, code: "x", message: "m" },
      { path: "$.game.runtime.maxEntities", code: "x", message: "m" },
    ];
    const r = await planLevelApply(d, m, e);
    expect(r).toMatchObject({ ok: false, stage: "engine" });
    if (r.ok) return;
    expect(r.issues.map((i) => `${i.source}@${i.path.join(".")}`)).toEqual([
      "levels@levels.0.waves.0.xMin", "levels@levels.0.waves.0.startTick", `levels@levels.0.placements.${n - 1}.x`, "base-spec@game.runtime.maxEntities",
    ]);
    expect(stableText(d)).toBe(before);
  });
  it("an oracle failure refuses the plan", async () => {
    const e = new Engine();
    e.failOracle = "boom";
    expect(await planLevelApply(doc(), withDerivation(), e)).toMatchObject({ ok: false, stage: "oracle", issues: [{ code: "oracle-failed", message: "run: boom" }] });
  });
});
describe("inputsSha256 and staleness", () => {
  it("ignores the owned pointers, follows the levels manifest, and reports none/fresh/stale", async () => {
    const m = withDerivation();
    const d = doc();
    expect(await derivationState(d, m)).toBe("none");
    const r = await planLevelApply(d, m, new Engine());
    if (!r.ok) throw new Error("plan failed");
    expect(await derivationState(r.doc, r.manifests)).toBe("fresh");
    expect(await inputsSha256(d, m)).toBe(await inputsSha256(r.doc, m));
    const changed = JSON.parse(JSON.stringify(r.manifests)) as typeof r.manifests;
    changed.levels.levels[0]!.name = "Renamed";
    expect(await derivationState(r.doc, changed)).toBe("stale");
    const other = JSON.parse(JSON.stringify(r.doc)) as Json;
    (other as any).game.runtime.maxEntities = 100;
    expect(await derivationState(other, r.manifests)).toBe("stale");
    expect(await sha256Hex("x")).toHaveLength(64);
  });
});
describe("pointer ownership", () => {
  it("levels and gameplay own disjoint pointers", () => {
    const all = [...POINTER_OWNERS.levels, ...POINTER_OWNERS.gameplay].map((p) => p.join("."));
    expect(new Set(all).size).toBe(all.length);
    for (const l of POINTER_OWNERS.levels) for (const g of POINTER_OWNERS.gameplay) expect(l.join(".").startsWith(g.join("."))).toBe(false);
  });
  it("Designer fields are locked only while the owning derivation is on", () => {
    const off = { levels: false, gameplay: false, activeLevel: "" };
    const path = ["game", "runtime", "spawners", 0, "xMin"];
    expect(lockedBy(path, off)).toBeNull();
    expect(lockedBy(path, { ...off, levels: true, activeLevel: "level-1" })).toBe("levels");
    expect(lockedBy(path, { ...off, gameplay: true })).toBeNull();
    expect(lockedBy(["game", "runtime", "lives"], { ...off, gameplay: true })).toBe("gameplay");
    expect(lockedBy(["game", "runtime", "kinds", 0, "id"], { levels: true, gameplay: true, activeLevel: "x" })).toBeNull();
    expect(lockedBy(path, null)).toBeNull();
  });
});
describe("applyActiveLevel through the controller", () => {
  async function boot(): Promise<Harness> {
    const h = harness({ marker: memoryMarker() });
    await h.session.start();
    await drain(h);
    const c = h.session.project.actions;
    const fx = withDerivation();
    for (const n of ["assets", "animations", "levels", "gameplay", "project"] as const) expect(c.commitManifest(n, fx[n] as never)).toMatchObject({ ok: true });
    await drain(h);
    return h;
  }
  const snap = (h: Harness) => ({ doc: h.session.store.getState().doc, manifests: h.session.project.getState().manifests });
  it("a valid level commits as one undo step; an invalid one leaves spec and manifests byte-identical", async () => {
    const h = await boot();
    const c = h.session.project;
    const before = snap(h);
    const r = await applyActiveLevel(c, new Engine());
    expect(r.ok).toBe(true);
    const after = snap(h);
    expect(sameValue(after.doc, before.doc)).toBe(false);
    expect(after.manifests?.project.derived.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.actions.undo()).toBe(true);
    expect(sameValue(snap(h), before)).toBe(true);
    const mid = snap(h);
    const rejecting = new Engine();
    rejecting.forceIssues = [{ path: "$.game.runtime.spawners[0].xMin", code: "semantic.spawn-range", message: "m" }];
    const bad = await applyActiveLevel(c, rejecting);
    expect(bad).toMatchObject({ ok: false, stage: "engine" });
    expect(stableText(snap(h).doc)).toBe(stableText(mid.doc));
    expect(sameValue(snap(h).manifests, mid.manifests)).toBe(true);
  });
  it("refuses to commit when the spec changed while the plan was being checked", async () => {
    const h = await boot();
    const c = h.session.project;
    const slow = new Engine();
    slow.during = () => { h.session.store.set(["game", "runtime", "maxEntities"], 127); };
    const r = await applyActiveLevel(c, slow);
    expect(r).toMatchObject({ ok: false, issues: [{ code: "changed-meanwhile" }] });
    expect(getAt(h.session.store.getState().doc ?? undefined, ["game", "runtime", "maxEntities"])).toBe(127);
  });
  it("refuses to commit when only the levels manifest changed during the oracle, and keeps the newer manifest", async () => {
    const h = await boot();
    const c = h.session.project;
    const before = snap(h);
    const newer = JSON.parse(JSON.stringify(before.manifests?.levels));
    newer.levels[0].name = "Edited meanwhile";
    const slow = new Engine();
    slow.during = () => { expect(c.actions.commitManifest("levels", newer)).toMatchObject({ ok: true }); };
    const r = await applyActiveLevel(c, slow);
    expect(r).toMatchObject({ ok: false, issues: [{ code: "changed-meanwhile" }] });
    const after = snap(h);
    expect(after.manifests?.levels.levels[0]?.name).toBe("Edited meanwhile");
    expect(after.doc).toBe(before.doc);
    expect(after.manifests?.project.derived.inputsSha256).toBe(before.manifests?.project.derived.inputsSha256);
  });
});
