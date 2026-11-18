import { describe, expect, it } from "vitest";
import { drain, harness, type Harness } from "../app/session.testkit";
import { getAt } from "../draft/path";
import { sameValue, stableText } from "../project/record";
import { memoryMarker } from "../project/testkit";
import { pumpkinDoc, xrefManifests } from "../project/xref.testkit";
import type { Json } from "../schema/schema";
import { applyReviewedGameplay, gameplayInSync, mapGameplayEngineIssue, planGameplayApply, reviewGameplay, ORACLE_TICKS } from "./apply";
import { compileGameplay } from "./gameplay";
import {
  addCollectible, addEnemy, freePair, gameplayIssues, removeCollectible, setCollectible, setEnemy, setLives, setWinScore, specCollisionRows,
} from "./gameplayOps";
import { lockedBy, POINTER_OWNERS } from "./ownership";
import { Engine } from "./testEngine";

const doc = (): Json => pumpkinDoc();
const withGameplay = () => {
  const m = xrefManifests();
  m.project = { ...m.project, derivation: { levels: false, gameplay: true, activeLevel: "" } };
  return m;
};
const RT = ["game", "runtime"];

describe("planGameplayApply", () => {
  it("compiles, validates with the engine, runs the oracle and returns the next document with a diff", async () => {
    const e = new Engine();
    const m = withGameplay();
    const r = await planGameplayApply(doc(), m, e);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(e.calls).toBe(1);
    expect(r.oracle.ticks).toBe(ORACLE_TICKS);
    expect(getAt(r.doc, [...RT, "lives"])).toBe(m.gameplay.lives.start);
    expect(getAt(r.doc, [...RT, "winScore"])).toBe(m.gameplay.score.winScore);
    expect(getAt(r.doc, [...RT, "collisions"])).toEqual(r.diff.collisions.after);
    expect(r.manifests.project.spec.currentSha256).toBe(r.sha256);
    expect(r.manifests.project.derived.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(gameplayInSync(r.doc, r.manifests)).toBe(true);
    expect(gameplayInSync(doc(), m)).toBe(false);
  });
  it("lists the existing spec rows that the module table does not reproduce", async () => {
    const r = await planGameplayApply(doc(), withGameplay(), new Engine());
    if (!r.ok) throw new Error("plan failed");
    const before = specCollisionRows(doc());
    expect(before.length).toBeGreaterThan(0);
    expect(r.removedRows.length).toBeGreaterThan(0);
    expect(r.removedRows.length).toBeLessThanOrEqual(before.length);
  });
  it("is refused with a precondition issue while derivation is off", async () => {
    const e = new Engine();
    const r = await planGameplayApply(doc(), xrefManifests(), e);
    expect(r).toMatchObject({ ok: false, stage: "precondition", issues: [{ code: "derivation-off" }] });
    expect(e.calls).toBe(0);
  });
  it("an unknown kind is refused at the compile stage with the field path, and the input is not modified", async () => {
    const m = withGameplay();
    m.gameplay = { ...m.gameplay, collectibles: [{ ...m.gameplay.collectibles[0]!, kind: "nope" }] };
    const d = doc();
    const before = stableText(d);
    const r = await planGameplayApply(d, m, new Engine());
    expect(r).toMatchObject({ ok: false, stage: "compile", issues: [{ source: "gameplay", code: "unknown-kind", path: ["collectibles", 0, "kind"] }] });
    expect(stableText(d)).toBe(before);
  });
  it("maps engine issues to the gameplay field that produced them; others stay on the spec", async () => {
    const e = new Engine();
    e.forceIssues = [
      { path: "$.game.runtime.lives", code: "x", message: "m" },
      { path: "$.game.runtime.winScore", code: "x", message: "m" },
      { path: "$.game.runtime.collisions[0].score", code: "x", message: "m" },
      { path: "$.game.runtime.collisions[1].lives", code: "x", message: "m" },
      { path: "$.game.runtime.collisions[1].b", code: "x", message: "m" },
      { path: "$.game.runtime.maxEntities", code: "x", message: "m" },
    ];
    const r = await planGameplayApply(doc(), withGameplay(), e);
    expect(r).toMatchObject({ ok: false, stage: "engine" });
    if (r.ok) return;
    expect(r.issues.map((i) => `${i.source}@${i.path.join(".")}`)).toEqual([
      "gameplay@lives.start", "gameplay@score.winScore", "gameplay@collectibles.0.points", "gameplay@enemies.0.livesLost", "gameplay@enemies.0.targetKind", "base-spec@game.runtime.maxEntities",
    ]);
  });
  it("mapGameplayEngineIssue keeps an unparseable path as the spec's", () => {
    const c = compileGameplay(withGameplay().gameplay, doc(), []);
    if (!c.ok) throw new Error("compile failed");
    expect(mapGameplayEngineIssue({ path: "???", code: "x", message: "m" }, c)).toMatchObject({ source: "base-spec" });
  });
  it("an oracle failure refuses the plan", async () => {
    const e = new Engine();
    e.failOracle = "boom";
    expect(await planGameplayApply(doc(), withGameplay(), e)).toMatchObject({ ok: false, stage: "oracle", issues: [{ code: "oracle-failed", message: "run: boom" }] });
  });
  it("with level derivation on and the levels out of date, the recorded hash is not advanced", async () => {
    const m = withGameplay();
    m.project = { ...m.project, derivation: { levels: true, gameplay: true, activeLevel: "level-1" }, derived: { inputsSha256: "" } };
    const r = await planGameplayApply(doc(), m, new Engine());
    if (!r.ok) throw new Error("plan failed");
    expect(r.manifests.project.derived.inputsSha256).toBe("");
  });
});

describe("pointer ownership is disjoint from levels", () => {
  const off = { levels: false, gameplay: false, activeLevel: "" };
  it("gameplay derivation locks exactly lives, winScore and collisions and nothing the levels own", () => {
    const g = { ...off, gameplay: true };
    for (const p of POINTER_OWNERS.gameplay) expect(lockedBy([...p, 0, "a"], g)).toBe("gameplay");
    for (const p of POINTER_OWNERS.levels) expect(lockedBy([...p, 0], g)).toBeNull();
  });
  it("level derivation never locks a gameplay pointer", () => {
    const l = { ...off, levels: true, activeLevel: "level-1" };
    for (const p of POINTER_OWNERS.gameplay) expect(lockedBy(p, l)).toBeNull();
  });
  it("nothing is locked while gameplay derivation is off", () => {
    for (const p of POINTER_OWNERS.gameplay) expect(lockedBy(p, off)).toBeNull();
  });
});

describe("gameplayIssues: collision-pair conflicts and field-level checks", () => {
  it("a clean manifest on a spec with no clash has no issues for the module's own pairs once they equal the spec rows", () => {
    const m = xrefManifests();
    const c = compileGameplay(m.gameplay, doc(), []);
    if (!c.ok) throw new Error("compile failed");
    const withRows = JSON.parse(JSON.stringify(doc())) as any;
    withRows.game.runtime.collisions = c.collisions;
    expect(gameplayIssues(m.gameplay, withRows as Json, false)).toEqual([]);
  });
  it("reports a Designer-owned row on a module pair with different values, at the module row's kind field, in either order", () => {
    const m = xrefManifests();
    const d = JSON.parse(JSON.stringify(doc())) as any;
    const col = m.gameplay.collectibles[0]!;
    d.game.runtime.collisions = [{ a: col.collectorKind, b: col.kind, despawnA: false, despawnB: false, score: 999, lives: 0 }];
    const issues = gameplayIssues(m.gameplay, d as Json, false);
    expect(issues).toMatchObject([{ source: "gameplay", code: "collision-conflict", path: ["collectibles", 0, "kind"] }]);
  });
  it("does not report Designer rows once the module owns the table (derivation on)", () => {
    const m = xrefManifests();
    const d = JSON.parse(JSON.stringify(doc())) as any;
    const col = m.gameplay.collectibles[0]!;
    d.game.runtime.collisions = [{ a: col.kind, b: col.collectorKind, despawnA: false, despawnB: false, score: 999, lives: 0 }];
    expect(gameplayIssues(m.gameplay, d as Json, true)).toEqual([]);
  });
  it("an edit that would put two module rows on one pair is refused by the manifest rule and not stored", () => {
    const m = xrefManifests().gameplay;
    const col = m.collectibles[0]!;
    expect(setEnemy(m, m.enemies[0]!.id, { kind: col.kind, targetKind: col.collectorKind })).toMatchObject({ ok: false, reason: expect.stringContaining("already handled") });
  });
  it("reports an unknown kind at its field", () => {
    const m = xrefManifests();
    const bad = { ...m.gameplay, enemies: [{ ...m.gameplay.enemies[0]!, targetKind: "ghost" }] };
    expect(gameplayIssues(bad, doc(), true)).toMatchObject([{ code: "unknown-kind", path: ["enemies", 0, "targetKind"] }]);
  });
});

describe("gameplay ops", () => {
  const base = () => xrefManifests().gameplay;
  it("edit lives and win score within the manifest limits and refuse values outside them", () => {
    expect(setLives(base(), 5)).toMatchObject({ ok: true, gameplay: { lives: { start: 5 } } });
    expect(setWinScore(base(), 200)).toMatchObject({ ok: true, gameplay: { score: { winScore: 200 } } });
    expect(setLives(base(), 0)).toMatchObject({ ok: false });
    expect(setLives(base(), 100)).toMatchObject({ ok: false });
    expect(setWinScore(base(), -1)).toMatchObject({ ok: false });
  });
  it("add allocates a free id, edit patches one row, remove drops it, and none mutates the input", () => {
    const m = base();
    const before = stableText(m);
    expect(freePair(m, ["player", "star"])).toEqual(["player", "player"]);
    expect(freePair(m, ["star"])).toEqual(["star", "star"]);
    const pair = freePair(m, ["bat", "player", "star"]);
    expect(pair).toEqual(["bat", "star"]);
    const a = addCollectible(m, pair![0], pair![1]);
    if (!a.ok) throw new Error(a.reason);
    expect(a.gameplay.collectibles).toHaveLength(2);
    expect(new Set(a.gameplay.collectibles.map((c) => c.id)).size).toBe(2);
    const id = a.gameplay.collectibles[1]!.id;
    expect(setCollectible(a.gameplay, id, { points: 25 })).toMatchObject({ ok: true });
    expect(setCollectible(a.gameplay, id, { points: 2_000_000 })).toMatchObject({ ok: false });
    expect(setCollectible(a.gameplay, "nope", { points: 5 })).toMatchObject({ ok: false });
    const r = removeCollectible(a.gameplay, id);
    expect(r.ok && r.gameplay.collectibles).toHaveLength(1);
    const e = addEnemy(m, "bat", "bat");
    if (!e.ok) throw new Error(e.reason);
    expect(setEnemy(e.gameplay, e.gameplay.enemies[1]!.id, { livesLost: 2 })).toMatchObject({ ok: true });
    expect(addEnemy(m, "", "")).toMatchObject({ ok: false });
    expect(stableText(m)).toBe(before);
  });
});

describe("review then apply through the controller", () => {
  async function boot(): Promise<Harness> {
    const h = harness({ marker: memoryMarker() });
    await h.session.start();
    await drain(h);
    const c = h.session.project.actions;
    const fx = withGameplay();
    for (const n of ["assets", "animations", "levels", "gameplay", "project"] as const) expect(c.commitManifest(n, fx[n] as never)).toMatchObject({ ok: true });
    await drain(h);
    return h;
  }
  const snap = (h: Harness) => ({ doc: h.session.store.getState().doc, manifests: h.session.project.getState().manifests });
  it("review writes nothing; apply commits the reviewed plan as one undo step", async () => {
    const h = await boot();
    const c = h.session.project;
    const before = snap(h);
    const review = await reviewGameplay(c, new Engine());
    if (!review.ok) throw new Error(JSON.stringify(review.issues));
    expect(snap(h).doc).toBe(before.doc);
    expect(snap(h).manifests).toBe(before.manifests);
    expect(applyReviewedGameplay(c, review).ok).toBe(true);
    const after = snap(h);
    expect(getAt(after.doc ?? undefined, [...RT, "lives"])).toBe(before.manifests?.gameplay.lives.start);
    expect(c.actions.undo()).toBe(true);
    expect(sameValue(snap(h), before)).toBe(true);
  });
  it("a rejected review leaves the spec and manifests byte-identical", async () => {
    const h = await boot();
    const before = snap(h);
    const e = new Engine();
    e.forceIssues = [{ path: "$.game.runtime.lives", code: "x", message: "m" }];
    expect(await reviewGameplay(h.session.project, e)).toMatchObject({ ok: false, stage: "engine" });
    expect(sameValue(snap(h), before)).toBe(true);
  });
  it("apply is refused, and the newer edit kept, when the project changed after the review", async () => {
    const h = await boot();
    const c = h.session.project;
    const review = await reviewGameplay(c, new Engine());
    if (!review.ok) throw new Error("review failed");
    h.session.store.set(["game", "runtime", "maxEntities"], 127);
    const r = applyReviewedGameplay(c, review);
    expect(r).toMatchObject({ ok: false, issues: [{ code: "changed-meanwhile" }] });
    expect(getAt(h.session.store.getState().doc ?? undefined, [...RT, "maxEntities"])).toBe(127);
  });
  it("derivation can be turned on while no module row clashes, and is refused with the reason when one does", async () => {
    const h = await boot();
    const c = h.session.project.actions;
    expect(c.setGameplayDerivation(false)).toMatchObject({ ok: true });
    expect(c.setGameplayDerivation(true)).toMatchObject({ ok: true });
    const col = h.session.project.getState().manifests!.gameplay.collectibles[0]!;
    h.session.store.set([...RT, "collisions"], [{ a: col.kind, b: col.collectorKind, despawnA: false, despawnB: false, score: 999, lives: 0 }]);
    expect(c.setGameplayDerivation(false)).toMatchObject({ ok: true });
    expect(c.setGameplayDerivation(true)).toMatchObject({ ok: false, reason: expect.stringContaining("Designer-owned") });
    expect(h.session.project.getState().manifests?.project.derivation.gameplay).toBe(false);
  });
});
