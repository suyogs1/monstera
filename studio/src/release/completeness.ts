// Completeness check (task 8.1, R13.2). Pure: every input is passed in, nothing is read from a store here.
//
// It lists what is wrong BEFORE export. Errors block export; warnings do not. It decides no game rule: engine and manifest
// problems come from the project validation aggregate (task 1.4) and are only classified here, by source and code.
// "Could not check" is an error too: a check that did not run is not a clean result.
import type { ModuleId } from "../app/capabilities";
import type { ExportPlan } from "../engine/protocol";
import type { ManifestMap } from "../project/manifests";
import type { AggregateResult, ProjectIssue } from "../project/validation";
import { sha256Bytes } from "../assets/import";

export type Severity = "error" | "warning";
/** One class per kind of problem R13.2 names, plus the classes that say a check could not run. */
export type CheckClass =
  | "engine" | "not-validated" | "manifest" | "asset-missing" | "reference-missing" | "animation-frame" | "unknown-ad"
  | "derived-stale" | "asset-bytes" | "unverified" | "plan-mismatch" | "goldens-omitted" | "asset-unused";
export const ERROR_CLASSES: readonly CheckClass[] = [
  "engine", "not-validated", "manifest", "asset-missing", "reference-missing", "animation-frame", "unknown-ad", "derived-stale",
  "asset-bytes", "unverified", "plan-mismatch",
];
export interface CheckItem { class: CheckClass; severity: Severity; message: string; module: ModuleId | null; pathText: string | null }
export type DerivationCheck = "none" | "fresh" | "stale";
export interface CompletenessInput {
  /** The engine has no verdict for the current revision yet. */
  pending: boolean;
  aggregate: AggregateResult;
  manifests: ManifestMap | null;
  /** The derived spec against its manifests, or null while it has not been computed. */
  derivation: DerivationCheck | null;
  /** Derivation switches (project manifest): staleness only matters while one is on. */
  derivationOn: boolean;
  /** Asset ids whose bytes are not stored. null while not checked. */
  missingBlobs: readonly string[] | null;
}
const item = (c: CheckClass, severity: Severity, message: string, module: ModuleId | null = null, pathText: string | null = null): CheckItem =>
  ({ class: c, severity, message, module, pathText });

const ANIMATION_CODES: readonly string[] = ["unknown-frame", "unknown-sheet", "empty-sequence"];
function classify(i: ProjectIssue): CheckClass {
  if (i.source === "engine") return "engine";
  if (i.source === "xref") return i.code === "xref.unknown-asset" ? "asset-missing" : "reference-missing";
  if (i.manifest === "animations" && ANIMATION_CODES.includes(i.code)) return "animation-frame";
  // A placement field of the ad manifest (type or trigger outside the known values) names an ad that does not exist.
  if (i.manifest === "integrations" && i.path[0] === "monetization" && i.path[1] === "placements" && (i.path[3] === "type" || i.path[3] === "trigger")) return "unknown-ad";
  return "manifest";
}

/** Everything that blocks export, then everything worth knowing. Deterministic: aggregate order, then the fixed checks. */
export function checkCompleteness(input: CompletenessInput): CheckItem[] {
  const out: CheckItem[] = [];
  if (input.pending || input.aggregate.engineMissing) {
    out.push(item("not-validated", "error", "The engine has not validated the current draft yet, so nothing can be confirmed."));
  }
  for (const i of input.aggregate.issues) out.push(item(classify(i), "error", i.message, i.module, i.pathText));
  const skipped = input.aggregate.xrefSkipped;
  for (const m of skipped.sources) out.push(item("unverified", "error", `References from the ${m} manifest were not checked because that manifest is invalid.`));
  for (const t of skipped.targets) out.push(item("unverified", "error", `References to ${t}s were not judged because the ${t} definitions are missing or invalid.`));
  if (input.derivationOn) {
    if (input.derivation === "stale") {
      out.push(item("derived-stale", "error", "The derived spec is out of date with its levels or gameplay manifests. Review and apply the derivation again.", "levels"));
    } else if (input.derivation === null) {
      out.push(item("unverified", "error", "Whether the derived spec is current has not been checked yet."));
    }
  }
  if (input.missingBlobs === null) {
    if ((input.manifests?.assets.assets.length ?? 0) > 0) out.push(item("unverified", "error", "The stored asset files have not been checked yet.", "assets"));
  } else {
    for (const id of input.missingBlobs) out.push(item("asset-bytes", "error", `Asset ${id} is listed but its file is not stored in this browser. Import it again or delete it.`, "assets", `assets:${id}`));
  }
  const m = input.manifests;
  if (m) {
    const sheetAssets = new Set(m.animations.sheets.map((s) => s.assetId));
    for (const a of m.assets.assets) {
      if (a.kind === "image" && a.kindRefs.length === 0 && !sheetAssets.has(a.id)) {
        out.push(item("asset-unused", "warning", `Asset ${a.id} is stored and exported but no entity or sprite sheet uses it.`, "assets", `assets:${a.id}`));
      }
    }
  }
  return out;
}

export const blocking = (items: readonly CheckItem[]): CheckItem[] => items.filter((i) => i.severity === "error");
export const canExport = (items: readonly CheckItem[]): boolean => blocking(items).length === 0;

// ------------------------------------------------------------------------------------------------ the generated tree

type ReadyPlan = Extract<ExportPlan, { ok: true }>;
function decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const MANIFEST = "MONSTERA-MANIFEST.json";
/**
 * Does the generated tree equal the engine plan for THIS draft? Checks, in order: the plan was made for the current spec hash;
 * every file's bytes hash to the hash the plan states; the generator manifest hashes to manifestSha256; the manifest lists
 * exactly the other files with the hashes the files have. Recorded goldens omitted by the engine is a warning, not an error.
 */
export async function verifyPlan(plan: ReadyPlan, currentSpecSha256: string | null, sha: (bytes: Uint8Array) => Promise<string> = sha256Bytes): Promise<CheckItem[]> {
  const out: CheckItem[] = [];
  const bad = (message: string) => out.push(item("plan-mismatch", "error", message));
  if (currentSpecSha256 === null || plan.specSha256 !== currentSpecSha256) bad("The generated files were made for a different draft than the current one. Generate again.");
  const actual = new Map<string, string>();
  for (const f of plan.files) {
    const h = await sha(decode(f.data));
    actual.set(f.path, h);
    if (h !== f.sha256) bad(`${f.path} does not match the hash the engine plan states for it.`);
  }
  const manifestFile = plan.files.find((f) => f.path === MANIFEST);
  if (!manifestFile) bad(`The plan has no ${MANIFEST}.`);
  else {
    if (actual.get(MANIFEST) !== plan.manifestSha256) bad(`${MANIFEST} does not match the manifest hash of the engine plan.`);
    let listed: Map<string, string> | null = null;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(decode(manifestFile.data))) as { files?: { path: string; sha256: string }[] };
      listed = new Map((parsed.files ?? []).map((e) => [e.path, e.sha256]));
    } catch { bad(`${MANIFEST} cannot be read.`); }
    if (listed) {
      for (const [p, h] of listed) {
        if (!actual.has(p)) bad(`${MANIFEST} lists ${p}, which is not in the generated files.`);
        else if (actual.get(p) !== h) bad(`${p} differs from the hash listed in ${MANIFEST}.`);
      }
      for (const p of actual.keys()) if (p !== MANIFEST && !listed.has(p)) bad(`${p} is generated but not listed in ${MANIFEST}.`);
    }
  }
  if (plan.scenariosOmitted) {
    out.push(item("goldens-omitted", "warning", `The ${plan.scenariosOmitted.count} recorded golden scenario(s) belong to another spec, so none are embedded in the native conformance tests.`));
  }
  return out;
}
