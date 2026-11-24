// Spec v4 -> v5 (Gate E1, docs/SPEC-V2-MIGRATION.md "v4 to v5"). Pure and deliberately narrow: exactly one source version.
//
// v5 adds two presentation-only fields with documented neutral values. migrateV4Doc adds them to a COPY of a v4 document and
// changes nothing else: every v4 property keeps its value. It does not validate; the caller (Session) must hand the result to the
// v5 engine and use it only when the engine accepts it. Any other version, or a document that already carries v5 fields, is not
// touched: versions are never guessed.
import type { Json } from "../schema/schema";

export const NEUTRAL_ATLAS = { png: "", frameWidth: 1, frameHeight: 1, columns: 1, rows: 1 } as const;
export const NEUTRAL_SPRITE = { frames: [] as number[], ticksPerFrame: 1 } as const;

type Obj = { [k: string]: Json };
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export type V4Migration = { ok: true; doc: Json } | { ok: false; reason: "not-v4" | "shape" };

/** Whether `doc` declares spec version 4 (the only version this module migrates). */
export const isV4 = (doc: unknown): boolean => isObj(doc) && doc["specVersion"] === 4;

/** The v5 form of a v4 document: specVersion 5, neutral game.atlas, a neutral sprite on every kind. */
export function migrateV4Doc(doc: Json): V4Migration {
  if (!isV4(doc)) return { ok: false, reason: "not-v4" };
  const copy = JSON.parse(JSON.stringify(doc)) as Obj;
  const game = copy["game"];
  if (!isObj(game) || "atlas" in game) return { ok: false, reason: "shape" };
  const runtime = game["runtime"];
  if (!isObj(runtime) || !Array.isArray(runtime["kinds"])) return { ok: false, reason: "shape" };
  const kinds = runtime["kinds"] as Json[];
  if (!kinds.every((k) => isObj(k) && !("sprite" in k))) return { ok: false, reason: "shape" };
  copy["specVersion"] = 5;
  game["atlas"] = { ...NEUTRAL_ATLAS };
  for (const k of kinds as Obj[]) k["sprite"] = { frames: [], ticksPerFrame: NEUTRAL_SPRITE.ticksPerFrame };
  return { ok: true, doc: copy };
}

/** Whether a JSON text is a v4 specification (false for unreadable text). */
export function textIsV4(text: string | null): boolean {
  if (text === null) return false;
  try { return isV4(JSON.parse(text)); } catch { return false; }
}
