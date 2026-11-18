// Assigning an asset to spec kinds (task 2.3). Pure. The cross-reference index (task 1.4) turns `kindRefs` into the
// "asset links kind" reference, so a linked kind cannot be deleted and a rename rewrites the link.
import type { Asset, AssetsManifest } from "../project/manifests";
export type AssignPlan = { ok: true; manifest: AssetsManifest } | { ok: false; reason: string };
/** Replaces the kinds linked to one asset. The stored list is sorted and without duplicates (the manifest's own rule). */
export function planAssign(manifest: AssetsManifest, assetId: string, kindIds: readonly string[], knownKinds: readonly string[]): AssignPlan {
  if (!manifest.assets.some((a) => a.id === assetId)) return { ok: false, reason: `"${assetId}" is not an asset` };
  const unknown = kindIds.find((k) => !knownKinds.includes(k));
  if (unknown !== undefined) return { ok: false, reason: `"${unknown}" is not a kind in this game` };
  const next = [...new Set(kindIds)].sort();
  return { ok: true, manifest: { ...manifest, assets: manifest.assets.map((a) => (a.id === assetId ? { ...a, kindRefs: next } : a)) } };
}
/** The image shown on a kind card: the first linked image by id order, or null. Audio is never a thumbnail. */
export function linkedImage(manifest: AssetsManifest | undefined, kindId: string): Asset | null {
  if (manifest === undefined || kindId === "") return null;
  return manifest.assets.find((a) => a.kind === "image" && a.kindRefs.includes(kindId)) ?? null;
}
