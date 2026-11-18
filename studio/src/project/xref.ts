// Cross-reference index (task 1.4). A DERIVED, read-only view over the one document and the sidecar manifests: it lists
// every place that refers to a shared id (a spec kind, an asset, a level) so the UI can answer "who uses this kind".
// It owns no ids: kind definitions are read from game.runtime.kinds of the spec every time an index is built, and an
// index is never edited. It is rebuilt (or reused when both inputs are the same objects) by XrefCache.
//
// Which fields are references is decided by the real schemas, nothing else:
//   spec (module designer)  input.tapKind, initialEntities[].kind, spawners[].kind, collisions[].a / .b      -> kind
//   assets    (assets)      assets[].kindRefs[]                                                                -> kind
//   animations (sprites)    animations[].kindRef; sheets[].assetId                                             -> kind; asset
//   levels    (levels)      levels[].placements[].kind, levels[].waves[].kind                                  -> kind
//   gameplay  (gameplay)    collectibles[].kind / .collectorKind, enemies[].kind / .targetKind                 -> kind
//   project   (dashboard)   derivation.activeLevel                                                            -> level
// Empty strings mean "none" (tapKind, kindRef, activeLevel) and are not references.
// NOT indexed, on purpose: integrations monetization.placements[].rewardKind ("Reward name", a game-economy label, not a
// spec kind), spawner and wave `stream` names (they share the kind id pattern but name PRNG streams), difficulty
// `waveId` (internal to one level, checked by the levels manifest) and proposal ops[].path (free text, not a typed field).
import { specKindReferences } from "../draft/ops";
import { getAt, toIssuePath } from "../draft/path";
import type { ModuleId } from "../app/capabilities";
import type { Json } from "../schema/schema";
import type { ManifestMap, ManifestName } from "./manifests";
/** A path that cannot be modified: entries and their paths are frozen at runtime as well. */
export type ReadonlyPath = readonly (string | number)[];
/**
 * The manifests that have fields the index reads as outgoing references (the buildXrefIndex branches below). A manifest not
 * listed here (integrations, proposal) holds no indexed reference, so it can never be a suppressed cross-reference source.
 */
export const XREF_REFERENCE_SOURCES = ["assets", "animations", "levels", "gameplay", "project"] as const satisfies readonly ManifestName[];
export type XrefTargetType = "kind" | "asset" | "level";
export type XrefSourceManifest = "spec" | ManifestName;
export type XrefRefType =
  | "spec.input.tapKind" | "spec.initialEntity.kind" | "spec.spawner.kind" | "spec.collision.a" | "spec.collision.b"
  | "assets.kindRefs" | "animations.kindRef" | "animations.sheet.assetId"
  | "levels.placement.kind" | "levels.wave.kind"
  | "gameplay.collectible.kind" | "gameplay.collectible.collectorKind" | "gameplay.enemy.kind" | "gameplay.enemy.targetKind"
  | "project.activeLevel";
export interface XrefEntry {
  /** The Studio module that owns the field holding the reference (where the user fixes it). */
  readonly module: ModuleId;
  /** "spec" for the canonical spec, otherwise the manifest name. */
  readonly manifest: XrefSourceManifest;
  /** Path inside that document (spec: from the root, e.g. game.runtime.spawners[1].kind). */
  readonly path: ReadonlyPath;
  /** The same path in the engine's "$.a.b[0]" form (spec) or "name:$.a.b[0]" (manifest); unique per entry. */
  readonly pathText: string;
  readonly targetType: XrefTargetType;
  /** The id the field holds. Not necessarily defined (see XrefIndex.isDefined). */
  readonly targetId: string;
  readonly type: XrefRefType;
  /** Short human wording, e.g. "levels: level 'one', wave 'w1' (kind)". */
  readonly label: string;
}
const MODULE_RANK: Record<string, number> = { designer: 0, assets: 1, sprites: 2, levels: 3, gameplay: 4, backend: 5, monetization: 6, dashboard: 7 };
const SOURCE_RANK: Record<XrefSourceManifest, number> = { spec: 0, assets: 1, animations: 2, levels: 3, gameplay: 4, integrations: 5, project: 6, proposal: 7 };
const textPath = (manifest: XrefSourceManifest, path: ReadonlyPath): string => (manifest === "spec" ? toIssuePath([...path]) : `${manifest}:${toIssuePath([...path])}`);
function comparePath(a: ReadonlyPath, b: ReadonlyPath): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string | number, y = b[i] as string | number;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return typeof x === "number" ? -1 : typeof y === "number" ? 1 : x < y ? -1 : 1;
  }
  return a.length - b.length;
}
/** Total, input-order-independent order: module, source, path (array indices numerically), then type. */
export function compareEntries(a: XrefEntry, b: XrefEntry): number {
  return (MODULE_RANK[a.module] ?? 99) - (MODULE_RANK[b.module] ?? 99)
    || SOURCE_RANK[a.manifest] - SOURCE_RANK[b.manifest]
    || comparePath(a.path, b.path)
    || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0);
}
const EMPTY: readonly XrefEntry[] = Object.freeze([]);
/**
 * The index is immutable at runtime: the instance, `entries`, every entry, every entry's path and every list returned by
 * a lookup are frozen, and the lookup lists hold the very same entry objects as `entries`, so a consumer can neither
 * change a result nor make the lookup disagree with the entry list. The lookup Map and the definition Sets are ES private
 * fields (#): they are not properties of the instance at all, so nothing outside the class can reach, replace or
 * mutate them (a frozen instance alone would not stop `map.set`). Only the frozen lists they hand out leave the class.
 *
 * Definition sources. isDefined answers from the definitions found in the inputs: the spec's game.runtime.kinds (when
 * that list is structurally readable), the assets manifest and the levels manifest (when present). A source that is
 * absent or unreadable is NOT an empty set: canJudge() is false for it and callers must not report an id as unknown.
 */
export class XrefIndex {
  /** Every reference, sorted by compareEntries. */
  readonly entries: readonly XrefEntry[];
  readonly #byTarget = new Map<string, readonly XrefEntry[]>();
  readonly #kinds: ReadonlySet<string> | null;
  readonly #assets: ReadonlySet<string> | null;
  readonly #levels: ReadonlySet<string> | null;
  /** The inputs this index was built from (identity), kept private for isCurrent(); never exposed, never a copy. */
  readonly #sourceDoc: Json | null;
  readonly #sourceManifests: Partial<ManifestMap> | null;
  constructor(
    sourceDoc: Json | null, sourceManifests: Partial<ManifestMap> | null, entries: readonly XrefEntry[],
    defined: { kinds: string[] | null; assets: string[] | null; levels: string[] | null },
  ) {
    this.#sourceDoc = sourceDoc;
    this.#sourceManifests = sourceManifests;
    const sorted = entries.map((e) => Object.freeze({ ...e, path: Object.freeze([...e.path]) })).sort(compareEntries);
    this.entries = Object.freeze(sorted);
    const lists = new Map<string, XrefEntry[]>();
    for (const e of sorted) {
      const k = `${e.targetType}\u0000${e.targetId}`;
      const list = lists.get(k);
      if (list) list.push(e); else lists.set(k, [e]);
    }
    for (const [k, list] of lists) this.#byTarget.set(k, Object.freeze(list));
    this.#kinds = defined.kinds === null ? null : new Set(defined.kinds);
    this.#assets = defined.assets === null ? null : new Set(defined.assets);
    this.#levels = defined.levels === null ? null : new Set(defined.levels);
    Object.freeze(this);
  }
  /** Every reference to one id, in index order. Constant time per lookup. The list is frozen and shared. */
  referencesTo(targetType: XrefTargetType, id: string): readonly XrefEntry[] {
    return this.#byTarget.get(`${targetType}\u0000${id}`) ?? EMPTY;
  }
  /** Every reference to a spec kind id. */
  referencesToKind(id: string): readonly XrefEntry[] { return this.referencesTo("kind", id); }
  #definitions(targetType: XrefTargetType): ReadonlySet<string> | null {
    return targetType === "kind" ? this.#kinds : targetType === "asset" ? this.#assets : this.#levels;
  }
  /** Whether the definition source for this target type is present and readable (so "not defined" means "unknown"). */
  canJudge(targetType: XrefTargetType): boolean { return this.#definitions(targetType) !== null; }
  /** Whether the id is defined. False when the source is unavailable too; check canJudge before treating false as "unknown". */
  isDefined(targetType: XrefTargetType, id: string): boolean { return this.#definitions(targetType)?.has(id) ?? false; }
  /** True when `doc` and `manifests` are the very objects this index was built from (structural sharing makes this exact). */
  isCurrent(doc: Json | null, manifests: Partial<ManifestMap> | null): boolean { return doc === this.#sourceDoc && manifests === this.#sourceManifests; }
}
/**
 * The kind ids the spec defines, or null when game.runtime.kinds is missing, not a list, or holds an element without a
 * string id (a structurally unreadable definition source). An empty list is readable: it defines no kinds.
 */
export function readKindDefinitions(doc: Json | null): string[] | null {
  const kinds = getAt(doc ?? undefined, ["game", "runtime", "kinds"]);
  if (!Array.isArray(kinds)) return null;
  const ids: string[] = [];
  for (const k of kinds) {
    const id = getAt(k, ["id"]);
    if (typeof id !== "string") return null;
    if (id !== "") ids.push(id);
  }
  return ids;
}
/** Builds the index. Pure and deterministic: equal inputs give an identical entry list regardless of object key order. */
export function buildXrefIndex(doc: Json | null, manifests: Partial<ManifestMap> | null): XrefIndex {
  const out: XrefEntry[] = [];
  const add = (module: ModuleId, manifest: XrefSourceManifest, path: ReadonlyPath, targetType: XrefTargetType, targetId: string, type: XrefRefType, label: string): void => {
    if (targetId !== "") out.push({ module, manifest, path, pathText: textPath(manifest, path), targetType, targetId, type, label });
  };
  const SPEC_TYPE: Record<string, XrefRefType> = {
    "input.tapKind": "spec.input.tapKind", "initialEntity.kind": "spec.initialEntity.kind", "spawner.kind": "spec.spawner.kind",
    "collision.a": "spec.collision.a", "collision.b": "spec.collision.b",
  };
  if (doc !== null) for (const r of specKindReferences(doc)) add("designer", "spec", r.path, "kind", r.kindId, SPEC_TYPE[r.type] as XrefRefType, `designer: ${r.label}`);
  if (manifests !== null) {
    manifests.assets?.assets.forEach((a, i) => a.kindRefs.forEach((k, j) => add("assets", "assets", ["assets", i, "kindRefs", j], "kind", k, "assets.kindRefs", `assets: asset '${a.id}' kind link`)));
    manifests.animations?.sheets.forEach((s, i) => add("sprites", "animations", ["sheets", i, "assetId"], "asset", s.assetId, "animations.sheet.assetId", `animations: sheet '${s.id}' image`));
    manifests.animations?.animations.forEach((a, i) => add("sprites", "animations", ["animations", i, "kindRef"], "kind", a.kindRef, "animations.kindRef", `animations: animation '${a.id}' kind`));
    manifests.levels?.levels.forEach((l, i) => {
      l.placements.forEach((p, j) => add("levels", "levels", ["levels", i, "placements", j, "kind"], "kind", p.kind, "levels.placement.kind", `levels: level '${l.id}', placement '${p.id}'`));
      l.waves.forEach((w, j) => add("levels", "levels", ["levels", i, "waves", j, "kind"], "kind", w.kind, "levels.wave.kind", `levels: level '${l.id}', wave '${w.id}'`));
    });
    manifests.gameplay?.collectibles.forEach((c, i) => {
      add("gameplay", "gameplay", ["collectibles", i, "kind"], "kind", c.kind, "gameplay.collectible.kind", `gameplay: collectible '${c.id}' (collectible kind)`);
      add("gameplay", "gameplay", ["collectibles", i, "collectorKind"], "kind", c.collectorKind, "gameplay.collectible.collectorKind", `gameplay: collectible '${c.id}' (collector kind)`);
    });
    manifests.gameplay?.enemies.forEach((e, i) => {
      add("gameplay", "gameplay", ["enemies", i, "kind"], "kind", e.kind, "gameplay.enemy.kind", `gameplay: enemy '${e.id}' (enemy kind)`);
      add("gameplay", "gameplay", ["enemies", i, "targetKind"], "kind", e.targetKind, "gameplay.enemy.targetKind", `gameplay: enemy '${e.id}' (target kind)`);
    });
    if (manifests.project) add("dashboard", "project", ["derivation", "activeLevel"], "level", manifests.project.derivation.activeLevel, "project.activeLevel", "project: active level");
  }
  return new XrefIndex(doc, manifests, out, {
    kinds: readKindDefinitions(doc),
    assets: manifests?.assets ? manifests.assets.assets.map((a) => a.id) : null,
    levels: manifests?.levels ? manifests.levels.levels.map((l) => l.id) : null,
  });
}/**
 * Keeps the index of the latest inputs. get() returns the cached index while doc and manifests are the same objects
 * (the controller and DraftStore use structural sharing, so any edit yields a new object); otherwise it rebuilds.
 * invalidate() drops it explicitly. There is no incremental update: a rebuild is one linear pass.
 */
export class XrefCache {
  private cached: XrefIndex | null = null;
  /** Number of builds so far (lets tests prove reuse and rebuild). */
  builds = 0;
  get(doc: Json | null, manifests: Partial<ManifestMap> | null): XrefIndex {
    if (this.cached !== null && this.cached.isCurrent(doc, manifests)) return this.cached;
    this.builds++;
    this.cached = buildXrefIndex(doc, manifests);
    return this.cached;
  }
  invalidate(): void { this.cached = null; }
}
