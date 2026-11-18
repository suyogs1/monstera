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
//   conflict     another tab wrote the record (compare-and-swap on writeSeq failed), or a reopen found a stored record that
//                differs from the last one this store saved or loaded while memory holds unsaved work. NOTHING was
//                written. Writes stay paused until reloadFromStorage({discardMemory:true}) (adopt the stored record,
//                an explicit destructive owner action). retryOpen() never discards memory. exportRecovery() returns
//                the in-memory project first and the preserved stored record under `stored` (Recovery format 2).
//   read-only    the database version or the record format is newer than this build. Never written, never upgraded.
//                In-memory work held when this was found stays exportable.
//   quarantined  the stored record is unreadable or inconsistent. It stays untouched; recoveryJson() carries its raw
//                fields. Never written over.
//   closed       versionchange or an abnormal close. Writes refused until retryOpen(). The latest snapshot stays in memory;
//                retryOpen() reconciles it with the stored record (see load()): it is never silently replaced.
//   Recovery from quarantine / format-newer: startNewProject(snapshot) saves a NEW project under a new key and moves
//   the active pointer in the same transaction as that commit. The preserved record is never written or deleted.
// pagehide flushing is best-effort and belongs to the caller; this store never reports saved before a commit.
import { classifyError, openDb, type IdbConnection, type IdbErrorKind, type OpenOptions } from "./idb";
import { LEGACY_PROJECT_KEY, MIGRATION_META_KEY, migrateLegacyDraft, readLegacyDraft, type MigrationResult, type MigrationRuntime } from "./migrate";
import {
  ACTIVE_KEY, buildRecord, contentText, evaluateRecord, readContents, recoveryFromRaw, recoveryFromSnapshot, recoveryWithStored, sha256Hex, snapshotIssues, stableText, writeRecord,
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
  /** The earlier (localStorage) draft, when it needs to be shown: recovered into memory, unreadable or refused. Never deleted. */
  legacy: LegacyState | null;
}

export interface LegacyState {
  status: "recovered" | "unreadable" | "refused";
  message: string;
}

export type ReloadResult = { ok: true } | { ok: false; reason: "unsaved-changes" | "memory-only"; message: string };
export type StartProjectResult =
  | { ok: true; projectKey: string }
  | { ok: false; reason: "state" | "closed" | "unsaved-changes" | "key-exists" | "invalid-snapshot" | "storage"; message: string };

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
  /** Source of unique ids for new project keys. Default crypto.randomUUID. */
  randomId?: () => string;
}

/** A project key that is not in `existing`. Throws after 8 collisions (the random source is broken). */
export function mintProjectKey(existing: Iterable<string>, randomId: () => string = () => globalThis.crypto.randomUUID()): string {
  const taken = new Set(existing);
  for (let i = 0; i < 8; i++) {
    const key = `p-${randomId()}`;
    if (!taken.has(key)) return key;
  }
  throw new Error("could not mint an unused project key");
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
  private readonly randomId: (() => string) | undefined;

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
  /** The last record this store committed or loaded (content ignores writeSeq). Memory differing from it is unsaved work. */
  private lastSaved: { projectKey: string; seq: number; content: string } | null = null;
  private knownKeys: string[] = [];
  /** A stored record kept for recovery after startNewProject (retained until dismissRetained()). */
  private retained: unknown;
  private hasRetained = false;

  constructor(deps: ProjectStoreDeps = {}) {
    this.factory = "factory" in deps ? deps.factory : globalThis.indexedDB;
    this.openConn = deps.openConnection ?? openDb;
    this.now = deps.now ?? (() => Date.now());
    this.sha256 = deps.sha256 ?? sha256Hex;
    this.marker = deps.marker ?? null;
    this.storage = deps.storage ?? null;
    this.migration = deps.migration ?? null;
    this.randomId = deps.randomId;
  }

  private static initial(): ProjectStoreState {
    return { status: "loading", detail: { message: "Opening storage.", error: null, lastSavedAt: null, reason: null, issues: [], actions: [] }, project: null, hint: null, migration: null, legacy: null };
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
  /**
   * Explicit action after blocked, failed, closed or conflict: close and reopen. No-op in memory-only. It NEVER discards
   * unsaved in-memory work: the freshly loaded record is reconciled with it (see load()). Only
   * reloadFromStorage({ discardMemory: true }) replaces memory with the stored record.
   */
  retryOpen(): Promise<void> {
    if (this.permanentlyMemoryOnly) return Promise.resolve();
    this.generation++;
    this.conn?.close();
    this.conn = null;
    this.pending = null;
    return this.open();
  }
  /**
   * Adopts the stored record. This is the ONLY place that drops the in-memory project, and only on request: while
   * memory holds unsaved changes it refuses unless `discardMemory: true` is passed (call exportRecovery() first).
   */
  async reloadFromStorage(opts: { discardMemory?: boolean } = {}): Promise<ReloadResult> {
    if (this.permanentlyMemoryOnly) return { ok: false, reason: "memory-only", message: "Browser storage is not available; there is nothing to reload." };
    if ((await this.unsavedMemory()) && opts.discardMemory !== true) {
      return { ok: false, reason: "unsaved-changes", message: "This project has unsaved changes in memory. Export them first, then reload with discardMemory: true to replace them with the stored version." };
    }
    this.current = null;
    this.pending = null;
    if (!this.conn || this.conn.closed) await this.retryOpen();
    else await this.load(this.conn);
    return { ok: true };
  }

  /** The in-memory project when it differs from the last record this store saved or loaded (or was never stored), else null. */
  private async unsavedMemory(): Promise<ProjectSnapshot | null> {
    const cur = this.current;
    if (!cur) return null;
    const last = this.lastSaved;
    if (!last || last.projectKey !== cur.projectKey) return cur;
    try {
      return contentText(await buildRecord(cur, 0, this.sha256)) === last.content ? null : cur;
    } catch {
      return cur; // cannot be compared (an invalid manifest): treat as unsaved work
    }
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
    const held = await this.unsavedMemory(); // unsaved work that must survive this (re)open
    this.set("loading", { message: "Opening storage." }, { hint: null });
    let conn: IdbConnection;
    try {
      conn = await this.openConn(this.factory, undefined, {
        allowNewer: true,
        onVersionChange: () => { if (gen === this.generation) this.closedBy("versionchange"); },
        onClose: () => { if (gen === this.generation) this.closedBy("abnormal-close"); },
      });
    } catch (e) {
      await this.openFailed(e);
      return;
    }
    this.conn = conn;
    if (!conn.newerThanSupported && this.migration) {
      let result: MigrationResult;
      try {
        result = await migrateLegacyDraft(conn, { ...this.migration, sha256: this.sha256, now: this.now });
      } catch (e) {
        await this.openFailed(e);
        return;
      }
      this.set("loading", { message: "Opening storage." }, { migration: result, legacy: legacyOf(result) });
      if (result.status === "failed") {
        if (!held) this.current = result.legacy;
        if (!held || !this.lastSaved) {
          // The legacy snapshot is the baseline of "unsaved": a later reopen keeps edits made on top of it.
          try { const r = await buildRecord(result.legacy, 1, this.sha256); this.lastSaved = { projectKey: r.projectKey, seq: 1, content: contentText(r) }; } catch { this.lastSaved = null; }
        }
        this.set("failed", {
          message: `Migrating the earlier draft failed (${result.reason}). The draft is still in your browser and open in memory.`,
          reason: "migration", error: result.error ? { kind: result.error.kind, name: result.error.name, message: result.error.message } : null,
          actions: ["retryOpen", "exportRecovery"],
        }, { project: held ?? result.legacy });
        return;
      }
    }
    await this.load(conn, held);
  }

  private async openFailed(e: unknown): Promise<void> {
    const info = classifyError(e);
    const error = { kind: info.kind, name: info.name, message: info.message };
    if (info.kind === "unavailable") {
      this.permanentlyMemoryOnly = true;
      const message = "Browser storage is not available. Your work stays in memory only and is NOT being saved.";
      this.set("memory-only", { message, reason: "unavailable", error, actions: ["exportRecovery"] });
      await this.recoverLegacyInMemory(message, error);
    } else if (info.kind === "blocked") {
      this.set("failed", { message: "Another tab holds an older version of Studio open and blocks storage. Close it, then retry.", reason: "blocked", error, actions: ["retryOpen"] });
    } else {
      this.set("failed", { message: `Storage could not be opened: ${info.message}`, reason: info.kind === "quota" ? "quota" : "error", error, actions: ["retryOpen", "exportRecovery"] });
    }
  }

  /**
   * IndexedDB is unavailable: read the legacy draft with getItem only (no connection needed) and keep it in memory.
   * The status stays 'memory-only'; nothing is ever claimed saved and the legacy key is never written or removed.
   */
  private async recoverLegacyInMemory(baseMessage: string, error: StoreDetail["error"]): Promise<void> {
    if (!this.migration) return;
    const read = await readLegacyDraft({ ...this.migration, sha256: this.sha256 });
    if (read.status === "none") return;
    const keep = { reason: "unavailable" as const, error, actions: ["exportRecovery" as const] };
    if (read.status === "recovered") {
      if (this.current) return; // work already open in memory wins; the draft stays untouched in this browser
      this.current = read.snapshot;
      const message = "The earlier draft was recovered into memory. It is NOT saved anywhere new; download the recovery file to keep it.";
      this.set("memory-only", { ...keep, message: `${baseMessage} ${message}` }, { project: read.snapshot, legacy: { status: "recovered", message } });
      return;
    }
    const message = read.status === "unreadable"
      ? `The earlier draft could not be read from this browser (${read.message}). It was not changed.`
      : `The earlier draft was not loaded (${read.reason}: ${read.message}). It was not changed or deleted.`;
    this.set("memory-only", { ...keep, message: `${baseMessage} ${message}` }, { legacy: { status: read.status, message } });
  }

  /**
   * Reads and evaluates the active record. Never writes. `held` is unsaved in-memory work: it is never replaced. It is
   * kept as is when the stored record is unchanged since this store last saved or loaded it, and otherwise the store
   * enters conflict / read-only / quarantined with BOTH versions preserved (memory exported first, stored under `stored`).
   */
  private async load(conn: IdbConnection, held: ProjectSnapshot | null = null): Promise<void> {
    let contents;
    try {
      contents = await readContents(conn, [ACTIVE_KEY, MIGRATION_META_KEY]);
    } catch (e) {
      await this.openFailed(e);
      return;
    }
    const { records } = contents;
    this.knownCount = records.length;
    this.knownKeys = records.flatMap((r) => (typeof r === "object" && r !== null && typeof (r as { projectKey?: unknown }).projectKey === "string" ? [(r as { projectKey: string }).projectKey] : []));
    this.seqByKey.clear();
    this.hasRaw = false;
    this.raw = undefined;
    // A migrated-but-not-yet-verified record (no migration flag) is never an active project; only migration activates it.
    const verified = contents.meta[MIGRATION_META_KEY] !== undefined;
    const candidates = records.filter((r) => verified || !(typeof r === "object" && r !== null && (r as { projectKey?: unknown }).projectKey === LEGACY_PROJECT_KEY));
    const activeKey = (contents.meta[ACTIVE_KEY] as { value?: unknown } | undefined)?.value;
    // Fallback to the first record when no pointer exists: save() and migration always write the pointer in the same
    // transaction that commits/verifies a record, so this only serves databases written by other means.
    const pick = candidates.find((r) => typeof r === "object" && r !== null && (r as { projectKey?: unknown }).projectKey === activeKey) ?? candidates[0];
    const hint = this.hintFor(records.length);
    const dbNewer = conn.newerThanSupported === true;
    const preserve = (r: unknown): void => { this.raw = r; this.hasRaw = true; };
    const ro = (reason: "database-newer" | "format-newer", message: string, issues: StoreIssue[] = [], project: ProjectSnapshot | null = null): void =>
      this.set("read-only", { message, reason, issues, actions: ["exportRecovery"] }, { project, hint });
    const NEWER_DB = "This storage was created by a newer Studio. It is read-only here.";
    if (pick === undefined) {
      this.current = held;
      if (!held) this.lastSaved = null;
      if (dbNewer) ro("database-newer", NEWER_DB, [], held);
      else if (held) this.set("unsaved", { message: "Your changes are kept in memory and are not saved yet." }, { project: held, hint });
      else this.set("unsaved", { message: records.length > candidates.length ? "Nothing is stored yet. An unverified migration record exists and was not opened." : "Nothing is stored yet." }, { project: null, hint });
      return;
    }
    const ev = await evaluateRecord(pick, this.sha256);
    if (ev.kind === "ok") {
      const stored = ev.record;
      if (held) {
        this.current = held;
        const last = this.lastSaved;
        const unchanged = last !== null && last.projectKey === stored.projectKey && held.projectKey === stored.projectKey
          && last.seq === stored.writeSeq && last.content === contentText(stored);
        if (dbNewer) { preserve(pick); ro("database-newer", `${NEWER_DB} Your unsaved changes are kept in memory and can be exported.`, [], held); return; }
        if (unchanged) {
          this.seqByKey.set(stored.projectKey, stored.writeSeq);
          this.set("unsaved", { message: "Changes are not saved yet." }, { project: held, hint });
          return;
        }
        preserve(pick);
        this.set("conflict", {
          message: "The stored project differs from the version this tab last saved, and this tab has unsaved changes. Both are kept and nothing was written. Export your changes, then reload the stored version to continue.",
          reason: "conflict", actions: ["reloadFromStorage", "retryOpen", "exportRecovery"],
        }, { project: held, hint });
        return;
      }
      this.seqByKey.set(stored.projectKey, stored.writeSeq);
      this.lastSaved = { projectKey: stored.projectKey, seq: stored.writeSeq, content: contentText(stored) };
      this.current = ev.project;
      if (dbNewer) ro("database-newer", NEWER_DB, [], ev.project);
      else this.set("saved", { message: "Saved." }, { project: ev.project, hint });
      return;
    }
    preserve(pick);
    this.current = held;
    if (!held) this.lastSaved = null;
    if (dbNewer) ro("database-newer", NEWER_DB, [], held);
    else if (ev.kind === "newer-format") ro("format-newer", `The stored project uses format ${ev.format}, which this Studio cannot read. It is kept unchanged and read-only.`, [], held);
    else this.set("quarantined", { message: "The stored project could not be read. It is kept unchanged; download the recovery file.", reason: "corrupt", issues: ev.issues, actions: ["exportRecovery"] }, { project: held, hint });
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
        // setActive=true on purpose: this commit IS the verification of a normal save (the record and the active
        // pointer are written in the same transaction, so the pointer never refers to an uncommitted record).
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
      this.lastSaved = { projectKey: record.projectKey, seq: record.writeSeq, content: contentText(record) };
      if (expected === 0) { this.knownCount++; this.knownKeys.push(record.projectKey); this.writeMarker(); }
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

  /**
   * Deterministic recovery data. Primary fields are the IN-MEMORY project whenever there is one; when a different stored
   * record is being preserved (conflict, read-only, quarantine) it is added under `stored` and format is 2. Without
   * an in-memory project the preserved stored record is the primary data (format 1). `{ stored: true }` returns only the
   * preserved stored record (also after startNewProject, until dismissRetained()). No blobs.
   */
  recoveryJson(opts: { stored?: boolean } = {}): Recovery | null {
    if (opts.stored) return this.hasRaw ? recoveryFromRaw(this.raw) : this.hasRetained ? recoveryFromRaw(this.retained) : null;
    if (this.current) return this.hasRaw ? recoveryWithStored(this.current, this.raw) : recoveryFromSnapshot(this.current);
    return this.hasRaw ? recoveryFromRaw(this.raw) : null;
  }
  /** Stable text of recoveryJson() (sorted keys, two-space indent, LF), or null. */
  exportRecovery(opts: { stored?: boolean } = {}): string | null {
    const r = this.recoveryJson(opts);
    return r ? stableText(r) : null;
  }
  /** Drops the stored record retained by startNewProject. The record itself stays in IndexedDB. */
  dismissRetained(): void {
    this.retained = undefined;
    this.hasRetained = false;
  }

  /** A project key unused by any record seen at the last load (and by this session's saves). */
  newProjectKey(): string {
    return mintProjectKey(this.knownKeys, this.randomId);
  }

  /**
   * Explicit recovery: saves `snapshot` as a NEW project and makes it the active one. Allowed only from 'quarantined'
   * and from read-only 'format-newer' (the preserved record is unreadable to this build but the database itself is at a
   * version this build may write). Refused from database-newer read-only (the schema may differ), memory-only, closed,
   * loading and every normal state. The key must differ from every key read at load, and the write is a compare-and-swap
   * with expectedSeq 0 (the key must not exist) that sets the active pointer in the SAME transaction as the record.
   * The preserved record is never written or deleted; its recovery data stays reachable via recoveryJson({ stored: true }).
   * In-memory work is only replaced with `discardMemory: true` (the caller normally passes that work as `snapshot`).
   */
  async startNewProject(snapshot: ProjectSnapshot, opts: { discardMemory?: boolean } = {}): Promise<StartProjectResult> {
    const { status, detail } = this.state;
    if (!(status === "quarantined" || (status === "read-only" && detail.reason === "format-newer"))) {
      return { ok: false, reason: "state", message: `A new project cannot be started while the store is ${status}${detail.reason ? ` (${detail.reason})` : ""}.` };
    }
    const conn = this.conn;
    if (!conn || conn.closed || conn.newerThanSupported) return { ok: false, reason: "closed", message: "Storage is not open for writing." };
    if (this.current && !opts.discardMemory && (await this.unsavedMemory())) {
      return { ok: false, reason: "unsaved-changes", message: "Unsaved in-memory work would be replaced. Pass it as the snapshot or set discardMemory." };
    }
    if (this.knownKeys.includes(snapshot.projectKey)) return { ok: false, reason: "key-exists", message: `A project with the key "${snapshot.projectKey}" already exists. Use newProjectKey().` };
    const issues = snapshotIssues(snapshot);
    if (issues.length > 0) return { ok: false, reason: "invalid-snapshot", message: issues.map((i) => i.message).join("; ") };
    let record;
    try { record = await buildRecord(snapshot, 1, this.sha256); } catch (e) { return { ok: false, reason: "invalid-snapshot", message: (e as Error).message }; }
    let outcome;
    try {
      outcome = await writeRecord(conn, record, 0, true); // record and active pointer commit together or not at all
    } catch (e) {
      const info = classifyError(e);
      return { ok: false, reason: "storage", message: `The new project could not be saved (${info.message}). The preserved record is unchanged.` };
    }
    if (outcome !== "written") return { ok: false, reason: "key-exists", message: `The key "${snapshot.projectKey}" is already in use (${outcome}). Nothing was written.` };
    if (this.hasRaw) { this.retained = this.raw; this.hasRetained = true; }
    this.hasRaw = false;
    this.raw = undefined;
    this.pending = null;
    this.current = snapshot;
    this.seqByKey.clear();
    this.seqByKey.set(record.projectKey, 1);
    this.lastSaved = { projectKey: record.projectKey, seq: 1, content: contentText(record) };
    this.knownKeys.push(record.projectKey);
    this.knownCount++;
    this.writeMarker();
    this.set("saved", { message: "Saved.", lastSavedAt: this.now() }, { project: snapshot });
    return { ok: true, projectKey: record.projectKey };
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

function legacyOf(r: MigrationResult): LegacyState | null {
  if (r.status === "refused") return { status: "refused", message: `The earlier draft was not migrated (${r.reason}: ${r.message}). It was not changed or deleted.` };
  if (r.status === "unreadable") return { status: "unreadable", message: `The earlier draft could not be read (${r.message}). It was not changed.` };
  if (r.status === "failed") return { status: "recovered", message: "The earlier draft is open in memory because migrating it failed." };
  return null;
}
