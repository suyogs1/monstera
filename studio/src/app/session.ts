import { DraftStore, type Baseline } from "../draft/store";
import { EngineClient } from "../engine/client";
import type { TemplateInfo } from "../engine/protocol";
import { SchemaModel, type Json } from "../schema/schema";

const VALIDATE_DELAY_MS = 150;

export type Boot = { phase: "starting" } | { phase: "ready" } | { phase: "failed"; message: string };

/** Wires the worker, the schema reader and the draft together. No rules live here: it forwards text to the engine. */
export class Session {
  readonly engine = new EngineClient();
  readonly store: DraftStore;
  schema: SchemaModel | undefined;
  boot: Boot = { phase: "starting" };
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(storage: Storage | undefined) {
    this.store = new DraftStore(storage);
    this.store.subscribe(() => this.scheduleValidation());
  }

  get templates(): TemplateInfo[] { return this.engine.templates; }

  private starting: Promise<void> | undefined;

  /** Idempotent: React StrictMode runs effects twice in development. */
  start(): Promise<void> {
    this.starting ??= this.startOnce();
    return this.starting;
  }

  private async startOnce(): Promise<void> {
    await this.engine.init();
    this.schema = new SchemaModel(await this.engine.schemas());
    const stored = this.store.readStored();
    if (stored) {
      const validation = await this.engine.validateDraft(stored.docText);
      const storedDoc = validation.parsed ? (JSON.parse(stored.docText) as Json) : null;
      if (storedDoc !== null && typeof storedDoc === "object" && !Array.isArray(storedDoc)) {
        this.store.load(storedDoc, stored.baseline, validation);
        this.boot = { phase: "ready" };
        return;
      }
    }
    const first = this.engine.templates.find((t) => t.group === "official") ?? this.engine.templates[0];
    if (!first) throw new Error("the engine bundle lists no templates");
    await this.loadTemplate(first.id);
    this.boot = { phase: "ready" };
  }

  async loadTemplate(id: string): Promise<void> {
    const info = this.engine.templates.find((t) => t.id === id);
    if (!info) throw new Error(`unknown template ${id}`);
    const t = await this.engine.template(info.path);
    const baseline: Baseline = { label: info.id, templateId: info.id, group: info.group, canonicalText: t.canonicalText, sha256: t.sha256 };
    this.store.load(JSON.parse(t.fileText) as Json, baseline, t);
  }

  /** Back to the starting point of the current draft (template or imported file). */
  async reset(): Promise<void> {
    const b = this.store.getState().baseline;
    if (!b) return;
    if (b.templateId) { await this.loadTemplate(b.templateId); return; }
    if (b.canonicalText) {
      const v = await this.engine.validateDraft(b.canonicalText);
      this.store.load(JSON.parse(b.canonicalText) as Json, b, v);
    }
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
    const baseline: Baseline = { label: fileName, templateId: null, group: "import", canonicalText: v.canonicalText, sha256: v.sha256 };
    this.store.load(JSON.parse(v.canonicalText) as Json, baseline, v);
    return { ok: true };
  }

  private scheduleValidation(): void {
    const s = this.store.getState();
    if (s.doc === null || s.validatedRevision === s.revision) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    const revision = s.revision;
    this.timer = setTimeout(() => {
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
}
