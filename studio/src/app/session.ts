import { applyActiveLevel, applyReviewedGameplay, reviewGameplay, type ApplyResult, type GameplayApplyResult, type GameplayReview } from "../derive/apply";
import { browserProbes } from "../assets/browserProbes";
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
  private async adopt(project: ProjectSnapshot): Promise<boolean> {
    let v: DraftValidation;
    try { v = await this.engine.validateDraft(project.specText); } catch { return false; }
    if (!v.parsed) return false;
    const doc = JSON.parse(project.specText) as Json;
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return false;
    await this.project.replaceProject({ projectKey: project.projectKey, name: project.name, manifests: project.manifests, persist: false }, () => this.store.load(doc, project.baseline, v));
    return true;
  }

  /** The engine's canonical text, its SHA-256 and the runtime facts of that same document; null when it cannot supply them. */
  private async canonicalize(docText: string): Promise<CanonicalSpec | null> {
    let v: DraftValidation;
    try { v = await this.engine.validateDraft(docText); } catch { return null; }
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
  private async startProjectFrom(doc: Json, baseline: Baseline, v: DraftValidation, name: string): Promise<void> {
    const { manifests, provisionalGameplay } = await this.defaultsFor(v);
    const projectKey = this.projects.newProjectKey();
    const saving = this.project.replaceProject({ projectKey, name, manifests, persist: true, provisionalGameplay }, () => this.store.load(doc, baseline, v));
    saving.catch(() => undefined); // the store reports save failures through its state
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
  async loadTemplate(id: string): Promise<void> {
    const { doc, baseline, t, name } = await this.templateContent(id);
    await this.startProjectFrom(doc, baseline, t, name);
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
      await this.loadTemplate(first.id);
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
    const saving = this.project.replaceProject({ projectKey: view.projectKey, name: view.name ?? baseline.label, manifests: view.manifests, persist: true }, () => this.store.load(doc, baseline, v));
    saving.catch(() => undefined);
  }

  /** The engine decides whether a file is loadable (strict JSON: duplicate keys and BOMs are refused). */
  async importText(text: string, fileName: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const v = await this.engine.validateDraft(text);
    if (!v.parsed || v.canonicalText === null) {
      return { ok: false, message: v.issues[0]?.message ?? "the file could not be read as JSON" };
    }
    const top = JSON.parse(v.canonicalText) as Json;
    if (top === null || typeof top !== "object" || Array.isArray(top)) {
      const kind = top === null ? "null" : Array.isArray(top) ? "an array" : typeof top;
      return { ok: false, message: `a specification is a JSON object, but this file contains ${kind}. Your draft was not changed.` };
    }
    const baseline: Baseline = { label: fileName, templateId: null, group: "import", canonicalText: v.canonicalText, sha256: v.sha256,
      origin: v.ok ? await this.originOfImport(v.sha256) : null };
    try {
      await this.startProjectFrom(top, baseline, v, fileName);
    } catch (e) {
      return { ok: false, message: `${e instanceof Error ? e.message : "the project could not be created"}. Your draft was not changed.` };
    }
    return { ok: true };
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
