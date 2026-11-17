import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  DB_NAME, STORE_BLOBS, STORE_META, STORE_PROJECTS, IdbError, classifyError, openDb, runTransaction, upgradeDb,
  type IdbConnection, type IdbErrorKind,
} from "./idb";

// Each test builds its own IDBFactory, so databases are isolated and need no cleanup.

function rawOpen(factory: IDBFactory, version: number, onUpgrade?: (db: IDBDatabase, oldVersion: number) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, version);
    req.onupgradeneeded = (e) => onUpgrade?.(req.result, e.oldVersion);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function rejection(p: Promise<unknown>): Promise<IdbError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(IdbError);
    return e as IdbError;
  }
  throw new Error("expected the promise to reject");
}

const bind = (v: unknown, t: object): unknown => (typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v);

interface Hooks {
  onSet?: (prop: string, value: unknown) => unknown;
  store?: (os: IDBObjectStore) => IDBObjectStore;
  error?: DOMException;
}

function proxyTx(tx: IDBTransaction, hooks: Hooks): IDBTransaction {
  return new Proxy(tx, {
    get(t, p) {
      if (p === "objectStore") return (n: string) => (hooks.store ? hooks.store(t.objectStore(n)) : t.objectStore(n));
      if (p === "error" && hooks.error) return hooks.error;
      return bind(Reflect.get(t, p, t), t);
    },
    set(t, p, v) {
      (t as unknown as Record<string | symbol, unknown>)[p] = hooks.onSet && typeof p === "string" ? hooks.onSet(p, v) : v;
      return true;
    },
  });
}

/** A connection whose transactions are wrapped with the hooks. */
function instrument(conn: IdbConnection, hooks: Hooks, onTransactionArgs?: (args: unknown[]) => void): IdbConnection {
  const db = {
    transaction: (...args: unknown[]) => {
      onTransactionArgs?.(args);
      return proxyTx((conn.db.transaction as (...a: unknown[]) => IDBTransaction).apply(conn.db, args.slice(0, 2)), hooks);
    },
  } as unknown as IDBDatabase;
  return { db, get closed() { return conn.closed; }, close: () => conn.close() };
}

async function fresh(): Promise<{ factory: IDBFactory; conn: IdbConnection }> {
  const factory = new IDBFactory();
  return { factory, conn: await openDb(factory) };
}

const P = [STORE_PROJECTS];

describe("openDb: creation and reopening", () => {
  it("creates exactly the three stores with the exact key paths", async () => {
    const { conn } = await fresh();
    expect([...conn.db.objectStoreNames].sort()).toEqual([STORE_BLOBS, STORE_META, STORE_PROJECTS]);
    const tx = conn.db.transaction([STORE_PROJECTS, STORE_BLOBS, STORE_META], "readonly");
    expect(tx.objectStore(STORE_PROJECTS).keyPath).toBe("projectKey");
    expect(tx.objectStore(STORE_BLOBS).keyPath).toEqual(["projectKey", "assetId"]);
    expect(tx.objectStore(STORE_META).keyPath).toBe("key");
    expect(conn.db.name).toBe("monstera-studio");
    expect(conn.db.version).toBe(1);
  });

  it("reopens an existing database without an upgrade, and records survive close and reopen", async () => {
    const { factory, conn } = await fresh();
    await runTransaction(conn, [STORE_PROJECTS, STORE_BLOBS], "readwrite", (tx) => {
      tx.store(STORE_PROJECTS).put({ projectKey: "a", n: 1 });
      tx.store(STORE_BLOBS).put({ projectKey: "a", assetId: "x", bytes: 3 });
    });
    conn.close();
    expect(conn.closed).toBe(true);
    let upgraded = false;
    const db = await rawOpen(factory, 1, () => { upgraded = true; });
    db.close();
    expect(upgraded).toBe(false);
    const again = await openDb(factory);
    const out = await runTransaction(again, [STORE_PROJECTS, STORE_BLOBS], "readonly", (tx) => ({
      p: tx.store(STORE_PROJECTS).get("a"),
      b: tx.store(STORE_BLOBS).get(["a", "x"]),
    }));
    expect(out.p.value).toEqual({ projectKey: "a", n: 1 });
    expect(out.b.value).toEqual({ projectKey: "a", assetId: "x", bytes: 3 });
  });

  it("keeps existing data when a higher version is opened, and does not recreate stores", async () => {
    const { factory, conn } = await fresh();
    await runTransaction(conn, P, "readwrite", (tx) => { tx.store(STORE_PROJECTS).put({ projectKey: "keep" }); });
    conn.close();
    const v2 = await openDb(factory, DB_NAME, { version: 2 });
    expect(v2.db.version).toBe(2);
    expect([...v2.db.objectStoreNames].sort()).toEqual([STORE_BLOBS, STORE_META, STORE_PROJECTS]);
    const out = await runTransaction(v2, P, "readonly", (tx) => tx.store(STORE_PROJECTS).getAll());
    expect(out.value).toEqual([{ projectKey: "keep" }]);
  });

  it("upgradeDb is idempotent when the stores and data already exist", async () => {
    const { factory, conn } = await fresh();
    await runTransaction(conn, P, "readwrite", (tx) => { tx.store(STORE_PROJECTS).put({ projectKey: "keep" }); });
    conn.close();
    let created = -1;
    const db = await rawOpen(factory, 2, (d, oldVersion) => {
      expect(oldVersion).toBe(1);
      const spy = vi.spyOn(d, "createObjectStore");
      upgradeDb(d, 0); // simulates the full handler re-running over an already populated database
      created = spy.mock.calls.length;
    });
    expect(created).toBe(0);
    const out = await runTransaction({ db, closed: false, close: () => db.close() }, P, "readonly", (tx) => tx.store(STORE_PROJECTS).getAll());
    expect(out.value).toEqual([{ projectKey: "keep" }]);
  });
});

describe("openDb: failures", () => {
  it("reports a missing factory as unavailable", async () => {
    expect((await rejection(openDb(null))).kind).toBe("unavailable");
  });

  it("falls back to the global indexedDB, which does not exist in the node test environment", async () => {
    expect((await rejection(openDb())).kind).toBe("unavailable");
  });

  it("reports an exception thrown by factory.open as unavailable and keeps the cause", async () => {
    const cause = new DOMException("denied", "SecurityError");
    const factory = { open: () => { throw cause; } } as unknown as IDBFactory;
    const err = await rejection(openDb(factory));
    expect(err.kind).toBe("unavailable");
    expect(err.info.cause).toBe(cause);
  });

  it("classifies an open error (VersionError when the stored version is higher)", async () => {
    const factory = new IDBFactory();
    (await rawOpen(factory, 2)).close();
    const err = await rejection(openDb(factory, DB_NAME, { version: 1 }));
    expect(err.kind).toBe("version");
    expect(err.info.cause).toBeInstanceOf(DOMException);
  });

  it("rejects immediately with 'blocked' while another connection refuses to close, and closes the late connection", async () => {
    const factory = new IDBFactory();
    const blocker = await rawOpen(factory, 1, (d) => { d.createObjectStore(STORE_META, { keyPath: "key" }); }); // no onversionchange
    const err = await rejection(openDb(factory, DB_NAME, { version: 2 }));
    expect(err.kind).toBe("blocked");
    blocker.close();
    // The abandoned open completes after the blocker closes. A delete is queued behind it, and it is only
    // blocked if the adapter leaked that connection instead of closing it.
    let deleteBlocked = false;
    await new Promise<void>((resolve, reject) => {
      const del = factory.deleteDatabase(DB_NAME);
      del.onblocked = () => { deleteBlocked = true; };
      del.onsuccess = () => resolve();
      del.onerror = () => reject(del.error);
    });
    expect(deleteBlocked).toBe(false);
  });

  it("closes the connection on versionchange and notifies the caller", async () => {
    const factory = new IDBFactory();
    const events: string[] = [];
    const first = await openDb(factory, DB_NAME, { onVersionChange: (e) => events.push(`versionchange:${e.newVersion}`) });
    expect(first.closed).toBe(false);
    const second = await rawOpen(factory, 2);
    expect(first.closed).toBe(true);
    expect(events).toEqual(["versionchange:2"]);
    expect((await rejection(runTransaction(first, P, "readonly", () => undefined))).kind).toBe("unavailable");
    second.close();
  });
});

// fake-indexeddb never closes a connection on its own, so an abnormal browser close cannot be provoked. These tests
// dispatch the database's own `close` handler directly, which is exactly what a browser invokes. Limitation: they prove
// the adapter's handling, not that a given browser fires `close` in a given situation.
describe("openDb: abnormal close", () => {
  const fireClose = (conn: IdbConnection): void => { (conn.db.onclose as (e: Event) => void)(new Event("close")); };

  it("sets closed before invoking onClose, and invokes it once", async () => {
    const factory = new IDBFactory();
    const seen: boolean[] = [];
    const ref: { conn?: IdbConnection } = {};
    ref.conn = await openDb(factory, DB_NAME, { onClose: () => seen.push(ref.conn?.closed ?? false) });
    expect(ref.conn.closed).toBe(false);
    fireClose(ref.conn);
    fireClose(ref.conn);
    expect(seen).toEqual([true]);
    expect(ref.conn.closed).toBe(true);
    expect((await rejection(runTransaction(ref.conn, P, "readonly", () => undefined))).kind).toBe("unavailable");
  });

  it("does not report a close the adapter started", async () => {
    const factory = new IDBFactory();
    const onClose = vi.fn();
    const conn = await openDb(factory, DB_NAME, { onClose });
    conn.close();
    fireClose(conn);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not report a versionchange close", async () => {
    const factory = new IDBFactory();
    const onClose = vi.fn();
    const first = await openDb(factory, DB_NAME, { onClose });
    const second = await rawOpen(factory, 2);
    expect(first.closed).toBe(true);
    fireClose(first);
    expect(onClose).not.toHaveBeenCalled();
    second.close();
  });

  it("keeps the connection closed when the callback throws", async () => {
    const factory = new IDBFactory();
    const conn = await openDb(factory, DB_NAME, { onClose: () => { throw new Error("boom"); } });
    expect(() => fireClose(conn)).not.toThrow();
    expect(conn.closed).toBe(true);
    expect((await rejection(runTransaction(conn, P, "readonly", () => undefined))).kind).toBe("unavailable");
  });

  it("works without a callback", async () => {
    const { conn } = await fresh();
    expect(() => fireClose(conn)).not.toThrow();
    expect(conn.closed).toBe(true);
  });
});

describe("runTransaction", () => {
  it("performs a write and a read", async () => {
    const { conn } = await fresh();
    await runTransaction(conn, P, "readwrite", (tx) => { tx.store(STORE_PROJECTS).put({ projectKey: "a", v: 1 }); });
    const slot = await runTransaction(conn, P, "readonly", (tx) => tx.store(STORE_PROJECTS).get("a"));
    expect(slot.value).toEqual({ projectKey: "a", v: 1 });
  });

  it("runs several requests, across stores, in one transaction", async () => {
    const { conn } = await fresh();
    const r = await runTransaction(conn, [STORE_PROJECTS, STORE_META], "readwrite", (tx) => {
      tx.store(STORE_PROJECTS).put({ projectKey: "a" });
      tx.store(STORE_PROJECTS).put({ projectKey: "b" });
      tx.store(STORE_META).put({ key: "k", v: 1 });
      return { all: tx.store(STORE_PROJECTS).getAll(), meta: tx.store(STORE_META).get("k") };
    });
    expect(r.all.value).toEqual([{ projectKey: "a" }, { projectKey: "b" }]);
    expect(r.meta.value).toEqual({ key: "k", v: 1 });
  });

  it("completes a follow-up request scheduled from a success callback before oncomplete, and resolves only after oncomplete", async () => {
    const { conn } = await fresh();
    const log: string[] = [];
    const wrapped = instrument(conn, { onSet: (p, v) => (p === "oncomplete" ? (e: Event) => { log.push("oncomplete"); (v as (e: Event) => void)(e); } : v) });
    const r = await runTransaction(wrapped, P, "readwrite", (tx) => {
      tx.store(STORE_PROJECTS).put({ projectKey: "a", n: 1 }, (_key, t) => {
        log.push("put-success");
        t.store(STORE_PROJECTS).get("a", (rec, t2) => {
          log.push("get-success");
          t2.store(STORE_PROJECTS).put({ projectKey: "a", n: (rec as { n: number }).n + 1 }, () => { log.push("followup-success"); });
        });
      });
    });
    log.push("resolved");
    expect(r).toBeUndefined();
    expect(log).toEqual(["put-success", "get-success", "followup-success", "oncomplete", "resolved"]);
    const out = await runTransaction(conn, P, "readonly", (tx) => tx.store(STORE_PROJECTS).get("a"));
    expect(out.value).toEqual({ projectKey: "a", n: 2 });
  });

  it("rejects with 'abort' when the work aborts the transaction, and rolls back", async () => {
    const { conn } = await fresh();
    const err = await rejection(runTransaction(conn, P, "readwrite", (tx) => {
      tx.store(STORE_PROJECTS).put({ projectKey: "a" });
      tx.abort();
    }));
    expect(err.kind).toBe("abort");
    const out = await runTransaction(conn, P, "readonly", (tx) => tx.store(STORE_PROJECTS).getAll());
    expect(out.value).toEqual([]);
  });

  it("rejects a failing request (duplicate add) with the underlying DOMException and rolls the transaction back", async () => {
    const { conn } = await fresh();
    await runTransaction(conn, P, "readwrite", (tx) => { tx.store(STORE_PROJECTS).put({ projectKey: "a", v: 1 }); });
    const err = await rejection(runTransaction(conn, P, "readwrite", (tx) => {
      tx.store(STORE_PROJECTS).put({ projectKey: "b" });
      tx.store(STORE_PROJECTS).add({ projectKey: "a", v: 2 });
    }));
    expect(err.info.name).toBe("ConstraintError");
    expect(err.info.cause).toBeInstanceOf(DOMException);
    const out = await runTransaction(conn, P, "readonly", (tx) => tx.store(STORE_PROJECTS).getAll());
    expect(out.value).toEqual([{ projectKey: "a", v: 1 }]);
  });

  it("rejects an async callback with 'async-callback' and persists nothing", async () => {
    const { conn } = await fresh();
    const err = await rejection(runTransaction(
      conn, P, "readwrite",
      // @ts-expect-error async work is rejected by the type
      async (tx) => { tx.store(STORE_PROJECTS).put({ projectKey: "z" }); },
    ));
    expect(err.kind).toBe("async-callback");
    const out = await runTransaction(conn, P, "readonly", (tx) => tx.store(STORE_PROJECTS).getAll());
    expect(out.value).toEqual([]);
  });

  it("rejects a success callback that returns a promise", async () => {
    const { conn } = await fresh();
    const err = await rejection(runTransaction(conn, P, "readwrite", (tx) => {
      tx.store(STORE_PROJECTS).put({ projectKey: "z" }, () => Promise.resolve() as unknown as void);
    }));
    expect(err.kind).toBe("async-callback");
    const out = await runTransaction(conn, P, "readonly", (tx) => tx.store(STORE_PROJECTS).getAll());
    expect(out.value).toEqual([]);
  });

  it("rejects when work or a success callback throws, and rolls back", async () => {
    const { conn } = await fresh();
    const boom = new Error("boom");
    const a = await rejection(runTransaction(conn, P, "readwrite", (tx) => {
      tx.store(STORE_PROJECTS).put({ projectKey: "a" });
      throw boom;
    }));
    expect(a.info.cause).toBe(boom);
    const b = await rejection(runTransaction(conn, P, "readwrite", (tx) => {
      tx.store(STORE_PROJECTS).put({ projectKey: "b" }, () => { throw boom; });
    }));
    expect(b.info.cause).toBe(boom);
    const out = await runTransaction(conn, P, "readonly", (tx) => tx.store(STORE_PROJECTS).getAll());
    expect(out.value).toEqual([]);
  });

  it("classifies a quota failure thrown by a request, rejects, and a later write succeeds", async () => {
    const { conn } = await fresh();
    const full = instrument(conn, {
      store: (os) => new Proxy(os, {
        get: (t, p) => (p === "put" ? () => { throw new DOMException("full", "QuotaExceededError"); } : bind(Reflect.get(t, p, t), t)),
      }),
    });
    const err = await rejection(runTransaction(full, P, "readwrite", (tx) => { tx.store(STORE_PROJECTS).put({ projectKey: "a" }); }));
    expect(err.kind).toBe("quota");
    expect(err.info.name).toBe("QuotaExceededError");
    await runTransaction(conn, P, "readwrite", (tx) => { tx.store(STORE_PROJECTS).put({ projectKey: "ok" }); });
    const out = await runTransaction(conn, P, "readonly", (tx) => tx.store(STORE_PROJECTS).getAll());
    expect(out.value).toEqual([{ projectKey: "ok" }]);
  });

  it("classifies an aborted transaction whose error is QuotaExceededError as 'quota'", async () => {
    const { conn } = await fresh();
    const quota = instrument(conn, { error: new DOMException("full", "QuotaExceededError") });
    const err = await rejection(runTransaction(quota, P, "readwrite", (tx) => { tx.abort(); }));
    expect(err.kind).toBe("quota");
  });

  it("passes durability only for readwrite and falls back when the runtime throws TypeError", async () => {
    const { conn } = await fresh();
    const seen: unknown[][] = [];
    const strictFails = {
      db: {
        transaction: (...args: unknown[]) => {
          seen.push(args);
          if (args.length > 2) throw new TypeError("unsupported");
          return (conn.db.transaction as (...a: unknown[]) => IDBTransaction).apply(conn.db, args);
        },
      } as unknown as IDBDatabase,
      closed: false,
      close: () => undefined,
    };
    await runTransaction(strictFails, P, "readwrite", (tx) => { tx.store(STORE_PROJECTS).put({ projectKey: "a" }); }, { durability: "strict" });
    await runTransaction(strictFails, P, "readonly", () => undefined, { durability: "strict" });
    expect(seen.map((a) => a.length)).toEqual([3, 2, 2]);
    expect(seen[0]?.[2]).toEqual({ durability: "strict" });
    await runTransaction(conn, P, "readwrite", (tx) => { tx.store(STORE_PROJECTS).put({ projectKey: "b" }); }, { durability: "strict" });
  });
});

describe("classifyError", () => {
  const dom = (name: string) => new DOMException("m", name);
  const table: [string, unknown, IdbErrorKind][] = [
    ["QuotaExceededError", dom("QuotaExceededError"), "quota"],
    ["Firefox quota name", { name: "NS_ERROR_DOM_QUOTA_REACHED" }, "quota"],
    ["code 22", { code: 22 }, "quota"],
    ["code 1014", { code: 1014 }, "quota"],
    ["AbortError with quota cause", { name: "AbortError", cause: dom("QuotaExceededError") }, "quota"],
    ["AbortError with quota transaction.error", { name: "AbortError", transaction: { error: dom("QuotaExceededError") } }, "quota"],
    ["AbortError", dom("AbortError"), "abort"],
    ["AbortError with other cause", { name: "AbortError", cause: dom("ConstraintError") }, "abort"],
    ["blocked event", { type: "blocked" }, "blocked"],
    ["BlockedError", { name: "BlockedError" }, "blocked"],
    ["SecurityError", dom("SecurityError"), "unavailable"],
    ["InvalidStateError", dom("InvalidStateError"), "unavailable"],
    ["VersionError", dom("VersionError"), "version"],
    ["ConstraintError", dom("ConstraintError"), "unknown"],
    ["plain Error", new Error("x"), "unknown"],
    ["string", "oops", "unknown"],
    ["undefined", undefined, "unknown"],
    ["null", null, "unknown"],
    ["number", 7, "unknown"],
  ];
  it.each(table)("%s", (_label, input, kind) => {
    const info = classifyError(input);
    expect(info.kind).toBe(kind);
    expect(typeof info.name).toBe("string");
    expect(typeof info.message).toBe("string");
    expect(info.cause).toBe(input);
  });

  it("passes an IdbError through unchanged, and keeps names and messages", () => {
    const e = new IdbError({ kind: "async-callback", name: "AsyncCallbackError", message: "sync only", cause: undefined });
    expect(classifyError(e)).toBe(e.info);
    expect(classifyError(e).kind).toBe("async-callback");
    expect(classifyError(new Error("x"))).toMatchObject({ name: "Error", message: "x" });
    expect(classifyError("oops")).toMatchObject({ name: "UnknownError", message: "oops" });
  });
});
