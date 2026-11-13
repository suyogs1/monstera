// Plain-language reading of the draft for the Overview and the Spawns section. It only rephrases values that are
// in the spec (no simulation, no rules): every line carries the path of the field that controls it. All accessors
// tolerate half-formed documents, because an invalid or imported draft can hold anything.
import { getAt, type Path } from "../draft/path";
import type { Json } from "../schema/schema";

export interface Line { text: string; path: Path }
export interface Fact { label: string; value: string; path: Path }

const RT: Path = ["game", "runtime"];
const str = (d: Json, p: Path): string | undefined => { const v = getAt(d, p); return typeof v === "string" ? v : undefined; };
const num = (d: Json, p: Path): number | undefined => { const v = getAt(d, p); return typeof v === "number" ? v : undefined; };
const list = (d: Json, p: Path): Json[] => { const v = getAt(d, p); return Array.isArray(v) ? v : []; };

export function seconds(ticks: number, tickRate: number): string {
  if (!(tickRate > 0)) return "?";
  return String(Math.round((ticks / tickRate) * 100) / 100);
}

const signed = (n: number) => (n > 0 ? `+${n}` : `\u2212${Math.abs(n)}`);

export function ruleSentences(doc: Json): Line[] {
  return list(doc, [...RT, "collisions"]).map((c, i) => {
    const a = str(c, ["a"]) ?? "?", b = str(c, ["b"]) ?? "?";
    const score = num(c, ["score"]) ?? 0, lives = num(c, ["lives"]) ?? 0;
    const effects: string[] = [];
    if (score !== 0) effects.push(`score ${signed(score)}`);
    if (lives !== 0) effects.push(`lives ${signed(lives)}`);
    const gone = [...new Set([getAt(c, ["despawnA"]) === true ? a : "", getAt(c, ["despawnB"]) === true ? b : ""].filter(Boolean))];
    if (gone.length) effects.push(gone.length === 2 ? `${gone[0]} and ${gone[1]} vanish` : `${gone[0]} vanishes`);
    return { text: `${a} touches ${b}: ${effects.length ? effects.join("; ") : "no effect"}`, path: [...RT, "collisions", i] };
  });
}

export function spawnLines(doc: Json): Line[] {
  const rate = num(doc, ["game", "simulation", "tickRate"]) ?? 0;
  return list(doc, [...RT, "spawners"]).map((s, i) => {
    const kind = str(s, ["kind"]) ?? "?";
    const interval = num(s, ["intervalTicks"]) ?? 0, start = num(s, ["startTick"]) ?? 0;
    const perMinute = interval > 0 && rate > 0 ? Math.round(((60 * rate) / interval) * 10) / 10 : undefined;
    return {
      text: `${kind}: every ${seconds(interval, rate)} s, from ${seconds(start, rate)} s${perMinute !== undefined ? ` (${perMinute} per minute)` : ""}`,
      path: [...RT, "spawners", i],
    };
  });
}

export function facts(doc: Json): Fact[] {
  const out: Fact[] = [];
  const add = (label: string, value: string | undefined, path: Path) => { if (value !== undefined && value !== "") out.push({ label, value, path }); };
  const w = num(doc, ["game", "world", "width"]), h = num(doc, ["game", "world", "height"]);
  add("Genre", str(doc, ["game", "genre"]), ["game", "genre"]);
  add("Orientation", str(doc, ["game", "orientation"]), ["game", "orientation"]);
  add("World", w !== undefined && h !== undefined ? `${w} \u00d7 ${h} units` : undefined, ["game", "world", "width"]);
  const rate = num(doc, ["game", "simulation", "tickRate"]);
  add("Simulation", rate !== undefined ? `${rate} ticks per second` : undefined, ["game", "simulation", "tickRate"]);
  add("Input", str(doc, ["game", "input", "scheme"]), ["game", "input", "scheme"]);
  const lives = num(doc, [...RT, "lives"]);
  add("Lives", lives !== undefined ? String(lives) : undefined, [...RT, "lives"]);
  const win = num(doc, [...RT, "winScore"]);
  add("Winning", win === undefined ? undefined : win > 0 ? `reach ${win} points` : "no win score; play until lives run out", [...RT, "winScore"]);
  // Lists have no single control: a tile opens the first item's card, or the section itself when the list is empty.
  const first = (key: string): Path => (list(doc, [...RT, key]).length > 0 ? [...RT, key, 0] : [...RT, key]);
  add("Entity kinds", String(list(doc, [...RT, "kinds"]).length), first("kinds"));
  add("Spawners", String(list(doc, [...RT, "spawners"]).length), first("spawners"));
  add("Rules", String(list(doc, [...RT, "collisions"]).length), first("collisions"));
  return out;
}

/** Spawn times of one spawner within the first `horizonTicks` ticks (for the Spawns timeline). */
export function spawnTicks(startTick: number, intervalTicks: number, horizonTicks: number, cap = 400): number[] {
  const out: number[] = [];
  if (!(intervalTicks >= 1) || !(startTick >= 0)) return out;
  for (let t = startTick; t <= horizonTicks && out.length < cap; t += intervalTicks) out.push(t);
  return out;
}
