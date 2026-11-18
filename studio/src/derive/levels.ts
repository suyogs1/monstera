// Level compiler (task 4.1): levels manifest + base spec -> `initialEntities` and `spawners` of one level.
//
// Pure: no I/O, no clock, no randomness, no UI state, no mutation of its inputs, no shared mutable state. The same
// inputs always produce structurally identical output. The compiler maps fields to fields and contains no game rules
// (no collision, scoring, tick or RNG semantics); the unmodified Python engine validates and simulates the result
// (design section 0, "Compile, then engine decides"). Applying the result to a spec is task 4.2, not this file.
import { validateManifest, type Issue, type Level, type LevelsManifest } from "../project/manifests";

/** Declared limit: a level compiles to at most this many spawners (design 3.6; also enforced by the manifest checks). */
export const MAX_SPAWNERS_PER_LEVEL = 64;

/** Where an issue points: a field path in the levels manifest, or in the base spec. */
export type IssueSource = "levels" | "base-spec" | "request";
export interface CompileIssue extends Issue { source: IssueSource }

/** Spec `EntityInstance` (key order of `game.schema.json`). */
export interface CompiledEntity { kind: string; x: number; y: number; vx: number; vy: number; controlled: boolean }
/** Spec `Spawner` (key order of `game.schema.json`). */
export interface CompiledSpawner {
  stream: string; kind: string; startTick: number; intervalTicks: number;
  xMin: number; xMax: number; yMin: number; yMax: number; vx: number; vy: number;
}
export type CompileResult =
  | {
    ok: true;
    levelId: string;
    initialEntities: CompiledEntity[];
    /** All waves in manifest order, then all difficulty steps in manifest order. */
    spawners: CompiledSpawner[];
    /** Manifest path that produced `initialEntities[i]`, so engine issues can be mapped back to level fields (task 4.2). */
    entityPaths: (string | number)[][];
    /** Manifest path that produced `spawners[i]`. */
    spawnerPaths: (string | number)[][];
  }
  | { ok: false; issues: CompileIssue[] };

/** Fields that look natural but have no v4 representation. Rejected by name so the message says why (design section 6, E3). */
const UNSUPPORTED: Readonly<Record<string, string>> = {
  count: "spawners cannot count; v4 has no wave end or spawn count (E3)",
  maxSpawns: "spawners cannot count; v4 has no wave end or spawn count (E3)",
  endTick: "spawners cannot stop; v4 has no wave end (E3)",
  stopTick: "spawners cannot stop; v4 has no wave end (E3)",
  endsAtTick: "spawners cannot stop; v4 has no wave end (E3)",
  duration: "spawners cannot stop; v4 has no wave end (E3)",
  winScore: "a win condition per level is not supported; winScore belongs to gameplay (E3)",
  winCondition: "a win condition per level is not supported (E3)",
  lives: "lives per level is not supported; lives belong to gameplay (E3)",
  next: "level sequencing and in-app level selection are not supported (E3)",
  nextLevel: "level sequencing and in-app level selection are not supported (E3)",
  selectable: "in-app level selection is not supported (E3)",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** Normalizes -0 to 0 so the output serializes and compares identically. */
const num = (n: number): number => n + 0;
const issue = (source: IssueSource, path: (string | number)[], code: string, message: string): CompileIssue => ({ source, path, code, message });

function manifestIssues(raw: Issue[]): CompileIssue[] {
  return raw.map((i) => {
    const key = i.path[i.path.length - 1];
    if (i.code === "additional" && typeof key === "string" && own(UNSUPPORTED as Record<string, unknown>, key)) {
      return issue("levels", i.path, "unsupported-field", `"${key}" is not supported: ${UNSUPPORTED[key]}`);
    }
    return issue("levels", i.path, i.code, i.message);
  });
}

interface BaseView { maxEntities: number; kinds: Set<string> }

/** Reads only what the compiler needs from the base spec. Anything else in the spec is neither read nor checked here. */
function readBase(baseSpec: unknown): { ok: true; base: BaseView } | { ok: false; issues: CompileIssue[] } {
  const bad = (path: (string | number)[], message: string) => ({ ok: false as const, issues: [issue("base-spec", path, "bad-base-spec", message)] });
  if (!isObj(baseSpec)) return bad([], "the base spec must be an object");
  const game = baseSpec["game"];
  if (!isObj(game)) return bad(["game"], "the base spec has no game object");
  const rt = game["runtime"];
  if (!isObj(rt)) return bad(["game", "runtime"], "the base spec has no runtime object");
  const max = rt["maxEntities"];
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) return bad(["game", "runtime", "maxEntities"], "maxEntities must be a positive integer");
  const list = rt["kinds"];
  if (!Array.isArray(list)) return bad(["game", "runtime", "kinds"], "kinds must be an array");
  const kinds = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const k: unknown = list[i];
    if (!isObj(k) || typeof k["id"] !== "string") return bad(["game", "runtime", "kinds", i, "id"], "every kind needs a string id");
    kinds.add(k["id"]);
  }
  return { ok: true, base: { maxEntities: max, kinds } };
}

function compileOne(level: Level, at: number, base: BaseView): CompileResult {
  const issues: CompileIssue[] = [];
  const lp: (string | number)[] = ["levels", at];
  const known = [...base.kinds].sort().join(", ") || "none";
  if (level.placements.length > base.maxEntities) {
    issues.push(issue("levels", [...lp, "placements"], "entity-cap",
      `${level.placements.length} placements exceed the base spec's maxEntities ${base.maxEntities}`));
  }
  level.placements.forEach((p, i) => {
    if (!base.kinds.has(p.kind)) issues.push(issue("levels", [...lp, "placements", i, "kind"], "unknown-kind", `"${p.kind}" is not a kind of the base spec; defined: ${known}`));
  });
  level.waves.forEach((w, i) => {
    if (!base.kinds.has(w.kind)) issues.push(issue("levels", [...lp, "waves", i, "kind"], "unknown-kind", `"${w.kind}" is not a kind of the base spec; defined: ${known}`));
  });
  if (level.waves.length + level.difficulty.length > MAX_SPAWNERS_PER_LEVEL) {
    issues.push(issue("levels", [...lp, "waves"], "too-many-spawners", `a level compiles to at most ${MAX_SPAWNERS_PER_LEVEL} spawners`));
  }
  const byWave = new Map(level.waves.map((w, i) => [w.id, { w, i }]));
  level.difficulty.forEach((d, j) => {
    if (!byWave.has(d.waveId)) issues.push(issue("levels", [...lp, "difficulty", j, "waveId"], "unknown-wave", `wave "${d.waveId}" does not exist in this level`));
  });
  if (issues.length > 0) return { ok: false, issues };

  const initialEntities: CompiledEntity[] = level.placements.map((p) => ({
    kind: p.kind, x: num(p.x), y: num(p.y), vx: num(p.vx), vy: num(p.vy), controlled: p.controlled,
  }));
  const spawners: CompiledSpawner[] = level.waves.map((w) => ({
    stream: w.stream, kind: w.kind, startTick: num(w.startTick), intervalTicks: num(w.intervalTicks),
    xMin: num(w.xMin), xMax: num(w.xMax), yMin: num(w.yMin), yMax: num(w.yMax), vx: num(w.vx), vy: num(w.vy),
  }));
  // A difficulty step reuses its wave's kind and ranges; v4 spawners cannot be changed or stopped, so the wave keeps running.
  for (const d of level.difficulty) {
    const entry = byWave.get(d.waveId);
    if (!entry) continue; // unreachable: unknown waves were reported above
    const w = entry.w;
    spawners.push({
      stream: d.stream, kind: w.kind, startTick: num(d.atTick), intervalTicks: num(d.intervalTicks),
      xMin: num(w.xMin), xMax: num(w.xMax), yMin: num(w.yMin), yMax: num(w.yMax), vx: num(d.vx), vy: num(d.vy),
    });
  }
  return {
    ok: true,
    levelId: level.id,
    initialEntities,
    spawners,
    entityPaths: level.placements.map((_, i) => [...lp, "placements", i]),
    spawnerPaths: [
      ...level.waves.map((_, i) => [...lp, "waves", i]),
      ...level.difficulty.map((_, j) => [...lp, "difficulty", j]),
    ],
  };
}

/**
 * Compiles one level of `levels` against `baseSpec`. `levels` is validated first with the manifest validators, so every
 * schema, range, uniqueness and ordering rule of task 0.3 applies; its issues are returned unchanged except that
 * fields that need engine support are named as unsupported. All issues carry the field path in `levels` (or in the
 * base spec for `source: "base-spec"`). Neither input is modified.
 */
export function compileLevel(levels: unknown, baseSpec: unknown, levelId: string): CompileResult {
  const parsed = validateManifest("levels", levels);
  if (!parsed.ok) return { ok: false, issues: manifestIssues(parsed.issues) };
  const manifest: LevelsManifest = parsed.value;
  const baseRead = readBase(baseSpec);
  if (!baseRead.ok) return baseRead;
  const at = manifest.levels.findIndex((l) => l.id === levelId);
  const level = manifest.levels[at];
  if (level === undefined) {
    const ids = manifest.levels.map((l) => l.id).join(", ") || "none";
    return { ok: false, issues: [issue("request", ["levelId"], "unknown-level", `"${levelId}" is not a level of this manifest; defined: ${ids}`)] };
  }
  return compileOne(level, at, baseRead.base);
}
