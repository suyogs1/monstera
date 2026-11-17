// One-way, read-only migration of the legacy localStorage draft (monstera.studio.draft.v1) into one IndexedDB project.
//
// Algorithm (every step before the next; nothing is deleted anywhere):
//   1. Read the flag and all records (one readonly transaction). Flag set => 'skipped'. Any record other than our own
//      deterministic key => 'skipped' (never migrate into a non-empty database, never touch an unrelated record).
//   2. Read the legacy key through a getItem-only reader (readLegacyDraft, which needs no IndexedDB connection).
//      None => 'nothing-to-migrate' (empty database) or 'skipped'. A reader that THROWS => 'unreadable' (never
//      interpreted as "no draft").
//   3. Parse it strictly. Corrupt JSON, version !== 1, non-string docText, malformed baseline, a spec without
//      project.id or default inputs that cannot be supplied => 'refused' with a reason. The legacy value, the database
//      and the flag stay untouched.
//   4. Build the record (hash and canonical manifest text first, no transaction open). The optional origin back-fill
//      is injected (Session's rule: a draft stored without origin takes its template's origin); this module imports
//      neither Session nor React.
//   5. Write the record with compare-and-swap under the fixed key 'legacy-draft-v1' (one transaction) WITHOUT the
//      active-project pointer. If a record with that key already exists from an interrupted run it is resumed ONLY
//      when it is valid and deeply equals the record we would write. Any difference => 'record-diverged'; an existing
//      record is never overwritten, whatever its writeSeq.
//   6. Read it back in a SEPARATE transaction and deep-compare spec text and document, baseline and manifest text.
//   7. Only then write the migration flag AND the active-project pointer together in ONE final readwrite transaction.
// A crash after step 5 leaves a record with neither flag nor pointer: the next boot finds only our own key,
// re-verifies (steps 5-7) and then activates it. It cannot duplicate (the key is fixed) and cannot touch another
// project. A verification failure writes neither entry and returns the legacy values for the caller to keep in memory.
import type { Baseline, Origin } from "../draft/store";
import { IdbError, STORE_META, classifyError, runTransaction, type IdbConnection, type IdbErrorInfo } from "./idb";
import type { ManifestMap } from "./manifests";
import {
  ACTIVE_KEY, buildRecord, evaluateRecord, isBaseline, readContents, readRecord, sameValue, specProjectId, writeRecord,
  type ProjectRecord, type ProjectSnapshot, type Sha256,
} from "./record";

export const LEGACY_KEY = "monstera.studio.draft.v1";
export const LEGACY_PROJECT_KEY = "legacy-draft-v1";
export const MIGRATION_META_KEY = "migration:draft.v1";

/** Everything the migration knows about the draft; Session forwards it to buildDefaultManifests (defaults.ts). */
export interface DefaultManifestsContext {
  projectId: string;
  projectName: string;
  /** SHA-256 of the spec text exactly as it will be stored. */
  specSha256: string;
  baseline: Baseline;
  /** baseline.sha256, else the SHA-256 of baseline.canonicalText, else null (unknown: never invented). */
  baselineSha256: string | null;
}

export interface MigrationRuntime {
  /** Read-only access to the legacy storage. setItem/removeItem/clear are never used (the type does not offer them). */
  legacy: Pick<Storage, "getItem">;
  /**
   * Default manifests for the migrated project (Session supplies buildDefaultManifests, see defaults.ts). May throw when
   * an input it needs is unknown: the draft is then refused ('inputs-unavailable') instead of inventing values.
   */
  defaultManifests: (ctx: DefaultManifestsContext) => ManifestMap | Promise<ManifestMap>;
  /** Optional: origin for a draft stored without one. Absent: the baseline is migrated exactly as stored. */
  backfillOrigin?: (baseline: Baseline) => Promise<Origin | null>;
  sha256: Sha256;
  now: () => number;
}

export type RefusedReason = "corrupt-json" | "unsupported-version" | "bad-doc-text" | "bad-baseline" | "bad-spec" | "inputs-unavailable";

export type MigrationResult =
  | { status: "nothing-to-migrate" }
  | { status: "skipped"; reason: "flag-set" | "projects-exist" | "no-legacy-draft" }
  | { status: "migrated"; projectKey: string; resumed: boolean }
  | { status: "refused"; reason: RefusedReason; message: string }
  | { status: "unreadable"; message: string }
  | { status: "failed"; reason: "verification" | "storage" | "record-diverged" | "manifests"; message: string; error: IdbErrorInfo | null; legacy: ProjectSnapshot };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

interface Parsed { docText: string; baseline: Baseline; projectId: string }
type ParseResult = { ok: true; value: Parsed } | { ok: false; reason: Exclude<RefusedReason, "inputs-unavailable">; message: string };

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

export type LegacyRuntime = Pick<MigrationRuntime, "legacy" | "defaultManifests" | "backfillOrigin" | "sha256">;

export type LegacyRead =
  | { status: "recovered"; raw: string; snapshot: ProjectSnapshot }
  | { status: "none" }
  | { status: "refused"; reason: RefusedReason; message: string }
  | { status: "unreadable"; message: string };

/**
 * Pure, read-only: reads the legacy draft through getItem only and builds the project snapshot it would migrate to.
 * Needs no IndexedDB connection. A reader that throws is 'unreadable', never 'none'. Never writes anywhere.
 */
export async function readLegacyDraft(rt: LegacyRuntime): Promise<LegacyRead> {
  let raw: string | null;
  try { raw = rt.legacy.getItem(LEGACY_KEY); } catch (e) {
    return { status: "unreadable", message: `the earlier draft could not be read from this browser (${e instanceof Error ? e.message : "unknown error"})` };
  }
  if (raw === null || raw === "") return { status: "none" };
  const parsed = parseLegacy(raw);
  if (!parsed.ok) return { status: "refused", reason: parsed.reason, message: parsed.message };
  const { docText, projectId } = parsed.value;
  try {
    let baseline = parsed.value.baseline;
    if (baseline.origin === undefined && rt.backfillOrigin) baseline = { ...baseline, origin: await rt.backfillOrigin(baseline) };
    const specSha256 = await rt.sha256(docText);
    const name = baseline.label;
    const baselineSha256 = baseline.sha256 ?? (baseline.canonicalText !== null ? await rt.sha256(baseline.canonicalText) : null);
    const manifests = await rt.defaultManifests({ projectId, projectName: name, specSha256, baseline, baselineSha256 });
    return { status: "recovered", raw, snapshot: { projectKey: LEGACY_PROJECT_KEY, name, projectId, specText: docText, baseline, manifests } };
  } catch (e) {
    return { status: "refused", reason: "inputs-unavailable", message: `the earlier draft is valid but its project defaults could not be built (${e instanceof Error ? e.message : "unknown error"})` };
  }
}

export async function migrateLegacyDraft(conn: IdbConnection, rt: MigrationRuntime): Promise<MigrationResult> {
  const { records, meta } = await readContents(conn, [MIGRATION_META_KEY]);
  if (meta[MIGRATION_META_KEY] !== undefined) return { status: "skipped", reason: "flag-set" };
  const own = records.find((r) => isObject(r) && r["projectKey"] === LEGACY_PROJECT_KEY);
  if (records.some((r) => r !== own)) return { status: "skipped", reason: "projects-exist" };

  const read = await readLegacyDraft(rt);
  if (read.status === "none") return records.length === 0 ? { status: "nothing-to-migrate" } : { status: "skipped", reason: "no-legacy-draft" };
  if (read.status === "refused") return { status: "refused", reason: read.reason, message: read.message };
  if (read.status === "unreadable") return { status: "unreadable", message: read.message };
  const { raw, snapshot } = read;
  const { baseline, projectId } = snapshot;
  const docText = snapshot.specText;
  const fail = (reason: "verification" | "storage" | "record-diverged" | "manifests", message: string, error: IdbErrorInfo | null = null): MigrationResult =>
    ({ status: "failed", reason, message, error, legacy: snapshot });

  let expected: ProjectRecord;
  try { expected = await buildRecord(snapshot, 1, rt.sha256); } catch (e) { return fail("manifests", (e as Error).message); }

  try {
    let resumed = false;
    if (own !== undefined) {
      resumed = true;
      const seen = await evaluateRecord(own, rt.sha256);
      // Resume only a valid record that deeply equals what we would write. Anything else is left exactly as it is.
      // The raw stored value is compared too, so an unknown extra field also counts as a difference.
      if (seen.kind !== "ok" || !sameValue(own, expected) || !sameValue(seen.record, expected)) {
        return fail("record-diverged", "the earlier migration record differs from the earlier draft; it is left untouched");
      }
    } else {
      // setActive=false: the record is NOT the active project until it has been verified (step 7).
      const outcome = await writeRecord(conn, expected, 0, false);
      if (outcome !== "written") return fail("record-diverged", `the migration record could not be created (${outcome})`);
    }

    const back = await evaluateRecord(await readRecord(conn, LEGACY_PROJECT_KEY), rt.sha256);
    if (back.kind !== "ok") return fail("verification", "the migrated record could not be read back as a valid project");
    const same = back.record.specText === docText && sameValue(JSON.parse(back.record.specText), JSON.parse(docText))
      && sameValue(back.record.baseline, baseline) && sameValue(back.record.manifests, expected.manifests)
      && back.record.projectId === projectId && back.record.name === snapshot.name;
    if (!same) return fail("verification", "the migrated record differs from the legacy draft; it was not activated and no migration flag was written");

    const legacySha256 = await rt.sha256(raw);
    const migratedAt = rt.now();
    await runTransaction(conn, [STORE_META], "readwrite", (tx) => {
      const meta = tx.store(STORE_META);
      meta.put({ key: MIGRATION_META_KEY, format: 1, projectKey: LEGACY_PROJECT_KEY, legacySha256, migratedAt });
      meta.put({ key: ACTIVE_KEY, value: LEGACY_PROJECT_KEY });
    }, { durability: "strict" });
    return { status: "migrated", projectKey: LEGACY_PROJECT_KEY, resumed };
  } catch (e) {
    const info = e instanceof IdbError ? e.info : classifyError(e);
    return fail("storage", info.message, info);
  }
}
