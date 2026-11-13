// Explains a badge result by naming what the draft changed. It NEVER decides a verdict: the verdict comes only from
// the engine's checkpoint comparison (glue.badge_check). Classes follow requirements R5.2/R5.3 and the frozen spec v4
// table (design.md). `tests/test_presentation.py` proves the display-only and not-read fields cannot reach the oracle,
// and READS THE TWO LISTS BELOW (drift guard): anything classified non-behaviour here must be deleted by that proof.
// Keep them as plain string arrays named DISPLAY_ONLY_PATTERNS and BEHAVIOUR_PREFIXES.
import type { Json } from "../schema/schema";
import type { Path } from "../draft/path";
import { toPattern } from "../draft/path";

/** behaviour: the oracle reads it (R5.2). display: presentation only (R5.3, spec v4). other: not read by the oracle. */
export type ChangeClass = "behaviour" | "display" | "other";

export const DISPLAY_ONLY_PATTERNS = [
  "project.displayName",
  "game.palette.primary", "game.palette.accent", "game.palette.background",
  "game.hud.lifeGlyph", "game.hud.scoreLabel",
  "game.screens.startHint", "game.screens.winTitle", "game.screens.loseTitle",
  "game.runtime.kinds[].color", "game.runtime.kinds[].glyph", "game.runtime.kinds[].effect",
] as const;

/** Prefixes of the fields the oracle reads (sim.Config and the frame loop). Everything else under `game` is not read. */
const BEHAVIOUR_PREFIXES = [
  "game.world", "game.simulation", "game.runtime",
  "game.input.dragGain", "game.input.swipeSpeed", "game.input.tapKind", "game.input.tapVx", "game.input.tapVy",
];

const DISPLAY = new Set<string>(DISPLAY_ONLY_PATTERNS);
const under = (pattern: string, prefix: string) => pattern === prefix || pattern.startsWith(`${prefix}.`) || pattern.startsWith(`${prefix}[`);

export function classifyPath(path: Path): ChangeClass {
  const p = toPattern(path);
  if (DISPLAY.has(p)) return "display";
  if (BEHAVIOUR_PREFIXES.some((prefix) => under(p, prefix))) return "behaviour";
  return "other";
}

/** Leaf paths that differ between two documents. A changed array length reports the array itself. */
export function changedPaths(a: Json | undefined, b: Json | undefined, at: Path = []): Path[] {
  if (a === b) return [];
  const isObj = (v: Json | undefined): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [at];
    return a.flatMap((x, i) => changedPaths(x, b[i], [...at, i]));
  }
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => changedPaths(a[k], b[k], [...at, k]));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [at];
}

export interface ChangeSummary { behaviour: Path[]; display: Path[]; other: Path[] }

export function summarizeChanges(baseline: Json | undefined, draft: Json | undefined): ChangeSummary {
  const out: ChangeSummary = { behaviour: [], display: [], other: [] };
  for (const p of changedPaths(baseline, draft)) out[classifyPath(p)].push(p);
  return out;
}
