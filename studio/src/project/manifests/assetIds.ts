// Asset id allocation rule (Studio manifests, assets version 1).
//  - Studio generates ids as `asset-` plus the sequence number zero-padded to four digits (`asset-0007`, `asset-12345`).
//  - `nextSeq` is the next unused sequence number. Allocation uses it, then increases it by one. It is never decreased:
//    deleting an asset keeps `nextSeq`, and importing a project keeps the imported `nextSeq` unchanged.
//  - The validator rejects a manifest whose `nextSeq` is not above the numeric suffix of every generated-form id it contains,
//    so the next allocation cannot collide with an existing asset.
//  - Limit: the ids of deleted assets are not stored. A hand-edited `nextSeq` that was lowered but still exceeds every
//    existing suffix cannot be detected, and Studio does not claim to reconstruct that history.
//  - Ids that do not have the generated form (for example from a hand-written pack) are allowed and take no part in the counter.
import type { AssetsManifest } from "./types";

const GENERATED = /^asset-(\d{4,6})$/;
export const MAX_ASSET_SEQ = 100000;

export const formatAssetId = (seq: number): string => `asset-${String(seq).padStart(4, "0")}`;

/** Sequence number of a generated-form id, or null for any other id. */
export function assetSeq(id: string): number | null {
  const m = GENERATED.exec(id);
  if (!m || m[1] === undefined) return null;
  if (m[1].length > 4 && m[1].startsWith("0")) return null; // formatAssetId never emits extra leading zeros
  return Number(m[1]);
}

/** The id the next import receives and the counter value to store afterwards. Does not touch the manifest. */
export function allocateAssetId(m: AssetsManifest): { id: string; nextSeq: number } {
  if (m.nextSeq >= MAX_ASSET_SEQ) throw new Error("asset id counter exhausted");
  return { id: formatAssetId(m.nextSeq), nextSeq: m.nextSeq + 1 };
}

/** Removes an asset and leaves `nextSeq` as it is. */
export function removeAsset(m: AssetsManifest, id: string): AssetsManifest {
  return { ...m, assets: m.assets.filter((a) => a.id !== id) };
}
