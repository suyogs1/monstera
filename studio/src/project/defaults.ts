// Default sidecar manifests and the initial baseline for a project Studio creates or migrates. Pure: no storage, no
// engine, no clock, no random. Everything Studio cannot know is an explicit input; a missing or malformed input returns a
// typed error. Nothing is invented, and nothing is taken from the manifest test fixtures (the Lantern Run samples).
//
// Runtime inputs Session must supply in Increment D (Session is NOT wired here):
//   backfillOrigin    Session's existing template-canonical lookup (same rule as startOnce: a draft stored without an
//                     origin takes the origin of its templateId with basis "template", else null).
//   defaultManifests  ctx => buildDefaultManifests({ projectId: ctx.projectId, specBaseSha256: ctx.baselineSha256,
//                     specCurrentSha256: ctx.specSha256 (hash of the canonical current spec text),
//                     engine: { gitCommit: engineClient.engine.gitCommit } }), unwrapped (throw DefaultManifestsError on
//                     failure: the migration then refuses the draft as 'inputs-unavailable' and keeps it untouched).
//   sha256            sha256Hex (Web Crypto).
//   legacy            window.localStorage, read through getItem only.
//   marker            window.localStorage (the eviction hint marker).
//   storage           navigator.storage.
//   factory           window.indexedDB (IDBFactory).
import type { Baseline, Origin } from "../draft/store";
import { MANIFEST_NAMES, validateManifest, type ManifestMap, type ManifestName } from "./manifests";

export interface DefaultManifestsInput {
  projectId: string;
  /** SHA-256 of the spec before any derivation (the baseline). Null when Studio does not know it. */
  specBaseSha256: string | null;
  /** SHA-256 of the canonical current spec text. */
  specCurrentSha256: string | null;
  /** The engine bundled in this Studio build (EngineClient.engine). */
  engine: { gitCommit: string | null | undefined };
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
 * defaults compile nothing into the spec. gameplay.lives.start is 3 only because the schema requires at least 1; it is inert
 * until gameplay derivation is turned on by the user. `modules` lists the five sidecar manifests that exist in the record.
 */
export function buildDefaultManifests(input: DefaultManifestsInput): DefaultManifestsResult {
  const missing: string[] = [];
  if (input.projectId === "") missing.push("projectId");
  if (input.specBaseSha256 === null || input.specBaseSha256 === "") missing.push("specBaseSha256");
  if (input.specCurrentSha256 === null || input.specCurrentSha256 === "") missing.push("specCurrentSha256");
  if (!input.engine.gitCommit) missing.push("engine.gitCommit");
  if (missing.length > 0) return { ok: false, error: { code: "missing-input", missing, message: `cannot build default manifests: missing ${missing.join(", ")}` } };
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
    gameplay: { schema: "monstera.studio.gameplay", version: 1, lives: { start: 3 }, score: { winScore: 0 }, collectibles: [], enemies: [], planned: [] },
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