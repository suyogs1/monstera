// Asset library helpers (task 2.2): list filters and the delete decision. Pure; the cross-reference index is the only authority
// on who uses an asset (task 1.4), so deleting never looks at manifests directly.
import type { Asset, AssetsManifest } from "../project/manifests";
import { removeAsset } from "../project/manifests/assetIds";
import type { XrefEntry, XrefIndex } from "../project/xref";
export interface LibraryFilter {
  category?: Asset["category"] | "all";
  kind?: Asset["kind"] | "all";
  /** Only assets linked to this spec kind id (R4.4, "by entity"). */
  kindRef?: string | "all";
}
export function filterAssets(assets: readonly Asset[], f: LibraryFilter): Asset[] {
  return assets.filter((a) =>
    (f.category === undefined || f.category === "all" || a.category === f.category)
    && (f.kind === undefined || f.kind === "all" || a.kind === f.kind)
    && (f.kindRef === undefined || f.kindRef === "all" || a.kindRefs.includes(f.kindRef)));
}
export type AssetDeletePlan =
  | { ok: true; manifest: AssetsManifest }
  | { ok: false; reason: string; references: readonly XrefEntry[] };
/** Removes the asset (the counter stays) unless something refers to it; then nothing changes and every reference is listed. */
export function planAssetDelete(manifest: AssetsManifest, index: XrefIndex, id: string): AssetDeletePlan {
  if (!manifest.assets.some((a) => a.id === id)) return { ok: false, reason: `"${id}" is not an asset`, references: [] };
  const references = index.referencesTo("asset", id);
  if (references.length > 0) {
    return { ok: false, reason: `"${id}" is still used by ${references.length} place${references.length === 1 ? "" : "s"}: ${references.map((r) => r.label).join("; ")}`, references };
  }
  return { ok: true, manifest: removeAsset(manifest, id) };
}
