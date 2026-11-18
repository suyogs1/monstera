// Apply path of level derivation (task 4.2): compile -> engine validate -> bounded oracle run -> commit or reject.
//
// planLevelApply never touches the project: it returns the next document and manifests, or the reasons it refused, with
// every engine issue mapped back to the level field that produced it. applyActiveLevel hands an accepted plan to the
// controller, which commits only if the draft is still the document the plan was computed from. No game rule lives here:
// the unmodified engine validates the derived spec and the oracle (preview session) runs it.
import { getAt, parseIssuePath, setAt, startsWith, type Path } from "../draft/path";
import type { DraftValidation, OracleCheck } from "../engine/protocol";
import type { Issue, ManifestMap } from "../project/manifests";
import { sameValue, sha256Hex, stableText, type Sha256 } from "../project/record";
import type { Json } from "../schema/schema";
import { compileGameplay, type GameplayCompileResult, type GameplayIssueSource } from "./gameplay";
import { compileLevel, type CompileIssue, type CompileResult } from "./levels";
import { POINTER_OWNERS } from "./ownership";
/** The oracle run covers this many ticks of the derived spec (10 s at 60 ticks per second). */
export const ORACLE_TICKS = 600;
export const ORACLE_SEED = 1;
/** The engine calls the apply path uses (EngineClient satisfies it). */
export interface ApplyEngine {
  validateDraft(text: string): Promise<DraftValidation>;
  /** Bounded run on a local GameLoop; never touches the live preview session. */
  oracleCheck(draftText: string, seed: number, ticks: number): Promise<OracleCheck>;
}
export interface ApplyPlan {
  ok: true;
  doc: Json;
  manifests: ManifestMap;
  canonicalText: string;
  sha256: string;
  /** The derived pointers before and after, for the diff the user sees before accepting. */
  diff: { initialEntities: { before: Json; after: Json }; spawners: { before: Json; after: Json } };
  oracle: { ticks: number; ms: number; hash: string };
}
export type ApplyRefusal = { ok: false; stage: "precondition" | "compile" | "engine" | "oracle"; issues: CompileIssue[] };
export type ApplyResult = ApplyPlan | ApplyRefusal;
const RT: Path = ["game", "runtime"];
const compiledIndex = (m: ManifestMap): number => Math.max(0, m.levels.levels.findIndex((l) => l.id === m.project.derivation.activeLevel));
const refuse = (stage: ApplyRefusal["stage"], issues: CompileIssue[]): ApplyRefusal => ({ ok: false, stage, issues });
/** Hash of everything derivation reads: the levels manifest, the active level and the spec without the owned pointers. */
export async function inputsSha256(doc: Json, manifests: ManifestMap, sha: Sha256 = sha256Hex): Promise<string> {
  let base = doc;
  for (const owned of Object.values(POINTER_OWNERS)) for (const p of owned) if (getAt(base, p) !== undefined) base = setAt(base, p, null);
  const d = manifests.project.derivation;
  return sha(stableText({ base, levels: d.levels ? { activeLevel: d.activeLevel, manifest: manifests.levels } : null, gameplay: d.gameplay ? manifests.gameplay : null }));
}
/** "none" before any derivation, "fresh" when the inputs still hash to the recorded value, else "stale". */
export async function derivationState(doc: Json, manifests: ManifestMap, sha: Sha256 = sha256Hex): Promise<"none" | "fresh" | "stale"> {
  const recorded = manifests.project.derived.inputsSha256;
  if (recorded === "") return "none";
  return (await inputsSha256(doc, manifests, sha)) === recorded ? "fresh" : "stale";
}
/** Maps one engine issue path to the level field that produced it; unmapped issues stay on the spec. */
export function mapEngineIssue(i: { path: string; code: string; message: string }, c: Extract<CompileResult, { ok: true }>, levels: Json): CompileIssue {
  const path = parseIssuePath(i.path);
  const unmapped: CompileIssue = { source: "base-spec", path: path ?? [i.path], code: i.code, message: i.message };
  if (!path) return unmapped;
  for (const [name, sources] of [["initialEntities", c.entitySourcePaths], ["spawners", c.spawnerSourcePaths]] as const) {
    const owned: Path = [...RT, name];
    if (!startsWith(path, owned) || typeof path[owned.length] !== "number") continue;
    const source = sources[path[owned.length] as number];
    if (!source) return unmapped;
    const prop = path[owned.length + 1];
    const obj = getAt(levels, source);
    const has = (k: string) => obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, k);
    let target: Path = source;
    if (typeof prop === "string") target = has(prop) ? [...source, prop] : prop === "startTick" && has("atTick") ? [...source, "atTick"] : source;
    return { source: "levels", path: target, code: i.code, message: i.message };
  }
  return unmapped;
}
/** Compiles the active level into `doc` and checks it with the engine. Pure with respect to the project: nothing is committed. */
export async function planLevelApply(doc: Json, manifests: ManifestMap, engine: ApplyEngine, sha: Sha256 = sha256Hex): Promise<ApplyResult> {
  const d = manifests.project.derivation;
  if (!d.levels) return refuse("precondition", [{ source: "request", path: ["derivation", "levels"], code: "derivation-off", message: "level derivation is off for this project" }]);
  const compiled = compileLevel(manifests.levels, doc, d.activeLevel);
  if (!compiled.ok) return refuse("compile", compiled.issues);
  const tickRate = getAt(doc, ["game", "simulation", "tickRate"]);
  if (typeof tickRate !== "number" || tickRate < 1) return refuse("precondition", [{ source: "base-spec", path: ["game", "simulation", "tickRate"], code: "bad-base-spec", message: "the base spec has no usable tickRate" }]);
  const entities = compiled.initialEntities as unknown as Json;
  const spawners = compiled.spawners as unknown as Json;
  const next = setAt(setAt(doc, [...RT, "initialEntities"], entities), [...RT, "spawners"], spawners);
  const verdict = await engine.validateDraft(JSON.stringify(next, null, 2));
  if (!verdict.ok || verdict.canonicalText === null || verdict.sha256 === null) {
    const issues = verdict.issues.length > 0
      ? verdict.issues.map((i) => mapEngineIssue(i, compiled, manifests.levels as unknown as Json))
      : [{ source: "base-spec" as const, path: [], code: "engine-rejected", message: "the engine could not read the derived specification" }];
    return refuse("engine", issues);
  }
  const run = await engine.oracleCheck(verdict.canonicalText, ORACLE_SEED, ORACLE_TICKS);
  if (!run.ok) return refuse("oracle", [{ source: "levels", path: ["levels", compiledIndex(manifests)], code: "oracle-failed", message: `${run.stage}: ${run.message}` }]);
  const nextDoc = JSON.parse(verdict.canonicalText) as Json;
  const inputs = await inputsSha256(nextDoc, manifests, sha);
  const nextManifests: ManifestMap = {
    ...manifests,
    project: { ...manifests.project, spec: { ...manifests.project.spec, currentSha256: verdict.sha256 }, derived: { inputsSha256: inputs } },
  };
  return {
    ok: true, doc: nextDoc, manifests: nextManifests, canonicalText: verdict.canonicalText, sha256: verdict.sha256,
    diff: {
      initialEntities: { before: getAt(doc, [...RT, "initialEntities"]) ?? null, after: entities },
      spawners: { before: getAt(doc, [...RT, "spawners"]) ?? null, after: spawners },
    },
    oracle: { ticks: run.ticks, ms: run.ms, hash: run.hash },
  };
}
/** What applyActiveLevel needs from the project controller. */
export interface DerivationSink {
  currentState(): { doc: Json; manifests: ManifestMap } | null;
  /** Must commit only while the live document AND manifests are the exact objects `expected` holds. */
  commitDerived(expected: { doc: Json; manifests: ManifestMap }, doc: Json, manifests: ManifestMap): { ok: true } | { ok: false; message: string };
}
/** Plans and, if the plan passes, commits it as one change (one undo step). A rejected plan leaves the project untouched. */
export async function applyActiveLevel(sink: DerivationSink, engine: ApplyEngine, sha: Sha256 = sha256Hex): Promise<ApplyResult> {
  const state = sink.currentState();
  if (state === null) return refuse("precondition", [{ source: "request", path: [], code: "no-project", message: "there is no open project" }]);
  const plan = await planLevelApply(state.doc, state.manifests, engine, sha);
  if (!plan.ok) return plan;
  const done = sink.commitDerived(state, plan.doc, plan.manifests);
  if (!done.ok) return refuse("precondition", [{ source: "request", path: [], code: "changed-meanwhile", message: done.message }]);
  return plan;
}

// ---------------------------------------------------------------------------------------------------------------------
// Gameplay apply (task 5.2): the same compile -> engine validate -> bounded oracle -> commit-or-reject path as the levels,
// for the pointers lives, winScore and collisions. Review and commit are separate calls so the user sees the diff and the
// engine verdict first; nothing is written until `applyReviewedGameplay`, and then only if nothing changed in between.
// ---------------------------------------------------------------------------------------------------------------------
export interface GameplayApplyIssue extends Issue { source: GameplayIssueSource | "request" }
export interface GameplayPlan {
  ok: true;
  doc: Json;
  manifests: ManifestMap;
  canonicalText: string;
  sha256: string;
  /** The derived pointers before and after (`null` = absent), for the diff the user sees before accepting. */
  diff: { lives: { before: Json; after: Json }; winScore: { before: Json; after: Json }; collisions: { before: Json; after: Json } };
  /** Spec collision rows that the module table does not reproduce: applying removes them (the module owns the whole table). */
  removedRows: Json[];
  oracle: { ticks: number; ms: number; hash: string };
}
export type GameplayRefusal = { ok: false; stage: "precondition" | "compile" | "engine" | "oracle"; issues: GameplayApplyIssue[] };
export type GameplayApplyResult = GameplayPlan | GameplayRefusal;
export type GameplayReview = { ok: true; expected: { doc: Json; manifests: ManifestMap }; plan: GameplayPlan } | GameplayRefusal;
const gRefuse = (stage: GameplayRefusal["stage"], issues: GameplayApplyIssue[]): GameplayRefusal => ({ ok: false, stage, issues });
const COLLISION_FIELD: Readonly<Record<string, Record<string, string>>> = {
  collectibles: { a: "kind", b: "collectorKind", despawnA: "despawn", score: "points" },
  enemies: { a: "kind", b: "targetKind", despawnA: "despawnEnemy", lives: "livesLost" },
};
/** Maps one engine issue path to the gameplay field that produced it; unmapped issues stay on the spec. */
export function mapGameplayEngineIssue(i: { path: string; code: string; message: string }, c: Extract<GameplayCompileResult, { ok: true }>): GameplayApplyIssue {
  const path = parseIssuePath(i.path);
  const unmapped: GameplayApplyIssue = { source: "base-spec", path: path ?? [i.path], code: i.code, message: i.message };
  if (!path) return unmapped;
  const is = (name: string) => startsWith(path, [...RT, name]);
  if (is("lives") && path.length === 3) return { source: "gameplay", path: ["lives", "start"], code: i.code, message: i.message };
  if (is("winScore") && path.length === 3) return { source: "gameplay", path: ["score", "winScore"], code: i.code, message: i.message };
  if (is("collisions") && typeof path[3] === "number") {
    const source = c.collisionSourcePaths[path[3]];
    if (!source) return unmapped;
    const prop = path[4];
    const field = typeof prop === "string" ? COLLISION_FIELD[String(source[0])]?.[prop] : undefined;
    return { source: "gameplay", path: field ? [...source, field] : source, code: i.code, message: i.message };
  }
  return unmapped;
}
/** True when the spec already holds exactly what the active levels compile to (a direct comparison, never a hash). */
function levelsInSync(doc: Json, manifests: ManifestMap): boolean {
  const d = manifests.project.derivation;
  const c = compileLevel(manifests.levels, doc, d.activeLevel);
  return c.ok && sameValue(c.initialEntities, getAt(doc, [...RT, "initialEntities"])) && sameValue(c.spawners, getAt(doc, [...RT, "spawners"]));
}
/** True when the spec already holds exactly what the gameplay manifest compiles to. */
export function gameplayInSync(doc: Json, manifests: ManifestMap): boolean {
  const c = compileGameplay(manifests.gameplay, doc, []);
  return c.ok && sameValue(c.lives, getAt(doc, [...RT, "lives"])) && sameValue(c.winScore, getAt(doc, [...RT, "winScore"])) && sameValue(c.collisions, getAt(doc, [...RT, "collisions"]));
}
/** Compiles the gameplay manifest into `doc` and checks it with the engine. Nothing is committed. */
export async function planGameplayApply(doc: Json, manifests: ManifestMap, engine: ApplyEngine, sha: Sha256 = sha256Hex): Promise<GameplayApplyResult> {
  const d = manifests.project.derivation;
  if (!d.gameplay) return gRefuse("precondition", [{ source: "request", path: ["derivation", "gameplay"], code: "derivation-off", message: "gameplay derivation is off for this project" }]);
  // While derivation is on the module owns the whole collision table (POINTER_OWNERS), so no row is Designer-owned here.
  const compiled = compileGameplay(manifests.gameplay, doc, []);
  if (!compiled.ok) return gRefuse("compile", compiled.issues);
  const before = getAt(doc, [...RT, "collisions"]);
  const next = setAt(setAt(setAt(doc, [...RT, "lives"], compiled.lives), [...RT, "winScore"], compiled.winScore), [...RT, "collisions"], compiled.collisions as unknown as Json);
  const verdict = await engine.validateDraft(JSON.stringify(next, null, 2));
  if (!verdict.ok || verdict.canonicalText === null || verdict.sha256 === null) {
    const issues = verdict.issues.length > 0
      ? verdict.issues.map((i) => mapGameplayEngineIssue(i, compiled))
      : [{ source: "base-spec" as const, path: [], code: "engine-rejected", message: "the engine could not read the derived specification" }];
    return gRefuse("engine", issues);
  }
  const run = await engine.oracleCheck(verdict.canonicalText, ORACLE_SEED, ORACLE_TICKS);
  if (!run.ok) return gRefuse("oracle", [{ source: "gameplay", path: [], code: "oracle-failed", message: `${run.stage}: ${run.message}` }]);
  const nextDoc = JSON.parse(verdict.canonicalText) as Json;
  // One recorded hash covers levels and gameplay. It may only say "fresh" when the levels half is in sync too.
  const inputs = d.levels && !levelsInSync(doc, manifests) ? manifests.project.derived.inputsSha256 : await inputsSha256(nextDoc, manifests, sha);
  const nextManifests: ManifestMap = {
    ...manifests,
    project: { ...manifests.project, spec: { ...manifests.project.spec, currentSha256: verdict.sha256 }, derived: { inputsSha256: inputs } },
  };
  const keep = new Set(compiled.collisions.map((r) => `${r.a}\u0000${r.b}`));
  const old = Array.isArray(before) ? before : [];
  const removedRows = old.filter((r) => { const o = r as { a?: unknown; b?: unknown } | null; return !(o && keep.has(`${String(o.a)}\u0000${String(o.b)}`)); });
  return {
    ok: true, doc: nextDoc, manifests: nextManifests, canonicalText: verdict.canonicalText, sha256: verdict.sha256,
    diff: {
      lives: { before: getAt(doc, [...RT, "lives"]) ?? null, after: compiled.lives },
      winScore: { before: getAt(doc, [...RT, "winScore"]) ?? null, after: compiled.winScore },
      collisions: { before: before ?? null, after: compiled.collisions as unknown as Json },
    },
    removedRows,
    oracle: { ticks: run.ticks, ms: run.ms, hash: run.hash },
  };
}
/** Step 1 of the flow: plans against the current project and remembers exactly which document and manifests it planned for. */
export async function reviewGameplay(sink: DerivationSink, engine: ApplyEngine, sha: Sha256 = sha256Hex): Promise<GameplayReview> {
  const state = sink.currentState();
  if (state === null) return gRefuse("precondition", [{ source: "request", path: [], code: "no-project", message: "there is no open project" }]);
  const plan = await planGameplayApply(state.doc, state.manifests, engine, sha);
  return plan.ok ? { ok: true, expected: state, plan } : plan;
}
/** Step 2: commits a reviewed plan as one change (one undo step), only if the project is still exactly what was reviewed. */
export function applyReviewedGameplay(sink: DerivationSink, review: Extract<GameplayReview, { ok: true }>): GameplayApplyResult {
  const done = sink.commitDerived(review.expected, review.plan.doc, review.plan.manifests);
  if (!done.ok) return gRefuse("precondition", [{ source: "request", path: [], code: "changed-meanwhile", message: done.message }]);
  return review.plan;
}
