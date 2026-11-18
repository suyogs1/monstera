// Per-level variants (task 4.3): each level compiled on its own into a standalone spec, checked by the engine.
//
// A variant is the base document with exactly two pointers replaced, game.runtime.initialEntities and
// game.runtime.spawners, by the output of the existing deterministic compiler (levels.ts). Nothing here writes to the
// project: browsing, editing or checking another level never touches the active spec (the active level goes through
// the Apply path of task 4.2). Checks run strictly one level at a time, so only one variant is in flight at any moment.
import { setAt, type Path } from "../draft/path";
import type { OracleCheck } from "../engine/protocol";
import type { Json } from "../schema/schema";
import type { LevelsManifest } from "../project/manifests";
import { mapEngineIssue, ORACLE_SEED, ORACLE_TICKS, type ApplyEngine } from "./apply";
import { compileLevel, type CompileIssue, type CompileResult } from "./levels";

const RT: Path = ["game", "runtime"];
type Compiled = Extract<CompileResult, { ok: true }>;

export type VariantCompile = { ok: true; spec: Json; compiled: Compiled } | { ok: false; issues: CompileIssue[] };
/** The base document with only `runtime.initialEntities` and `runtime.spawners` replaced by one level's compilation. */
export function compileVariant(doc: Json, levels: LevelsManifest, levelId: string): VariantCompile {
  const compiled = compileLevel(levels, doc, levelId);
  if (!compiled.ok) return compiled;
  const spec = setAt(setAt(doc, [...RT, "initialEntities"], compiled.initialEntities as unknown as Json), [...RT, "spawners"], compiled.spawners as unknown as Json);
  return { ok: true, spec, compiled };
}

export type VariantStage = "compile" | "engine" | "oracle" | "nondeterministic";
export interface VariantCheck {
  levelId: string;
  /** "valid" only when the engine accepted it, the bounded oracle ran, and a second identical run agreed byte for byte. */
  status: "valid" | "refused";
  stage: VariantStage | null;
  issues: CompileIssue[];
  /** Engine canonical text and hash of the variant. Kept only for valid variants (it is what gets exported). */
  canonicalText: string | null;
  sha256: string | null;
  oracle: { ticks: number; hash: string; ms: number } | null;
  /** Both runs produced the same canonical text, the same hash and the same oracle result. */
  deterministic: boolean;
}
const refused = (levelId: string, stage: VariantStage, issues: CompileIssue[]): VariantCheck =>
  ({ levelId, status: "refused", stage, issues, canonicalText: null, sha256: null, oracle: null, deterministic: false });

type Pass = { ok: true; canonicalText: string; sha256: string; run: Extract<OracleCheck, { ok: true }> } | { ok: false; check: VariantCheck };
async function pass(doc: Json, levels: LevelsManifest, levelId: string, engine: ApplyEngine): Promise<Pass> {
  const v = compileVariant(doc, levels, levelId);
  if (!v.ok) return { ok: false, check: refused(levelId, "compile", v.issues) };
  const verdict = await engine.validateDraft(JSON.stringify(v.spec, null, 2));
  if (!verdict.ok || verdict.canonicalText === null || verdict.sha256 === null) {
    const issues = verdict.issues.length > 0
      ? verdict.issues.map((i) => mapEngineIssue(i, v.compiled, levels as unknown as Json))
      : [{ source: "base-spec" as const, path: [], code: "engine-rejected", message: "the engine could not read the variant specification" }];
    return { ok: false, check: refused(levelId, "engine", issues) };
  }
  const run = await engine.oracleCheck(verdict.canonicalText, ORACLE_SEED, ORACLE_TICKS);
  if (!run.ok) {
    const at = levels.levels.findIndex((l) => l.id === levelId);
    return { ok: false, check: refused(levelId, "oracle", [{ source: "levels", path: ["levels", Math.max(0, at)], code: "oracle-failed", message: `${run.stage}: ${run.message}` }]) };
  }
  return { ok: true, canonicalText: verdict.canonicalText, sha256: verdict.sha256, run };
}
const sameRun = (a: Extract<OracleCheck, { ok: true }>, b: Extract<OracleCheck, { ok: true }>): boolean =>
  a.hash === b.hash && a.score === b.score && a.lives === b.lives && a.entities === b.entities && a.ended === b.ended && a.ticks === b.ticks;

/**
 * Compiles, validates and bounded-oracle-runs one level twice with the same seed and inputs and compares the canonical
 * text, its hash and the oracle result. Disagreement refuses the variant as "nondeterministic".
 */
export async function checkVariant(doc: Json, levels: LevelsManifest, levelId: string, engine: ApplyEngine): Promise<VariantCheck> {
  const first = await pass(doc, levels, levelId, engine);
  if (!first.ok) return first.check;
  const second = await pass(doc, levels, levelId, engine);
  if (!second.ok) return second.check;
  const same = first.canonicalText === second.canonicalText && first.sha256 === second.sha256 && sameRun(first.run, second.run);
  if (!same) {
    const at = Math.max(0, levels.levels.findIndex((l) => l.id === levelId));
    return refused(levelId, "nondeterministic", [{ source: "levels", path: ["levels", at], code: "nondeterministic", message: "two runs with the same seed and inputs disagreed on the canonical text or the oracle result" }]);
  }
  return {
    levelId, status: "valid", stage: null, issues: [], canonicalText: first.canonicalText, sha256: first.sha256,
    oracle: { ticks: first.run.ticks, hash: first.run.hash, ms: first.run.ms }, deterministic: true,
  };
}

export interface CheckAllOptions { signal?: AbortSignal; onProgress?: (done: number, total: number, last: VariantCheck) => void }
/** Every level in manifest order, one after the other (never concurrently). An aborted run returns the levels done so far. */
export async function checkAllVariants(doc: Json, levels: LevelsManifest, engine: ApplyEngine, opts: CheckAllOptions = {}): Promise<VariantCheck[]> {
  const out: VariantCheck[] = [];
  const ids = levels.levels.map((l) => l.id);
  for (const id of ids) {
    if (opts.signal?.aborted) break;
    const r = await checkVariant(doc, levels, id, engine);
    out.push(r);
    opts.onProgress?.(out.length, ids.length, r);
  }
  return out;
}
