import { applyActiveLevel, applyReviewedGameplay, reviewGameplay, type ApplyResult, type GameplayApplyResult, type GameplayReview } from "../derive/apply";
import { browserProbes } from "../assets/browserProbes";
import { exportBundle, importBundle } from "../export/bundle";
import { refuseSecrets } from "../integrations/secrets";
import type { ReplacementRisk } from "../project/controller";
import { BadgeRunner } from "../badge/badge";
import { DraftStore, type Baseline, type Origin } from "../draft/store";
import { PreviewController } from "../preview/controller";
import { Selection } from "../preview/select";
import { planProposal, type Proposal, type ProposalPlan, type ProposalRefusal } from "../kiro/proposal";
import { EngineClient } from "../engine/client";
import type { DraftValidation, TemplateInfo } from "../engine/protocol";
import { ProjectController, timeoutSchedule, type Schedule } from "../project/controller";
import { buildDefaultManifestsOrThrow, INITIALIZATION_RUNTIME, migrationDefaultManifests, specRuntimeFacts } from "../project/defaults";
import { LEGACY_KEY, type CanonicalSpec } from "../project/migrate";
import type { ManifestMap } from "../project/manifests";
import { sha256Hex, specProjectId, stableText, type ProjectSnapshot } from "../project/record";
import { isV4, migrateV4Doc, textIsV4 } from "../project/specV5";
import { ProjectStore, type ProjectStoreDeps, type StorageLike } from "../project/store";
import { SchemaModel, type Json } from "../schema/schema";
const VALIDATE_DELAY_MS = 150;

export type Boot = { phase: "starting" } | { phase: "ready" } | { phase: "failed"; message: string };

export interface SessionDeps {
  /** Default: a real EngineClient (Pyodide worker). Tests inject a fake. */
  engine?: EngineClient;
  /** The earlier localStorage draft, read through getItem only (migration). Absent: no migration. */
  legacy?: Pick<Storage, "getItem">;
  /** Eviction-hint marker storage. */
  marker?: Pick<Storage, "getItem" | "setItem">;
  /** IndexedDB factory; null models "unavailable". Omit the key for the default (globalThis.indexedDB). */
  factory?: IDBFactory | null;
  storage?: StorageLike | null;
  schedule?: Schedule;
  saveDelayMs?: number;
  projectDeps?: Pick<ProjectStoreDeps, "openConnection" | "sha256" | "now" | "randomId">;
}

/** Wires the worker, the schema reader, the draft and the project persistence together. No rules live here: it forwards text to the engine. */
/** The user's explicit choice to replace the open project even when that loses unsaved data. Never a default. */
export interface ReplaceOptions { discardUnsaved?: boolean }
/** A replacement that was refused because it could lose data; the UI may show `message`, ask, and retry with discardUnsaved. */
export type ReplaceRefusal = { ok: false; code: "would-lose-data"; message: string; risks: readonly ReplacementRisk[] };
/** `migratedFrom: 4`: the opened content was a spec v4 document, upgraded to v5 with neutral sprite fields (see specV5.ts). */
export type ReplaceOutcome = { ok: true; migratedFrom?: 4 } | ReplaceRefusal | { ok: false; code?: undefined; message: string };
/** The engine's verdict for the v5 form of a v4 text: none (not v4), migrated (the engine accepts it) or refused (it does not). */
type V4Upgrade = { kind: "none" } | { kind: "migrated"; v: DraftValidation & { canonicalText: string; sha256: string } } | { kind: "refused"; message: string };
export const MIGRATION_NOTICE = "This project was written for specification v4 and was upgraded to v5. Your project, its data and its assets were kept; neutral sprite fields were added and no sprites were assigned. You can keep editing as before.";
export class Session {
  readonly engine: EngineClient;
  /** The in-memory draft. Persistence is not its job; see `projects`. */
  readonly store: DraftStore;
  /** The single persistence authority (IndexedDB, with legacy migration). */
  readonly projects: ProjectStore;
  /** Draft + manifests + history + save scheduling. project/context.tsx exposes it. */
  readonly project: ProjectController;
  /** Determinism badge: runs only when asked (never per keystroke). */
  readonly badge: BadgeRunner;
  /** Live preview: the engine's GameLoop in the worker, one request in flight at a time. */
  readonly preview: PreviewController;
  /** Selected kind (click-through between the preview and the Entities editor). Display only, never in the spec. */
  readonly selection = new Selection();
  schema: SchemaModel | undefined;
  boot: Boot = { phase: "starting" };
  private readonly schedule: Schedule;
  private cancelValidation: (() => void) | undefined;
  private readonly legacy: Pick<Storage, "getItem"> | undefined;

  constructor(deps: SessionDeps = {}) {
    this.engine = deps.engine ?? new EngineClient();
    this.schedule = deps.schedule ?? timeoutSchedule;
    this.legacy = deps.legacy;
    this.store = new DraftStore();
    const legacyDeps = deps.legacy ? {
      migration: {
        legacy: deps.legacy,
        canonicalize: (docText: string) => this.canonicalize(docText),
        // The runtime facts come with the canonicalize result (same validated document); runtimeOf is never the source.
        defaultManifests: (ctx: Parameters<ReturnType<typeof migrationDefaultManifests>>[0]) =>
          migrationDefaultManifests({ engine: this.engine.engine, runtimeOf: () => null })(ctx),
        backfillOrigin: (b: Baseline) => this.originOfTemplateBaseline(b),
      },
    } : {};
    this.projects = new ProjectStore({
      ...("factory" in deps ? { factory: deps.factory } : {}),
      marker: deps.marker ?? null, storage: deps.storage ?? null, ...legacyDeps, ...deps.projectDeps,
    });
    this.project = new ProjectController({
      draft: this.store, projects: this.projects, schedule: this.schedule, saveDelayMs: deps.saveDelayMs,
      adopt: async (p) => { await this.adopt(p); },
      legacyRecovery: () => this.legacyRecovery(),
      kindIdPattern: () => this.schema?.field("game.runtime.kinds[].id")?.regex,
      assetProbes: browserProbes(),
    });
    this.badge = new BadgeRunner(this.engine, this.store);
    this.preview = new PreviewController(this.engine);
    this.engine.onReply = (fn, bytes, ms) => { if (fn === "preview_frame") this.preview.noteReply(bytes, ms); };
    this.store.subscribe(() => this.scheduleValidation());
  }

  get templates(): TemplateInfo[] { return this.engine.templates; }

  private starting: Promise<void> | undefined;

  /** Idempotent: React StrictMode runs effects twice in development. */
  start(): Promise<void> {
    this.starting ??= this.startOnce();
    return this.starting;
  }

  /**
   * Boot: engine first (a failure here rejects: the "engine could not start" path), then storage (a failure here never
   * rejects: ProjectStore reports it through its state and the app opens anyway).
   *   1. engine init and schemas
   *   2. ProjectStore.open(): open IndexedDB, migrate the legacy draft (engine-canonicalized), load the active project
   *   3. a project in the store state (stored, migrated, or recovered into memory) is adopted as the live project, clean
   *   4. otherwise the first official template becomes a NEW project (saved in the background, not awaited)
   */
  private async startOnce(): Promise<void> {
    await this.engine.init();
    this.schema = new SchemaModel(await this.engine.schemas());
    try { await this.projects.open(); } catch { /* the store's own state carries the failure */ }
    const project = this.projects.getState().project;
    if (project === null || !(await this.adopt(project))) {
      const first = this.engine.templates.find((t) => t.group === "official") ?? this.engine.templates[0];
      if (!first) throw new Error("the engine bundle lists no templates");
      await this.loadTemplate(first.id);
    }
    this.boot = { phase: "ready" };
  }

  /** Makes a stored (or recovered) project live. Clean: nothing to save. False when the engine cannot read its text. */
  private async adopt(stored: ProjectSnapshot): Promise<boolean> {
    // A spec v4 project (or one whose baseline still holds v4 text, after a legacy migration) is upgraded first. The upgraded
    // project is saved as ONE atomic record under its own key; until that write commits the stored v4 record is untouched,
    // and a refused upgrade leaves it exactly as it was (it opens as before).
    let migrated = false;
    let project = stored;
    try {
      const up = await this.migrateSnapshot(stored);
      if (up) { project = up; migrated = true; }
    } catch { /* the engine could not answer: open the stored project unchanged */ }
    let v: DraftValidation;
    try { v = await this.engine.validateDraft(project.specText); } catch { return false; }
    if (!v.parsed) return false;
    const doc = JSON.parse(project.specText) as Json;
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return false;
    await this.project.replaceProject({ projectKey: project.projectKey, name: project.name, manifests: project.manifests, doc, persist: migrated }, () => this.store.load(doc, project.baseline, v));
    if (migrated) this.announceMigration();
    return true;
  }

  /** The v5 engine's verdict on the v5 form of a v4 text (specV5.ts). Never guesses another version. */
  private async upgradeV4(text: string): Promise<V4Upgrade> {
    let doc: Json;
    try { doc = JSON.parse(text) as Json; } catch { return { kind: "none" }; }
    if (!isV4(doc)) return { kind: "none" };
    const m = migrateV4Doc(doc);
    if (!m.ok) return { kind: "refused", message: "it declares specification v4 but already has v5 fields or no entity kinds, so it is not migrated" };
    const v = await this.engine.validateDraft(stableText(m.doc));
    if (v.ok !== true || v.canonicalText === null || v.sha256 === null) {
      const first = v.issues[0];
      return { kind: "refused", message: `its v5 form is not valid (${first ? `${first.path} ${first.message}` : "the engine refused it"}), so it is not migrated` };
    }
    return { kind: "migrated", v: { ...v, canonicalText: v.canonicalText, sha256: v.sha256 } };
  }

  /** Points the project manifest's spec hashes that named the old text at the new one; every other value is kept. */
  private static rebindSpecHashes(m: ManifestMap, oldSha: string | null, newSha: string): ManifestMap {
    if (oldSha === null || oldSha === newSha) return m;
    const s = m.project.spec;
    const spec = { ...s, baseSha256: s.baseSha256 === oldSha ? newSha : s.baseSha256, currentSha256: s.currentSha256 === oldSha ? newSha : s.currentSha256 };
    return spec.baseSha256 === s.baseSha256 && spec.currentSha256 === s.currentSha256 ? m : { ...m, project: { ...m.project, spec } };
  }

  /** The baseline and origin of a migrated project: v4 texts become their v5 forms; null when nothing references v4. */
  private async upgradeBaseline(b: Baseline): Promise<Baseline | null> {
    let next = b;
    if (textIsV4(b.canonicalText)) {
      const up = await this.upgradeV4(b.canonicalText as string);
      if (up.kind === "migrated") next = { ...next, canonicalText: up.v.canonicalText, sha256: up.v.sha256 };
    }
    const o = b.origin;
    if (o && textIsV4(o.canonicalText)) {
      const t = (await this.templateCanonicals()).find((x) => x.info.id === o.templateId);
      if (t?.canonicalText) {
        // "identical" stays only while the baseline really equals the template; a v4 copy of it no longer does.
        const basis = o.basis === "identical" && next.sha256 !== t.sha256 ? "template" : o.basis;
        next = { ...next, origin: { ...o, path: t.info.path, canonicalText: t.canonicalText, basis } };
      }
    }
    return next === b ? null : next;
  }

  /** The upgraded form of a stored project, or null when it needs none or cannot be upgraded (it is then opened unchanged). */
  private async migrateSnapshot(p: ProjectSnapshot): Promise<ProjectSnapshot | null> {
    const spec = await this.upgradeV4(p.specText);
    if (spec.kind === "refused") return null;
    const baseline = await this.upgradeBaseline(p.baseline);
    if (spec.kind === "none" && baseline === null) return null;
    const specText = spec.kind === "migrated" ? spec.v.canonicalText : p.specText;
    const manifests = spec.kind === "migrated" ? Session.rebindSpecHashes(p.manifests, await sha256Hex(p.specText), spec.v.sha256) : p.manifests;
    return { ...p, specText, baseline: baseline ?? p.baseline, manifests };
  }

  private readonly migrationListeners = new Set<() => void>();
  /** Set when content written for spec v4 was upgraded in this session (shown once by the top bar until dismissed). */
  migrationNotice: string | null = null;
  onMigrationNotice = (l: () => void): (() => void) => { this.migrationListeners.add(l); return () => this.migrationListeners.delete(l); };
  dismissMigrationNotice(): void { this.migrationNotice = null; for (const l of this.migrationListeners) l(); }
  private announceMigration(): void { this.migrationNotice = MIGRATION_NOTICE; for (const l of this.migrationListeners) l(); }

  /** The engine's canonical text, its SHA-256 and the runtime facts of that same document; null when it cannot supply them. */
  private async canonicalize(docText: string): Promise<CanonicalSpec | null> {
    let v: DraftValidation;
    try { v = await this.engine.validateDraft(docText); } catch { return null; }
    if (v.ok !== true && textIsV4(docText)) { // a v4 legacy draft: its v5 form, only when the engine accepts it
      let up: V4Upgrade;
      try { up = await this.upgradeV4(docText); } catch { return null; }
      if (up.kind === "migrated") v = up.v;
    }
    // A document that parses gets canonical text even when it is invalid (ok: false); only a VALID spec may be migrated.
    if (v.ok !== true || !v.parsed || v.canonicalText === null || v.sha256 === null) return null;
    return { canonicalText: v.canonicalText, sha256: v.sha256, runtime: specRuntimeFacts(v.canonicalText) };
  }

  /**
   * Default manifests of a NEW project from the engine's canonical text. Throws when an input is unknown (never invents one).
   * A VALIDATED spec supplies its own runtime.lives / runtime.winScore. An invalid one (ok: false) cannot be trusted for
   * them, so the gameplay manifest is initialized with INITIALIZATION_RUNTIME and marked provisional: the document itself
   * is untouched, and the controller aligns the gameplay manifest with the validated spec before the first write.
   */
  private async defaultsFor(v: DraftValidation): Promise<{ projectId: string; manifests: ManifestMap; provisionalGameplay: boolean }> {
    const canonical = v.canonicalText;
    if (!v.parsed || canonical === null) throw new Error("the engine produced no canonical text for this specification");
    const projectId = specProjectId(canonical);
    if (projectId === null) throw new Error("the specification has no project.id");
    const sha = await sha256Hex(canonical);
    if (v.sha256 !== sha) throw new Error("the engine SHA-256 differs from the SHA-256 of its canonical text");
    const provisionalGameplay = v.ok !== true;
    const manifests = buildDefaultManifestsOrThrow({
      projectId, specBaseSha256: sha, specCurrentSha256: sha, engine: { gitCommit: this.engine.engine?.gitCommit },
      runtime: provisionalGameplay ? INITIALIZATION_RUNTIME : specRuntimeFacts(canonical) ?? { lives: null, winScore: null },
    });
    return { projectId, manifests, provisionalGameplay };
  }

  /** Content of a freshly loaded document becomes a new project (new key; every earlier project record is kept). */
  private async startProjectFrom(doc: Json, baseline: Baseline, v: DraftValidation, name: string, opts: ReplaceOptions): Promise<ReplaceRefusal | null> {
    const { manifests, provisionalGameplay } = await this.defaultsFor(v);
    const refusal = refuseSecrets({ doc, manifests }); // before the save is started: its failures are reported by the store, this one is a refusal
    if (refusal) throw new Error(refusal);
    const lost = await this.replacementRefusal(opts); // the last await before the replacement, so nothing can change in between
    if (lost) return lost;
    const projectKey = this.projects.newProjectKey();
    const saving = this.project.replaceProject({ projectKey, name, manifests, doc, persist: true, provisionalGameplay }, () => this.store.load(doc, baseline, v));
    saving.catch(() => undefined); // the store reports save failures through its state
    return null;
  }

  /** The shared preflight (ProjectController.checkReplacement) as a refusal the UI can confirm, or null when replacing loses nothing or the caller chose to discard. */
  private async replacementRefusal(opts: ReplaceOptions): Promise<ReplaceRefusal | null> {
    await this.validateNow(); // an edit still inside its validation delay is judged on its real state, not refused for being unchecked
    const check = await this.project.checkReplacement();
    if (check.ok || opts.discardUnsaved === true) return null;
    return { ok: false, code: "would-lose-data", message: `${check.message} Nothing was replaced.`, risks: check.risks };
  }

  private async templateContent(id: string) {
    const info = this.engine.templates.find((t) => t.id === id);
    if (!info) throw new Error(`unknown template ${id}`);
    const t = await this.engine.template(info.path);
    const baseline: Baseline = { label: info.id, templateId: info.id, group: info.group, canonicalText: t.canonicalText, sha256: t.sha256,
      origin: t.canonicalText ? { templateId: info.id, path: info.path, basis: "template", canonicalText: t.canonicalText } : null };
    return { doc: JSON.parse(t.fileText) as Json, baseline, t, name: info.id };
  }

  /** A template becomes a new project (history cleared, saved in the background). */
  /** Compiles the active level into the spec (engine-validated, oracle-checked) and commits it as one undo step, or refuses. */
  applyActiveLevel(): Promise<ApplyResult> { return applyActiveLevel(this.project, this.engine); }
  /** Gameplay step 1: compiles and engine-checks the gameplay manifest against the current spec; writes nothing. */
  reviewGameplay(): Promise<GameplayReview> { return reviewGameplay(this.project, this.engine); }
  /** Gameplay step 2: commits a reviewed plan as one undo step, only if the project is unchanged since the review. */
  applyReviewedGameplay(review: Extract<GameplayReview, { ok: true }>): GameplayApplyResult { return applyReviewedGameplay(this.project, review); }
  /** Proposal inbox, step 1: checks a proposal against the current project. Nothing is written. */
  async reviewProposal(proposal: Proposal): Promise<{ ok: true; expected: { doc: Json; manifests: ManifestMap }; plan: ProposalPlan } | ProposalRefusal> {
    const state = this.project.currentState();
    if (state === null) return { ok: false, stage: "precondition", message: "there is no open project" };
    const plan = await planProposal(state, proposal, this.engine);
    return plan.ok ? { ok: true, expected: state, plan } : plan;
  }
  /** Proposal inbox, step 2: commits the reviewed plan as one undo step, only if the project is still what was reviewed. */
  applyReviewedProposal(review: { expected: { doc: Json; manifests: ManifestMap }; plan: ProposalPlan }): { ok: true } | ProposalRefusal {
    const done = this.project.commitDerived(review.expected, review.plan.doc, review.plan.manifests);
    return done.ok ? { ok: true } : { ok: false, stage: "precondition", message: done.message };
  }
  /** A template becomes a new project, unless that would lose data (see ReplaceRefusal); `discardUnsaved` is the user's explicit choice. */
  async loadTemplate(id: string, opts: ReplaceOptions = {}): Promise<ReplaceOutcome> {
    const { doc, baseline, t, name } = await this.templateContent(id);
    return (await this.startProjectFrom(doc, baseline, t, name, opts)) ?? { ok: true };
  }

  /**
   * Deletes a stored project. The open project is replaced first (another stored project, else a new one from the first
   * official template), so a failure leaves the old project untouched, and only then removed with its asset bytes.
   */
  async deleteProject(key: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (key !== this.project.getState().projectKey) return this.project.actions.deleteProject(key);
    const listed = await this.projects.listProjects();
    if (!listed.ok) return { ok: false, reason: listed.message };
    const other = listed.entries.find((e) => e.state === "ok" && e.projectKey !== key);
    if (other) {
      const opened = await this.project.actions.openProject(other.projectKey, { discardMemory: true });
      if (!opened.ok) return opened;
    } else {
      const first = this.engine.templates.find((t) => t.group === "official") ?? this.engine.templates[0];
      if (!first) return { ok: false, reason: "The engine lists no template to start a replacement project from." };
      await this.loadTemplate(first.id, { discardUnsaved: true }); // the open project is the one being deleted
      await this.project.whenSettled();
    }
    if (this.project.getState().projectKey === key) return { ok: false, reason: "The project could not be replaced, so it was not deleted." };
    return this.project.actions.deleteProject(key);
  }
  private templateCanon: Promise<{ info: TemplateInfo; sha256: string | null; canonicalText: string | null }[]> | undefined;

  /** Engine canonical text and SHA-256 of every bundled template (read once). */
  templateCanonicals() {
    this.templateCanon ??= Promise.all(this.engine.templates.map(async (info) => {
      const t = await this.engine.template(info.path);
      return { info, sha256: t.sha256, canonicalText: t.canonicalText };
    }));
    return this.templateCanon;
  }

  /** A draft stored without an origin takes the origin of its template (same rule the old startup used); else null. */
  private async originOfTemplateBaseline(b: Baseline): Promise<Origin | null> {
    const t = (await this.templateCanonicals()).find((x) => x.info.id === b.templateId);
    return t?.canonicalText ? { templateId: t.info.id, path: t.info.path, basis: "template", canonicalText: t.canonicalText } : null;
  }

  /** The user states which template an imported draft comes from (or none). Labelled "declared" everywhere. */
  async declareOrigin(templateId: string | null): Promise<void> {
    if (templateId === null) { this.store.setOrigin(null); return; }
    const t = (await this.templateCanonicals()).find((x) => x.info.id === templateId);
    if (!t?.canonicalText) throw new Error(`unknown template ${templateId}`);
    this.store.setOrigin({ templateId, path: t.info.path, basis: "declared", canonicalText: t.canonicalText });
  }

  /** An import's origin is known only when it is exactly a template (same canonical SHA-256); never from project.id. */
  private async originOfImport(sha256: string | null): Promise<Baseline["origin"]> {
    if (!sha256) return null;
    const t = (await this.templateCanonicals()).find((x) => x.sha256 === sha256);
    return t?.canonicalText ? { templateId: t.info.id, path: t.info.path, basis: "identical", canonicalText: t.canonicalText } : null;
  }

  /** Back to the starting point of the current draft (template or imported file). Same project: its key and manifests stay. */
  async reset(): Promise<void> {
    const b = this.store.getState().baseline;
    const view = this.project.getState();
    if (!b || view.projectKey === null || view.manifests === null) return;
    let content: { doc: Json; baseline: Baseline; v: DraftValidation } | undefined;
    if (b.templateId) {
      const { doc, baseline, t } = await this.templateContent(b.templateId);
      content = { doc, baseline, v: t };
    } else if (b.canonicalText) {
      content = { doc: JSON.parse(b.canonicalText) as Json, baseline: b, v: await this.engine.validateDraft(b.canonicalText) };
    }
    if (!content) return;
    const { doc, baseline, v } = content;
    const saving = this.project.replaceProject({ projectKey: view.projectKey, name: view.name ?? baseline.label, manifests: view.manifests, doc, persist: true }, () => this.store.load(doc, baseline, v));
    saving.catch(() => undefined);
  }

  /** The engine decides whether a file is loadable (strict JSON: duplicate keys and BOMs are refused). */
  async importText(text: string, fileName: string, opts: ReplaceOptions = {}): Promise<ReplaceOutcome> {
    let v = await this.engine.validateDraft(text);
    if (!v.parsed || v.canonicalText === null) {
      return { ok: false, message: v.issues[0]?.message ?? "the file could not be read as JSON" };
    }
    const up = await this.upgradeV4(text);
    if (up.kind === "refused") return { ok: false, message: `this is a specification v4 file, but ${up.message}. Your draft was not changed.` };
    if (up.kind === "migrated") v = up.v;
    const canonicalText: string = v.canonicalText ?? text; // non-null: checked above, and a migrated verdict always has it
    const top = JSON.parse(canonicalText) as Json;
    if (top === null || typeof top !== "object" || Array.isArray(top)) {
      const kind = top === null ? "null" : Array.isArray(top) ? "an array" : typeof top;
      return { ok: false, message: `a specification is a JSON object, but this file contains ${kind}. Your draft was not changed.` };
    }
    const baseline: Baseline = { label: fileName, templateId: null, group: "import", canonicalText: v.canonicalText, sha256: v.sha256,
      origin: v.ok ? await this.originOfImport(v.sha256) : null };
    try {
      const refusal = await this.startProjectFrom(top, baseline, v, fileName, opts);
      if (refusal) return refusal;
    } catch (e) {
      return { ok: false, message: `${e instanceof Error ? e.message : "the project could not be created"}. Your draft was not changed.` };
    }
    if (up.kind === "migrated") { this.announceMigration(); return { ok: true, migratedFrom: 4 }; }
    return { ok: true };
  }

  /** The open project as a bundle ZIP (spec, manifests, asset bytes), or a reason it cannot be exported yet. Writes nothing. */
  async exportBundleBytes(): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; message: string }> {
    await this.project.flush();
    await this.project.whenSettled();
    const s = this.store.getState();
    const state = this.project.currentState();
    const text = s.validation?.canonicalText ?? null;
    if (state === null || text === null || s.validation?.ok !== true || s.validatedRevision !== s.revision) {
      return { ok: false, message: "only a project whose specification the engine has validated can be exported as a bundle" };
    }
    const assets = new Map<string, Uint8Array>();
    for (const a of state.manifests.assets.assets) {
      const b = await this.project.assetBytes(a.id);
      if (!b) return { ok: false, message: `asset ${a.id} has no stored file, so the bundle cannot be exported` };
      assets.set(a.id, b);
    }
    try { return { ok: true, bytes: exportBundle({ specText: text, manifests: state.manifests, assets }) }; } catch (e) { return { ok: false, message: (e as Error).message }; }
  }

  /**
   * Imports a bundle ZIP as a NEW project. importBundle validates everything and applies nothing; only a complete, secret-free
   * project is stored (asset bytes first, then the project record), so a refusal leaves the open project and storage as they were.
   */
  async importBundleBytes(bytes: Uint8Array, fileName: string, opts: ReplaceOptions = {}): Promise<ReplaceOutcome> {
    const r = await importBundle(bytes);
    if (!r.ok) return { ok: false, message: `${r.message} Your project was not changed.` };
    const { specText, assets } = r.project;
    let manifests = r.project.manifests;
    let v = await this.engine.validateDraft(specText);
    if (!v.parsed || v.canonicalText === null) return { ok: false, message: `the bundle's specification could not be read: ${v.issues[0]?.message ?? "invalid JSON"}. Your project was not changed.` };
    // Every bundle integrity check above ran on the bundle as written; only then is a v4 specification upgraded.
    const up = await this.upgradeV4(specText);
    if (up.kind === "refused") return { ok: false, message: `the bundle holds a specification v4 file, but ${up.message}. Your project was not changed.` };
    if (up.kind === "migrated") { manifests = Session.rebindSpecHashes(manifests, v.sha256, up.v.sha256); v = up.v; }
    const doc = JSON.parse(v.canonicalText ?? specText) as Json; // non-null: checked above, and a migrated verdict always has it
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, message: "the bundle's specification is not a JSON object. Your project was not changed." };
    const refusal = refuseSecrets({ doc, manifests });
    if (refusal) return { ok: false, message: `the bundle was refused: ${refusal}. Your project was not changed.` };
    const lost = await this.replacementRefusal(opts);
    if (lost) return lost;
    const projectKey = this.projects.newProjectKey();
    // The controller keeps the bytes it is handed in its own cache, so they stay readable and re-exportable even where
    // putBlob could not persist them (memory-only, conflict, closed). Nothing here reports them as saved.
    const retained = new Map<string, Uint8Array>();
    for (const [id, data] of assets) {
      const copy = data.slice();
      const stored = await this.projects.putBlob(projectKey, id, copy);
      if (!stored.ok) {
        await this.projects.pruneBlobs(projectKey, new Set()); // best effort: nothing of the refused import stays stored
        return { ok: false, message: `${stored.message} Your project was not changed.` };
      }
      retained.set(id, copy);
    }
    const baseline: Baseline = { label: fileName, templateId: null, group: "import", canonicalText: v.canonicalText, sha256: v.sha256,
      origin: v.ok ? await this.originOfImport(v.sha256) : null };
    if (opts.discardUnsaved !== true && this.project.getState().dirty) { // edits arrived while the asset files were being stored
      return { ok: false, code: "would-lose-data", message: "The open project changed while the bundle was being read. Nothing was replaced.", risks: [] };
    }
    try {
      await this.project.replaceProject({ projectKey, name: fileName, manifests, doc, persist: true, blobs: retained }, () => this.store.load(doc, baseline, v));
    } catch (e) {
      if (this.project.getState().projectKey !== projectKey) await this.projects.pruneBlobs(projectKey, new Set());
      return { ok: false, message: `${e instanceof Error ? e.message : "the project could not be created"}. Your project was not changed.` };
    }
    if (up.kind === "migrated") { this.announceMigration(); return { ok: true, migratedFrom: 4 }; }
    return { ok: true };
  }

  /** Runs the pending validation now instead of after its delay (same engine call and same stale-result rule as scheduleValidation). */
  private async validateNow(): Promise<void> {
    const s = this.store.getState();
    if (s.doc === null || s.validatedRevision === s.revision) return;
    this.cancelValidation?.();
    this.cancelValidation = undefined;
    const revision = s.revision;
    try {
      this.store.setValidation(revision, await this.engine.validateDraft(JSON.stringify(s.doc)));
    } catch (e) {
      this.store.setValidation(revision, {
        ok: false, parsed: false, sha256: null, canonicalText: null,
        issues: [{ path: "$", code: "studio.engine-error", message: (e as Error).message }],
      });
    }
  }

  private scheduleValidation(): void {
    const s = this.store.getState();
    if (s.doc === null || s.validatedRevision === s.revision) return;
    this.cancelValidation?.();
    const revision = s.revision;
    this.cancelValidation = this.schedule(() => {
      const doc = this.store.getState().doc;
      if (doc === null) return;
      this.engine.validateDraft(JSON.stringify(doc)).then(
        (v) => this.store.setValidation(revision, v),
        (e: Error) => this.store.setValidation(revision, {
          ok: false, parsed: false, sha256: null, canonicalText: null,
          issues: [{ path: "$", code: "studio.engine-error", message: e.message }],
        }),
      );
    }, VALIDATE_DELAY_MS);
  }

  /**
   * Exact recovery text of an earlier draft that was refused or unreadable at boot (never deleted, never changed): the
   * recovery JSON when the legacy value parses, else the raw string. Null when there is none.
   */
  legacyRecovery(): string | null {
    let raw: string | null;
    try { raw = this.legacy?.getItem(LEGACY_KEY) ?? null; } catch { return null; }
    if (raw === null || raw === "") return null;
    try {
      const top = JSON.parse(raw) as { docText?: unknown; baseline?: unknown };
      if (typeof top.docText === "string") {
        return stableText({ format: 1, kind: "monstera.studio.recovery", specText: top.docText, baseline: top.baseline ?? null, manifests: {} });
      }
    } catch { /* not JSON: the raw text is the recovery */ }
    return raw;
  }
}
