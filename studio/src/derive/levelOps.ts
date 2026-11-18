// Pure level operations (task 4.3): add, duplicate, move, delete and edit the levels manifest.
//
// Every planner returns the NEXT levels manifest or a refusal; none mutates its input or throws. Each result is checked
// with the existing manifest validator (schema, unique ids, unique and sorted order, stream and wave rules), so no second
// rule set exists here. Deletion asks the cross-reference index, so a level the project still points at cannot be removed.
import type { Json } from "../schema/schema";
import { validateManifest, type DifficultyStep, type Level, type LevelsManifest, type ManifestMap, type Placement, type Wave } from "../project/manifests";
import { buildXrefIndex, type XrefEntry } from "../project/xref";

export type LevelOpResult = { ok: true; levels: LevelsManifest } | { ok: false; reason: string; references?: XrefEntry[] };

const refuse = (reason: string, references?: XrefEntry[]): LevelOpResult => (references === undefined ? { ok: false, reason } : { ok: false, reason, references });
const ID_MAX = 32;

/** Lowercase letters, digits and hyphens, starting with a letter, at most `max` characters (the manifest id pattern). */
export function slug(text: string, fallback: string, max = ID_MAX): string {
  let s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
  if (!/^[a-z]/.test(s)) s = s === "" ? fallback : `${fallback}-${s}`.slice(0, max);
  return s.length < 2 ? `${fallback}`.slice(0, max) : s;
}
/** `base`, else `base-2`, `base-3`, ... the first one not in `taken`, never longer than `max` characters. */
export function freeId(base: string, taken: ReadonlySet<string>, max = ID_MAX): string {
  const b = base.slice(0, max);
  if (!taken.has(b)) return b;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${b.slice(0, max - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
const checked = (levels: Level[], from: LevelsManifest): LevelOpResult => {
  const next: LevelsManifest = { ...from, levels };
  const r = validateManifest("levels", next);
  if (r.ok) return { ok: true, levels: next };
  const i = r.issues[0];
  return refuse(`${i?.path.join(".") ?? ""} ${i?.message ?? "the levels manifest is invalid"}`.trim());
};
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const indexOf = (m: LevelsManifest, id: string): number => m.levels.findIndex((l) => l.id === id);

export function addLevel(m: LevelsManifest, name: string): LevelOpResult {
  const clean = name.trim();
  if (clean === "") return refuse("a level needs a name");
  if (m.levels.length >= 32) return refuse("a project holds at most 32 levels");
  const id = freeId(slug(clean, "level"), new Set(m.levels.map((l) => l.id)));
  const order = m.levels.reduce((n, l) => Math.max(n, l.order), 0) + 1;
  return checked([...m.levels, { id, name: clean.slice(0, 60), order, placements: [], waves: [], difficulty: [] }], m);
}
/** Deep copy placed right after its source; later levels move down one position so `order` stays unique and sorted. */
export function duplicateLevel(m: LevelsManifest, id: string): LevelOpResult {
  const at = indexOf(m, id);
  const src = m.levels[at];
  if (src === undefined) return refuse(`"${id}" is not a level`);
  if (m.levels.length >= 32) return refuse("a project holds at most 32 levels");
  const copy: Level = { ...clone(src), id: freeId(`${src.id}-copy`.slice(0, ID_MAX), new Set(m.levels.map((l) => l.id))), name: `${src.name} copy`.slice(0, 60), order: src.order + 1 };
  let prev = copy.order;
  const rest = m.levels.slice(at + 1).map((l) => { prev = Math.max(l.order, prev + 1); return { ...l, order: prev }; });
  return checked([...m.levels.slice(0, at + 1), copy, ...rest], m);
}
/** Swaps position and `order` with the neighbour; the array stays sorted by order. */
export function moveLevel(m: LevelsManifest, id: string, dir: -1 | 1): LevelOpResult {
  const at = indexOf(m, id);
  const to = at + dir;
  const a = m.levels[at], b = m.levels[to];
  if (a === undefined) return refuse(`"${id}" is not a level`);
  if (b === undefined) return refuse(dir < 0 ? "the level is already first" : "the level is already last");
  const next = m.levels.slice();
  next[at] = { ...b, order: a.order };
  next[to] = { ...a, order: b.order };
  return checked(next, m);
}
/** Refused while anything refers to the level (the active level of the project); the reason names every referrer. */
export function removeLevel(doc: Json | null, manifests: ManifestMap, id: string): LevelOpResult {
  if (indexOf(manifests.levels, id) < 0) return refuse(`"${id}" is not a level`);
  const refs = buildXrefIndex(doc, manifests).referencesTo("level", id);
  if (refs.length > 0) return refuse(`level '${id}' cannot be deleted: ${refs.map((r) => r.label).join("; ")}`, [...refs]);
  return checked(manifests.levels.levels.filter((l) => l.id !== id), manifests.levels);
}

// ------------------------------------------------------------------ editing one level
const edit = (m: LevelsManifest, id: string, change: (l: Level) => Level | string): LevelOpResult => {
  const at = indexOf(m, id);
  const l = m.levels[at];
  if (l === undefined) return refuse(`"${id}" is not a level`);
  const r = change(clone(l));
  if (typeof r === "string") return refuse(r);
  const next = m.levels.slice();
  next[at] = r;
  return checked(next, m);
};
export const renameLevel = (m: LevelsManifest, id: string, name: string): LevelOpResult =>
  name.trim() === "" ? refuse("a level needs a name") : edit(m, id, (l) => ({ ...l, name: name.trim().slice(0, 60) }));
const taken = (list: { id: string }[]): Set<string> => new Set(list.map((x) => x.id));
const streams = (l: Level): Set<string> => new Set([...l.waves.map((w) => w.stream), ...l.difficulty.map((d) => d.stream)]);

export const addPlacement = (m: LevelsManifest, id: string, kind: string): LevelOpResult => edit(m, id, (l) => {
  const p: Placement = { id: freeId("placement", taken(l.placements)), kind, x: 0, y: 0, vx: 0, vy: 0, controlled: false };
  return { ...l, placements: [...l.placements, p] };
});
export const setPlacement = (m: LevelsManifest, id: string, placementId: string, patch: Partial<Omit<Placement, "id">>): LevelOpResult =>
  edit(m, id, (l) => (l.placements.some((p) => p.id === placementId) ? { ...l, placements: l.placements.map((p) => (p.id === placementId ? { ...p, ...patch } : p)) } : `"${placementId}" is not a placement`));
export const removePlacement = (m: LevelsManifest, id: string, placementId: string): LevelOpResult =>
  edit(m, id, (l) => ({ ...l, placements: l.placements.filter((p) => p.id !== placementId) }));

export const addWave = (m: LevelsManifest, id: string, kind: string): LevelOpResult => edit(m, id, (l) => {
  const wid = freeId("wave", taken(l.waves));
  const w: Wave = { id: wid, stream: freeId(kind.slice(0, 28) || "wave", streams(l)), kind, startTick: 0, intervalTicks: 60, xMin: 0, xMax: 0, yMin: 0, yMax: 0, vx: 0, vy: 0 };
  return { ...l, waves: [...l.waves, w] };
});
export const setWave = (m: LevelsManifest, id: string, waveId: string, patch: Partial<Omit<Wave, "id">>): LevelOpResult =>
  edit(m, id, (l) => (l.waves.some((w) => w.id === waveId) ? { ...l, waves: l.waves.map((w) => (w.id === waveId ? { ...w, ...patch } : w)) } : `"${waveId}" is not a wave`));
/** A wave a difficulty step still uses cannot be removed; the reason lists the steps. */
export const removeWave = (m: LevelsManifest, id: string, waveId: string): LevelOpResult => edit(m, id, (l) => {
  const users = l.difficulty.filter((d) => d.waveId === waveId).map((d) => d.id);
  if (users.length > 0) return `wave '${waveId}' is used by difficulty step${users.length === 1 ? "" : "s"} ${users.map((u) => `'${u}'`).join(", ")}`;
  return { ...l, waves: l.waves.filter((w) => w.id !== waveId) };
});

export const addStep = (m: LevelsManifest, id: string, waveId: string): LevelOpResult => edit(m, id, (l) => {
  const w = l.waves.find((x) => x.id === waveId);
  if (w === undefined) return `"${waveId}" is not a wave of this level`;
  const s: DifficultyStep = {
    id: freeId("step", taken(l.difficulty)), waveId, stream: freeId(`${w.stream.slice(0, 24)}-late`, streams(l)),
    atTick: w.startTick + Math.max(1, w.intervalTicks), intervalTicks: Math.max(1, Math.floor(w.intervalTicks / 2)), vx: w.vx, vy: w.vy,
  };
  return { ...l, difficulty: [...l.difficulty, s] };
});
export const setStep = (m: LevelsManifest, id: string, stepId: string, patch: Partial<Omit<DifficultyStep, "id">>): LevelOpResult =>
  edit(m, id, (l) => (l.difficulty.some((d) => d.id === stepId) ? { ...l, difficulty: l.difficulty.map((d) => (d.id === stepId ? { ...d, ...patch } : d)) } : `"${stepId}" is not a difficulty step`));
export const removeStep = (m: LevelsManifest, id: string, stepId: string): LevelOpResult =>
  edit(m, id, (l) => ({ ...l, difficulty: l.difficulty.filter((d) => d.id !== stepId) }));
