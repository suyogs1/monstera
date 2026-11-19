// Project bundle export and import (task 1.5): one ZIP holding the canonical spec, the Studio manifests and the asset bytes.
//
//   monstera.spec.json
//   studio-pack/<manifest>.json            one per manifest name
//   studio-pack/assets/<assetId>/<file>    one per asset in assets.json
//
// This is the minimum layout a bundle needs to round-trip. Task 7.1 owns the full pack (ownership classes, the pack manifest,
// scaffold and derived files) and will extend the layout policy below. Import is a pure function: it returns a complete,
// validated project or a refusal and writes nothing, so the caller replaces its project only after a full success (atomic).
import { sha256Bytes } from "../assets/import";
import { MAX_FILE_BYTES } from "../assets/limits";
import { sniffAsset } from "../assets/sniff";
import { findSecrets, secretRules } from "../integrations/secrets";
import { MANIFEST_NAMES, parseManifest, serializeManifest, type ManifestMap, type ManifestName } from "../project/manifests";
import { decodeUtf8Strict, MAX_JSON_BYTES, parseStrictJson } from "../project/manifests/strictJson";
import { readZip, type EntryPolicy, type ZipRefusal } from "./unzip";
import { buildZip, type ZipEntry } from "./zip";

export const SPEC_PATH = "monstera.spec.json";
export const PACK_ROOT = "studio-pack";
export const manifestPath = (name: ManifestName): string => `${PACK_ROOT}/${name}.json`;
export const assetPath = (id: string, file: string): string => `${PACK_ROOT}/assets/${id}/${file}`;

export interface BundleProject {
  specText: string;
  manifests: ManifestMap;
  /** Asset bytes by asset id (the id in assets.json). */
  assets: ReadonlyMap<string, Uint8Array>;
}

export type BundleRefusal =
  | ZipRefusal | "missing-entry" | "invalid-spec" | "invalid-manifest" | "asset-mismatch" | "project-mismatch" | "secret";
export type BundleImport = { ok: true; project: BundleProject } | { ok: false; code: BundleRefusal; message: string };

// A credential can be an object key; never echo a path segment that itself matches a secret rule.
const safePath = (p: readonly (string | number)[]): string => p.map((s) => (typeof s === "string" && secretRules(s).length > 0 ? "<key>" : String(s))).join(".");
/** Importer messages interpolate attacker-controlled keys and values; a message that matches a secret rule is replaced whole. */
export const redact = (message: string): string => (secretRules(message).length > 0 ? "<message withheld: it contains a credential-shaped value>" : message);
const enc = new TextEncoder();
const byPath = (a: ZipEntry, b: ZipEntry): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** The archive of a project. A pure function of its inputs: entries sorted by path, fixed mode and timestamp, canonical manifest text. */
export function exportBundle(p: BundleProject): Uint8Array<ArrayBuffer> {
  const entries: ZipEntry[] = [{ path: SPEC_PATH, data: enc.encode(p.specText), mode: 0o644 }];
  for (const n of MANIFEST_NAMES) entries.push({ path: manifestPath(n), data: enc.encode(serializeManifest(n, p.manifests[n] as never)), mode: 0o644 });
  const listed = new Set<string>();
  for (const a of p.manifests.assets.assets) {
    const data = p.assets.get(a.id);
    if (!data) throw new Error(`asset ${a.id} has no bytes, so the project cannot be exported`);
    listed.add(a.id);
    entries.push({ path: assetPath(a.id, a.file), data, mode: 0o644 });
  }
  for (const id of p.assets.keys()) if (!listed.has(id)) throw new Error(`bytes for ${id} are not listed in the assets manifest`);
  return buildZip(entries.sort(byPath));
}

const MANIFEST_FILES = new Map<string, ManifestName>(MANIFEST_NAMES.map((n) => [manifestPath(n), n]));
const ASSET_PATH = new RegExp(`^${PACK_ROOT}/assets/([^/]+)/([^/]+)$`);

const policy: EntryPolicy = (path) => {
  if (path === SPEC_PATH || MANIFEST_FILES.has(path)) return { max: MAX_JSON_BYTES };
  if (ASSET_PATH.test(path)) return { max: MAX_FILE_BYTES };
  return { reason: `only ${SPEC_PATH}, ${PACK_ROOT}/<manifest>.json and ${PACK_ROOT}/assets/<id>/<file> are accepted` };
};

const refuse = (code: BundleRefusal, message: string): BundleImport => ({ ok: false, code, message });

/** Reads and fully validates a bundle. Nothing is applied: the caller receives the whole project or a refusal. */
export async function importBundle(bytes: Uint8Array): Promise<BundleImport> {
  const zip = await readZip(bytes, policy);
  if (!zip.ok) return zip;
  const files = new Map(zip.entries.map((e) => [e.path, e.data]));

  const specBytes = files.get(SPEC_PATH);
  if (!specBytes) return refuse("missing-entry", `${SPEC_PATH} is missing`);
  const spec = decodeUtf8Strict(specBytes);
  if (!spec.ok) return refuse("invalid-spec", redact(`${SPEC_PATH}: ${spec.issue.message}`));
  const parsed = parseStrictJson(spec.text);
  if (!parsed.ok) return refuse("invalid-spec", redact(`${SPEC_PATH}: ${parsed.issue.message}`));

  const specSecret = findSecrets(parsed.value)[0];
  if (specSecret) return refuse("secret", `${SPEC_PATH}: a credential-shaped value (${specSecret.rule}) at ${safePath(specSecret.path)} is not accepted`);
  const manifests: Partial<Record<ManifestName, unknown>> = {};
  for (const n of MANIFEST_NAMES) {
    const data = files.get(manifestPath(n));
    if (!data) return refuse("missing-entry", `${manifestPath(n)} is missing`);
    const r = parseManifest(n, data);
    if (!r.ok) return refuse("invalid-manifest", redact(`${manifestPath(n)}: ${r.issues[0]?.path.join(".") ?? ""} ${r.issues[0]?.message ?? ""}`.trim()));
    const found = findSecrets(r.value)[0];
    if (found) return refuse("secret", `${manifestPath(n)}: a credential-shaped value (${found.rule}) at ${safePath(found.path)} is not accepted`);
    manifests[n] = r.value;
  }
  const map = manifests as unknown as ManifestMap;

  const specId = (parsed.value as { project?: { id?: unknown } } | null)?.project?.id;
  if (specId !== map.project.projectId) return refuse("project-mismatch", `the spec's project.id differs from the project manifest's projectId "${map.project.projectId}"`);

  const assets = new Map<string, Uint8Array>();
  const expected = new Set<string>();
  for (const a of map.assets.assets) {
    const path = assetPath(a.id, a.file);
    expected.add(path);
    const data = files.get(path);
    if (!data) return refuse("missing-entry", `${path} is missing`);
    if (data.length !== a.bytes) return refuse("asset-mismatch", `${path} has ${data.length} bytes, the manifest says ${a.bytes}`);
    if ((await sha256Bytes(data)) !== a.sha256) return refuse("asset-mismatch", `${path} does not match its SHA-256 in the manifest`);
    const sniffed = sniffAsset(data);
    if (!sniffed.ok || sniffed.mime !== a.mime) return refuse("asset-mismatch", `${path} content is not the ${a.mime} the manifest declares`);
    assets.set(a.id, data);
  }
  for (const p of files.keys()) if (ASSET_PATH.test(p) && !expected.has(p)) return refuse("asset-mismatch", `${p} is not listed in the assets manifest`);

  return { ok: true, project: { specText: spec.text, manifests: map, assets } };
}
