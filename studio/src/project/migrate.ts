// One-way, read-only migration of the legacy localStorage draft (monstera.studio.draft.v1) into one IndexedDB project.
//
// Algorithm (every step before the next; nothing is deleted anywhere):
//   1. Read the flag and all records (one readonly transaction). Flag set => 'skipped'. Any record other than our own
//      deterministic key => 'skipped' (never migrate into a non-empty database, never touch an unrelated record).
//   2. Read the legacy key through a getItem-only reader. None => 'nothing-to-migrate' (empty database) or 'skipped'.
//   3. Parse it strictly. Corrupt JSON, version !== 1, non-string docText, malformed baseline or a spec without
//      project.id => 'refused' with a reason. The legacy value, the database and the flag stay untouched.
//   4. Build the record (hash and canonical manifest text first, no transaction open). The optional origin back-fill
//      is injected (Session's rule: a draft stored without origin takes its template's origin); this module imports
//      neither Session nor React.
//   5. Write the record with compare-and-swap under the fixed key 'legacy-draft-v1' (one transaction). If a record
//      with that key already exists from an interrupted run and already equals what we would write, no write happens.
//   6. Read it back in a SEPARATE transaction and deep-compare spec text and document, baseline and manifest text.
//   7. Only then write the flag in a third transaction.
// A crash after step 5 leaves a record without a flag: the next boot finds only our own key, re-verifies (steps 5-7)
// and sets the flag. It cannot duplicate (the key is fixed) and cannot touch another project. A verification failure
// sets no flag and returns the legacy values for the caller to keep in memory; a retry overwrites only our own record.
import type { Baseline, Origin } from "../draft/store";
import { IdbError, STORE_META, classifyError, runTransaction, type IdbConnection, type IdbErrorInfo } from "./idb";
import type { ManifestMap } from "./manifests";
import {
  buildRecord, evaluateRecord, isBaseline, readContents, readRecord, sameValue, specProjectId, writeRecord,
  type ProjectRecord, type ProjectSnapshot, type Sha256,
} from "./record";

export const LEGACY_KEY = "monstera.studio.draft.v1";
export const LEGACY_PROJECT_KEY = "legacy-draft-v1";
export const MIGRATION_META_KEY = "migration:draft.v1";

export interface MigrationRuntime {
  /** Read-only access to the legacy storage. setItem/removeItem/clear are never used (the type does not offer them). */
  legacy: Pick<Storage, "getItem">;
  /** Default manifests for the migrated project. Studio has no confirmed source for these yet (open decision). */
  defaultManifests: (ctx: { projectId: string; specSha256: string }) => ManifestMap;
  /** Optional: origin for a draft stored without one. Absent: the baseline is migrated exactly as stored. */
  backfillOrigin?: (baseline: Baseline) => Promise<Origin | null>;
  sha256: Sha256;
  now: () => number;
}

export type MigrationResult =
  | { status: "nothing-to-migrate" }
  | { status: "skipped"; reason: "flag-set" | "projects-exist" | "no-legacy-draft" }
  | { status: "migrated"; projectKey: string; resumed: boolean }
  | { status: "refused"; reason: "corrupt-json" | "unsupported-version" | "bad-doc-text" | "bad-baseline" | "bad-spec"; message: string }
  | { status: "failed"; reason: "verification" | "storage" | "record-diverged" | "manifests"; message: string; error: IdbErrorInfo | null; legacy: ProjectSnapshot };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

interface Parsed { docText: string; baseline: Baseline; projectId: string }
type ParseResult = { ok: true; value: Parsed } | { ok: false; reason: Extract<MigrationResult, { status: "refused" }>["reason"]; message: string };

function parseLegacy(raw: string): ParseResult {
  let top: unknown;
  try { top = JSON.parse(raw); } catch { return { ok: false, reason: "corrupt-json", message: "the legacy draft is not valid JSON" }; }
  if (!isObject(top)) return { ok: false, reason: "corrupt-json", message: "the legacy draft is not a JSON object" };
  if (top["version"] !== 1) return { ok: false, reason: "unsupported-version", message: `the legacy draft has version ${JSON.stringify(top["version"])}, only 1 is supported` };
  const docText = top["docText"];
  if (typeof docText !== "string") return { ok: false, reason: "bad-doc-text", message: "docText is not a string" };
  const baseline = top["baseline"];
  if (!isBaseline(baseline)) return { ok: false, reason: "bad-baseline", message: "the baseline has an unknown shape" };
  const projectId = specProjectId(docText);
  if (projectId === null) return { ok: false, reason: "bad-spec", message: "docText is not a JSON object with project.id" };
  return { ok: true, value: { docText, baseline, projectId } };
}

export async function migrateLegacyDraft(conn: IdbConnection, rt: MigrationRuntime): Promise<MigrationResult> {
  const { records, meta } = await readContents(conn, [MIGRATION_META_KEY]);
  if (meta[MIGRATION_META_KEY] !== undefined) return { status: "skipped", reason: "flag-set" };
  const own = records.find((r) => isObject(r) && r["projectKey"] === LEGACY_PROJECT_KEY);
  if (records.some((r) => r !== own)) return { status: "skipped", reason: "projects-exist" };

  let raw: string | null = null;
  try { raw = rt.legacy.getItem(LEGACY_KEY); } catch { raw = null; }
  if (raw === null || raw === "") return records.length === 0 ? { status: "nothing-to-migrate" } : { status: "skipped", reason: "no-legacy-draft" };

  const parsed = parseLegacy(raw);
  if (!parsed.ok) return { status: "refused", reason: parsed.reason, message: parsed.message };
  const { docText, projectId } = parsed.value;
  let baseline = parsed.value.baseline;
  if (baseline.origin === undefined && rt.backfillOrigin) baseline = { ...baseline, origin: await rt.backfillOrigin(baseline) };

  const specSha256 = await rt.sha256(docText);
  const snapshot: ProjectSnapshot = {
    projectKey: LEGACY_PROJECT_KEY, name: baseline.label, projectId, specText: docText, baseline,
    manifests: rt.defaultManifests({ projectId, specSha256 }),
  };
  const fail = (reason: "verification" | "storage" | "record-diverged" | "manifests", message: string, error: IdbErrorInfo | null = null): MigrationResult =>
    ({ status: "failed", reason, message, error, legacy: snapshot });

  let expected: ProjectRecord;
  try { expected = await buildRecord(snapshot, 1, rt.sha256); } catch (e) { return fail("manifests", (e as Error).message); }

  try {
    let resumed = false;
    if (own !== undefined) {
      resumed = true;
      const seen = await evaluateRecord(own, rt.sha256);
      const identical = seen.kind === "ok" && sameValue(seen.record, expected);
      if (!identical) {
        const seq = isObject(own) ? own["writeSeq"] : undefined;
        if (seq !== 1) return fail("record-diverged", "the earlier migration record was changed after it was written; it is left untouched");
        const outcome = await writeRecord(conn, expected, 1, true);
        if (outcome !== "written") return fail("record-diverged", `the earlier migration record could not be replaced (${outcome})`);
      }
    } else {
      const outcome = await writeRecord(conn, expected, 0, true);
      if (outcome !== "written") return fail("record-diverged", `the migration record could not be created (${outcome})`);
    }

    const back = await evaluateRecord(await readRecord(conn, LEGACY_PROJECT_KEY), rt.sha256);
    if (back.kind !== "ok") return fail("verification", "the migrated record could not be read back as a valid project");
    const same = back.record.specText === docText && sameValue(JSON.parse(back.record.specText), JSON.parse(docText))
      && sameValue(back.record.baseline, baseline) && sameValue(back.record.manifests, expected.manifests)
      && back.record.projectId === projectId && back.record.name === snapshot.name;
    if (!same) return fail("verification", "the migrated record differs from the legacy draft; no migration flag was written");

    const legacySha256 = await rt.sha256(raw);
    const migratedAt = rt.now();
    await runTransaction(conn, [STORE_META], "readwrite", (tx) => {
      tx.store(STORE_META).put({ key: MIGRATION_META_KEY, format: 1, projectKey: LEGACY_PROJECT_KEY, legacySha256, migratedAt });
    }, { durability: "strict" });
    return { status: "migrated", projectKey: LEGACY_PROJECT_KEY, resumed };
  } catch (e) {
    const info = e instanceof IdbError ? e.info : classifyError(e);
    return fail("storage", info.message, info);
  }
}
