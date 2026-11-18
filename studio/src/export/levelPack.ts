// Level variant export (task 4.3): each validated level at `studio-pack/derived/levels/<id>/monstera.spec.json`.
//
// This is only the derived/levels part of the future Studio pack (task 7.1 owns the pack as a whole: manifests,
// provenance, the rest of the tree). The file content is the engine's canonical text of the checked variant, never text
// that Studio serialized itself. Nothing but those files is written into the archive.
import type { VariantCheck } from "../derive/variants";
import { buildZip, type ZipEntry } from "./zip";

export const LEVEL_PACK_ROOT = "studio-pack/derived/levels";
export const levelVariantPath = (levelId: string): string => `${LEVEL_PACK_ROOT}/${levelId}/monstera.spec.json`;

/** Variants that may be exported: valid, deterministic, with the engine's canonical text. */
export const exportable = (checks: readonly VariantCheck[]): VariantCheck[] =>
  checks.filter((c) => c.status === "valid" && c.deterministic && c.canonicalText !== null);

export function levelPackEntries(checks: readonly VariantCheck[]): ZipEntry[] {
  const enc = new TextEncoder();
  return exportable(checks)
    .slice()
    .sort((a, b) => (a.levelId < b.levelId ? -1 : a.levelId > b.levelId ? 1 : 0))
    .map((c) => ({ path: levelVariantPath(c.levelId), data: enc.encode(c.canonicalText as string), mode: 0o644 }));
}
/** The archive of the exportable variants. Throws when none is exportable (nothing is written for an empty set). */
export function levelPackZip(checks: readonly VariantCheck[]): Uint8Array<ArrayBuffer> {
  const entries = levelPackEntries(checks);
  if (entries.length === 0) throw new Error("no level variant is valid, so there is nothing to export");
  return buildZip(entries);
}
