// Project-wide kind rename and delete (task 1.4). Pure planners: they take the document and the manifests and return the
// complete next state, or a refusal, and change nothing. ProjectController applies a successful plan as ONE history
// entry (see ProjectController.renameKind / removeKind), which is what makes it atomic and undoable in one step.
//
// The spec side is the existing Designer operation (draft/ops renameKind / removeKind). The manifest side is driven by
// the cross-reference index, so the set of fields that are rewritten or that block a delete is exactly the set the index
// reports; there is no second list of reference fields. Every changed manifest is re-validated with the normal manifest
// validator before the plan succeeds; one that would become invalid refuses the whole rename.
import { removeKind, renameKind } from "../draft/ops";
import { setAt } from "../draft/path";
import type { Json } from "../schema/schema";
import { MANIFEST_NAMES, validateManifest, type ManifestMap, type ManifestName } from "./manifests";
import { buildXrefIndex, type XrefEntry } from "./xref";
export interface KindRenamePlan {
  ok: true;
  doc: Json;
  manifests: ManifestMap;
  /** References rewritten in the spec and in each manifest (only manifests that changed are listed). */
  updated: { spec: number; manifests: Partial<Record<ManifestName, number>>; total: number };
}
export type KindRenameResult = KindRenamePlan | { ok: false; reason: string };
/** Null when the id is acceptable, otherwise the reason it is not. */
export type KindIdCheck = (id: string) => string | null;
/**
 * The kind-id rule is the canonical spec schema's (game.runtime.kinds[].id, the engine's own `pattern`), read by the
 * caller from the engine schema model and handed in as a pattern string. Nothing here spells the rule out, so there is no
 * second copy to drift. Fails closed: an unavailable or malformed pattern rejects every new id.
 */
export function kindIdCheck(pattern: string | undefined): KindIdCheck {
  let re: RegExp | null = null;
  try { re = pattern === undefined ? null : new RegExp(pattern); } catch { re = null; }
  return (id) => {
    if (re === null) return "the kind id rule is not available, so the new id cannot be checked";
    return re.test(id) ? null : `'${id}' is not a valid kind id (the specification allows a lowercase letter, then lowercase letters, digits or hyphens, at most 32 characters)`;
  };
}
/**
 * Order of refusals (unchanged for the existing ones): unknown source, no-op, empty, taken id; then, for a real rename,
 * an invalid new id. Nothing is changed before every check has passed.
 */
export function planKindRename(doc: Json, manifests: ManifestMap, from: string, to: string, check: KindIdCheck): KindRenameResult {
  const specResult = renameKind(doc, from, to);
  if (!specResult.ok) return specResult;
  if (from === to) return { ok: true, doc, manifests, updated: { spec: 0, manifests: {}, total: 0 } };
  const invalid = check(to);
  if (invalid !== null) return { ok: false, reason: invalid };
  const refs = buildXrefIndex(doc, manifests).referencesToKind(from).filter((r) => r.manifest !== "spec");
  const next: Record<string, Json> = {};
  const counts: Partial<Record<ManifestName, number>> = {};
  for (const r of refs) {
    const name = r.manifest as ManifestName;
    next[name] = setAt((next[name] ?? (manifests[name] as unknown as Json)), [...r.path], to);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  // assets[].kindRefs must stay sorted and without duplicates (the manifest's own rule); a rename can break both.
  if (next["assets"] !== undefined) {
    const a = next["assets"] as unknown as ManifestMap["assets"];
    next["assets"] = { ...a, assets: a.assets.map((x) => (x.kindRefs.includes(to) ? { ...x, kindRefs: [...new Set(x.kindRefs)].sort() } : x)) } as unknown as Json;
  }
  const result: ManifestMap = refs.length === 0 ? manifests : { ...manifests };
  for (const name of MANIFEST_NAMES) {
    const value = next[name];
    if (value === undefined) continue;
    const v = validateManifest(name, value);
    if (!v.ok) {
      const i = v.issues[0];
      return { ok: false, reason: `renaming '${from}' to '${to}' would make the ${name} manifest invalid: ${i?.path.join(".") ?? ""} ${i?.message ?? ""}`.trim() };
    }
    (result as unknown as Record<string, unknown>)[name] = v.value;
  }
  const total = specResult.updatedReferences + Object.values(counts).reduce((n, c) => n + (c ?? 0), 0);
  return { ok: true, doc: specResult.doc, manifests: result, updated: { spec: specResult.updatedReferences, manifests: counts, total } };
}
export type KindRemoveResult =
  | { ok: true; doc: Json }
  | { ok: false; reason: string; references: XrefEntry[] };
/** Removes a kind only when nothing in the spec or in any manifest refers to it. Otherwise lists every reference. */
export function planKindRemoval(doc: Json, manifests: ManifestMap, id: string): KindRemoveResult {
  const refs = buildXrefIndex(doc, manifests).referencesToKind(id);
  if (refs.length > 0) {
    const modules = [...new Set(refs.map((r) => r.module))];
    return { ok: false, reason: `'${id}' is still used by ${refs.length} place${refs.length === 1 ? "" : "s"} (${modules.join(", ")})`, references: [...refs] };
  }
  const r = removeKind(doc, id);
  return r.ok ? { ok: true, doc: r.doc } : { ok: false, reason: r.reason, references: [] };
}
