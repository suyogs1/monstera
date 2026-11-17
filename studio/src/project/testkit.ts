// Test helpers shared by the ProjectStore and migration tests. Imported by tests only (never by application code).
import { IDBFactory } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Baseline } from "../draft/store";
import { DB_NAME, openDb, type IdbConnection, type OpenOptions } from "./idb";
import { MANIFEST_NAMES, type ManifestMap } from "./manifests";
import type { CanonicalSpec } from "./migrate";
import { sha256Hex, type ProjectSnapshot } from "./record";

/** A canonicalize for texts that are already canonical (the engine would return them unchanged); runtime left to runtimeOf. */
export const identityCanonicalize = async (docText: string): Promise<CanonicalSpec> => ({ canonicalText: docText, sha256: await sha256Hex(docText), runtime: null });

const repo = join(__dirname, "..", "..", "..");
export const pumpkinText = readFileSync(join(repo, "apps/pumpkin-blaster/monstera.spec.json"), "utf8");
const fixtureText = (n: string): string => readFileSync(join(__dirname, "manifests", "fixtures", `${n}.valid.json`), "utf8");

export function manifestsFor(projectId: string): ManifestMap {
  const m = Object.fromEntries(MANIFEST_NAMES.map((n) => [n, JSON.parse(fixtureText(n))])) as unknown as ManifestMap;
  m.project = { ...m.project, projectId };
  return m;
}

export const baseline: Baseline = {
  label: "pumpkin-blaster", templateId: "pumpkin-blaster", group: "official", canonicalText: pumpkinText, sha256: "a".repeat(64),
  origin: { templateId: "pumpkin-blaster", path: "apps/pumpkin-blaster/monstera.spec.json", basis: "template", canonicalText: pumpkinText },
};

export const snapshot = (projectKey = "p1", specText = pumpkinText): ProjectSnapshot =>
  ({ projectKey, name: "Pumpkin Blaster", projectId: "pumpkin-blaster", specText, baseline, manifests: manifestsFor("pumpkin-blaster") });

/** The same snapshot with a recognisable edit in the spec text (keeps project.id). */
export const edited = (n: number, projectKey = "p1"): ProjectSnapshot => snapshot(projectKey, pumpkinText.replace(/\n$/, "") + `\n${" ".repeat(n)}\n`);

export const newFactory = (): IDBFactory => new IDBFactory();

export async function rawOpen(factory: IDBFactory, version?: number, onUpgrade?: (db: IDBDatabase, oldVersion: number) => void): Promise<IDBDatabase> {
  // Without a version the database must already have its schema: let the adapter create or reuse it first.
  if (version === undefined) (await openDb(factory, DB_NAME, { allowNewer: true })).close();
  return new Promise((resolve, reject) => {
    const req = version === undefined ? factory.open(DB_NAME) : factory.open(DB_NAME, version);
    req.onupgradeneeded = (e) => onUpgrade?.(req.result, e.oldVersion);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Reads one value straight from the database with a raw connection (independent of the adapter). */
export async function rawGet(factory: IDBFactory, store: string, key: IDBValidKey): Promise<unknown> {
  const db = await rawOpen(factory);
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction(store, "readonly").objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally { db.close(); }
}
export async function rawAll(factory: IDBFactory, store: string): Promise<unknown[]> {
  const db = await rawOpen(factory);
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction(store, "readonly").objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result as unknown[]);
      r.onerror = () => reject(r.error);
    });
  } finally { db.close(); }
}
export async function rawPut(factory: IDBFactory, store: string, value: unknown): Promise<void> {
  const db = await rawOpen(factory);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

// ---------------------------------------------------------------- instrumented connections

const bind = (v: unknown, t: object): unknown => (typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v);

export interface Hooks {
  /** Called when a transaction is opened. */
  onTransaction?: (names: string[], mode: string) => void;
  /** Called when a store method runs (put/get/...). Throwing makes that call throw inside the transaction work. */
  onCall?: (store: string, method: string, mode: string, args: unknown[]) => void;
  /** Replaces the result of get() requests. */
  tamperGet?: (store: string, result: unknown, mode: string) => unknown;
  /** Called when a transaction completes or aborts. */
  onEnd?: (event: "complete" | "abort", mode: string) => void;
}

function wrapStore(os: IDBObjectStore, mode: string, hooks: Hooks): IDBObjectStore {
  return new Proxy(os, {
    get(t, p) {
      if (typeof p === "string") {
        const v = Reflect.get(t, p, t);
        if (typeof v === "function") {
          return (...args: unknown[]) => {
            hooks.onCall?.(t.name, p, mode, args);
            const out = (v as (...a: unknown[]) => unknown).apply(t, args);
            if (p === "get" && hooks.tamperGet) {
              const req = out as IDBRequest;
              return new Proxy(req, {
                get(r, q) { return q === "result" ? hooks.tamperGet?.(t.name, r.result, mode) : bind(Reflect.get(r, q, r), r); },
                set(r, q, val) { (r as unknown as Record<string | symbol, unknown>)[q] = val; return true; },
              });
            }
            return out;
          };
        }
        return v;
      }
      return Reflect.get(t, p, t);
    },
  });
}

export function wrapConnection(conn: IdbConnection, hooks: Hooks): IdbConnection {
  const db = {
    transaction: (...args: unknown[]) => {
      const names = ([] as string[]).concat(args[0] as string | string[]);
      const mode = String(args[1]);
      hooks.onTransaction?.(names, mode);
      const tx = (conn.db.transaction as (...a: unknown[]) => IDBTransaction).apply(conn.db, args.slice(0, 2));
      return new Proxy(tx, {
        get(t, p) {
          if (p === "objectStore") return (n: string) => wrapStore(t.objectStore(n), mode, hooks);
          return bind(Reflect.get(t, p, t), t);
        },
        set(t, p, v) {
          if (p === "oncomplete" || p === "onabort") {
            const ev = p === "oncomplete" ? "complete" : "abort";
            (t as unknown as Record<string | symbol, unknown>)[p] = (e: Event) => { hooks.onEnd?.(ev, mode); (v as (e: Event) => void)(e); };
          } else (t as unknown as Record<string | symbol, unknown>)[p] = v;
          return true;
        },
      });
    },
  } as unknown as IDBDatabase;
  return { db, get closed() { return conn.closed; }, get newerThanSupported() { return conn.newerThanSupported; }, close: () => conn.close() };
}

export interface Opened { options: OpenOptions | undefined; conn: IdbConnection }
/** An openConnection function for ProjectStore that wraps every connection and records the open options. */
export function instrumentedOpen(hooks: Hooks, opened: Opened[] = []) {
  return async (factory: IDBFactory | null | undefined, name: string | undefined, options: OpenOptions): Promise<IdbConnection> => {
    const conn = wrapConnection(await openDb(factory, name, options), hooks);
    opened.push({ options, conn });
    return conn;
  };
}

/** A legacy storage whose write methods fail the test. */
export function readOnlyStorage(items: Record<string, string>): Pick<Storage, "getItem"> & { reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];
  return {
    reads, writes,
    getItem: (k: string) => { reads.push(k); return items[k] ?? null; },
    // Never called by correct code. Reachable only through a cast; any call is recorded and fails the tests.
    ...({ setItem: () => { writes.push("setItem"); }, removeItem: () => { writes.push("removeItem"); }, clear: () => { writes.push("clear"); } } as object),
  };
}

export function memoryMarker(initial?: string): Pick<Storage, "getItem" | "setItem"> & { value: string | null } {
  const m = { value: initial ?? null, getItem: (): string | null => m.value, setItem: (_k: string, v: string): void => { m.value = v; } };
  return m;
}
