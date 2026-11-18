// Validation aggregator (task 1.4). It COORDINATES; it decides nothing itself except the cross-reference rules:
//   engine   the issues the engine returned for the canonical spec (passed in, never recomputed here)
//   manifest the existing per-manifest validator (validateManifest: envelope, schema, internal checks), run per manifest
//   xref     a manifest field names a kind, asset or level that the project does not define
// Spec-internal references (a spawner naming an unknown kind, ...) are the engine's rule and are not re-checked.
// Every issue carries the module that owns the field and the precise path inside the document, so a UI can navigate to it.
//
// Cross-reference policy (two separate questions, never confused):
//   1. Is the TARGET unknown? Only judged when its definition source is present and trustworthy: the spec's
//      game.runtime.kinds must be structurally readable; the assets / levels manifest must exist AND pass its own
//      validation. A missing or invalid source is never treated as an empty set, so it cannot produce "unknown" issues.
//   2. Is the REFERENCE SOURCE usable? Outgoing references are read only from manifests that passed their own validation.
//      A manifest that fails validation keeps its manifest issues and its outgoing cross-reference checks are SUPPRESSED
//      until it is valid (its fields have no reliable shape). That suppression is reported, not silent: see
//      AggregateResult.xrefSkipped. References from valid manifests are still checked against every trustworthy target.
//
// "Not found" and "could not check" are different outcomes. An unknown id is an issue. A check that could not run (the
// target's definition source is unavailable, or the reference source is invalid) is not an issue about the id, but it
// means the project has NOT been fully verified, so `ok` is false until it can run. A skipped check only counts when
// something actually needed it: an unavailable Levels manifest does not block `ok` while nothing refers to a level.
import type { ModuleId } from "../app/capabilities";
import { parseIssuePath, toIssuePath, type Path } from "../draft/path";
import type { DraftValidation } from "../engine/protocol";
import type { Json } from "../schema/schema";
import { MANIFEST_NAMES, validateManifest, type ManifestMap, type ManifestName } from "./manifests";
import { buildXrefIndex, XREF_REFERENCE_SOURCES, type XrefIndex, type XrefSourceManifest, type XrefTargetType } from "./xref";
export type IssueSource = "engine" | "manifest" | "xref";
export interface ProjectIssue {
  source: IssueSource;
  /** The module whose field is wrong. */
  module: ModuleId;
  /** "spec" or the manifest the path points into. */
  manifest: XrefSourceManifest;
  /** Precise path inside that document. Empty only for an engine issue whose path is not a plain field path. */
  path: Path;
  /** "$.a.b[0]" for the spec (the engine's own text, kept verbatim); "name:$.a.b[0]" for a manifest. */
  pathText: string;
  code: string;
  message: string;
}
const MODULE_OF_MANIFEST: Record<Exclude<ManifestName, "integrations">, ModuleId> = {
  project: "dashboard", assets: "assets", animations: "sprites", levels: "levels", gameplay: "gameplay", proposal: "kiro",
};
/** Module of a manifest field. Integrations spans two modules: backend.* is Backend and Services, monetization.* is Monetization. */
export function moduleOfManifestPath(name: ManifestName, path: Path): ModuleId {
  if (name !== "integrations") return MODULE_OF_MANIFEST[name];
  return path[0] === "backend" ? "backend" : "monetization";
}
const TARGET_TYPES: readonly XrefTargetType[] = ["kind", "asset", "level"];
const manifestPathText = (name: ManifestName, path: Path): string => `${name}:${toIssuePath(path)}`;
export interface AggregateInput {
  /** The engine's verdict for the CURRENT revision, or null when it has none yet. */
  engine: DraftValidation | null;
  doc: Json | null;
  manifests: Partial<ManifestMap> | null;
  /** A cached index for exactly (doc, manifests); built here when omitted. */
  index?: XrefIndex;
}
export interface AggregateResult {
  issues: ProjectIssue[];
  /** Per source, for status displays. */
  counts: Record<IssueSource, number>;
  /** The engine has no verdict for the current revision (issues of the other sources are still reported). */
  engineMissing: boolean;
  /**
   * What the cross-reference check could NOT do, so a UI can say so instead of showing a clean result:
   *   sources  manifests that can hold outgoing references (XREF_REFERENCE_SOURCES) but failed validation, so their references are not checked
   *   targets  target types whose definition source is absent or unreadable AND that some manifest reference needs
   *            (those references are not judged). A type nobody refers to is not listed: nothing was skipped.
   * `ok` is false while either list is non-empty.
   */
  xrefSkipped: { sources: ManifestName[]; targets: XrefTargetType[] };
  ok: boolean;
}

/** Order: engine issues as returned, manifest issues by manifest then validator order, cross-reference issues in index order. Deterministic. */
export function aggregateValidation(input: AggregateInput): AggregateResult {
  const issues: ProjectIssue[] = [];
  for (const i of input.engine?.issues ?? []) {
    issues.push({ source: "engine", module: "designer", manifest: "spec", path: parseIssuePath(i.path) ?? [], pathText: i.path, code: i.code, message: i.message });
  }
  const valid = new Set<ManifestName>();
  if (input.manifests !== null) {
    for (const name of MANIFEST_NAMES) {
      const value = input.manifests[name];
      if (value === undefined) continue;
      const r = validateManifest(name, value);
      if (r.ok) valid.add(name);
      else for (const i of r.issues) issues.push({ source: "manifest", module: moduleOfManifestPath(name, i.path), manifest: name, path: i.path, pathText: manifestPathText(name, i.path), code: i.code, message: i.message });
    }
  }
  const xrefSkipped: AggregateResult["xrefSkipped"] = { sources: [], targets: [] };
  if (input.manifests !== null) { // doc may be null: its kind list is then an unavailable definition source, reported below
    // Only manifests that passed their own validation take part: as reference sources (outgoing checks) and as
    // definition sources (assets, levels). The spec's kind list is judged by its own structural readability.
    const usable: Partial<ManifestMap> = {};
    for (const name of valid) (usable as Record<string, unknown>)[name] = input.manifests[name];
    const allValid = valid.size === MANIFEST_NAMES.length;
    const index = input.index !== undefined && allValid && input.index.isCurrent(input.doc, input.manifests) ? input.index : buildXrefIndex(input.doc, usable);
    // Only manifests that the index reads references from can have outgoing checks suppressed (XREF_REFERENCE_SOURCES);
    // an invalid integrations or proposal manifest keeps its manifest issues but is never listed here.
    xrefSkipped.sources = XREF_REFERENCE_SOURCES.filter((n) => input.manifests?.[n] !== undefined && !valid.has(n));
    // A skipped target counts only when a manifest reference (the spec's own are the engine's) actually needed it.
    xrefSkipped.targets = TARGET_TYPES.filter((t) => !index.canJudge(t) && index.entries.some((e) => e.manifest !== "spec" && e.targetType === t));
    for (const e of index.entries) {
      if (e.manifest === "spec" || !index.canJudge(e.targetType) || index.isDefined(e.targetType, e.targetId)) continue;
      issues.push({
        source: "xref", module: e.module, manifest: e.manifest, path: [...e.path], pathText: e.pathText,
        code: `xref.unknown-${e.targetType}`, message: `${e.label} refers to ${e.targetType} '${e.targetId}', which the project does not define`,
      });
    }
  }
  const counts: Record<IssueSource, number> = { engine: 0, manifest: 0, xref: 0 };
  for (const i of issues) counts[i.source]++;
  const engineMissing = input.engine === null;
  return { issues, counts, engineMissing, xrefSkipped, ok: !engineMissing && input.engine?.ok === true && issues.length === 0 && xrefSkipped.sources.length === 0 && xrefSkipped.targets.length === 0 };
}