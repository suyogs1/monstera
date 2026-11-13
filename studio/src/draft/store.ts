// The one draft: a single canonical spec document plus where it came from. Nothing else is configuration.
// The store is plain TypeScript (no React) so it can be tested; React reads it through useSyncExternalStore.
import type { DraftValidation, TemplateInfo } from "../engine/protocol";
import type { Json } from "../schema/schema";
import { setAt, type Path } from "./path";

export interface Baseline {
  /** What the draft started from: a bundled template, or an imported file. */
  label: string;
  templateId: string | null;
  group: TemplateInfo["group"] | "import";
  /** Engine canonical text of the starting document (for "edited?" and the diff in the Spec view). */
  canonicalText: string | null;
  sha256: string | null;
}

export interface DraftState {
  doc: Json | null;
  baseline: Baseline | null;
  /** Bumped on every document change; validation results carry the revision they belong to. */
  revision: number;
  validation: DraftValidation | null;
  validatedRevision: number;
}

type Listener = () => void;

const STORAGE_KEY = "monstera.studio.draft.v1";

export interface StoredDraft { version: 1; docText: string; baseline: Baseline }

export class DraftStore {
  private state: DraftState = { doc: null, baseline: null, revision: 0, validation: null, validatedRevision: -1 };
  private readonly listeners = new Set<Listener>();

  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined = undefined) {}

  getState = (): DraftState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private commit(next: DraftState, persist: boolean): void {
    this.state = next;
    if (persist) this.persist();
    for (const l of this.listeners) l();
  }

  private persist(): void {
    const { doc, baseline } = this.state;
    if (!this.storage) return;
    try {
      if (doc === null || baseline === null) this.storage.removeItem(STORAGE_KEY);
      else this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, docText: JSON.stringify(doc), baseline } satisfies StoredDraft));
    } catch {
      /* storage full or unavailable: the draft just stays in memory */
    }
  }

  /** Replaces the whole document (template load, import, restore). */
  load(doc: Json, baseline: Baseline, validation: DraftValidation | null = null): void {
    this.commit({
      doc, baseline, revision: this.state.revision + 1,
      validation, validatedRevision: validation ? this.state.revision + 1 : -1,
    }, true);
  }

  /** Replaces the document with an edited version of itself. */
  replace(doc: Json): void {
    if (doc === this.state.doc) return;
    this.commit({ ...this.state, doc, revision: this.state.revision + 1 }, true);
  }

  set(path: Path, value: Json): void {
    if (this.state.doc === null) return;
    this.replace(setAt(this.state.doc, path, value));
  }

  /** Called by the validation runner. Results for an older revision are dropped. */
  setValidation(revision: number, validation: DraftValidation): void {
    if (revision !== this.state.revision) return;
    this.commit({ ...this.state, validation, validatedRevision: revision }, false);
  }

  /** Reads what a previous session stored. The caller must still verify it with the engine. */
  readStored(): StoredDraft | undefined {
    if (!this.storage) return undefined;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as StoredDraft;
      return parsed.version === 1 && typeof parsed.docText === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}
