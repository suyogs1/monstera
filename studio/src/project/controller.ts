// ProjectController: joins the in-memory draft (DraftStore), the project manifests, ONE shared undo history and the
// ProjectStore (the only persistence authority). Plain TypeScript, no React; project/context.tsx reads it.
//
// Canonical text convention. A snapshot handed to ProjectStore always carries the ENGINE's canonical text of the current
// revision (DraftStore.validation.canonicalText, validated for exactly state.revision) and its SHA-256, checked here to
// equal sha256(canonicalText). Nothing in Studio serializes a spec with JSON.stringify and calls it canonical.
//   * While the current revision has no engine canonical text (not validated yet, the engine failed, or the text has no
//     project.id) nothing is saved. The edit stays in memory and the view reports status "unsaved" with gate
//     "waiting-for-validation" / "waiting-for-valid-spec". "saved" is never reported for an edit that was not stored.
//   * With derivation off the project manifest's baseSha256 and currentSha256 both equal sha256(canonicalText) and its
//     projectId equals spec project.id (rule 11: identity = spec.project.id). That is kept in step silently on save; it is
//     not an undo entry. With derivation on the hashes belong to the (later) derivation task and are left alone.
//
// History. One History<{doc, manifests}> holds the state BEFORE each change, so spec and manifests undo together. Spec
// edits arrive through DraftStore.set/replace (coalesce key "spec:<path>"), manifest edits through commitManifest
// (key "manifest:<name>[.<field>]"). Undo/redo go through the normal store paths (draft.replace, then a save), so the
// engine re-validates and the restored state is persisted; the view says "unsaved" until that write committed. History
// is cleared by replaceProject (template load, import, reset, project switch, migration/adopt), startNewProject and reload.
//
// Saves. Each change bumps editSeq. A save is submitted after the engine validated the current revision, debounced
// (saveDelayMs, injected timer); load/import/new project are submitted at once. submittedSeq is the editSeq of the last
// snapshot handed to ProjectStore. The view is "unsaved" while editSeq > submittedSeq even if ProjectStore reports
// "saved" for an OLDER snapshot (a write that completes for an older revision never marks a newer one saved).
// ProjectStore keeps one write in flight and coalesces later snapshots into the next write. flush() on pagehide /
// visibilitychange is best-effort: it starts a write, it never reports "saved" by itself.
import type { DraftStore } from "../draft/store";
import type { Json } from "../schema/schema";
import { History } from "./history";
import { validateManifest, type ManifestMap, type ManifestName } from "./manifests";
import { recoveryFromSnapshot, sameValue, sha256Hex, specProjectId, stableText, type ProjectSnapshot, type Sha256 } from "./record";
import type {
  EstimateResult, LegacyState, PersistenceResult, ProjectStore, ProjectStoreStatus, ReloadResult, StartProjectResult, StoreDetail,
} from "./store";
import type { MigrationResult } from "./migrate";

export type Schedule = (fn: () => void, ms: number) => () => void;
export const timeoutSchedule: Schedule = (fn, ms) => {
  const h = setTimeout(fn, ms);
  return () => clearTimeout(h);
};
export const SAVE_DELAY_MS = 300;

/** The coherent history snapshot. Both members are immutable (structural sharing); never mutated after being pushed. */
export interface ProjectState { doc: Json; manifests: ManifestMap }

/** Why the current edit is not (yet) in ProjectStore. "idle": nothing is waiting. */
export type SaveGate = "idle" | "waiting-for-validation" | "waiting-for-valid-spec" | "hash-mismatch" | "scheduled";

export interface ProjectViewState {
  /** ProjectStore's status, except that "saved"/"saving" become "unsaved" while a newer edit has not been handed to it. */
  status: ProjectStoreStatus;
  /** ProjectStore's own status. */
  storeStatus: ProjectStoreStatus;
  detail: StoreDetail;
  hint: string | null;
  migration: MigrationResult | null;
  legacy: LegacyState | null;
  projectKey: string | null;
  name: string | null;
  manifests: ManifestMap | null;
  canUndo: boolean;
  canRedo: boolean;
  gate: SaveGate;
  /** An edit exists that ProjectStore has not been given yet or has not committed. */
  dirty: boolean;
}

export type CommitResult = { ok: true; changed: boolean } | { ok: false; message: string };
export type RetryOpenResult = { ok: true } | { ok: false; reason: "unsaved-invalid-edits"; message: string };
export type ReloadOutcome = ReloadResult | { ok: false; reason: "no-project"; message: string };

export interface ControllerDeps {
  draft: DraftStore;
  projects: ProjectStore;
  /** Replaces the live project with a stored one (engine-validates it, loads the draft, calls replaceProject). Session supplies it. */
  adopt: (project: ProjectSnapshot) => Promise<void>;
  schedule?: Schedule;
  saveDelayMs?: number;
  sha256?: Sha256;
  now?: () => number;
  /** Exact recovery text of a legacy draft that was refused or unreadable (Session reads it, read-only). */
  legacyRecovery?: () => string | null;
}

export interface ProjectActions {
  undo(): boolean;
  redo(): boolean;
  commitManifest<N extends ManifestName>(name: N, value: ManifestMap[N], field?: string): CommitResult;
  retryOpen(): Promise<RetryOpenResult>;
  retrySave(): Promise<ProjectStoreStatus>;
  reloadFromStorage(opts?: { discardMemory?: boolean }): Promise<ReloadOutcome>;
  exportRecovery(opts?: { stored?: boolean; legacy?: boolean }): string | null;
  startNewProject(opts?: { discardMemory?: boolean }): Promise<StartProjectResult>;
  requestPersistence(): Promise<PersistenceResult>;
  estimate(): Promise<EstimateResult>;
}

const GATE_MESSAGE: Record<SaveGate, string> = {
  idle: "Changes are not saved yet.",
  "waiting-for-validation": "Changes are kept in memory until the engine has checked them.",
  "waiting-for-valid-spec": "The specification could not be canonicalized by the engine, so these changes are kept in memory and are not saved.",
  "hash-mismatch": "The engine's hash does not match its canonical text, so these changes are kept in memory and are not saved.",
  scheduled: "Changes are not saved yet.",
};

export class ProjectController {
  private readonly history: History<ProjectState>;
  private readonly listeners = new Set<() => void>();
  private readonly schedule: Schedule;
  private readonly delay: number;
  private readonly sha256: Sha256;
  private manifests: ManifestMap | null = null;
  private projectKey: string | null = null;
  private name: string | null = null;
  private lastDoc: Json | null = null;
  private editSeq = 0;
  private submittedSeq = 0;
  private gate: SaveGate = "idle";
  private cancelTimer: (() => void) | undefined;
  private suspended = false;
  private restoring = false;
  private inFlight: Promise<unknown> = Promise.resolve();
  private view: ProjectViewState;

  readonly actions: ProjectActions;

  constructor(private readonly deps: ControllerDeps) {
    this.history = new History<ProjectState>(deps.now);
    this.schedule = deps.schedule ?? timeoutSchedule;
    this.delay = deps.saveDelayMs ?? SAVE_DELAY_MS;
    this.sha256 = deps.sha256 ?? sha256Hex;
    this.view = this.buildView();
    deps.draft.subscribe(() => this.onDraft());
    deps.projects.subscribe(() => this.refresh());
    this.actions = {
      undo: () => this.undo(), redo: () => this.redo(),
      commitManifest: (n, v, f) => this.commitManifest(n, v, f),
      retryOpen: () => this.retryOpen(), retrySave: () => this.retrySave(),
      reloadFromStorage: (o) => this.reloadFromStorage(o), exportRecovery: (o) => this.exportRecovery(o),
      startNewProject: (o) => this.startNewProject(o),
      requestPersistence: () => deps.projects.requestPersistence(), estimate: () => deps.projects.estimate(),
    };
  }

  getState = (): ProjectViewState => this.view;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  // ------------------------------------------------------------ view

  private get dirty(): boolean { return this.editSeq > this.submittedSeq; }

  private buildView(): ProjectViewState {
    const st = this.deps.projects.getState();
    const unstored = this.dirty && (st.status === "saved" || st.status === "saving");
    return {
      status: unstored ? "unsaved" : st.status,
      storeStatus: st.status,
      detail: unstored ? { ...st.detail, message: GATE_MESSAGE[this.gate], actions: [] } : st.detail,
      hint: st.hint, migration: st.migration, legacy: st.legacy,
      projectKey: this.projectKey, name: this.name, manifests: this.manifests,
      canUndo: this.history.canUndo, canRedo: this.history.canRedo, gate: this.gate, dirty: this.dirty,
    };
  }

  private refresh(): void {
    this.view = this.buildView();
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------ draft events

  private onDraft(): void {
    if (this.suspended) return;
    const { draft } = this.deps;
    const s = draft.getState();
    switch (draft.lastChange) {
      case "validation":
        this.maybeArm();
        return;
      case "edit":
        if (!this.restoring && this.lastDoc !== null && this.manifests !== null) {
          this.history.push({ doc: this.lastDoc, manifests: this.manifests }, draft.editKey === undefined ? undefined : `spec:${draft.editKey}`);
        }
        this.lastDoc = s.doc;
        this.markDirty();
        return;
      case "origin":
        this.markDirty();
        return;
      default: // a bare draft.load outside replaceProject: new content, so old history no longer applies
        this.history.clear();
        this.lastDoc = s.doc;
        this.markDirty();
    }
  }

  private markDirty(): void {
    this.editSeq++;
    this.maybeArm();
  }

  /** Decides what the pending edit is waiting for, and schedules the save when the engine's canonical text is there. */
  private maybeArm(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (!this.dirty || this.manifests === null || this.projectKey === null) this.gate = "idle";
    else {
      const s = this.deps.draft.getState();
      if (s.doc === null || s.validatedRevision !== s.revision) this.gate = "waiting-for-validation";
      else if (this.canonicalOf(s) === null) this.gate = "waiting-for-valid-spec";
      else {
        this.gate = "scheduled";
        this.cancelTimer = this.schedule(() => { this.cancelTimer = undefined; void this.submit(); }, this.delay);
      }
    }
    this.refresh();
  }

  /**
   * The text that may be persisted: the engine's canonical text of the CURRENT revision, and only when the engine
   * VALIDATED it (ok). A document that merely parses also gets canonical text from the engine (ok: false, parsed: true);
   * that is not a valid spec and is never handed to storage.
   */
  private canonicalOf(s: ReturnType<DraftStore["getState"]>): string | null {
    if (s.validatedRevision !== s.revision) return null;
    const v = s.validation;
    if (v === null || v.ok !== true) return null;
    const text = v.canonicalText;
    return text !== null && specProjectId(text) !== null ? text : null;
  }

  // ------------------------------------------------------------ saving

  /**
   * Builds the snapshot of the current revision from the engine's canonical text and hands it to ProjectStore.
   * Returns the store status afterwards. Nothing is handed over (and nothing claimed) when no canonical text exists.
   */
  private submit(): Promise<ProjectStoreStatus> {
    const run = this.doSubmit();
    this.inFlight = run;
    return run;
  }

  private async doSubmit(): Promise<ProjectStoreStatus> {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    const status = (): ProjectStoreStatus => this.deps.projects.getState().status;
    const seq = this.editSeq;
    const s = this.deps.draft.getState();
    const key = this.projectKey, m = this.manifests, baseline = s.baseline;
    const canonical = this.canonicalOf(s);
    if (key === null || m === null || baseline === null || s.doc === null) return status();
    if (canonical === null) { this.maybeArm(); return status(); }
    const id = specProjectId(canonical) as string;
    const sha = await this.sha256(canonical);
    if (this.editSeq !== seq) return status(); // a newer edit arrived while hashing; it has re-armed the gate
    if (s.validation?.sha256 != null && s.validation.sha256 !== sha) { // never trust one hash and store the other
      this.gate = "hash-mismatch";
      this.refresh();
      return status();
    }
    const p = m.project;
    const compiled = p.derivation.levels || p.derivation.gameplay;
    let manifests = m;
    if (p.projectId !== id || (!compiled && (p.spec.baseSha256 !== sha || p.spec.currentSha256 !== sha))) {
      manifests = { ...m, project: { ...p, projectId: id, spec: compiled ? p.spec : { ...p.spec, baseSha256: sha, currentSha256: sha } } };
      this.manifests = manifests; // identity/hash follow the spec; not a user edit, so no history entry
    }
    this.submittedSeq = seq;
    this.gate = "idle";
    this.refresh();
    return this.deps.projects.save({ projectKey: key, name: this.name ?? baseline.label, projectId: id, specText: canonical, baseline, manifests });
  }

  /** Best-effort: starts the write of a pending edit now (pagehide, visibilitychange, before reload/retry). */
  async flush(): Promise<void> {
    if (this.dirty) await this.submit();
  }

  /** Resolves when the latest submit() (hashing and the store write) settled, including submits made meanwhile. */
  async whenSettled(): Promise<void> {
    let p: Promise<unknown>;
    do { p = this.inFlight; await p; } while (p !== this.inFlight);
  }

  retrySave(): Promise<ProjectStoreStatus> {
    return this.deps.projects.retrySave();
  }

  /** Registers best-effort flush handlers. Returns the function that removes them. */
  attachLifecycle(win: Pick<Window, "addEventListener" | "removeEventListener">, doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">): () => void {
    const onHide = (): void => { void this.flush(); };
    const onVisibility = (): void => { if (doc.visibilityState === "hidden") onHide(); };
    win.addEventListener("pagehide", onHide);
    doc.addEventListener("visibilitychange", onVisibility);
    return () => { win.removeEventListener("pagehide", onHide); doc.removeEventListener("visibilitychange", onVisibility); };
  }

  // ------------------------------------------------------------ project identity

  /**
   * Makes `apply` (which loads the draft) the live project. The draft change made by `apply` is not an edit: history is
   * cleared. With persist the new content is submitted at once (new project, import, reset); without it the project is
   * clean (it came from storage). Returns the write's status when persisting.
   */
  async replaceProject(p: { projectKey: string; name: string; manifests: ManifestMap; persist: boolean }, apply: () => void): Promise<ProjectStoreStatus | null> {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.suspended = true;
    try { apply(); } finally { this.suspended = false; }
    this.projectKey = p.projectKey;
    this.name = p.name;
    this.manifests = p.manifests;
    this.lastDoc = this.deps.draft.getState().doc;
    this.history.clear();
    if (!p.persist) {
      this.submittedSeq = this.editSeq;
      this.gate = "idle";
      this.refresh();
      return null;
    }
    this.editSeq++;
    this.refresh(); // identity, history and dirtiness are visible at once; the write follows
    return this.submit();
  }

  // ------------------------------------------------------------ manifests and history

  /** The single manifest commit seam: validates, records the previous state in the shared history, saves. */
  commitManifest<N extends ManifestName>(name: N, value: ManifestMap[N], field?: string): CommitResult {
    const { draft } = this.deps;
    const doc = draft.getState().doc;
    if (this.manifests === null || doc === null) return { ok: false, message: "there is no open project" };
    const r = validateManifest(name, value);
    if (!r.ok) return { ok: false, message: `the ${name} manifest is invalid: ${r.issues[0]?.path.join(".") ?? ""} ${r.issues[0]?.message ?? ""}`.trim() };
    if (sameValue(this.manifests[name], value)) return { ok: true, changed: false };
    this.history.push({ doc, manifests: this.manifests }, `manifest:${name}${field ? `.${field}` : ""}`);
    this.manifests = { ...this.manifests, [name]: value };
    this.markDirty();
    return { ok: true, changed: true };
  }

  undo(): boolean { return this.travel("undo"); }
  redo(): boolean { return this.travel("redo"); }

  private travel(dir: "undo" | "redo"): boolean {
    const { draft } = this.deps;
    const doc = draft.getState().doc;
    if (this.manifests === null || doc === null) return false;
    const current: ProjectState = { doc, manifests: this.manifests };
    const target = dir === "undo" ? this.history.undo(current) : this.history.redo(current);
    if (target === undefined) return false;
    this.restoring = true;
    try {
      this.manifests = target.manifests;
      if (target.doc !== doc) draft.replace(target.doc); // onDraft: lastDoc, markDirty; no history push while restoring
    } finally { this.restoring = false; }
    if (target.doc === doc) this.markDirty(); // manifests only
    return true;
  }

  // ------------------------------------------------------------ storage actions

  /** Same project as the live one (key, canonical spec text, baseline, manifests)? Used to decide whether to adopt. */
  private matchesLive(p: ProjectSnapshot): boolean {
    const s = this.deps.draft.getState();
    return p.projectKey === this.projectKey && s.validatedRevision === s.revision && s.validation?.canonicalText === p.specText
      && this.manifests !== null && sameValue(p.manifests, this.manifests) && sameValue(p.baseline, s.baseline);
  }

  /**
   * Reopens storage. Never discards unsaved work: a pending edit is first handed to ProjectStore (which keeps it and
   * reconciles it with what is stored). An edit that cannot be handed over (no engine canonical text) refuses the retry.
   * With nothing unsaved, a stored project that differs from the live one (another tab saved) replaces it.
   */
  async retryOpen(): Promise<RetryOpenResult> {
    if (this.dirty) {
      await this.submit();
      if (this.dirty) return { ok: false, reason: "unsaved-invalid-edits", message: "Unsaved changes cannot be handed to storage yet (the engine has no canonical text for them). Export a recovery file or fix the specification first." };
    }
    await this.deps.projects.retryOpen();
    const st = this.deps.projects.getState();
    if (st.project !== null && !this.matchesLive(st.project) && st.status !== "conflict") {
      // Not dirty here, so nothing in memory is lost: ProjectStore holds either our last snapshot or the stored one.
      if (st.status === "saved") await this.deps.adopt(st.project);
    }
    if (this.deps.projects.getState().status === "unsaved" && this.deps.projects.getState().project !== null) await this.deps.projects.retrySave();
    this.refresh();
    return { ok: true };
  }

  /** Adopts the stored project. Refuses while unsaved changes exist unless discardMemory is passed (export first). */
  async reloadFromStorage(opts: { discardMemory?: boolean } = {}): Promise<ReloadOutcome> {
    if (this.dirty) {
      await this.submit();
      if (this.dirty && opts.discardMemory !== true) {
        return { ok: false, reason: "unsaved-changes", message: "There are unsaved changes that storage has not seen. Export a recovery file, then reload with discardMemory: true." };
      }
    }
    const r = await this.deps.projects.reloadFromStorage(opts);
    if (!r.ok) return r;
    const p = this.deps.projects.getState().project;
    if (p === null) return { ok: false, reason: "no-project", message: "Nothing is stored; the open project was kept." };
    await this.deps.adopt(p);
    return r;
  }

  exportRecovery(opts: { stored?: boolean; legacy?: boolean } = {}): string | null {
    if (opts.legacy) return this.deps.legacyRecovery?.() ?? null;
    const fromStore = this.deps.projects.exportRecovery(opts.stored ? { stored: true } : {});
    if (fromStore !== null || opts.stored) return fromStore;
    // Nothing is held by ProjectStore (e.g. the open project could not be handed over): export the live draft as it is.
    const s = this.deps.draft.getState();
    if (s.doc === null || this.manifests === null || this.projectKey === null || s.baseline === null) return null;
    const canonical = this.canonicalOf(s);
    return stableText(recoveryFromSnapshot({
      projectKey: this.projectKey, name: this.name ?? s.baseline.label, projectId: specProjectId(canonical ?? "") ?? this.manifests.project.projectId,
      specText: canonical ?? JSON.stringify(s.doc), baseline: s.baseline, manifests: this.manifests,
    }));
  }

  /** Recovery from quarantine / newer record: saves the live project as a NEW project under a fresh key and activates it. */
  async startNewProject(opts: { discardMemory?: boolean } = {}): Promise<StartProjectResult> {
    const s = this.deps.draft.getState();
    const canonical = this.canonicalOf(s);
    if (canonical === null || this.manifests === null || s.baseline === null) {
      return { ok: false, reason: "invalid-snapshot", message: "The open project has no engine canonical text yet, so it cannot be saved as a new project." };
    }
    const id = specProjectId(canonical) as string;
    const sha = await this.sha256(canonical);
    const p = this.manifests.project;
    const compiled = p.derivation.levels || p.derivation.gameplay;
    const manifests: ManifestMap = { ...this.manifests, project: { ...p, projectId: id, spec: compiled ? p.spec : { ...p.spec, baseSha256: sha, currentSha256: sha } } };
    const key = this.deps.projects.newProjectKey();
    const r = await this.deps.projects.startNewProject({ projectKey: key, name: this.name ?? s.baseline.label, projectId: id, specText: canonical, baseline: s.baseline, manifests }, opts);
    if (r.ok) {
      this.projectKey = key;
      this.manifests = manifests;
      this.history.clear();
      this.submittedSeq = this.editSeq;
      this.gate = "idle";
      this.refresh();
    }
    return r;
  }
}
