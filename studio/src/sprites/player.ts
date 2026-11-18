// Headless animation player core (task 3.3). All timing is integer ticks; frame choice is exactly `frameIndex` (3.1).
import type { Animation, Frame, Sheet } from "../project/manifests/types";
import { frameIndex } from "./timeline";

export interface PlayerState { tick: number; playing: boolean }
export const initialPlayer: PlayerState = { tick: 0, playing: false };

/** Sequence index shown at a tick. */
export function indexAt(anim: Pick<Animation, "fps" | "loop" | "sequence">, tickRate: number, tick: number): number {
  return frameIndex(tick, tickRate, anim.fps, anim.sequence, anim.loop);
}

/** The sheet frame shown at a tick, or an error when the sequence names a frame the sheet lacks. */
export function frameAt(
  anim: Pick<Animation, "fps" | "loop" | "sequence">,
  sheet: Pick<Sheet, "frames">,
  tickRate: number,
  tick: number,
): { ok: true; index: number; frame: Frame } | { ok: false; error: string } {
  if (anim.sequence.length === 0) return { ok: false, error: "the sequence is empty" };
  const index = indexAt(anim, tickRate, tick);
  const id = anim.sequence[index]?.frameId;
  const frame = sheet.frames.find((f) => f.id === id);
  return frame ? { ok: true, index, frame } : { ok: false, error: `frame "${String(id)}" is not in the sheet` };
}

/** Frame ids for ticks from..to inclusive (the headless equivalent of watching the player). */
export function frameSequence(
  anim: Pick<Animation, "fps" | "loop" | "sequence">,
  tickRate: number,
  from: number,
  to: number,
): string[] {
  const out: string[] = [];
  for (let t = from; t <= to; t++) out.push((anim.sequence[indexAt(anim, tickRate, t)] as { frameId: string }).frameId);
  return out;
}

export const play = (s: PlayerState): PlayerState => ({ ...s, playing: true });
export const pause = (s: PlayerState): PlayerState => ({ ...s, playing: false });
export const restart = (s: PlayerState): PlayerState => ({ ...s, tick: 0 });
/** Step one tick forward or back (never below 0). Stepping pauses. */
export const step = (s: PlayerState, delta: 1 | -1): PlayerState => ({ playing: false, tick: Math.max(0, s.tick + delta) });

/** Advance by elapsed wall time; fractional ticks are carried by the caller via the returned remainder (ms). */
export function advance(s: PlayerState, tickRate: number, elapsedMs: number, carryMs: number): { state: PlayerState; carryMs: number } {
  if (!s.playing) return { state: s, carryMs: 0 };
  const total = carryMs + elapsedMs;
  const msPerTick = 1000 / tickRate;
  const n = Math.floor(total / msPerTick);
  return { state: n > 0 ? { ...s, tick: s.tick + n } : s, carryMs: total - n * msPerTick };
}
