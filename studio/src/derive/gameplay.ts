// Gameplay compiler (task 5.1): gameplay manifest + base spec -> `lives`, `winScore` and module `collisions`.
//
// Pure: no I/O, no clock, no randomness, no UI state, no mutation of its inputs, no shared mutable state. The compiler
// maps fields to fields and contains no game rules (no scoring, collision or tick semantics); the unmodified Python
// engine validates and simulates the result (design section 0, "Compile, then engine decides"). Merging the result into
// a spec is the apply path (task 5.2), not this file.
import { validateManifest, type GameplayManifest, type Issue } from "../project/manifests";

/** Where an issue points: the gameplay manifest, the base spec, or the Designer-owned collision rows passed in. */
export type GameplayIssueSource = "gameplay" | "base-spec" | "designer-rows";
export interface GameplayIssue extends Issue { source: GameplayIssueSource }

/** Spec `CollisionEffect` (key order of `game.schema.json`). */
export interface CompiledCollision { a: string; b: string; despawnA: boolean; despawnB: boolean; score: number; lives: number }

export type GameplayCompileResult =
  | {
    ok: true;
    lives: number;
    winScore: number;
    /** Collectible rows in manifest order, then enemy rows in manifest order. Designer-owned rows are not included. */
    collisions: CompiledCollision[];
    /** Path of the manifest object (a collectible or an enemy) that produced `collisions[i]`. */
    collisionSourcePaths: (string | number)[][];
  }
  | { ok: false; issues: GameplayIssue[] };

const PLANNED = "planned: the v4 contract has no timed state or persistence";
/** Natural fields with no v4 representation. They are named only on the manifest root; elsewhere they are ordinary unknown properties. */
const UNSUPPORTED: Readonly<Record<string, string>> = {
  health: `health is ${PLANNED}`,
  powerUps: `power-ups are ${PLANNED}`,
  progression: `progression is ${PLANNED}`,
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const issue = (source: GameplayIssueSource, path: (string | number)[], code: string, message: string): GameplayIssue => ({ source, path, code, message });

function manifestIssues(raw: Issue[]): GameplayIssue[] {
  return raw.map((i) => {
    const key = i.path[i.path.length - 1];
    if (i.code === "additional" && i.path.length === 1 && typeof key === "string" && own(UNSUPPORTED, key)) {
      return issue("gameplay", i.path, "unsupported-field", `"${key}" is not supported: ${UNSUPPORTED[key]}`);
    }
    return issue("gameplay", i.path, i.code, i.message);
  });
}

/** Reads only the kind ids of the base spec. Anything else in the spec is neither read nor checked here. */
function readKinds(baseSpec: unknown): { ok: true; kinds: Set<string> } | { ok: false; issues: GameplayIssue[] } {
  const bad = (path: (string | number)[], message: string) => ({ ok: false as const, issues: [issue("base-spec", path, "bad-base-spec", message)] });
  if (!isObj(baseSpec)) return bad([], "the base spec must be an object");
  const game = baseSpec["game"];
  if (!isObj(game)) return bad(["game"], "the base spec has no game object");
  const rt = game["runtime"];
  if (!isObj(rt)) return bad(["game", "runtime"], "the base spec has no runtime object");
  const list = rt["kinds"];
  if (!Array.isArray(list)) return bad(["game", "runtime", "kinds"], "kinds must be an array");
  const kinds = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const k: unknown = list[i];
    if (!isObj(k) || typeof k["id"] !== "string") return bad(["game", "runtime", "kinds", i, "id"], "every kind needs a string id");
    kinds.add(k["id"]);
  }
  return { ok: true, kinds };
}

/** Reads `a` and `b` of each Designer-owned collision row. */
function readDesignerRows(rows: unknown): { ok: true; pairs: [string, string][] } | { ok: false; issues: GameplayIssue[] } {
  if (!Array.isArray(rows)) return { ok: false, issues: [issue("designer-rows", [], "bad-designer-rows", "Designer-owned collision rows must be an array")] };
  const pairs: [string, string][] = [];
  for (let i = 0; i < rows.length; i++) {
    const r: unknown = rows[i];
    if (!isObj(r) || typeof r["a"] !== "string" || typeof r["b"] !== "string") {
      return { ok: false, issues: [issue("designer-rows", [i], "bad-designer-rows", "every collision row needs string a and b")] };
    }
    pairs.push([r["a"], r["b"]]);
  }
  return { ok: true, pairs };
}

/** The pair is compared without order: a row (a,b) and a row (b,a) both act on the same two entities. */
const pairKey = (a: string, b: string): string => (a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/**
 * Compiles `gameplay` against `baseSpec`. `designerRows` are the base spec's collision rows that no module produced;
 * a module row on the same kind pair is reported as `collision-conflict` and nothing is merged or dropped silently.
 * `gameplay` is validated first with the manifest validators (task 0.3); its issues are returned unchanged except that
 * the planned fields are named as unsupported. Neither input is modified.
 */
export function compileGameplay(gameplay: unknown, baseSpec: unknown, designerRows: unknown): GameplayCompileResult {
  const parsed = validateManifest("gameplay", gameplay);
  if (!parsed.ok) return { ok: false, issues: manifestIssues(parsed.issues) };
  const m: GameplayManifest = parsed.value;
  const baseRead = readKinds(baseSpec);
  if (!baseRead.ok) return baseRead;
  const rowsRead = readDesignerRows(designerRows);
  if (!rowsRead.ok) return rowsRead;
  const known = [...baseRead.kinds].sort().join(", ") || "none";
  const issues: GameplayIssue[] = [];
  const taken = new Map<string, number>();
  rowsRead.pairs.forEach(([a, b], i) => { if (!taken.has(pairKey(a, b))) taken.set(pairKey(a, b), i); });

  const rows: CompiledCollision[] = [];
  const paths: (string | number)[][] = [];
  const add = (section: "collectibles" | "enemies", i: number, kindRef: string, otherField: string, other: string, row: CompiledCollision) => {
    for (const [field, id] of [["kind", kindRef], [otherField, other]] as const) {
      if (!baseRead.kinds.has(id)) issues.push(issue("gameplay", [section, i, field], "unknown-kind", `"${id}" is not a kind of the base spec; defined: ${known}`));
    }
    const hit = taken.get(pairKey(row.a, row.b));
    if (hit !== undefined) {
      issues.push(issue("gameplay", [section, i, "kind"], "collision-conflict", `the pair ${row.a} and ${row.b} is already a Designer-owned collision row (collisions[${hit}] of the base spec)`));
    }
    rows.push(row);
    paths.push([section, i]);
  };
  m.collectibles.forEach((c, i) => add("collectibles", i, c.kind, "collectorKind", c.collectorKind,
    { a: c.kind, b: c.collectorKind, despawnA: c.despawn, despawnB: false, score: c.points, lives: 0 }));
  m.enemies.forEach((e, i) => add("enemies", i, e.kind, "targetKind", e.targetKind,
    { a: e.kind, b: e.targetKind, despawnA: e.despawnEnemy, despawnB: false, score: 0, lives: 0 - e.livesLost }));
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, lives: m.lives.start, winScore: m.score.winScore, collisions: rows, collisionSourcePaths: paths };
}
