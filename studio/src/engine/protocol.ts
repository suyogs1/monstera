export interface EngineTimings {
  pyodideMs: number;
  bundleFetchMs: number;
  unpackMs: number;
  importEngineMs: number;
  totalMs: number;
  files: number;
}

export type WorkerRequest =
  | { id: number; cmd: "init"; base: string }
  | { id: number; cmd: "call"; fn: EngineFunction; args: string[] };

export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

/** Functions exported by glue.py. Each takes and returns strings (JSON). */
export type EngineFunction =
  | "info" | "schemas" | "validate_draft" | "template" | "golden_report" | "plan_template" | "badge_scenarios" | "badge_check"
  | "preview_start" | "preview_frame" | "preview_trace" | "export_plan";

export interface ExportFile { path: string; mode: number; size: number; sha256: string; kind: string; data: string }
export type ExportPlan =
  | { ok: false; message: string }
  | { ok: true; projectId: string; specSha256: string; label: string; layout: "app" | "fixture"; manifestSha256: string;
      scenariosIncluded: number; scenariosOmitted: { count: number; reason: string } | null; files: ExportFile[] };

/** An input event exactly as the engine (and a scenario file) takes it. */
export interface EngineEvent { type: "press" | "release" | "tap" | "drag" | "swipe"; dx: number; dy: number; dir: "none" | "up" | "down" | "left" | "right" }
/** Engine state after a frame. `entities` is flat: [id, kind, x, y, vx, vy, controlled] per entity, raw Q16.16. */
export interface PreviewSnapshot { tick: number; score: number; lives: number; ended: boolean; alpha: number; ticks: number; entities: number[]; ms: number }
export type PreviewStart = { ok: true; session: number; sha256: string; seed: number; snapshot: PreviewSnapshot } | { ok: false; message: string };
export type PreviewFrame = { ok: true; session: number; snapshot: PreviewSnapshot } | { ok: false; message: string };
export interface PreviewTrace { session: number; seed: number; sha256: string; frames: [number, EngineEvent[]][]; truncated: boolean; tick: number; hash: string }

export interface BadgeScenario {
  file: string; name: string; ticks: number; frameDriven: boolean; checkpoints: number;
  recordedSpecPath: string; recordedSpecSha256: string;
}
/** One scenario's outcome as the engine glue reports it. Equality was decided in Python. */
export type BadgeCheck =
  | { status: "match"; file: string; draftSha256: string; checkpoints: number; divergentCheckpoints: 0; ms: number }
  | { status: "diverged"; file: string; draftSha256: string; checkpoints: number; divergentCheckpoints: number; ms: number;
      firstDivergentIndex: number; firstDivergentTick: number | null; expected: Checkpoint | null; actual: Checkpoint | null }
  | { status: "invalid" | "error"; file: string; draftSha256: null; message: string };

export interface Checkpoint { tick: number; hash: string; observe: Record<string, number> }
export interface GoldenRow {
  file: string; specPath: string; frameDriven: boolean; ticks: number;
  committed: Checkpoint[]; fresh: Checkpoint[]; ms: number; checkIssues: string[];
}
export interface PlanFileRow { path: string; sha256: string; size: number; mode: string | number }
export type PlanTemplate =
  | { ok: false; issues: Issue[] }
  | { ok: true; project: string; layout: string; specSha256: string; scenarioCount: number; files: PlanFileRow[]; ms: number };

export interface Issue { path: string; code: string; message: string }

export interface DraftValidation {
  ok: boolean;
  parsed: boolean;
  issues: Issue[];
  sha256: string | null;
  canonicalText: string | null;
}

export interface TemplateInfo { id: string; path: string; group: "official" | "kiro-sample" }

export interface TemplateLoad extends DraftValidation {
  path: string;
  fileText: string;
  canonicalEqualsFile: boolean;
}
