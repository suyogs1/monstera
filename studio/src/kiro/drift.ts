// Drift view model (task 7.4, requirement 10.3): reads an exported project ZIP and classifies every Studio-written file with the
// Task 7.1 importer, the same classification tools/check-drift.sh prints. Nothing is written and nothing is sent anywhere.
import { MAX_TOTAL_BYTES, readZip } from "../export/unzip";
import { importPack, type ClassifiedFile, type DriftState, type PackImport } from "../pack/import";
export interface DriftReport {
  files: ClassifiedFile[];
  counts: Record<DriftState, number>;
  /** Edited or missing scaffold files: the check script exits non-zero for exactly these. */
  drift: ClassifiedFile[];
  invalid: PackImport["invalid"];
}
export type DriftResult = { ok: true; report: DriftReport } | { ok: false; error: string };
export function reportOf(p: PackImport): DriftReport {
  const counts: Record<DriftState, number> = { unchanged: 0, edited: 0, missing: 0, unknown: 0 };
  for (const f of p.files) counts[f.state]++;
  return { files: p.files, counts, drift: p.drift, invalid: p.invalid };
}
/** Reads the archive with the hardened reader (limits, path and checksum checks), then classifies it. */
export async function driftFromZip(bytes: Uint8Array): Promise<DriftResult> {
  const zip = await readZip(bytes, () => ({ max: MAX_TOTAL_BYTES }));
  if (!zip.ok) return { ok: false, error: zip.message };
  const imported = await importPack(zip.entries);
  return imported.ok ? { ok: true, report: reportOf(imported.value) } : { ok: false, error: imported.error };
}
