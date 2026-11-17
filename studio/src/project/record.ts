// The persisted project record and everything both ProjectStore and the legacy migration share: building a record from
// a snapshot, evaluating a stored value (never trusting it), canonical text, and the compare-and-swap write.
// No React, no engine, no module state. Async work (hashing) happens here BEFORE a transaction is opened.
import type { Baseline } from "../draft/store";
import { STORE_META, STORE_PROJECTS, runTransaction, type IdbConnection } from "./idb";
import { MANIFEST_NAMES, parseManifest, serializeManifest, type ManifestMap, type ManifestName } from "./manifests";

export const RECORD_FORMAT = 1;
export const ACTIVE_KEY = "activeProjectKey";

export type Sha256 = (text: string) => Promise<string>;

/** SHA-256 of the UTF-8 text, lowercase hex, through Web Crypto (browsers and Node 22). */
export const sha256Hex: Sha256 = async (text) => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** What callers hand to ProjectStore: the live project, with manifests as validated objects. */
export interface ProjectSnapshot {
  projectKey: string;
  name: string;
  projectId: string;
  /** The specification text exactly as it must be stored (the engine's canonical text when the caller has it). */
  specText: string;
  baseline: Baseline;
  manifests: ManifestMap;
}

/** The IndexedDB 'projects' record, format 1. */
export interface ProjectRecord {
  format: number;
  projectKey: string;
  name: string;
  projectId: string;
  specText: string;
  specSha256: string;
  baseline: Baseline;
  /** Canonical manifest text (serializeManifest), one entry per manifest name. */
  manifests: Record<ManifestName, string>;
  writeSeq: number;
}

export interface StoreIssue { code: string; message: string }

export type Evaluation =
  | { kind: "ok"; record: ProjectRecord; project: ProjectSnapshot }
  | { kind: "newer-format"; format: number }
  | { kind: "invalid"; issues: StoreIssue[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function isBaseline(v: unknown): v is Baseline {
  if (!isObject(v)) return false;
  const str = (x: unknown): boolean => typeof x === "string";
  const strOrNull = (x: unknown): boolean => x === null || typeof x === "string";
  if (!str(v["label"]) || !strOrNull(v["templateId"]) || !str(v["group"]) || !strOrNull(v["canonicalText"]) || !strOrNull(v["sha256"])) return false;
  const o = v["origin"];
  if (o === undefined || o === null) return true;
  return isObject(o) && str(o["templateId"]) && str(o["path"]) && str(o["canonicalText"])
    && (o["basis"] === "template" || o["basis"] === "identical" || o["basis"] === "declared");
}

/** Recursively sorts object keys so equal values give equal text. Own keys only; undefined values vanish in JSON. */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
/** Stable text of any JSON value: sorted keys, two-space indent, LF, one trailing newline. */
export const stableText = (v: unknown): string => JSON.stringify(sortKeys(v), null, 2) + "\n";
export const sameValue = (a: unknown, b: unknown): boolean => stableText(a) === stableText(b);

export function specProjectId(specText: string): string | null {
  try {
    const doc: unknown = JSON.parse(specText);
    const p = isObject(doc) ? doc["project"] : undefined;
    const id = isObject(p) ? p["id"] : undefined;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** Checks a snapshot the caller wants to save; returns issues instead of writing an inconsistent record. */
export function snapshotIssues(s: ProjectSnapshot): StoreIssue[] {
  const out: StoreIssue[] = [];
  const id = specProjectId(s.specText);
  if (id === null) out.push({ code: "spec-unparseable", message: "the specification text is not a JSON object with project.id" });
  else if (id !== s.projectId) out.push({ code: "project-id-mismatch", message: `spec project.id "${id}" differs from the project id "${s.projectId}"` });
  if (s.manifests.project.projectId !== s.projectId) {
    out.push({ code: "manifest-project-mismatch", message: `project manifest id "${s.manifests.project.projectId}" differs from the project id "${s.projectId}"` });
  }
  return out;
}

/** Throws when a manifest is invalid (serializeManifest). The hash is computed here, before any transaction. */
export async function buildRecord(s: ProjectSnapshot, writeSeq: number, sha256: Sha256): Promise<ProjectRecord> {
  const manifests = Object.fromEntries(MANIFEST_NAMES.map((n) => [n, serializeManifest(n, s.manifests[n] as never)])) as Record<ManifestName, string>;
  return {
    format: RECORD_FORMAT, projectKey: s.projectKey, name: s.name, projectId: s.projectId, specText: s.specText,
    specSha256: await sha256(s.specText), baseline: s.baseline, manifests, writeSeq,
  };
}

/** Reads a stored value without trusting it. Never throws. Runs outside any transaction. */
export async function evaluateRecord(raw: unknown, sha256: Sha256): Promise<Evaluation> {
  if (!isObject(raw)) return { kind: "invalid", issues: [{ code: "not-an-object", message: "the stored value is not an object" }] };
  const format = raw["format"];
  if (typeof format !== "number" || !Number.isInteger(format) || format < 1) {
    return { kind: "invalid", issues: [{ code: "bad-format", message: "the record has no valid format number" }] };
  }
  if (format > RECORD_FORMAT) return { kind: "newer-format", format };
  const issues: StoreIssue[] = [];
  const str = (k: string): string => {
    const v = raw[k];
    if (typeof v === "string") return v;
    issues.push({ code: "bad-field", message: `${k} must be a string` });
    return "";
  };
  const projectKey = str("projectKey"), name = str("name"), projectId = str("projectId"), specText = str("specText"), specSha256 = str("specSha256");
  const writeSeq = raw["writeSeq"];
  if (typeof writeSeq !== "number" || !Number.isInteger(writeSeq) || writeSeq < 0) issues.push({ code: "bad-field", message: "writeSeq must be a non-negative integer" });
  const baseline = raw["baseline"];
  if (!isBaseline(baseline)) issues.push({ code: "bad-field", message: "baseline has an unknown shape" });
  const mraw = raw["manifests"];
  if (!isObject(mraw)) issues.push({ code: "bad-field", message: "manifests must be an object" });
  if (issues.length > 0 || !isBaseline(baseline) || !isObject(mraw) || typeof writeSeq !== "number") return { kind: "invalid", issues };

  if ((await sha256(specText)) !== specSha256) issues.push({ code: "hash-mismatch", message: "the specification text does not match its stored SHA-256" });
  const id = specProjectId(specText);
  if (id === null) issues.push({ code: "spec-unparseable", message: "the specification text is not a JSON object with project.id" });
  else if (id !== projectId) issues.push({ code: "project-id-mismatch", message: `spec project.id "${id}" differs from the record project id "${projectId}"` });
  const manifestValues: Partial<Record<ManifestName, unknown>> = {};
  const texts: Partial<Record<ManifestName, string>> = {};
  for (const n of MANIFEST_NAMES) {
    const t = mraw[n];
    if (typeof t !== "string") { issues.push({ code: "manifest-invalid", message: `manifest ${n} is missing or not text` }); continue; }
    const r = parseManifest(n, t);
    if (!r.ok) { issues.push({ code: "manifest-invalid", message: `manifest ${n}: ${r.issues[0]?.path.join(".") ?? ""} ${r.issues[0]?.message ?? ""}`.trim() }); continue; }
    manifestValues[n] = r.value;
    texts[n] = t;
  }
  const pm = manifestValues.project as ManifestMap["project"] | undefined;
  if (pm && pm.projectId !== projectId) issues.push({ code: "manifest-project-mismatch", message: `project manifest id "${pm.projectId}" differs from the record project id "${projectId}"` });
  if (issues.length > 0) return { kind: "invalid", issues };
  return {
    kind: "ok",
    record: { format, projectKey, name, projectId, specText, specSha256, baseline, manifests: texts as Record<ManifestName, string>, writeSeq },
    project: { projectKey, name, projectId, specText, baseline, manifests: manifestValues as unknown as ManifestMap },
  };
}

// ---------------------------------------------------------------- transactions

export interface DbContents {
  records: unknown[];
  meta: Record<string, unknown>;
}

/** One readonly transaction: every project record plus the named meta entries (stored value, or undefined). */
export async function readContents(conn: IdbConnection, metaKeys: readonly string[]): Promise<DbContents> {
  const slots = new Map<string, { value: unknown }>();
  let all: { value: unknown } | undefined;
  await runTransaction(conn, [STORE_PROJECTS, STORE_META], "readonly", (tx) => {
    all = tx.store(STORE_PROJECTS).getAll();
    for (const k of metaKeys) slots.set(k, tx.store(STORE_META).get(k));
  });
  return { records: (all?.value as unknown[] | undefined) ?? [], meta: Object.fromEntries([...slots].map(([k, s]) => [k, s.value])) };
}

/** One readonly transaction reading one project record. */
export async function readRecord(conn: IdbConnection, projectKey: string): Promise<unknown> {
  let slot: { value: unknown } | undefined;
  await runTransaction(conn, [STORE_PROJECTS], "readonly", (tx) => { slot = tx.store(STORE_PROJECTS).get(projectKey); });
  return slot?.value;
}

export type WriteOutcome = "written" | "conflict" | "foreign" | "newer-format";

function checkStored(stored: unknown, expectedSeq: number): WriteOutcome {
  if (stored === undefined) return expectedSeq === 0 ? "written" : "conflict";
  if (!isObject(stored)) return "foreign";
  const f = stored["format"];
  if (typeof f === "number" && Number.isInteger(f) && f > RECORD_FORMAT) return "newer-format";
  const seq = stored["writeSeq"];
  if (f !== RECORD_FORMAT || typeof seq !== "number" || !Number.isInteger(seq)) return "foreign";
  return seq === expectedSeq ? "written" : "conflict";
}

/**
 * Compare-and-swap write, in ONE readwrite transaction: read the stored record, and only if its writeSeq equals
 * expectedSeq (0 = no record) put the new record (and the active key). Otherwise abort: nothing is written. The record
 * is fully built (hash and canonical text) before this is called; nothing asynchronous runs inside the transaction.
 * Resolves only after the transaction committed. Rejects with IdbError on any storage failure.
 */
export async function writeRecord(conn: IdbConnection, record: ProjectRecord, expectedSeq: number, setActive: boolean): Promise<WriteOutcome> {
  let outcome = "written" as WriteOutcome;
  try {
    await runTransaction(conn, [STORE_PROJECTS, STORE_META], "readwrite", (tx) => {
      tx.store(STORE_PROJECTS).get(record.projectKey, (stored, t) => {
        outcome = checkStored(stored, expectedSeq);
        if (outcome !== "written") { t.abort(); return; }
        t.store(STORE_PROJECTS).put(record);
        if (setActive) t.store(STORE_META).put({ key: ACTIVE_KEY, value: record.projectKey });
      });
    }, { durability: "strict" });
  } catch (e) {
    if (outcome !== "written") return outcome;
    throw e;
  }
  return outcome;
}

// ---------------------------------------------------------------- recovery

export interface Recovery {
  format: number;
  kind: "monstera.studio.recovery";
  specText: string | null;
  baseline: unknown;
  manifests: Record<string, string>;
}

export function recoveryFromSnapshot(s: ProjectSnapshot): Recovery {
  const manifests: Record<string, string> = {};
  for (const n of MANIFEST_NAMES) {
    try { manifests[n] = serializeManifest(n, s.manifests[n] as never); } catch { /* an invalid manifest is left out rather than invented */ }
  }
  return { format: RECORD_FORMAT, kind: "monstera.studio.recovery", specText: s.specText, baseline: s.baseline, manifests };
}

/** From the raw stored value, exactly as stored. Only string manifest entries are carried. */
export function recoveryFromRaw(raw: unknown): Recovery {
  const o = isObject(raw) ? raw : {};
  const m = isObject(o["manifests"]) ? o["manifests"] : {};
  const manifests = Object.fromEntries(Object.keys(m).sort().filter((k) => typeof m[k] === "string").map((k) => [k, m[k] as string]));
  return { format: RECORD_FORMAT, kind: "monstera.studio.recovery", specText: typeof o["specText"] === "string" ? o["specText"] : null, baseline: o["baseline"] ?? null, manifests };
}
