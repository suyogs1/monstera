// Structural edits that touch more than one field. They are editing conveniences over the one canonical document;
// the engine still decides whether the result is valid (R1.2). Nothing here knows game rules.
import type { Json } from "../schema/schema";
import { getAt, insertAt, removeIndex, setAt, type Path } from "./path";

export type Doc = Json;

export interface KindRef {
  /** Where the kind id is referenced. */
  path: Path;
  /** Human wording for the UI, e.g. "spawner 2 (kind)". */
  label: string;
}

const RT: Path = ["game", "runtime"];

const asArray = (doc: Doc, path: Path): Json[] => {
  const v = getAt(doc, path);
  return Array.isArray(v) ? v : [];
};

export function kindIds(doc: Doc): string[] {
  return asArray(doc, [...RT, "kinds"]).map((k) => String(getAt(k, ["id"]) ?? ""));
}

/** Every place the spec refers to a kind id (not the definition itself). */
export function kindReferences(doc: Doc, id: string): KindRef[] {
  const refs: KindRef[] = [];
  if (getAt(doc, ["game", "input", "tapKind"]) === id) refs.push({ path: ["game", "input", "tapKind"], label: "input: tap spawns" });
  asArray(doc, [...RT, "initialEntities"]).forEach((e, i) => {
    if (getAt(e, ["kind"]) === id) refs.push({ path: [...RT, "initialEntities", i, "kind"], label: `starting entity ${i + 1}` });
  });
  asArray(doc, [...RT, "spawners"]).forEach((s, i) => {
    if (getAt(s, ["kind"]) === id) refs.push({ path: [...RT, "spawners", i, "kind"], label: `spawner ${i + 1}` });
  });
  asArray(doc, [...RT, "collisions"]).forEach((c, i) => {
    if (getAt(c, ["a"]) === id) refs.push({ path: [...RT, "collisions", i, "a"], label: `collision ${i + 1} (first kind)` });
    if (getAt(c, ["b"]) === id) refs.push({ path: [...RT, "collisions", i, "b"], label: `collision ${i + 1} (second kind)` });
  });
  return refs;
}

export type RenameResult = { ok: true; doc: Doc; updatedReferences: number } | { ok: false; reason: string };

/** Renames a kind and every reference to it in one step. Refuses an id that is already taken or an unknown source. */
export function renameKind(doc: Doc, from: string, to: string): RenameResult {
  const ids = kindIds(doc);
  const index = ids.indexOf(from);
  if (index < 0) return { ok: false, reason: `no kind '${from}'` };
  if (from === to) return { ok: true, doc, updatedReferences: 0 };
  if (to === "") return { ok: false, reason: "a kind id cannot be empty" };
  if (ids.includes(to)) return { ok: false, reason: `'${to}' is already a kind id` };
  const refs = kindReferences(doc, from);
  let next = setAt(doc, [...RT, "kinds", index, "id"], to);
  for (const r of refs) next = setAt(next, r.path, to);
  return { ok: true, doc: next, updatedReferences: refs.length };
}

export type RemoveResult = { ok: true; doc: Doc } | { ok: false; reason: string; references: KindRef[] };

/** Removes a kind definition. Blocked while anything still refers to it. */
export function removeKind(doc: Doc, id: string): RemoveResult {
  const index = kindIds(doc).indexOf(id);
  if (index < 0) return { ok: false, reason: `no kind '${id}'`, references: [] };
  const references = kindReferences(doc, id);
  if (references.length > 0) {
    return { ok: false, reason: `'${id}' is still used by ${references.length} place${references.length === 1 ? "" : "s"}`, references };
  }
  return { ok: true, doc: removeIndex(doc, [...RT, "kinds"], index) };
}

const uniqueKindId = (doc: Doc): string => {
  const taken = new Set(kindIds(doc));
  for (let n = 1; ; n++) if (!taken.has(`kind-${n}`)) return `kind-${n}`;
};

// New list items are written out in full (the spec has no hidden defaults). These starting values are Studio's
// choice for a new row, visible and editable immediately; they are not engine defaults.
const UNIT = 65536;

export function addKind(doc: Doc): { doc: Doc; id: string } {
  const id = uniqueKindId(doc);
  const kind: Json = { id, color: "#FFFFFF", glyph: "", effect: "none", width: UNIT, height: UNIT, lifetimeTicks: 0, exitPolicy: "despawn" };
  return { doc: insertAt(doc, [...RT, "kinds"], kind), id };
}

export function addInitialEntity(doc: Doc): Doc {
  const kind = kindIds(doc)[0] ?? "";
  return insertAt(doc, [...RT, "initialEntities"], { kind, x: 0, y: 0, vx: 0, vy: 0, controlled: false });
}

export function addSpawner(doc: Doc): Doc {
  const kind = kindIds(doc)[0] ?? "";
  const taken = new Set(asArray(doc, [...RT, "spawners"]).map((s) => String(getAt(s, ["stream"]) ?? "")));
  let n = 1;
  while (taken.has(`stream-${n}`)) n++;
  return insertAt(doc, [...RT, "spawners"], {
    stream: `stream-${n}`, kind, startTick: 0, intervalTicks: 60, xMin: 0, xMax: 0, yMin: 0, yMax: 0, vx: 0, vy: 0,
  });
}

export function addCollision(doc: Doc): Doc {
  const [a = "", b = a] = kindIds(doc);
  return insertAt(doc, [...RT, "collisions"], { a, b, despawnA: false, despawnB: false, score: 0, lives: 0 });
}

export const removeInitialEntity = (doc: Doc, i: number): Doc => removeIndex(doc, [...RT, "initialEntities"], i);
export const removeSpawner = (doc: Doc, i: number): Doc => removeIndex(doc, [...RT, "spawners"], i);
export const removeCollision = (doc: Doc, i: number): Doc => removeIndex(doc, [...RT, "collisions"], i);
