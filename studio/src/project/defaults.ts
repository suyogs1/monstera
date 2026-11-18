// Default sidecar manifests and the initial baseline for a project Studio creates or migrates. Pure: no storage, no
// engine, no clock, no random. Everything Studio cannot know is an explicit input; a missing or malformed input returns a
// typed error. Nothing is invented, and nothing is taken from the manifest test fixtures (the Lantern Run samples).
//
// Hash semantics. project.spec.baseSha256 is the spec immediately BEFORE Studio derivation and currentSha256 the spec
// after it. A new or migrated project has had no derivation, so both are SHA-256(current spec text as stored).
// Baseline.sha256 (the M3 template/import baseline) is provenance only: it stays in record.baseline and is NEVER a
// project-manifest hash input. Gameplay starts from the validated current spec's runtime.lives and runtime.winScore,
// supplied by Session from the engine-validated document (this module does not read or validate the spec itself).
//
// Runtime inputs Session must supply in Increment D (Session is NOT wired here):
//   backfillOrigin    Session's existing template-canonical lookup (same rule as startOnce: a draft stored without an
//                     origin takes the origin of its templateId with basis "template", else null).
//   defaultManifests  migrationDefaultManifests({ engine: engineClient.engine, runtimeOf }) where runtimeOf(specText)
//                     returns { lives, winScore } read from the ENGINE-VALIDATED document (null when the engine rejects
//                     it). On any failure it throws DefaultManifestsFailure: the migration refuses the draft as
//                     'inputs-unavailable' and keeps it untouched. The spec text it hashes is the text the record stores;
//                     Session must store the engine's canonical text for that hash to be the canonical-spec hash.
//   sha256            sha256Hex (Web Crypto).
//   legacy            window.localStorage, read through getItem only.
//   marker            window.localStorage (the eviction hint marker).
//   storage           navigator.storage.
//   factory           window.indexedDB (IDBFactory).
import type { Baseline, Origin } from "../draft/store";
import { MANIFEST_NAMES, validateManifest, type ManifestMap, type ManifestName } from "./manifests";
import type { DefaultManifestsContext } from "./migrate";

/** runtime.lives and runtime.winScore of the engine-validated current spec. */
export interface SpecRuntimeFacts { lives: number | null | undefined; winScore: number | null | undefined }

export interface DefaultManifestsInput {
  projectId: string;
  /** SHA-256 of the spec immediately before Studio derivation. Not the M3 baseline hash. Null when unknown. */
  specBaseSha256: string | null;
  /** SHA-256 of the current spec text. */
  specCurrentSha256: string | null;
  /** The engine bundled in this Studio build (EngineClient.engine). */
  engine: { gitCommit: string | null | undefined };
  /** From the validated current spec; never defaulted here. */
  runtime: SpecRuntimeFacts;
}

export type DefaultManifestsError =
  | { code: "missing-input"; missing: string[]; message: string }
  | { code: "invalid-input"; field: string; message: string }
  /** The project manifest rule: while no derivation is on, currentSha256 must equal baseSha256. */
  | { code: "spec-hash-mismatch"; message: string }
  | { code: "invalid-manifest"; manifest: ManifestName; message: string };

export type DefaultManifestsResult = { ok: true; manifests: ManifestMap } | { ok: false; error: DefaultManifestsError };

export class DefaultManifestsFailure extends Error {
  readonly error: DefaultManifestsError;
  constructor(error: DefaultManifestsError) {
    super(error.message);
    this.name = "DefaultManifestsFailure";
    this.error = error;
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Valid, project-specific defaults for every manifest. Everything optional is empty or off: derivation is off, so the
 * defaults compile nothing into the spec. Gameplay lives and win score mirror the current spec's runtime values, so the
 * gameplay manifest agrees with the spec; collectibles and enemies stay empty (collision rows are not converted until a
 * lossless, previewed mapping exists). `modules` lists the five sidecar manifests that exist in the record.
 */
export function buildDefaultManifests(input: DefaultManifestsInput): DefaultManifestsResult {
  const missing: string[] = [];
  const absent = (v: unknown): boolean => v === null || v === undefined;
  if (input.projectId === "") missing.push("projectId");
  if (input.specBaseSha256 === null || input.specBaseSha256 === "") missing.push("specBaseSha256");
  if (input.specCurrentSha256 === null || input.specCurrentSha256 === "") missing.push("specCurrentSha256");
  if (!input.engine.gitCommit) missing.push("engine.gitCommit");
  if (absent(input.runtime.lives)) missing.push("runtime.lives");
  if (absent(input.runtime.winScore)) missing.push("runtime.winScore");
  if (missing.length > 0) return { ok: false, error: { code: "missing-input", missing, message: `cannot build default manifests: missing ${missing.join(", ")}` } };
  for (const f of ["lives", "winScore"] as const) {
    if (!Number.isInteger(input.runtime[f])) return { ok: false, error: { code: "invalid-input", field: `runtime.${f}`, message: `runtime.${f} is not an integer` } };
  }
  const lives = input.runtime.lives as number, winScore = input.runtime.winScore as number;
  const base = input.specBaseSha256 as string, current = input.specCurrentSha256 as string, commit = input.engine.gitCommit as string;
  if (!SHA256.test(base)) return { ok: false, error: { code: "invalid-input", field: "specBaseSha256", message: "specBaseSha256 is not a lowercase hex SHA-256" } };
  if (!SHA256.test(current)) return { ok: false, error: { code: "invalid-input", field: "specCurrentSha256", message: "specCurrentSha256 is not a lowercase hex SHA-256" } };
  if (!COMMIT.test(commit)) return { ok: false, error: { code: "invalid-input", field: "engine.gitCommit", message: "engine.gitCommit is not a 40-character lowercase hex commit" } };
  if (base !== current) {
    return { ok: false, error: { code: "spec-hash-mismatch", message: "the baseline hash differs from the current spec hash, but the project manifest requires them equal while no derivation is on" } };
  }
  const manifests: ManifestMap = {
    project: {
      schema: "monstera.studio.project", version: 1, projectId: input.projectId,
      spec: { path: "monstera.spec.json", baseSha256: base, currentSha256: current },
      engine: { gitCommit: commit },
      derivation: { levels: false, gameplay: false, activeLevel: "" },
      derived: { inputsSha256: "" },
      modules: ["animations", "assets", "gameplay", "integrations", "levels"],
    },
    assets: { schema: "monstera.studio.assets", version: 1, nextSeq: 1, assets: [] },
    animations: { schema: "monstera.studio.animations", version: 1, sheets: [], animations: [] },
    levels: { schema: "monstera.studio.levels", version: 1, levels: [] },
    gameplay: { schema: "monstera.studio.gameplay", version: 1, lives: { start: lives }, score: { winScore }, collectibles: [], enemies: [], planned: [] },
    integrations: {
      schema: "monstera.studio.integrations", version: 1,
      backend: { provider: "firebase", services: { analytics: false, auth: false, crashlytics: false, firestore: false, remoteConfig: false }, status: "scaffold", configFiles: [] },
      monetization: { provider: "admob", mode: "mock", placements: [] },
    },
    proposal: { schema: "monstera.studio.proposal", version: 1, target: "spec", summary: "No pending proposal.", ops: [] },
  };
  for (const name of MANIFEST_NAMES) {
    const r = validateManifest(name, manifests[name]);
    if (!r.ok) return { ok: false, error: { code: "invalid-manifest", manifest: name, message: `${name}: ${r.issues[0]?.path.join(".") ?? ""} ${r.issues[0]?.message ?? ""}`.trim() } };
  }
  return { ok: true, manifests };
}

/** buildDefaultManifests that throws DefaultManifestsFailure, for the migration's defaultManifests runtime. */
export function buildDefaultManifestsOrThrow(input: DefaultManifestsInput): ManifestMap {
  const r = buildDefaultManifests(input);
  if (!r.ok) throw new DefaultManifestsFailure(r.error);
  return r.manifests;
}

/**
 * runtime.lives and runtime.winScore read from an ENGINE canonical document text (EngineClient.validateDraft().canonicalText).
 * This only reads the engine's output; it validates nothing. Null when the text is not an object with game.runtime.
 */
export function specRuntimeFacts(canonicalText: string): SpecRuntimeFacts | null {
  try {
    const doc: unknown = JSON.parse(canonicalText);
    const rt = (doc as { game?: { runtime?: Record<string, unknown> } } | null)?.game?.runtime;
    if (typeof rt !== "object" || rt === null) return null;
    return { lives: rt["lives"] as number | undefined, winScore: rt["winScore"] as number | undefined };
  } catch {
    return null;
  }
}

/**
 * Schema-valid gameplay values used ONLY to initialize the Studio gameplay manifest of a project whose spec the engine
 * has not validated (an invalid import). They are never written into the spec, never persisted as they are: before the
 * project's first write the controller replaces them with the validated spec's runtime.lives and runtime.winScore.
 */
export const INITIALIZATION_RUNTIME = { lives: 1, winScore: 0 } as const;

export interface MigrationDefaultsDeps {
  /** EngineClient.engine (the bundled engine identity); undefined before the engine started. */
  engine: { gitCommit: string } | undefined;
  /** runtime.lives and runtime.winScore of the engine-validated spec text, or null when the engine rejects the text. */
  runtimeOf: (specText: string) => Promise<SpecRuntimeFacts | null> | SpecRuntimeFacts | null;
}

/**
 * The production wiring of MigrationRuntime.defaultManifests. Both project-manifest hashes are the current spec's hash
 * (no derivation has happened); ctx.baselineSha256 is deliberately unused here. Throws DefaultManifestsFailure.
 */
export function migrationDefaultManifests(deps: MigrationDefaultsDeps): (ctx: DefaultManifestsContext) => Promise<ManifestMap> {
  return async (ctx) => {
    // ctx.runtime comes from the same engine-validated result as ctx.specText (MigrationRuntime.canonicalize); runtimeOf is the fallback.
    const runtime = ctx.runtime ?? (await deps.runtimeOf(ctx.specText));
    return buildDefaultManifestsOrThrow({
      projectId: ctx.projectId, specBaseSha256: ctx.specSha256, specCurrentSha256: ctx.specSha256,
      engine: { gitCommit: deps.engine?.gitCommit }, runtime: runtime ?? { lives: null, winScore: null },
    });
  };
}

// ---------------------------------------------------------------- baseline

export interface TemplateCanonical { id: string; path: string; sha256: string | null; canonicalText: string | null }

export type DeriveBaselineResult = { ok: true; baseline: Baseline } | { ok: false; message: string };

/**
 * The initial baseline of a project that has no separate baseline: the validated spec itself, treated as an import
 * (Session's import semantics: group "import", no templateId; the origin is known only when the canonical SHA-256 equals a
 * template's, basis "identical", never from project.id). A spec the engine did not validate has no baseline.
 */
export function deriveBaseline(input: {
  label: string;
  validation: { ok: boolean; canonicalText: string | null; sha256: string | null };
  templates: readonly TemplateCanonical[];
}): DeriveBaselineResult {
  const { label, validation, templates } = input;
  if (!validation.ok || validation.canonicalText === null || validation.sha256 === null) return { ok: false, message: "the specification is not valid, so no baseline can be derived" };
  const t = templates.find((x) => x.sha256 === validation.sha256);
  const origin: Origin | null = t?.canonicalText ? { templateId: t.id, path: t.path, basis: "identical", canonicalText: t.canonicalText } : null;
  return { ok: true, baseline: { label, templateId: null, group: "import", canonicalText: validation.canonicalText, sha256: validation.sha256, origin } };
}