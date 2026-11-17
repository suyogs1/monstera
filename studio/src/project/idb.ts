// Minimal IndexedDB adapter for Studio persistence: open/upgrade the database, run one transaction safely, classify
// errors. No project semantics, record schemas, hashing or save-status logic live here (later increments build on it).
//
// Database: 'monstera-studio' version 1 with three stores: projects (keyPath 'projectKey'), blobs (keyPath
// ['projectKey','assetId']) and meta (keyPath 'key').
//
// Injection: every function takes the IDBFactory as a parameter (default globalThis.indexedDB, read at call time).
// There is no module-level state.
//
// Upgrades are additive and idempotent. upgradeDb switches on oldVersion; a future schema version appends a case
// (see the marker in upgradeDb). Upgrades never delete or overwrite stores or records.
//
// Blocked opens: when another connection does not close on versionchange, IndexedDB fires `blocked` and leaves the
// open request pending. openDb rejects IMMEDIATELY with kind 'blocked' (it does not wait for the blocker). If the
// pending open later succeeds, the adapter closes that connection, so nothing leaks and nothing hangs.
//
// versionchange: the connection is closed at once (so another tab or version can upgrade), `closed` becomes true,
// and the optional onVersionChange callback runs. runTransaction on a closed connection rejects with 'unavailable',
// which lets callers stop writing.
//
// Abnormal close: when the browser closes the connection on its own (for example the user clears site data), the
// database fires `close`. The adapter sets `closed` to true first, then calls the optional onClose callback at most
// once. A close the adapter started (close(), or the versionchange handler) is never reported. An exception thrown
// by the callback is swallowed so it cannot disturb the state already set. Callers should treat onClose as the cue
// to stop writing and tell the user.
//
// Transaction lifecycle (runTransaction): `work` is SYNCHRONOUS. It schedules requests through the tx wrapper and
// may return a value (typically Slots). A request-success callback may schedule follow-up requests synchronously.
// The promise resolves ONLY on transaction.oncomplete, with work's return value; it rejects on transaction abort.
// A request error is never swallowed (preventDefault is never called), so the error bubbles and aborts the
// transaction; the rejection carries the underlying DOMException as `cause`. Exceptions thrown by work or by an
// onSuccess callback, and a thenable returned from either, abort the transaction and reject after the abort event
// (kind 'async-callback' for a thenable). Do NOT await, hash, fetch or compute inside work: an IndexedDB
// transaction auto-commits when control returns to the event loop with no pending requests. Compute everything
// first, then call runTransaction. Slot values are only meaningful after the returned promise has resolved.
//
// Durability: {durability:'strict'} is passed only for readwrite and only as a hint; a runtime that rejects the
// third argument (TypeError) gets the call retried without it.

export const DB_NAME = "monstera-studio";
export const DB_VERSION = 1;
export const STORE_PROJECTS = "projects";
export const STORE_BLOBS = "blobs";
export const STORE_META = "meta";

/** The exact store definitions of schema version 1. */
export const STORE_DEFS: readonly { readonly name: string; readonly keyPath: string | readonly string[] }[] = [
  { name: STORE_PROJECTS, keyPath: "projectKey" },
  { name: STORE_BLOBS, keyPath: ["projectKey", "assetId"] },
  { name: STORE_META, keyPath: "key" },
];

// ---------------------------------------------------------------- errors

export type IdbErrorKind = "quota" | "abort" | "blocked" | "unavailable" | "version" | "async-callback" | "unknown";

export interface IdbErrorInfo {
  readonly kind: IdbErrorKind;
  /** Name of the underlying error (for example 'QuotaExceededError'), or a synthetic name. */
  readonly name: string;
  readonly message: string;
  /** The original thrown value or DOMException. */
  readonly cause: unknown;
}

export class IdbError extends Error {
  readonly kind: IdbErrorKind;
  readonly info: IdbErrorInfo;
  constructor(info: IdbErrorInfo) {
    super(info.message, { cause: info.cause });
    this.name = "IdbError";
    this.kind = info.kind;
    this.info = info;
  }
}

const QUOTA_NAMES = new Set(["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED"]);
const UNAVAILABLE_NAMES = new Set(["SecurityError", "InvalidStateError"]);

function field(e: unknown, key: string): unknown {
  return typeof e === "object" && e !== null ? (e as Record<string, unknown>)[key] : undefined;
}

/** Pure classification of anything that can be thrown or reported by IndexedDB. */
export function classifyError(e: unknown): IdbErrorInfo {
  if (e instanceof IdbError) return e.info;
  const rawName = field(e, "name");
  const rawMessage = field(e, "message");
  const code = field(e, "code");
  const name = typeof rawName === "string" && rawName !== "" ? rawName : "UnknownError";
  const message = typeof rawMessage === "string" ? rawMessage : typeof e === "string" ? e : "Unknown error";
  const info = (kind: IdbErrorKind): IdbErrorInfo => ({ kind, name, message, cause: e });

  if (QUOTA_NAMES.has(name) || code === 22 || code === 1014) return info("quota");
  if (name === "AbortError") {
    const inner = field(e, "cause") ?? field(e, "error") ?? field(field(e, "transaction"), "error");
    return info(inner !== undefined && inner !== null && classifyError(inner).kind === "quota" ? "quota" : "abort");
  }
  if (name === "BlockedError" || field(e, "type") === "blocked") return info("blocked");
  if (name === "VersionError") return info("version");
  if (UNAVAILABLE_NAMES.has(name)) return info("unavailable");
  return info("unknown");
}

function toIdbError(e: unknown): IdbError {
  return e instanceof IdbError ? e : new IdbError(classifyError(e));
}

function synthetic(kind: IdbErrorKind, name: string, message: string, cause?: unknown): IdbError {
  return new IdbError({ kind, name, message, cause });
}

// ---------------------------------------------------------------- open

export interface IdbConnection {
  readonly db: IDBDatabase;
  /** True after close(), after a versionchange, or after the browser closed the connection abnormally. */
  readonly closed: boolean;
  close(): void;
}

export interface OpenOptions {
  /** Defaults to DB_VERSION. */
  readonly version?: number;
  /** Called after the connection was closed because another context requested a different version. */
  readonly onVersionChange?: (event: IDBVersionChangeEvent) => void;
  /** Called at most once when the browser closes the connection abnormally. `closed` is already true. Never called for close(). */
  readonly onClose?: () => void;
}

/**
 * Additive, idempotent schema upgrade. Safe to run when the stores already exist. Never deletes or overwrites.
 * To add a schema version: bump DB_VERSION and append a `case <previous version>:` below the marker that creates
 * only what is new (guarded by contains()), keeping the cases in ascending order so upgrades fall through.
 */
export function upgradeDb(db: IDBDatabase, oldVersion: number): void {
  switch (oldVersion) {
    case 0:
      for (const def of STORE_DEFS) {
        if (!db.objectStoreNames.contains(def.name)) db.createObjectStore(def.name, { keyPath: def.keyPath as string | string[] });
      }
    // falls through: future versions append `case 1:`, `case 2:` ... here.
    default:
      break;
  }
}

export function openDb(factory: IDBFactory | null | undefined = globalThis.indexedDB, name: string = DB_NAME, options: OpenOptions = {}): Promise<IdbConnection> {
  return new Promise<IdbConnection>((resolve, reject) => {
    if (!factory) {
      reject(synthetic("unavailable", "UnavailableError", "IndexedDB is not available in this context"));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(name, options.version ?? DB_VERSION);
    } catch (e) {
      const c = classifyError(e);
      reject(new IdbError({ ...c, kind: "unavailable" }));
      return;
    }
    let settled = false;
    let upgradeFailure: unknown;
    req.onupgradeneeded = (e) => {
      try {
        upgradeDb(req.result, e.oldVersion);
      } catch (err) {
        upgradeFailure = err;
        try { req.transaction?.abort(); } catch { /* already finished */ }
      }
    };
    req.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(synthetic("blocked", "BlockedError", "Another connection blocks the database open or upgrade"));
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      reject(toIdbError(upgradeFailure ?? req.error));
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) { db.close(); return; }
      settled = true;
      resolve(makeConnection(db, options.onVersionChange, options.onClose));
    };
  });
}

function makeConnection(db: IDBDatabase, onVersionChange?: (event: IDBVersionChangeEvent) => void, onClose?: () => void): IdbConnection {
  let closed = false;
  const conn: IdbConnection = {
    db,
    get closed() { return closed; },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
  db.onversionchange = (e) => {
    conn.close();
    onVersionChange?.(e);
  };
  db.onclose = () => {
    if (closed) return; // already closed by the adapter, or already reported
    closed = true;
    try { onClose?.(); } catch { /* a faulty callback must not affect the connection state set above */ }
  };
  return conn;
}

// ---------------------------------------------------------------- transactions

/** Receives the request result; only readable after runTransaction resolved. */
export interface Slot<T> {
  readonly settled: boolean;
  readonly value: T | undefined;
}

export type SuccessCallback<T> = (result: T, tx: IdbTx) => void;

export interface TxStore {
  get<T = unknown>(key: IDBValidKey | IDBKeyRange, onSuccess?: SuccessCallback<T | undefined>): Slot<T | undefined>;
  getAll<T = unknown>(query?: IDBValidKey | IDBKeyRange | null, onSuccess?: SuccessCallback<T[]>): Slot<T[]>;
  put(value: unknown, onSuccess?: SuccessCallback<IDBValidKey>): Slot<IDBValidKey>;
  add(value: unknown, onSuccess?: SuccessCallback<IDBValidKey>): Slot<IDBValidKey>;
  delete(key: IDBValidKey | IDBKeyRange, onSuccess?: SuccessCallback<undefined>): Slot<undefined>;
  clear(onSuccess?: SuccessCallback<undefined>): Slot<undefined>;
}

export interface IdbTx {
  store(name: string): TxStore;
  /** Aborts the transaction; runTransaction then rejects with kind 'abort'. */
  abort(): void;
}

/** Return types that cannot be a Promise or other thenable (async callbacks fail to compile). */
export type SyncResult = (object & { then?: never }) | string | number | boolean | bigint | symbol | null | undefined | void;

export interface TransactionOptions {
  readonly durability?: "default" | "strict" | "relaxed";
}

function isThenable(v: unknown): boolean {
  return (typeof v === "object" || typeof v === "function") && v !== null && typeof (v as { then?: unknown }).then === "function";
}

class SlotImpl<T> implements Slot<T> {
  settled = false;
  value: T | undefined;
}

export function runTransaction<R extends SyncResult>(
  conn: IdbConnection,
  storeNames: readonly string[],
  mode: IDBTransactionMode,
  work: (tx: IdbTx) => R,
  options: TransactionOptions = {},
): Promise<R> {
  return new Promise<R>((resolve, reject) => {
    if (conn.closed) {
      reject(synthetic("unavailable", "InvalidStateError", "The database connection is closed"));
      return;
    }
    let tx: IDBTransaction;
    try {
      tx = openTransaction(conn.db, storeNames, mode, options);
    } catch (e) {
      reject(toIdbError(e));
      return;
    }

    let pending: IdbError | undefined; // reason chosen by us, delivered once the abort event fires
    let requestError: unknown;
    let result: R | undefined;
    let done = false;
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      settle();
    };
    const fail = (e: unknown): void => {
      if (done) return;
      pending ??= toIdbError(e);
      try {
        tx.abort();
      } catch {
        finish(() => reject(pending));
      }
    };
    const guard = (fn: () => unknown): void => {
      try {
        if (isThenable(fn())) fail(synthetic("async-callback", "AsyncCallbackError", "Transaction callbacks must be synchronous"));
      } catch (e) {
        fail(e);
      }
    };

    const wrapper: IdbTx = {
      abort: () => tx.abort(),
      store(name: string): TxStore {
        const os = tx.objectStore(name);
        const run = <T>(req: IDBRequest<T>, onSuccess?: SuccessCallback<T>): Slot<T> => {
          const slot = new SlotImpl<T>();
          req.onsuccess = () => {
            slot.value = req.result;
            slot.settled = true;
            if (onSuccess) guard(() => onSuccess(req.result, wrapper));
          };
          // Record only. No preventDefault: the event must bubble so the transaction aborts.
          req.onerror = () => { requestError ??= req.error; };
          return slot;
        };
        return {
          get: <T>(key: IDBValidKey | IDBKeyRange, cb?: SuccessCallback<T | undefined>) => run(os.get(key) as IDBRequest<T | undefined>, cb),
          getAll: <T>(query?: IDBValidKey | IDBKeyRange | null, cb?: SuccessCallback<T[]>) => run(os.getAll(query) as IDBRequest<T[]>, cb),
          put: (value, cb) => run(os.put(value), cb),
          add: (value, cb) => run(os.add(value), cb),
          delete: (key, cb) => run(os.delete(key) as IDBRequest<undefined>, cb),
          clear: (cb) => run(os.clear() as IDBRequest<undefined>, cb),
        };
      },
    };

    tx.oncomplete = () => finish(() => (pending ? reject(pending) : resolve(result as R)));
    tx.onerror = () => { requestError ??= tx.error; }; // an abort event follows; settle there
    tx.onabort = () => finish(() => {
      if (pending) { reject(pending); return; }
      const cause = tx.error ?? requestError;
      reject(cause ? toIdbError(cause) : synthetic("abort", "AbortError", "The transaction was aborted"));
    });

    try {
      const r = work(wrapper);
      if (isThenable(r)) fail(synthetic("async-callback", "AsyncCallbackError", "Transaction callbacks must be synchronous"));
      else result = r;
    } catch (e) {
      fail(e);
    }
  });
}

function openTransaction(db: IDBDatabase, storeNames: readonly string[], mode: IDBTransactionMode, options: TransactionOptions): IDBTransaction {
  const names = [...storeNames];
  if (mode === "readwrite" && options.durability) {
    try {
      return db.transaction(names, mode, { durability: options.durability });
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
    }
  }
  return db.transaction(names, mode);
}
