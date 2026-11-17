// ProjectStore: the single persistence authority of Studio (spec, baseline and manifests are one atomic record).
// Plain TypeScript, no React. getState()/subscribe() like DraftStore. Every dependency is injected so tests are
// deterministic. IndexedDB is the only ongoing persistence layer; the legacy localStorage draft is only ever READ
// (see migrate.ts); the eviction marker is a best-effort hint, never authority.
//
// States (status): loading, saved, saving, unsaved, failed, memory-only, conflict, read-only, quarantined, closed.
//   saved        the last snapshot is in a COMMITTED transaction (set only after runTransaction resolved).
//   unsaved      a snapshot is waiting for the writer, or nothing is stored yet (empty database).
//   saving       one write in flight; later snapshots coalesce into the next write (one in flight at a time).
//   failed       a write or open failed (quota, abort, blocked, other). In-memory data is intact. retrySave() or
//                retryOpen(), or simply the next save(), tries again; success returns to 'saved'.
//   memory-only  IndexedDB is unavailable. Permanent for this session; nothing is ever claimed saved.
//   conflict     another tab wrote the record (compare-and-swap on writeSeq failed). NOTHING was written. Writes stay
//                paused until the user calls reloadFromStorage() (adopt the stored record) or retryOpen();
//                exportRecovery() returns "mine" first.
//   read-only    the database version or the record format is newer than this build. Never written, never upgraded.
//   quarantined  the stored record is unreadable or inconsistent. It stays untouched; recoveryJson() carries its raw
//                fields. Never written over.
//   closed       versionchange or an abnormal close. Writes refused until retryOpen().
// pagehide flushing is best-effort and belongs to the caller; this store never reports saved before a commit.
import { classifyError, openDb, type IdbConnection, type IdbErrorKind, type OpenOptions } from "./idb";
import { migrateLegacyDraft, type MigrationResult, type MigrationRuntime } from "./migrate";
import {
  ACTIVE_KEY, buildRecord, evaluateRecord, readContents, recoveryFromRaw, recoveryFromSnapshot, sha256Hex, snapshotIssues, stableText, writeRecord,
  type ProjectSnapshot, type Recovery, type Sha256, type StoreIssue,
} from "./record";

export type ProjectStoreStatus = "loading" | "saved" | "saving" | "unsaved" | "failed" | "memory-only" | "conflict" | "read-only" | "quarantined" | "closed";
export type StoreReason =
  | "quota" | "abort" | "blocked" | "unavailable" | "error" | "conflict" | "versionchange" | "abnormal-close" | "disposed"
  | "database-newer" | "format-newer" | "corrupt" | "migration" | "invalid-snapshot";
export type StoreAction = "retryOpen" | "retrySave" | "reloadFromStorage" | "exportRecovery";
export type PersistenceResult = "granted" | "not-granted" | "unavailable" | "rejected";
export type EstimateResult = { usage: number; quota: number } | "unknown";

export interface StoreDetail {
  message: string;
  error: { kind: IdbErrorKind; name: string; message: string } | null;
  lastSavedAt: number | null;
  reason: StoreReason | null;
  issues: StoreIssue[];
  actions: StoreAction[];
}

export interface ProjectStoreState {
  status: ProjectStoreStatus;
  detail: StoreDetail;
  /** The in-memory project: last loaded or last accepted snapshot. Kept when storage fails. */
  project: ProjectSnapshot | null;
  /** Best-effort eviction hint, or null. */
  hint: string | null;
  migration: MigrationResult | null;
}

export interface StorageLike {
  persist?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

export interface ProjectStoreDeps {
  /** Default globalThis.indexedDB. Pass null to model "IndexedDB is not available". */
  factory?: IDBFactory | null;
  /** Test seam; default openDb. */
  openConnection?: (factory: IDBFactory | null | undefined, name: string | undefined, options: OpenOptions) => Promise<IdbConnection>;
  now?: () => number;
  sha256?: Sha256;
  /** localStorage-like marker storage for the eviction hint. */
  marker?: Pick<Storage, "getItem" | "setItem"> | null;
  /** navigator.storage-like object. */
  storage?: StorageLike | null;
  /** Legacy draft migration (read-only). Omit to skip it. */
  migration?: Omit<MigrationRuntime, "sha256" | "now"> | null;
}

export const MARKER_KEY = "monstera.studio.projects-seen.v1";
export const EVICTION_HINT = "Studio found no saved projects, but this browser had saved at least one before. The browser may have cleared Studio's site data. This is a best-effort hint, not a reliable check.";

const ACTIONS: Record<string, StoreAction[]> = { failed: ["retrySave", "exportRecovery"] };

export class ProjectStore {
  private state: ProjectStoreState = ProjectStore.initial();
  private readonly listeners = new Set<() => void>();
  private readonly factory: IDBFactory | null | undefined;
  private readonly openConn: NonNullable<ProjectStoreDeps["openConnection"]>;
  private readonly now: () => number;
  private readonly sha256: Sha256;
  private readonly marker: ProjectStoreDeps["marker"];
  private readonly storage: StorageLike | null;
  private readonly migration: ProjectStoreDeps["migration"];

  private conn: IdbConnection | null = null;
  private generation = 0;
  private opening: Promise<void> | undefined;
  private pumping: Promise<void> | undefined;
  private pending: ProjectSnapshot | null = null;
  private current: ProjectSnapshot | null = null;
  private raw: unknown;
  private hasRaw = false;
  private readonly seqByKey = new Map<string, number>();
  private knownCount = 0;
  private permanentlyMemoryOnly = false;

  constructor(deps: ProjectStoreDeps = {}) {
    this.factory = "factory" in deps ? deps.factory : globalThis.indexedDB;
    this.openConn = deps.openConnection ?? openDb;
    this.now = deps.now ?? (() => Date.now());
    this.sha256 = deps.sha256 ?? sha256Hex;
    this.marker = deps.marker ?? null;
    this.storage = deps.storage ?? null;
    this.migration = deps.migration ?? null;
  }

  private static initial(): ProjectStoreState {
    return { status: "loading", detail: { message: "Opening storage.", error: null, lastSavedAt: null, reason: null, issues: [], actions: [] }, project: null, hint: null, migration: null };
  }

  getState = (): ProjectStoreState => this.state;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(status: ProjectStoreStatus, d: Partial<StoreDetail> & { message: string }, extra: Partial<ProjectStoreState> = {}): void {
    const lastSavedAt = d.lastSavedAt ?? this.state.detail.lastSavedAt;
    const detail: StoreDetail = { error: null, reason: null, issues: [], actions: ACTIONS[status] ?? [], ...d, lastSavedAt };
    this.state = { ...this.state, ...extra, status, detail };
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------ opening

  /** Opens the database, migrates the legacy draft (if configured) and loads the active project. Idempotent while running. */
  open(): Promise<void> {
    this.opening ??= this.doOpen().finally(() => { this.opening = undefined; });
    return this.opening;
  }
  /** Explicit action after blocked, failed, closed or conflict: close, reopen, reload. No-op in memory-only. */
  retryOpen(): Promise<void> {
    if (this.permanentlyMemoryOnly) return Promise.resolve();
    this.generation++;
    this.conn?.close();
    this.conn = null;
    this.pending = null;
    return this.open();
  }
  /** Adopts the stored record (conflict recovery). Mine is dropped: call exportRecovery() first. */
  async reloadFromStorage(): Promise<void> {
    if (!this.conn || this.conn.closed) return this.retryOpen();
    await this.load(this.conn);
  }
  /** Closes the connection; the store becomes 'closed' and refuses writes. */
  dispose(): void {
    this.generation++;
    this.conn?.close();
    this.pending = null;
    this.set("closed", { message: "Storage was closed.", reason: "disposed", actions: ["retryOpen"] });
  }

  private async doOpen(): Promise<void> {
    const gen = this.generation;
    this.set("loading", { message: "Opening storage." }, { hint: null });
    let conn: IdbConnection;
    try {
      conn = await this.openConn(this.factory, undefined, {
        allowNewer: true,
        onVersionChange: () => { if (gen === this.generation) this.closedBy("versionchange"); },
        onClose: () => { if (gen === this.generation) this.closedBy("abnormal-close"); },
      });
    } catch (e) {
      this.openFailed(e);
      return;
    }
    this.conn = conn;
    if (!conn.newerThanSupported && this.migration) {
      let result: MigrationResult;
      try {
        result = await migrateLegacyDraft(conn, { ...this.migration, sha256: this.sha256, now: this.now });
      } catch (e) {
        this.openFailed(e);
        return;
      }
      this.set("loading", { message: "Opening storage." }, { migration: result });
      if (result.status === "failed") {
        this.current = result.legacy;
        this.set("failed", {
          message: `Migrating the earlier draft failed (${result.reason}). The draft is still in your browser and open in memory.`,
          reason: "migration", error: result.error ? { kind: result.error.kind, name: result.error.name, message: result.error.message } : null,
          actions: ["retryOpen", "exportRecovery"],
        }, { project: result.legacy });
        return;
      }
    }
    await this.load(conn);
  }

  private openFailed(e: unknown): void {
    const info = classifyError(e);
    const error = { kind: info.kind, name: info.name, message: info.message };
    if (info.kind === "unavailable") {
      this.permanentlyMemoryOnly = true;
      this.set("memory-only", { message: "Browser storage is not available. Your work stays in memory only and is NOT being saved.", reason: "unavailable", error, actions: ["exportRecovery"] });
    } else if (info.kind === "blocked") {
      this.set("failed", { message: "Another tab holds an older version of Studio open and blocks storage. Close it, then retry.", reason: "blocked", error, actions: ["retryOpen"] });
    } else {
      this.set("failed", { message: `Storage could not be opened: ${info.message}`, reason: info.kind === "quota" ? "quota" : "error", error, actions: ["retryOpen", "exportRecovery"] });
    }
  }

  /** Reads and evaluates the active record. Never writes. */
  private async load(conn: IdbConnection): Promise<void> {
    let contents;
    try {
      contents = await readContents(conn, [ACTIVE_KEY]);
    } catch (e) {
      this.openFailed(e);
      return;
    }
    const { records } = contents;
    this.knownCount = records.length;
    this.seqByKey.clear();
    this.hasRaw = false;
    this.raw = undefined;
    const activeKey = (contents.meta[ACTIVE_KEY] as { value?: unknown } | undefined)?.value;
    const pick = records.find((r) => typeof r === "object" && r !== null && (r as { projectKey?: unknown }).projectKey === activeKey) ?? records[0];
    const hint = this.hintFor(records.length);
    const dbNewer = conn.newerThanSupported === true;
    const ro = (reason: "database-newer" | "format-newer", message: string, issues: StoreIssue[] = [], project: ProjectSnapshot | null = null): void =>
      this.set("read-only", { message, reason, issues, actions: ["exportRecovery"] }, { project, hint });
    if (pick === undefined) {
      this.current = null;
      if (dbNewer) ro("database-newer", "This storage was created by a newer Studio. It is read-only here.");
      else this.set("unsaved", { message: "Nothing is stored yet." }, { project: null, hint });
      return;
    }
    const ev = await evaluateRecord(pick, this.sha256);
    if (ev.kind === "ok") {
      this.seqByKey.set(ev.record.projectKey, ev.record.writeSeq);
      this.current = ev.project;
      if (dbNewer) ro("database-newer", "This storage was created by a newer Studio. It is read-only here.", [], ev.project);
      else this.set("saved", { message: "Saved." }, { project: ev.project, hint });
      return;
    }
    this.raw = pick;
    this.hasRaw = true;
    this.current = null;
    if (dbNewer) ro("database-newer", "This storage was created by a newer Studio. It is read-only here.");
    else if (ev.kind === "newer-format") ro("format-newer", `The stored project uses format ${ev.format}, which this Studio cannot read. It is kept unchanged and read-only.`);
    else this.set("quarantined", { message: "The stored project could not be read. It is kept unchanged; download the recovery file.", reason: "corrupt", issues: ev.issues, actions: ["exportRecovery"] }, { project: null, hint });
  }

  private hintFor(recordCount: number): string | null {
    if (recordCount > 0 || !this.marker) return null;
    try {
      const n = Number.parseInt(this.marker.getItem(MARKER_KEY) ?? "", 10);
      return Number.isInteger(n) && n > 0 ? EVICTION_HINT : null;
    } catch {
      return null;
    }
  }

  private closedBy(reason: "versionchange" | "abnormal-close"): void {
    this.pending = null;
    this.set("closed", {
      message: reason === "versionchange" ? "Studio was opened in another tab with a newer storage version. Writing is paused." : "The browser closed Studio's storage. Writing is paused.",
      reason, actions: ["retryOpen", "exportRecovery"],
    });
  }

  // ------------------------------------------------------------ saving

  /**
   * Accepts the current project. Returns the status after the write settled. Refused (nothing kept, nothing written)
   * while loading, read-only or quarantined. In memory-only, conflict, closed and migration-failed states the snapshot
   * is kept in memory and nothing is written.
   */
  save(snapshot: ProjectSnapshot): Promise<ProjectStoreStatus> {
    const s = this.state.status;
    if (s === "loading" || s === "read-only" || s === "quarantined") return Promise.resolve(s);
    this.current = snapshot;
    this.state = { ...this.state, project: snapshot };
    const blocked = s === "memory-only" || s === "conflict" || s === "closed" || !this.conn || this.conn.closed || this.state.detail.reason === "migration";
    if (blocked) {
      for (const l of this.listeners) l();
      return Promise.resolve(s);
    }
    this.pending = snapshot;
    if (s !== "saving") this.set("unsaved", { message: "Changes are not saved yet." });
    this.pumping ??= this.pump().finally(() => { this.pumping = undefined; });
    return this.pumping.then(() => this.state.status);
  }

  /** Writes the in-memory project again after a failure. */
  retrySave(): Promise<ProjectStoreStatus> {
    return this.current ? this.save(this.current) : Promise.resolve(this.state.status);
  }

  private async pump(): Promise<void> {
    const conn = this.conn;
    while (this.pending && conn) {
      const snap = this.pending;
      this.pending = null;
      this.set("saving", { message: "Saving." });
      const expected = this.seqByKey.get(snap.projectKey) ?? 0;
      let record;
      try {
        const issues = snapshotIssues(snap);
        if (issues.length > 0) {
          this.set("failed", { message: "The project is internally inconsistent and was not saved.", reason: "invalid-snapshot", issues, actions: ["exportRecovery"] });
          return;
        }
        record = await buildRecord(snap, expected + 1, this.sha256); // hash and canonical text BEFORE any transaction
      } catch (e) {
        this.set("failed", { message: `The project could not be prepared for saving: ${(e as Error).message}`, reason: "invalid-snapshot", actions: ["exportRecovery"] });
        return;
      }
      let outcome;
      try {
        outcome = await writeRecord(conn, record, expected, true);
      } catch (e) {
        this.writeFailed(e);
        return;
      }
      if (outcome === "conflict" || outcome === "foreign") {
        this.set("conflict", {
          message: outcome === "conflict" ? "Another tab changed this project. Nothing was written and saving is paused." : "The stored record has an unknown shape. Nothing was written and saving is paused.",
          reason: "conflict", actions: ["reloadFromStorage", "retryOpen", "exportRecovery"],
        });
        return;
      }
      if (outcome === "newer-format") {
        this.set("read-only", { message: "The stored project uses a newer format. It is kept unchanged and read-only.", reason: "format-newer", actions: ["exportRecovery"] });
        return;
      }
      this.seqByKey.set(record.projectKey, record.writeSeq);
      if (expected === 0) { this.knownCount++; this.writeMarker(); }
      const lastSavedAt = this.now();
      if (this.state.status === "closed") return;
      if (this.pending) this.set("saving", { message: "Saving.", lastSavedAt });
      else this.set("saved", { message: "Saved.", lastSavedAt });
    }
  }

  private writeFailed(e: unknown): void {
    if (this.state.status === "closed") return; // versionchange or abnormal close already moved the store here
    const info = classifyError(e);
    const error = { kind: info.kind, name: info.name, message: info.message };
    if (info.kind === "unavailable") { this.closedBy("abnormal-close"); return; }
    const reason: StoreReason = info.kind === "quota" ? "quota" : info.kind === "abort" ? "abort" : "error";
    const message = reason === "quota" ? "Browser storage is full. Your work is kept in memory and is NOT saved." : `The save failed (${info.message}). Your work is kept in memory and is NOT saved.`;
    this.set("failed", { message, reason, error });
  }

  private writeMarker(): void {
    try { this.marker?.setItem(MARKER_KEY, String(this.knownCount)); } catch { /* a hint only; never throws */ }
  }

  // ------------------------------------------------------------ recovery and storage

  /** Deterministic recovery data: raw stored fields when a stored record is being preserved, else the in-memory project. No blobs. */
  recoveryJson(): Recovery | null {
    if (this.hasRaw) return recoveryFromRaw(this.raw);
    return this.current ? recoveryFromSnapshot(this.current) : null;
  }
  /** Stable text of recoveryJson() (sorted keys, two-space indent, LF), or null. */
  exportRecovery(): string | null {
    const r = this.recoveryJson();
    return r ? stableText(r) : null;
  }

  async requestPersistence(): Promise<PersistenceResult> {
    const persist = this.storage?.persist;
    if (!persist) return "unavailable";
    try { return (await persist.call(this.storage)) ? "granted" : "not-granted"; } catch { return "rejected"; }
  }

  async estimate(): Promise<EstimateResult> {
    const estimate = this.storage?.estimate;
    if (!estimate) return "unknown";
    try {
      const r = await estimate.call(this.storage);
      return typeof r.usage === "number" && typeof r.quota === "number" ? { usage: r.usage, quota: r.quota } : "unknown";
    } catch {
      return "unknown";
    }
  }
}
