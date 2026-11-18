// Pure gameplay edits and checks (task 5.2): the planners return the NEXT gameplay manifest or a refusal; none mutates its
// input or throws. Every result is checked with the existing manifest validator, so no second rule set exists here. Field
// checks reuse the 5.1 compiler (unknown kinds, Designer collision conflicts); duplicate module pairs are the manifest
// validator's `duplicate-pair` rule, so an edit that would create one is refused before it is stored.
import type { Json } from "../schema/schema";
import { validateManifest, type GameplayManifest } from "../project/manifests";
import { sameValue } from "../project/record";
import { compileGameplay, type GameplayIssue } from "./gameplay";
import { freeId, slug } from "./levelOps";

export type GameplayOpResult = { ok: true; gameplay: GameplayManifest } | { ok: false; reason: string };
type Collectible = GameplayManifest["collectibles"][number];
type Enemy = GameplayManifest["enemies"][number];

const checked = (next: GameplayManifest): GameplayOpResult => {
  const r = validateManifest("gameplay", next);
  if (r.ok) return { ok: true, gameplay: next };
  const i = r.issues[0];
  return { ok: false, reason: `${i?.path.join(".") ?? ""} ${i?.message ?? "the gameplay manifest is invalid"}`.trim() };
};
const missing = (what: string, id: string): GameplayOpResult => ({ ok: false, reason: `no ${what} "${id}"` });

export const setLives = (m: GameplayManifest, start: number): GameplayOpResult => checked({ ...m, lives: { start } });
export const setWinScore = (m: GameplayManifest, winScore: number): GameplayOpResult => checked({ ...m, score: { winScore } });

const ids = (m: GameplayManifest): Set<string> => new Set([...m.collectibles.map((c) => c.id), ...m.enemies.map((e) => e.id)]);

/** The first pair of distinct kinds (then of equal kinds) that no module row uses yet in either order, or null. */
export function freePair(m: GameplayManifest, kinds: readonly string[]): [string, string] | null {
  const rows: [string, string][] = [...m.collectibles.map((c) => [c.kind, c.collectorKind] as [string, string]), ...m.enemies.map((e) => [e.kind, e.targetKind] as [string, string])];
  const used = new Set(rows.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  for (const same of [false, true]) for (const a of kinds) for (const b of kinds) if ((a === b) === same && !used.has(`${a}|${b}`)) return [a, b];
  return null;
}

export function addCollectible(m: GameplayManifest, kind: string, collectorKind: string): GameplayOpResult {
  if (kind === "" || collectorKind === "") return { ok: false, reason: "no free kind pair: every pair already has a row" };
  const id = freeId(slug(`${kind}-pickup`, "pickup"), ids(m));
  return checked({ ...m, collectibles: [...m.collectibles, { id, kind, collectorKind, points: 10, despawn: true }] });
}
export function setCollectible(m: GameplayManifest, id: string, patch: Partial<Omit<Collectible, "id">>): GameplayOpResult {
  if (!m.collectibles.some((c) => c.id === id)) return missing("collectible", id);
  return checked({ ...m, collectibles: m.collectibles.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
}
export function removeCollectible(m: GameplayManifest, id: string): GameplayOpResult {
  if (!m.collectibles.some((c) => c.id === id)) return missing("collectible", id);
  return checked({ ...m, collectibles: m.collectibles.filter((c) => c.id !== id) });
}

export function addEnemy(m: GameplayManifest, kind: string, targetKind: string): GameplayOpResult {
  if (kind === "" || targetKind === "") return { ok: false, reason: "no free kind pair: every pair already has a row" };
  const id = freeId(slug(`${kind}-hit`, "hit"), ids(m));
  return checked({ ...m, enemies: [...m.enemies, { id, kind, targetKind, livesLost: 1, despawnEnemy: true }] });
}
export function setEnemy(m: GameplayManifest, id: string, patch: Partial<Omit<Enemy, "id">>): GameplayOpResult {
  if (!m.enemies.some((e) => e.id === id)) return missing("enemy", id);
  return checked({ ...m, enemies: m.enemies.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
}
export function removeEnemy(m: GameplayManifest, id: string): GameplayOpResult {
  if (!m.enemies.some((e) => e.id === id)) return missing("enemy", id);
  return checked({ ...m, enemies: m.enemies.filter((e) => e.id !== id) });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The spec's collision rows (`runtime.collisions`), or an empty list when the spec has none or cannot be read. */
export function specCollisionRows(doc: Json | null): Json[] {
  const rt = isObj(doc) && isObj(doc["game"]) ? (doc["game"] as Record<string, unknown>)["runtime"] : undefined;
  const rows = isObj(rt) ? rt["collisions"] : undefined;
  return Array.isArray(rows) ? (rows as Json[]) : [];
}
/**
 * Field-level issues of the gameplay manifest against the spec, each with the manifest path of the field to fix.
 * While derivation is OFF the spec's collision rows are Designer-owned: a module row on the same pair with different
 * values is a `collision-conflict` (an identical row is what a previous apply wrote and is not a conflict). While it is ON
 * the module owns the whole table, so only the compiler's own checks remain.
 * Returns an empty list for a manifest that compiles cleanly.
 */
export function gameplayIssues(gameplay: GameplayManifest, doc: Json | null, derivationOn: boolean): GameplayIssue[] {
  if (doc === null) return [];
  const own = compileGameplay(gameplay, doc, []);
  const designer = derivationOn ? [] : specCollisionRows(doc).filter((r) => !(own.ok && own.collisions.some((c) => sameValue(c, r))));
  const compiled = designer.length === 0 ? own : compileGameplay(gameplay, doc, designer);
  return compiled.ok ? [] : compiled.issues;
}
/** The issues that belong to one row (`collectibles`/`enemies`, index), keyed for display next to its controls. */
export const issuesFor = (issues: readonly GameplayIssue[], section: string, index: number): GameplayIssue[] =>
  issues.filter((i) => i.path[0] === section && i.path[1] === index);
