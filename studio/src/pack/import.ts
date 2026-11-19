// Pack importer (task 7.1): reads an extracted tree, validates the manifest and every listed file, and classifies each
// file as unchanged, edited, missing or unknown (requirement 9.3). Reading ZIP bytes with limits belongs to task 1.5; this
// takes the already extracted entries. Nothing is written.
import { secretRules } from "../integrations/secrets";
import { unsafePath } from "../export/zip";
import { parseManifest, MANIFEST_NAMES, type ManifestName } from "../project/manifests";
import { classOf, MANIFEST_PATH, type ManifestClass } from "./layout";
import { parsePackManifest, sha256Bytes, type PackManifest, type Sha256Bytes } from "./manifest";
import type { PackFile } from "./export";

export type DriftState = "unchanged" | "edited" | "missing" | "unknown";
export interface ClassifiedFile { path: string; class: ManifestClass | null; state: DriftState }
export interface PackImport {
  manifest: PackManifest;
  files: ClassifiedFile[];
  /** Edited or missing studio-scaffold files: the drift the check script exits non-zero for. */
  drift: ClassifiedFile[];
  /** studio-pack/*.json that fail their schema (hand edits are allowed but validated on import). */
  invalid: { path: string; message: string }[];
}
export type ImportResult = { ok: true; value: PackImport } | { ok: false; error: string };

export async function importPack(files: readonly PackFile[], sha: Sha256Bytes = sha256Bytes): Promise<ImportResult> {
  const tree = new Map<string, Uint8Array>();
  for (const f of files) {
    const why = unsafePath(f.path);
    if (why) return { ok: false, error: `unsafe path '${f.path}': ${why}` };
    if (tree.has(f.path)) return { ok: false, error: `duplicate path '${f.path}'` };
    tree.set(f.path, f.data);
  }
  const raw = tree.get(MANIFEST_PATH);
  if (!raw) return { ok: false, error: `${MANIFEST_PATH} is missing` };
  const parsed = parsePackManifest(raw);
  if (!parsed.ok) return { ok: false, error: `${MANIFEST_PATH}: ${parsed.error}` };
  const listed = new Set(parsed.value.files.map((f) => f.path));
  const out: ClassifiedFile[] = [];
  for (const m of parsed.value.files) {
    const data = tree.get(m.path);
    out.push({ path: m.path, class: m.class, state: data === undefined ? "missing" : (await sha(data)) === m.sha256 ? "unchanged" : "edited" });
  }
  for (const path of tree.keys()) {
    if (path === MANIFEST_PATH || listed.has(path)) continue;
    const cls = classOf(path);
    // Engine-owned files and the spec are covered by the engine's own manifest and verify, not by this one.
    if (cls === "spec" || cls === "engine-owned") continue;
    out.push({ path, class: null, state: "unknown" });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const invalid: PackImport["invalid"] = [];
  for (const name of MANIFEST_NAMES) {
    const data = tree.get(`studio-pack/${name}.json`);
    if (!data) continue;
    const rule = secretRules(new TextDecoder("utf-8", { fatal: false }).decode(data))[0];
    if (rule) invalid.push({ path: `studio-pack/${name}.json`, message: `contains a credential-shaped value (${rule})` });
    const r = parseManifest(name as ManifestName, data);
    if (!r.ok) invalid.push({ path: `studio-pack/${name}.json`, message: r.issues[0] ? `${r.issues[0].path.join(".")} ${r.issues[0].message}` : "invalid" });
  }
  const drift = out.filter((f) => f.class === "studio-scaffold" && (f.state === "edited" || f.state === "missing"));
  return { ok: true, value: { manifest: parsed.value, files: out, drift, invalid } };
}
