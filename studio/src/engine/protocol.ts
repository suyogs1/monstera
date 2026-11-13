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
export type EngineFunction = "info" | "schemas" | "validate_draft" | "template";

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
