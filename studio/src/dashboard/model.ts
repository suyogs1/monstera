// View models of the Dashboard. Pure: every fact is read from state that already exists (the stored catalog, the draft's
// engine verdict, the determinism badge, the committed native evidence index). Nothing here computes a hash, validates a
// spec or restates a rule; it only chooses words.
import type { Verdict } from "../badge/badge";
import { matchNativeApps, type NativeIndex } from "../badge/nativeApps";
import type { CatalogEntry, Populated } from "../project/catalog";
import { MAX_PROJECT_NAME, populatedModules } from "../project/catalog";
import type { DraftState } from "../draft/store";
import type { ManifestMap } from "../project/manifests";

export type Tone = "ok" | "bad" | "pending";
export interface Line { text: string; tone: Tone }

/** The engine's verdict on the open draft. */
export function validationLine(d: Pick<DraftState, "validation" | "revision" | "validatedRevision">): Line {
  if (d.validation === null || d.validatedRevision !== d.revision) return { text: "Checking with the engine.", tone: "pending" };
  if (d.validation.ok) return { text: "Valid. The engine accepts this specification.", tone: "ok" };
  const n = d.validation.issues.length;
  return { text: n === 0 ? "Not valid." : `${n} ${n === 1 ? "issue" : "issues"} to fix.`, tone: "bad" };
}

/** The determinism badge of the open draft. The badge runs only on request, so "not run" is the normal first state. */
export function determinismLine(v: Verdict): Line {
  switch (v.kind) {
    case "not-run": return { text: "Not run for this draft. Run it in the Preview module.", tone: "pending" };
    case "running": return { text: `Running: ${v.done} of ${v.total} recorded runs checked.`, tone: "pending" };
    case "stale": return { text: "The last result is for an earlier version of this draft. Run it again.", tone: "pending" };
    case "no-goldens": return { text: "No recorded runs apply to this draft, so there is nothing to compare.", tone: "pending" };
    case "invalid": return { text: "No result: the engine refuses this draft.", tone: "bad" };
    case "error": return { text: "No result: the engine reported an error.", tone: "bad" };
    case "match": return { text: `MATCH: all ${v.run.scenarios.length} recorded runs reproduce.`, tone: "ok" };
    case "diverged": return { text: `DIVERGED: ${v.divergedScenarios} of ${v.run.scenarios.length} recorded runs differ.`, tone: "bad" };
  }
}

/** Native build evidence, bound to the exact specification SHA-256 and to nothing else. */
export function evidenceLine(index: NativeIndex, sha: string | null, projectId: string | null): Line {
  const { exact, otherSpec } = matchNativeApps(index, sha, projectId);
  if (exact) return { text: `${exact.label} for exactly this specification (committed evidence).`, tone: exact.label === "GENERATED" ? "pending" : "ok" };
  if (otherSpec) return { text: `None for this specification. Evidence exists for ${otherSpec.id}, but for a different specification.`, tone: "pending" };
  return { text: "None for this specification.", tone: "pending" };
}

export interface ProjectRow {
  projectKey: string;
  name: string;
  /** Null when the record cannot be read. */
  projectId: string | null;
  sha256: string | null;
  targets: string[];
  populated: Populated[];
  isOpen: boolean;
  /** The open project's own facts come from live state; stored ones from the saved text. */
  validation: Line;
  evidence: Line;
  /** Set for a record that cannot be read: the reason, and no actions except delete. */
  unreadable: string | null;
}

export interface LiveProject {
  projectKey: string;
  name: string;
  projectId: string | null;
  sha256: string | null;
  targets: string[];
  manifests: ManifestMap | null;
  validation: Line;
}

/**
 * One row per stored project plus the open project when it is not stored yet. The open project's row uses live facts, so
 * an edit shows at once; any other row says what the SAVED text is. Saved text is only ever written after the engine
 * validated it, which the wording says; it is checked again when the project is opened.
 */
export function projectRows(entries: readonly CatalogEntry[], live: LiveProject | null, index: NativeIndex): ProjectRow[] {
  const rows: ProjectRow[] = [];
  for (const e of entries) {
    if (e.state === "unreadable") {
      rows.push({
        projectKey: e.projectKey, name: e.name ?? e.projectKey, projectId: null, sha256: null, targets: [], populated: [], isOpen: false,
        validation: { text: "Unreadable.", tone: "bad" }, evidence: { text: "None.", tone: "pending" }, unreadable: e.message,
      });
      continue;
    }
    const isOpen = live !== null && live.projectKey === e.projectKey;
    if (isOpen && live) {
      rows.push(liveRow(live, index));
      continue;
    }
    rows.push({
      projectKey: e.projectKey, name: e.name, projectId: e.projectId, sha256: e.specSha256, targets: e.targets, populated: e.populated, isOpen: false,
      validation: { text: "Valid when saved. Checked again when opened.", tone: "ok" }, evidence: evidenceLine(index, e.specSha256, e.projectId), unreadable: null,
    });
  }
  if (live !== null && !rows.some((r) => r.projectKey === live.projectKey)) rows.unshift(liveRow(live, index));
  return rows;
}

function liveRow(live: LiveProject, index: NativeIndex): ProjectRow {
  return {
    projectKey: live.projectKey, name: live.name, projectId: live.projectId, sha256: live.sha256, targets: live.targets,
    populated: live.manifests ? populatedModules(live.manifests) : [], isOpen: true, validation: live.validation,
    evidence: evidenceLine(index, live.sha256, live.projectId), unreadable: null,
  };
}

/** What deleting costs, in words, for the confirmation. It names the project, what is stored with it, and that it cannot be undone. */
export function deleteWarning(row: Pick<ProjectRow, "name" | "projectId" | "populated" | "unreadable" | "isOpen">): string {
  const parts = [`Delete "${row.name}" from this browser?`];
  if (row.unreadable !== null) {
    parts.push("Its stored record cannot be read, so it is removed as it is.");
  } else {
    const lost = ["its specification", "its Studio data", ...row.populated.map((p) => p.detail)];
    parts.push(`This removes ${lost.join(", ")}, and every imported asset file stored with it.`);
  }
  if (row.isOpen) parts.push("It is the open project, so Studio opens another project (or a new one from a template) first.");
  parts.push("This cannot be undone. Nothing leaves this browser, so no other copy exists unless you exported one.");
  return parts.join(" ");
}

/** A default name for a copy that fits the name limit. */
export function copyName(name: string): string {
  const suffix = " copy";
  return `${name.length + suffix.length > MAX_PROJECT_NAME ? name.slice(0, MAX_PROJECT_NAME - suffix.length) : name}${suffix}`;
}

export const MODULE_LABEL: Record<Populated["module"], string> = {
  assets: "Assets", sprites: "Sprites", levels: "Levels", gameplay: "Gameplay", backend: "Backend", monetization: "Monetization",
};
