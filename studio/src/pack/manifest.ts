// MONSTERA-STUDIO-MANIFEST.json: sha256 and class for every Studio-written file (requirement 9.2). The engine's
// MONSTERA-MANIFEST.json stays authoritative for its own files and is neither listed nor edited here.
import { unsafePath } from "../export/zip";
import { parseStrictJson } from "../project/manifests/strictJson";
import { classOf, isManifestClass, MANIFEST_PATH, type ManifestClass } from "./layout";
export const STUDIO_MANIFEST_SCHEMA = "monstera.studio.pack-manifest";
export const STUDIO_MANIFEST_VERSION = 1;
export interface PackManifestFile { path: string; class: ManifestClass; sha256: string }
export interface PackManifest { schema: typeof STUDIO_MANIFEST_SCHEMA; version: 1; files: PackManifestFile[] }
export type Sha256Bytes = (data: Uint8Array) => Promise<string>;

export const sha256Bytes: Sha256Bytes = async (data) => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Canonical text: files sorted by path (code unit order), two-space indent, LF, one trailing newline. */
export function serializePackManifest(files: readonly PackManifestFile[]): string {
  const sorted = files.slice().sort(byPath).map((f) => ({ path: f.path, class: f.class, sha256: f.sha256 }));
  return JSON.stringify({ schema: STUDIO_MANIFEST_SCHEMA, version: STUDIO_MANIFEST_VERSION, files: sorted }, null, 2) + "\n";
}
export type PackManifestResult = { ok: true; value: PackManifest } | { ok: false; error: string };
const fail = (error: string): PackManifestResult => ({ ok: false, error });
/** Strict read and validation: envelope, version, exact keys, safe unique paths, class consistent with the layout. */
export function parsePackManifest(bytes: Uint8Array): PackManifestResult {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return fail("not valid UTF-8"); }
  const parsed = parseStrictJson(text);
  if (!parsed.ok) return fail(`${parsed.issue.message} (at offset ${parsed.issue.offset})`);
  const v = parsed.value as Record<string, unknown> | null;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return fail("not an object");
  if (Object.keys(v).sort().join() !== "files,schema,version") return fail("unexpected or missing keys");
  if (v["schema"] !== STUDIO_MANIFEST_SCHEMA) return fail(`schema must be "${STUDIO_MANIFEST_SCHEMA}"`);
  if (typeof v["version"] === "number" && v["version"] > STUDIO_MANIFEST_VERSION) return fail(`version ${v["version"]} was written by a newer Studio`);
  if (v["version"] !== STUDIO_MANIFEST_VERSION) return fail("unsupported version");
  if (!Array.isArray(v["files"])) return fail("files must be an array");
  const seen = new Set<string>();
  const files: PackManifestFile[] = [];
  for (const [i, f] of (v["files"] as unknown[]).entries()) {
    const r = f as Record<string, unknown> | null;
    if (typeof r !== "object" || r === null || Array.isArray(r) || Object.keys(r).sort().join() !== "class,path,sha256") return fail(`files[${i}]: unexpected or missing keys`);
    const { path, sha256 } = r as { path: unknown; sha256: unknown };
    if (typeof path !== "string") return fail(`files[${i}].path must be a string`);
    const why = unsafePath(path);
    if (why) return fail(`files[${i}].path '${path}' is unsafe: ${why}`);
    if (path === MANIFEST_PATH) return fail("the manifest cannot list itself");
    if (!isManifestClass(r["class"])) return fail(`files[${i}].class is not a Studio class`);
    if (classOf(path) !== r["class"]) return fail(`files[${i}]: '${path}' is not a ${r["class"]} path in the pack layout`);
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return fail(`files[${i}].sha256 must be 64 lowercase hex digits`);
    if (seen.has(path.toLowerCase())) return fail(`duplicate path '${path}'`);
    seen.add(path.toLowerCase());
    files.push({ path, class: r["class"], sha256 });
  }
  return { ok: true, value: { schema: STUDIO_MANIFEST_SCHEMA, version: 1, files } };
}
