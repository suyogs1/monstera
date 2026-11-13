// Determinism badge: "oracle vs recorded goldens". Plain TypeScript (no React) so it can be tested.
// The runner asks the engine glue to run each applicable golden against the draft; equality is decided in Python.
// This file only sequences the runs, binds them to the draft's SHA-256 and folds the per-scenario outcomes.
import type { DraftStore, Origin } from "../draft/store";
import type { BadgeCheck, BadgeScenario } from "../engine/protocol";

export interface BadgeEngine {
  badgeScenarios(templatePath: string): Promise<BadgeScenario[]>;
  badgeCheck(draftText: string, scenarioFile: string): Promise<BadgeCheck>;
}

export interface BadgeRun {
  /** The canonical draft SHA-256 the run was started for. Every result must carry this hash. */
  sha256: string;
  revision: number;
  /** The template whose recorded goldens were run (null: none applies). */
  origin: { templateId: string; path: string; basis: Origin["basis"] } | null;
  scenarios: BadgeScenario[];
  results: BadgeCheck[];
  phase: "running" | "done" | "cancelled";
  startedAt: number;
  ms: number;
}

export type Verdict =
  | { kind: "not-run" }
  | { kind: "running"; done: number; total: number }
  | { kind: "stale"; run: BadgeRun }
  | { kind: "no-goldens"; run: BadgeRun }
  | { kind: "invalid"; run: BadgeRun; message: string }
  | { kind: "error"; run: BadgeRun; message: string }
  | { kind: "match"; run: BadgeRun }
  | { kind: "diverged"; run: BadgeRun; first: Extract<BadgeCheck, { status: "diverged" }>; scenario: BadgeScenario; divergedScenarios: number };

export interface DraftView { revision: number; validatedRevision: number; ok: boolean; sha256: string | null; /** Current origin template path (null: none). */ originPath?: string | null }

/** Folds a run into one verdict for the current draft. MATCH requires every applicable golden to have matched
 *  for exactly this SHA-256. Anything else (stale, partial, invalid, error, a hash mismatch) is never MATCH. */
export function verdict(run: BadgeRun | null, draft: DraftView): Verdict {
  if (!run) return { kind: "not-run" };
  const sameOrigin = draft.originPath === undefined || draft.originPath === (run.origin?.path ?? null);
  const current = draft.validatedRevision === draft.revision && draft.ok && draft.sha256 === run.sha256 && sameOrigin;
  if (run.phase === "cancelled" || !current) return { kind: "stale", run };
  if (run.phase === "running") return { kind: "running", done: run.results.length, total: run.scenarios.length };
  // Errors first: a scenario list that could not be read is an error, never "no goldens".
  const invalid = run.results.find((r) => r.status === "invalid");
  if (invalid && "message" in invalid) return { kind: "invalid", run, message: invalid.message };
  const error = run.results.find((r) => r.status === "error");
  if (error && "message" in error) return { kind: "error", run, message: error.message };
  if (run.scenarios.length === 0) return { kind: "no-goldens", run };
  if (run.results.length !== run.scenarios.length || run.results.some((r, i) => r.file !== run.scenarios[i]?.file)) {
    return { kind: "error", run, message: `incomplete run: ${run.results.length} of ${run.scenarios.length} scenarios reported` };
  }
  const foreign = run.results.find((r) => r.draftSha256 !== run.sha256);
  if (foreign) return { kind: "error", run, message: `${foreign.file} reported a result for a different draft (${foreign.draftSha256})` };
  const diverged = run.results.filter((r): r is Extract<BadgeCheck, { status: "diverged" }> => r.status === "diverged");
  const first = diverged[0];
  if (first) {
    const scenario = run.scenarios.find((s) => s.file === first.file) as BadgeScenario;
    return { kind: "diverged", run, first, scenario, divergedScenarios: diverged.length };
  }
  if (run.results.every((r) => r.status === "match")) return { kind: "match", run };
  return { kind: "error", run, message: "unrecognised result" };
}

type Listener = () => void;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Runs on demand only. One scenario per engine call, so progress shows and an edit can stop the run between calls. */
export class BadgeRunner {
  private run: BadgeRun | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly engine: BadgeEngine, private readonly store: Pick<DraftStore, "getState">) {}

  getState = (): BadgeRun | null => this.run;
  subscribe = (l: Listener): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  private emit(next: BadgeRun): void { this.run = next; for (const l of this.listeners) l(); }

  /** Refuses to start unless the draft is validated, valid and unchanged since validation. */
  async start(): Promise<void> {
    const s = this.store.getState();
    const v = s.validation;
    if (this.run?.phase === "running") return;
    if (!v || !v.ok || v.sha256 === null || v.canonicalText === null || s.validatedRevision !== s.revision) return;
    // The goldens of the template the draft comes from (baseline origin), matched by recorded spec path. An import
    // that is not exactly a template and has no declared origin has none: NO GOLDENS, never a guess from project.id.
    const o = s.baseline?.origin ?? null;
    const origin = o ? { templateId: o.templateId, path: o.path, basis: o.basis } : null;
    const startedAt = now();
    const base: BadgeRun = { sha256: v.sha256, revision: s.revision, origin, scenarios: [], results: [], phase: "running", startedAt, ms: 0 };
    this.emit(base);
    let scenarios: BadgeScenario[] = [];
    try {
      scenarios = origin ? await this.engine.badgeScenarios(origin.path) : [];
    } catch (e) {
      this.emit({ ...base, phase: "done", ms: now() - startedAt,
        results: [{ status: "error", file: "(scenario list)", draftSha256: null, message: (e as Error).message }] });
      return;
    }
    let run: BadgeRun = { ...base, scenarios };
    this.emit(run);
    const text = v.canonicalText;
    for (const sc of scenarios) {
      if (this.store.getState().revision !== base.revision) { this.emit({ ...run, phase: "cancelled", ms: now() - startedAt }); return; }
      let r: BadgeCheck;
      try { r = await this.engine.badgeCheck(text, sc.file); }
      catch (e) { r = { status: "error", file: sc.file, draftSha256: null, message: (e as Error).message }; }
      run = { ...run, results: [...run.results, r] };
      this.emit(run);
      if (r.status === "invalid") break; // the draft itself is refused: no other scenario can produce a result
    }
    // A complete run stays bound to its SHA-256; verdict() reports it stale whenever the draft no longer has that hash.
    this.emit({ ...run, phase: "done", ms: now() - startedAt });
  }
}
