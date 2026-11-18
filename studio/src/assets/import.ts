// Asset import planning (task 2.2). Pure apart from the injected probes: nothing here touches the project, storage or the DOM.
// The plan either carries the next assets manifest (new asset appended, counter advanced) or a refusal that leaves everything
// as it was. Order of checks: license, project limits and content sniffing (task 2.1, bytes only), category against the sniffed
// kind, decode (injected), SHA-256, id allocation, then the whole manifest through the same validator the store uses.
//
// Name and type. The declared file name and MIME type are never trusted: the sniffed type decides kind, MIME and the stored
// file extension. A name whose extension disagrees with the content is accepted with a notice (R4.2: type is decided by
// content); content that is not an allowed type (SVG, HTML, script, truncated, over-limit) is refused whatever it is called.
//
// Limit, stated plainly: MP3 has no container end, so sniffing checks the first frame only and cannot see trailing data
// (design: ID3v1/APE tags are legitimate). An MP3 is therefore accepted only if the browser also reads its metadata
// (`probeAudioMs`); trailing bytes after valid audio are stored as given and are only ever played through <audio>.
import type { AssetsManifest, Asset, Provenance } from "../project/manifests";
import { validateManifest } from "../project/manifests";
import { allocateAssetId } from "../project/manifests/assetIds";
import { vetAsset, type AssetType, type SniffedAsset } from "./sniff";
export type AssetCategory = Asset["category"];
export const IMAGE_CATEGORIES: readonly AssetCategory[] = ["sprite", "background", "ui"];
export const AUDIO_CATEGORIES: readonly AssetCategory[] = ["sfx", "music"];
export const MAX_DURATION_MS = 3_600_000;
const EXT: Record<AssetType, string> = { png: "png", jpeg: "jpg", webp: "webp", gif: "gif", wav: "wav", ogg: "ogg", mp3: "mp3" };
const NAMES: Record<AssetType, string> = { png: "PNG", jpeg: "JPEG", webp: "WebP", gif: "GIF", wav: "WAV", ogg: "Ogg", mp3: "MP3" };
const ALIASES: Record<AssetType, readonly string[]> = {
  png: ["png"], jpeg: ["jpg", "jpeg", "jpe"], webp: ["webp"], gif: ["gif"], wav: ["wav", "wave"], ogg: ["ogg", "oga", "opus"], mp3: ["mp3"],
};
export interface ImportInput {
  /** The name the user's file had. Used only to build a safe stored name and to notice a wrong extension. */
  fileName: string;
  /** The MIME type the browser reported, if any. Never trusted; only compared for a notice. */
  declaredMime?: string;
  bytes: Uint8Array;
  category: AssetCategory;
  provenance: Provenance;
}
export interface ImportDeps {
  sha256?: (bytes: Uint8Array) => Promise<string>;
  /** Decodes an image and returns its pixel size, or null when it cannot be decoded. Absent: header dimensions are used. */
  decodeImage?: (bytes: Uint8Array, mime: string) => Promise<{ width: number; height: number } | null>;
  /** Reads the duration of OGG and MP3 audio in milliseconds, or null when it cannot be read. Absent: those types are refused. */
  probeAudioMs?: (bytes: Uint8Array, mime: string) => Promise<number | null>;
}
export type ImportPlan =
  | { ok: true; asset: Asset; manifest: AssetsManifest; notices: string[] }
  | { ok: false; reason: string };
const refuse = (reason: string): ImportPlan => ({ ok: false, reason });
export const sha256Bytes = async (bytes: Uint8Array): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const u32le = (b: Uint8Array, at: number): number => ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>> 0;
/** Duration of a sniffed WAV from its fmt byte rate and data length; null when either is missing or the rate is zero. */
export function wavDurationMs(b: Uint8Array): number | null {
  let at = 12;
  let byteRate = 0;
  const tag = (o: number): string => String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);
  while (at + 8 <= b.length) {
    const len = u32le(b, at + 4);
    if (tag(at) === "fmt " && len >= 16) byteRate = u32le(b, at + 16);
    if (tag(at) === "data") return byteRate > 0 ? Math.floor((Math.min(len, b.length - at - 8) * 1000) / byteRate) : null;
    at += 8 + len + (len & 1);
  }
  return null;
}
/** A bare, schema-valid file name built from the user's name and the SNIFFED type (never the declared extension). */
export function storedFileName(declared: string, type: AssetType): string {
  const last = declared.split(/[\\/]/).pop() ?? "";
  const dot = last.lastIndexOf(".");
  const stem = (dot > 0 ? last.slice(0, dot) : last).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 50);
  return `${stem === "" ? "asset" : stem}.${EXT[type]}`;
}
function extensionNotices(input: ImportInput, sniffed: SniffedAsset, stored: string): string[] {
  const out: string[] = [];
  const last = input.fileName.split(/[\\/]/).pop() ?? "";
  const dot = last.lastIndexOf(".");
  const ext = dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
  if (ext !== "" && !ALIASES[sniffed.type].includes(ext)) {
    out.push(`The file name ends in ".${ext}" but its content is ${NAMES[sniffed.type]}. The content decides; it is stored as "${stored}".`);
  }
  if (input.declaredMime !== undefined && input.declaredMime !== "" && input.declaredMime !== sniffed.mime) {
    out.push(`The browser reported "${input.declaredMime}" but the content is ${sniffed.mime}; the content type is used.`);
  }
  return out;
}
/** Decides whether `input` may be added to `manifest` and builds the manifest that results. Never throws, never mutates. */
export async function planImport(manifest: AssetsManifest, input: ImportInput, deps: ImportDeps = {}): Promise<ImportPlan> {
  if (input.provenance.license.trim() === "") return refuse("A license is required. Enter proprietary-owned or an SPDX-style license (for example CC0-1.0).");
  const usage = { count: manifest.assets.length, totalBytes: manifest.assets.reduce((n, a) => n + a.bytes, 0) };
  const sniffed = vetAsset(input.bytes, usage);
  if (!sniffed.ok) return refuse(sniffed.reason);
  const allowed = sniffed.kind === "image" ? IMAGE_CATEGORIES : AUDIO_CATEGORIES;
  if (!allowed.includes(input.category)) {
    return refuse(`The content is ${sniffed.kind === "image" ? "an image" : "audio"}, so the category must be one of: ${allowed.join(", ")} (not "${input.category}").`);
  }
  let width = 0;
  let height = 0;
  let durationMs = 0;
  try {
    if (sniffed.kind === "image") {
      width = sniffed.width ?? 0;
      height = sniffed.height ?? 0;
      if (deps.decodeImage) {
        const d = await deps.decodeImage(input.bytes, sniffed.mime);
        if (d === null) return refuse("The image could not be decoded.");
        if (d.width !== width || d.height !== height) return refuse("The image header and the decoded image disagree on size.");
      }
    } else {
      const ms = sniffed.type === "wav" ? wavDurationMs(input.bytes) : deps.probeAudioMs ? await deps.probeAudioMs(input.bytes, sniffed.mime) : null;
      if (ms === null || !Number.isInteger(ms) || ms < 1) return refuse("The audio could not be read, or it is shorter than 1 ms.");
      if (ms > MAX_DURATION_MS) return refuse("The audio is longer than one hour.");
      durationMs = ms;
    }
  } catch {
    return refuse(sniffed.kind === "image" ? "The image could not be decoded." : "The audio could not be read.");
  }
  let sha256: string;
  try { sha256 = await (deps.sha256 ?? sha256Bytes)(input.bytes); } catch { return refuse("The file could not be hashed."); }
  let alloc: { id: string; nextSeq: number };
  try { alloc = allocateAssetId(manifest); } catch (e) { return refuse((e as Error).message); }
  const file = storedFileName(input.fileName, sniffed.type);
  const asset: Asset = {
    id: alloc.id, kind: sniffed.kind, category: input.category, file, mime: sniffed.mime, bytes: input.bytes.length, sha256,
    width, height, durationMs, kindRefs: [], provenance: { ...input.provenance, license: input.provenance.license.trim() },
  };
  const next: AssetsManifest = { ...manifest, nextSeq: alloc.nextSeq, assets: [...manifest.assets, asset] };
  const v = validateManifest("assets", next);
  if (!v.ok) {
    const i = v.issues[0];
    return refuse(`The asset record is not valid: ${i?.path.join(".") ?? ""} ${i?.message ?? ""}`.trim());
  }
  return { ok: true, asset, manifest: next, notices: extensionNotices(input, sniffed, file) };
}
