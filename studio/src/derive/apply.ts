// Apply path of level derivation (task 4.2): compile -> engine validate -> bounded oracle run -> commit or reject.
//
// planLevelApply never touches the project: it returns the next document and manifests, or the reasons it refused, with
// every engine issue mapped back to the level field that produced it. applyActiveLevel hands an accepted plan to the
// controller, which commits only if the draft is still the document the plan was computed from. No game rule lives here:
// the unmodified engine validates the derived spec and the oracle (preview session) runs it.
import { getAt, parseIssuePath, setAt, startsWith, type Path } from "../draft/path";
import type { DraftValidation, EngineEvent, PreviewFrame, PreviewStart } from "../engine/protocol";
import type { ManifestMap } from "../project/manifests";
import { sha256Hex, stableText, type Sha256 } from "../project/record";
import type { Json } from "../schema/schema";
import { compileLevel, type CompileIssue, type CompileResult } from "./levels";
import { POINTER_OWNERS } from "./ownership";
/** The oracle run covers this many ticks of the derived spec (about 10 s at 60 ticks per second). */
export const ORACLE_TICKS = 600;
export const ORACLE_SEED = 1;
/** The engine calls the apply path uses (EngineClient satisfies it). */
export interface ApplyEngine {
  validateDraft(text: string): Promise<DraftValidation>;
  previewStart(draftText: string, seed: number): Promise<PreviewStart>;
  previewFrame(session: number, elapsedNanos: number, events: EngineEvent[]): Promise<PreviewFrame>;
}
export interface ApplyPlan {
  ok: true;
  doc: Json;
  manifests: ManifestMap;
  canonicalText: string;
  sha256: string;
  /** The derived pointers before and after, for the diff the user sees before accepting. */
  diff: { initialEntities: { before: Json; after: Json }; spawners: { before: Json; after: Json } };
  oracle: { ticks: number; ms: number };
}
export type ApplyRefusal = { ok: false; stage: "precondition" | "compile" | "engine" | "oracle"; issues: CompileIssue[] };
export type ApplyResult = ApplyPlan | ApplyRefusal;
const RT: Path = ["game", "runtime"];
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
function mapEngineIssue(i: { path: string; code: string; message: string }, c: Extract<CompileResult, { ok: true }>, levels: Json): CompileIssue {
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
async function oracleRun(engine: ApplyEngine, text: string, tickRate: number): Promise<{ ok: true; ticks: number; ms: number } | { ok: false; message: string }> {
  const t0 = performance.now();
  const start = await engine.previewStart(text, ORACLE_SEED);
  if (!start.ok) return { ok: false, message: start.message };
  const step = Math.round(1e9 / tickRate);
  let tick = start.snapshot.tick;
  for (let n = 0; n < ORACLE_TICKS && tick < ORACLE_TICKS; n++) {
    const f = await engine.previewFrame(start.session, step, []);
    if (!f.ok) return { ok: false, message: f.message };
    if (f.snapshot.tick <= tick) return { ok: false, message: "the oracle did not advance" };
    tick = f.snapshot.tick;
    if (f.snapshot.ended) break;
  }
  return { ok: true, ticks: tick, ms: performance.now() - t0 };
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
  const run = await oracleRun(engine, verdict.canonicalText, tickRate);
  if (!run.ok) return refuse("oracle", [{ source: "levels", path: ["levels"], code: "oracle-failed", message: run.message }]);
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
    oracle: { ticks: run.ticks, ms: run.ms },
  };
}
/** What applyActiveLevel needs from the project controller. */
export interface DerivationSink {
  currentState(): { doc: Json; manifests: ManifestMap } | null;
  commitDerived(expectedDoc: Json, doc: Json, manifests: ManifestMap): { ok: true } | { ok: false; message: string };
}
/** Plans and, if the plan passes, commits it as one change (one undo step). A rejected plan leaves the project untouched. */
export async function applyActiveLevel(sink: DerivationSink, engine: ApplyEngine, sha: Sha256 = sha256Hex): Promise<ApplyResult> {
  const state = sink.currentState();
  if (state === null) return refuse("precondition", [{ source: "request", path: [], code: "no-project", message: "there is no open project" }]);
  const plan = await planLevelApply(state.doc, state.manifests, engine, sha);
  if (!plan.ok) return plan;
  const done = sink.commitDerived(state.doc, plan.doc, plan.manifests);
  if (!done.ok) return refuse("precondition", [{ source: "request", path: [], code: "changed-meanwhile", message: done.message }]);
  return plan;
}
