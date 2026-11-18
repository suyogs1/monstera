// Pure view-model helpers for the persistence UI (indicator, banners, recovery export, undo/redo shortcuts, beforeunload).
// They read ProjectViewState only; the controller stays the single source of truth for what is saved. Nothing here
// decides persistence, it only words what the controller reports.
import type { ProjectActions, ProjectViewState } from "../project/controller";
import type { EstimateResult, PersistenceResult, StoreAction } from "../project/store";

export type PersistenceView = Pick<ProjectViewState, "status" | "storeStatus" | "detail" | "hint" | "migration" | "legacy" | "gate" | "dirty" | "projectKey" | "manifests" | "name">;

// ------------------------------------------------------------------ indicator

export type IndicatorKind = "loading" | "saved" | "saving" | "unsaved" | "failed" | "memory-only" | "conflict" | "read-only" | "quarantined" | "closed";

export interface Indicator {
  kind: IndicatorKind;
  /** Short label, always starts with "Project:" so it cannot be mistaken for the spec verdict. */
  label: string;
  /** Why (unsaved) or when (saved); null when there is nothing to add. */
  reason: string | null;
}

const UNSAVED_REASON: Record<ProjectViewState["gate"], string> = {
  idle: "Unsaved: changes have not been written yet",
  scheduled: "Unsaved: changes have not been written yet",
  "waiting-for-validation": "Unsaved: waiting for the engine to check the specification",
  "waiting-for-valid-spec": "Unsaved: the specification has validation errors",
  "hash-mismatch": "Unsaved: the engine's hash did not match its canonical text",
};

const LABELS: Record<Exclude<IndicatorKind, "saved" | "unsaved">, string> = {
  loading: "Project: opening storage…",
  saving: "Project: saving…",
  failed: "Project: save failed (not saved)",
  "memory-only": "Project: memory only (not saved)",
  conflict: "Project: conflict (not saved)",
  "read-only": "Project: read-only (not saved)",
  quarantined: "Project: stored copy quarantined (not saved)",
  closed: "Project: storage closed (not saved)",
};

/** UTC wall time of a save, deterministic for tests. */
export const formatSavedAt = (ms: number): string => `${new Date(ms).toISOString().slice(11, 19)} UTC`;

export function indicatorOf(v: PersistenceView): Indicator {
  // "Saved" needs the controller's own status, no uncommitted edit and nothing the gate is holding back.
  if (v.status === "saved" && !v.dirty && v.gate === "idle") {
    return { kind: "saved", label: "Project: saved", reason: v.detail.lastSavedAt === null ? null : `Last saved ${formatSavedAt(v.detail.lastSavedAt)}` };
  }
  const s = v.status;
  if (s === "saved" || s === "unsaved" || (s === "saving" && v.dirty)) return { kind: "unsaved", label: "Project: unsaved", reason: UNSAVED_REASON[v.gate] };
  return { kind: s, label: LABELS[s], reason: null };
}

// ------------------------------------------------------------------ banners

export type BannerAction = "retrySave" | "retryOpen" | "exportRecovery" | "exportStored" | "exportLegacy" | "reloadFromStorage" | "startNewProject";

export interface Banner {
  id: string;
  title: string;
  /** role="alert" for failures that need attention now, "status" for hints. */
  role: "alert" | "status";
  message: string;
  actions: BannerAction[];
  /** Extra sentences (what a button does). */
  notes: string[];
}

const RELOAD_NOTE = "Reload stored version replaces the project in this tab with the stored one and discards changes that are only in memory. Studio asks first and never does it automatically.";
const NEW_PROJECT_NOTE = "Save as a new project keeps the preserved record exactly as it is and stores the open project under a new key.";

function fromStore(a: readonly StoreAction[]): BannerAction[] {
  const out: BannerAction[] = [];
  if (a.includes("retrySave")) out.push("retrySave");
  if (a.includes("retryOpen")) out.push("retryOpen");
  if (a.includes("exportRecovery")) out.push("exportRecovery");
  if (a.includes("reloadFromStorage")) out.push("reloadFromStorage");
  return out;
}

export function bannersOf(v: PersistenceView): Banner[] {
  const out: Banner[] = [];
  const d = v.detail;
  const mig = v.migration;
  const migBad = mig !== null && (mig.status === "failed" || mig.status === "refused" || mig.status === "unreadable");
  const legacyBad = v.legacy !== null && (v.legacy.status === "refused" || v.legacy.status === "unreadable");
  const legacyAction: BannerAction[] = legacyBad || (mig !== null && (mig.status === "refused" || mig.status === "unreadable")) ? ["exportLegacy"] : [];

  // The storage status itself. Only actions the store lists (and, for a new project, the two states that allow it).
  const base = fromStore(d.actions);
  switch (v.storeStatus) {
    case "failed":
      if (d.reason === "migration") break; // shown by the migration banner below
      out.push({
        id: d.reason === "quota" ? "quota" : "failed", role: "alert",
        title: d.reason === "quota" ? "Browser storage is full" : "Saving failed",
        message: d.message, actions: base, notes: [],
      });
      break;
    case "memory-only":
      out.push({ id: "memory-only", role: "alert", title: "Memory only: nothing is saved", message: d.message, actions: base, notes: ["Browser storage is not available, so this project exists only in this tab. Export recovery data to keep it."] });
      break;
    case "conflict":
      out.push({ id: "conflict", role: "alert", title: "Another tab or writer changed the stored project", message: d.message, actions: base, notes: base.includes("reloadFromStorage") ? [RELOAD_NOTE] : [] });
      break;
    case "closed":
      out.push({ id: "closed", role: "alert", title: "Storage connection closed", message: d.message, actions: base, notes: [] });
      break;
    case "read-only": {
      const newer = d.reason === "format-newer";
      out.push({ id: "read-only", role: "alert", title: "Read-only: the stored data is newer than this Studio", message: d.message, actions: [...base, ...(newer ? ["exportStored" as const, "startNewProject" as const] : [])], notes: newer ? [NEW_PROJECT_NOTE] : ["The database is newer than this Studio, so nothing can be written. Export your work."] });
      break;
    }
    case "quarantined":
      out.push({ id: "quarantined", role: "alert", title: "Stored project quarantined", message: d.message, actions: [...base, "exportStored", "startNewProject"], notes: [NEW_PROJECT_NOTE] });
      break;
    default:
  }
  // Migration of the earlier localStorage draft.
  if (migBad || legacyBad || d.reason === "migration") {
    const message = mig !== null && "message" in mig ? mig.message : v.legacy?.message ?? d.message;
    out.push({
      id: "migration", role: "alert", title: "The earlier draft was not migrated", message,
      actions: [...(d.reason === "migration" ? base : []), ...legacyAction].filter((x, i, a) => a.indexOf(x) === i),
      notes: ["The earlier draft is still in this browser and was not changed or deleted."],
    });
  }
  if (v.hint !== null) out.push({ id: "eviction", role: "status", title: "Saved projects may be missing", message: v.hint, actions: [], notes: [] });
  return out;
}

// ------------------------------------------------------------------ actions that need more than one call

export type ActionNotice = { kind: "info" | "error"; text: string };
export type ReloadStep = { done: true; notice: ActionNotice } | { done: false; confirm: string };
export type Download = (fileName: string, text: string) => void;

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project";

export function recoveryFileName(v: Pick<PersistenceView, "manifests" | "projectKey">, kind: "live" | "stored" | "legacy"): string {
  if (kind === "legacy") return "monstera-recovery-legacy.json";
  const id = v.manifests?.project.projectId || v.projectKey || "project";
  return `monstera-recovery-${slug(id)}${kind === "stored" ? "-stored" : ""}.json`;
}

export function exportRecoveryFile(api: Pick<ProjectActions, "exportRecovery"> & PersistenceView, kind: "live" | "stored" | "legacy", download: Download): ActionNotice {
  const text = api.exportRecovery(kind === "stored" ? { stored: true } : kind === "legacy" ? { legacy: true } : {});
  if (text === null) return { kind: "error", text: kind === "legacy" ? "There is no earlier draft text to export." : kind === "stored" ? "There is no preserved stored record to export." : "There is no project data to export." };
  const name = recoveryFileName(api, kind);
  download(name, text);
  return { kind: "info", text: `Downloaded ${name}.` };
}

/** Step 1 of a reload: never discards. Step 2 is reloadConfirmed, offered only when this returned { done: false }. */
export async function reloadStep(api: Pick<ProjectActions, "reloadFromStorage">): Promise<ReloadStep> {
  const r = await api.reloadFromStorage();
  if (r.ok) return { done: true, notice: { kind: "info", text: "Reloaded the stored version." } };
  if (r.reason === "unsaved-changes") {
    return { done: false, confirm: "This tab has changes that are not stored. Reloading the stored version discards them. Export recovery data first if you may need them." };
  }
  return { done: true, notice: { kind: "error", text: r.message } };
}

export async function reloadConfirmed(api: Pick<ProjectActions, "reloadFromStorage">): Promise<ActionNotice> {
  const r = await api.reloadFromStorage({ discardMemory: true });
  return r.ok ? { kind: "info", text: "Discarded the in-memory changes and reloaded the stored version." } : { kind: "error", text: r.message };
}

export async function retryOpenStep(api: Pick<ProjectActions, "retryOpen">): Promise<ActionNotice> {
  const r = await api.retryOpen();
  return r.ok ? { kind: "info", text: "Retried opening storage." } : { kind: "error", text: r.message };
}

export async function retrySaveStep(api: Pick<ProjectActions, "retrySave">): Promise<ActionNotice> {
  const s = await api.retrySave();
  return s === "saved" ? { kind: "info", text: "Saved." } : { kind: "error", text: `Not saved (storage status: ${s}).` };
}

export async function newProjectStep(api: Pick<ProjectActions, "startNewProject">): Promise<ActionNotice> {
  const r = await api.startNewProject();
  return r.ok ? { kind: "info", text: "Saved the open project as a new project. The preserved record was left untouched." } : { kind: "error", text: r.message };
}

// ------------------------------------------------------------------ undo / redo shortcuts

export type Shortcut = "undo" | "redo";

export interface KeyLike {
  key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean;
  isComposing?: boolean;
  target?: unknown;
}

export interface NavigatorLike { platform?: string; userAgentData?: { platform?: string } }

export function isMacPlatform(nav: NavigatorLike | undefined): boolean {
  const p = nav?.userAgentData?.platform || nav?.platform || "";
  return /mac|iphone|ipad|ipod/i.test(p);
}

/** Text fields keep their native undo; Studio's undo must never fire from them. */
export function isEditableTarget(t: unknown): boolean {
  if (typeof t !== "object" || t === null) return false;
  const e = t as { tagName?: unknown; isContentEditable?: unknown; closest?: (s: string) => unknown };
  const tag = typeof e.tagName === "string" ? e.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (e.isContentEditable === true) return true;
  return typeof e.closest === "function" && e.closest("[contenteditable]:not([contenteditable=\"false\"])") != null;
}

/** Windows/Linux: Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y. macOS: Cmd+Z, Cmd+Shift+Z. Null when the key is not an undo/redo shortcut. */
export function shortcutOf(e: KeyLike, mac: boolean): Shortcut | null {
  if (e.isComposing === true || e.altKey || isEditableTarget(e.target)) return null;
  const key = e.key.toLowerCase();
  if (mac) {
    if (!e.metaKey || e.ctrlKey) return null;
    return key === "z" ? (e.shiftKey ? "redo" : "undo") : null;
  }
  if (!e.ctrlKey || e.metaKey) return null;
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y" && !e.shiftKey) return "redo";
  return null;
}

export const shortcutHint = (which: Shortcut, mac: boolean): string => (mac ? (which === "undo" ? "⌘Z" : "⇧⌘Z") : which === "undo" ? "Ctrl+Z" : "Ctrl+Shift+Z");

/** Runs the shortcut when it is available. Returns true when it was handled (the caller then calls preventDefault). */
export function runShortcut(s: Shortcut | null, v: Pick<ProjectViewState, "canUndo" | "canRedo">, a: Pick<ProjectActions, "undo" | "redo">): boolean {
  if (s === "undo") return v.canUndo ? a.undo() : false;
  if (s === "redo") return v.canRedo ? a.redo() : false;
  return false;
}

// ------------------------------------------------------------------ beforeunload

/**
 * True when closing or reloading the page could lose work. Only a project that is saved (committed), clean and not held
 * back by the gate is safe. A project whose storage is read-only or quarantined is safe when nothing was edited.
 * The browser's own prompt is used; the pagehide flush is best-effort and is not a reason to skip the warning.
 */
export function shouldWarnBeforeUnload(v: Pick<ProjectViewState, "status" | "gate" | "dirty" | "projectKey">): boolean {
  if (v.projectKey === null && !v.dirty) return false; // nothing is open yet
  if (v.dirty) return true;
  if (v.gate === "waiting-for-valid-spec" || v.gate === "waiting-for-validation" || v.gate === "hash-mismatch") return true;
  switch (v.status) {
    case "saved": case "loading": case "read-only": case "quarantined": return false;
    default: return true; // saving, unsaved, failed, memory-only, conflict, closed
  }
}

// ------------------------------------------------------------------ storage protection and site storage estimate
// Storage protection (navigator.storage.persist) is a request the browser may decline. It is not saving: a project is saved
// only when the indicator above says so. Wording here never promises that site data cannot be cleared.

export const PROTECT_LABEL = "Protect browser storage";
export const PROTECT_RETRY_LABEL = "Request again";
export const PROTECT_EXPLANATION =
  "Asks the browser to treat Studio's data as persistent. The browser decides whether to grant it. Granting reduces the chance the browser clears Studio's data when storage runs low. It does not stop you or your browser settings from clearing site data, and it is not the same as the project being saved.";

const PROTECT_RESULT: Record<PersistenceResult, string> = {
  granted: "Granted: the browser will treat Studio's storage as persistent. This lowers the chance of automatic clearing under storage pressure. Site data can still be cleared by you or by browser settings.",
  "not-granted": "Not granted: the browser declined this request. The browser decides, and it may decide differently later. Studio's data stays in normal storage.",
  unavailable: "Unavailable: this browser does not offer a persistent-storage request. Nothing was requested.",
  rejected: "Request failed: the browser rejected or could not complete the request. Nothing changed.",
};

export interface ProtectionView {
  buttonLabel: string;
  /** null until the user has made a request. */
  result: { outcome: PersistenceResult; ok: boolean; text: string } | null;
}

/** `last` is the outcome of the user's most recent request, or null when none was made. Only a non-granted outcome relabels the button. */
export function protectionView(last: PersistenceResult | null): ProtectionView {
  if (last === null) return { buttonLabel: PROTECT_LABEL, result: null };
  return { buttonLabel: last === "granted" ? PROTECT_LABEL : PROTECT_RETRY_LABEL, result: { outcome: last, ok: last === "granted", text: PROTECT_RESULT[last] } };
}

/**
 * Bytes in decimal (SI) units: 1 KB = 1000 B, 1 MB = 1000 KB, 1 GB = 1000 MB (the browser reports estimates, so exact
 * binary multiples add nothing). Below 10 of a unit one decimal is shown, otherwise a whole number; rounding is half up.
 * A value that rounds to 1000 is shown in the next unit. Invalid input (negative, NaN, infinite) gives "unknown".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const whole = Math.round(bytes);
  if (whole < 1000) return `${whole} B`;
  let u = 1;
  let shown = roundUnit(bytes / 1000);
  while (shown >= 1000 && u < units.length - 1) { u++; shown = roundUnit(bytes / 1000 ** u); }
  return `${shown} ${units[u]}`;
}
function roundUnit(x: number): number {
  return x < 10 ? Math.round(x * 10) / 10 : Math.round(x);
}

export interface EstimateView { kind: "known" | "unknown"; text: string }

/** Sentence for the origin-wide estimate. It is never a project size. */
export function estimateView(e: EstimateResult | null): EstimateView {
  if (e === null) return { kind: "unknown", text: "Site storage: checking…" };
  if (e === "unknown" || !Number.isFinite(e.usage) || !Number.isFinite(e.quota) || e.usage < 0 || e.quota <= 0) return { kind: "unknown", text: "Site storage: estimate unavailable" };
  return { kind: "known", text: `Site storage: about ${formatBytes(e.usage)} of ${formatBytes(e.quota)} (browser estimate for this whole site, not just this project)` };
}