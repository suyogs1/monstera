// Pack exporter (task 7.1). Input: the files Studio generates for this export plus, on a re-export, the tree that was
// imported. Rules (requirement 9.4): a write-once file that already exists is kept byte for byte; a studio-scaffold file
// edited by the developer is not overwritten without an explicit per-path choice; studio-data is rewritten (Studio's copy
// wins). The archive is deterministic: sorted paths, fixed timestamps, fixed modes (see zip.ts).
import { buildZip, type ZipEntry } from "../export/zip";
import { classOf, MANIFEST_PATH, type ManifestClass } from "./layout";
import { parsePackManifest, serializePackManifest, sha256Bytes, type PackManifestFile, type Sha256Bytes } from "./manifest";

export interface PackFile { path: string; data: Uint8Array; /** Unix permission bits; 0644 when absent. Comes from the engine plan, never from the file name. */ mode?: number }
export type ScaffoldChoice = "keep" | "overwrite";
export interface ScaffoldConflict { path: string; existingSha256: string; manifestSha256: string | null; newSha256: string }
export interface ExportInput {
  /** Everything Studio writes in this export: spec, engine output, studio-pack files, templates. Not the manifest. */
  files: readonly PackFile[];
  /** The previously exported tree, when re-exporting over an imported project. */
  existing?: readonly PackFile[];
  /** Per-path answer for a conflict. "keep" keeps the developer's file and leaves it flagged as drift. */
  choices?: Readonly<Record<string, ScaffoldChoice>>;
  sha256?: Sha256Bytes;
}
export type ExportResult =
  | { ok: true; entries: ZipEntry[]; zip: Uint8Array<ArrayBuffer>; manifest: PackManifestFile[]; kept: string[] }
  | { ok: false; error: string; conflicts: ScaffoldConflict[] };

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function exportPack(input: ExportInput): Promise<ExportResult> {
  const sha = input.sha256 ?? sha256Bytes;
  const existing = new Map((input.existing ?? []).map((f) => [f.path, f.data]));
  let previous = new Map<string, string>();
  const old = existing.get(MANIFEST_PATH);
  if (old) {
    const parsed = parsePackManifest(old);
    if (!parsed.ok) return { ok: false, error: `existing ${MANIFEST_PATH} is invalid: ${parsed.error}`, conflicts: [] };
    previous = new Map(parsed.value.files.map((f) => [f.path, f.sha256]));
  }
  const seen = new Set<string>();
  const conflicts: ScaffoldConflict[] = [];
  const entries: ZipEntry[] = [];
  const manifest: PackManifestFile[] = [];
  const kept: string[] = [];
  for (const f of input.files.slice().sort((a, b) => cmp(a.path, b.path))) {
    const cls = classOf(f.path);
    if (cls === null) return { ok: false, error: `'${f.path}' is not part of the pack layout`, conflicts: [] };
    if (seen.has(f.path)) return { ok: false, error: `duplicate path '${f.path}'`, conflicts: [] };
    seen.add(f.path);
    let data = f.data;
    const onDisk = existing.get(f.path);
    if (cls === "write-once" && onDisk) {
      data = onDisk;
      kept.push(f.path);
    } else if (cls === "studio-scaffold" && onDisk && !same(onDisk, f.data)) {
      const existingSha256 = await sha(onDisk);
      const manifestSha256 = previous.get(f.path) ?? null;
      if (existingSha256 !== manifestSha256) {
        const choice = input.choices?.[f.path];
        if (choice === "keep") { data = onDisk; kept.push(f.path); }
        else if (choice !== "overwrite") conflicts.push({ path: f.path, existingSha256, manifestSha256, newSha256: await sha(f.data) });
      }
    }
    entries.push({ path: f.path, data, mode: f.mode ?? 0o644 });
    // A kept scaffold file is recorded with the hash Studio would write, so it keeps showing as edited (drift).
    if (cls !== "spec" && cls !== "engine-owned") manifest.push({ path: f.path, class: cls as ManifestClass, sha256: await sha(cls === "write-once" ? data : f.data) });
  }
  if (conflicts.length > 0) return { ok: false, error: `${conflicts.length} edited scaffold file(s) need a choice`, conflicts };
  entries.push({ path: MANIFEST_PATH, data: new TextEncoder().encode(serializePackManifest(manifest)), mode: 0o644 });
  entries.sort((a, b) => cmp(a.path, b.path));
  return { ok: true, entries, zip: buildZip(entries), manifest, kept };
}
