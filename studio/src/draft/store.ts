// The one draft: a single canonical spec document plus where it came from. Nothing else is configuration.
// The store is plain TypeScript (no React) so it can be tested; React reads it through useSyncExternalStore.
import type { DraftValidation, TemplateInfo } from "../engine/protocol";
import { findSecrets } from "../integrations/secrets";
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
  /** The template whose recorded goldens apply (the badge). Never derived from the draft's own project.id. */
  origin?: Origin | null;
}

export interface Origin {
  templateId: string;
  /** Repository path of the template spec; scenarios are matched by their recorded `spec.path`. */
  path: string;
  /** template: loaded from it; identical: an imported file byte-equal (canonical SHA-256) to it; declared: chosen by the user. */
  basis: "template" | "identical" | "declared";
  /** The template's engine canonical text (what the badge explanation compares the draft with). */
  canonicalText: string;
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

/** What the last notification was about. Valid only while listeners run (set before they are called). */
export type ChangeKind = "load" | "edit" | "origin" | "validation";

/**
 * In-memory draft only. Persistence belongs to ProjectStore (src/project/store.ts); this store never touches any
 * storage. The legacy localStorage key is read, for migration only, by src/project/migrate.ts.
 */
export class DraftStore {
  private state: DraftState = { doc: null, baseline: null, revision: 0, validation: null, validatedRevision: -1 };
  private readonly listeners = new Set<Listener>();
  /** Kind of the change being announced (see ChangeKind). */
  lastChange: ChangeKind = "load";
  /** For an "edit" made through set(): the edited path ("a.b.0"), the coalescing key. Undefined for replace(). */
  editKey: string | undefined;

  getState = (): DraftState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private commit(next: DraftState, kind: ChangeKind): void {
    this.state = next;
    this.lastChange = kind;
    for (const l of this.listeners) l();
  }

  /** Replaces the whole document (template load, import, restore). */
  load(doc: Json, baseline: Baseline, validation: DraftValidation | null = null): void {
    this.editKey = undefined;
    this.commit({
      doc, baseline, revision: this.state.revision + 1,
      validation, validatedRevision: validation ? this.state.revision + 1 : -1,
    }, "load");
  }

  /** Replaces the document with an edited version of itself. */
  replace(doc: Json): void {
    if (doc === this.state.doc) return;
    this.commit({ ...this.state, doc, revision: this.state.revision + 1 }, "edit");
  }

  /** Applies one field edit. Returns false, changing nothing, when the value looks like a credential (design 8.1). */
  set(path: Path, value: Json): boolean {
    if (this.state.doc === null) return false;
    if (findSecrets(value).length > 0) return false;
    const next = setAt(this.state.doc, path, value);
    this.editKey = path.join(".");
    try { this.replace(next); } finally { this.editKey = undefined; }
    return true;
  }

  /** Records which template's goldens apply to the current draft (the document itself is unchanged). */
  setOrigin(origin: Origin | null): void {
    if (this.state.baseline === null) return;
    this.editKey = undefined;
    this.commit({ ...this.state, baseline: { ...this.state.baseline, origin } }, "origin");
  }

  /** Called by the validation runner. Results for an older revision are dropped. */
  setValidation(revision: number, validation: DraftValidation): void {
    if (revision !== this.state.revision) return;
    this.editKey = undefined;
    this.commit({ ...this.state, validation, validatedRevision: revision }, "validation");
  }
}
