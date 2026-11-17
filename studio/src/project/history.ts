// Undo/redo history over immutable snapshots. Intended T: { doc, manifests }, so the spec document and the sidecar
// manifests are undone and redone together as one entry. Blobs are never part of a snapshot or of history.
//
// Immutability contract: snapshots are stored by reference, never cloned. Callers must treat every snapshot as
// immutable and produce edits with structural sharing (setAt returns a new tree and leaves the old one untouched).
// A snapshot that is mutated in place after being pushed corrupts history; there is no defensive copy or freeze.
//
// Coalescing: a push with a coalesceKey equal to the previous push's key, made at most COALESCE_WINDOW_MS after
// that previous push, joins the previous entry and keeps its FIRST pre-change snapshot. The window is measured from
// the LAST push of the burst (sliding), so continuous typing stays one entry; a pause longer than the window ends it.
// A different or missing key, an elapsed window, undo, redo and clear all end the burst.
export const HISTORY_LIMIT = 100;
export const COALESCE_WINDOW_MS = 1000;

export class History<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private lastKey: string | undefined;
  private lastAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  /** Records the state from before a change. Clears redo. */
  push(prev: T, coalesceKey?: string): void {
    const at = this.now();
    const joins = coalesceKey !== undefined && coalesceKey === this.lastKey && this.undoStack.length > 0 && at - this.lastAt <= COALESCE_WINDOW_MS;
    this.redoStack = [];
    this.lastKey = coalesceKey;
    this.lastAt = at;
    if (joins) return;
    this.undoStack.push(prev);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
  }

  /** Returns the prior snapshot and stores `current` for redo; undefined (no change) when there is nothing to undo. */
  undo(current: T): T | undefined {
    const prev = this.undoStack.pop();
    if (prev === undefined) return undefined;
    this.redoStack.push(current);
    this.breakCoalescing();
    return prev;
  }

  /** Returns the snapshot that was undone and stores `current` for undo; undefined (no change) when nothing to redo. */
  redo(current: T): T | undefined {
    const next = this.redoStack.pop();
    if (next === undefined) return undefined;
    this.undoStack.push(current);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.breakCoalescing();
    return next;
  }

  /** Empties both stacks. For load, import, reset and project switch. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.breakCoalescing();
  }

  private breakCoalescing(): void { this.lastKey = undefined; }
}
