// Pure tick -> sequence index (task 3.1). Integer arithmetic only; the same tick always gives the same index.
export interface Hold { holdFrames: number }
export type LoopMode = "once" | "loop" | "pingpong";

/**
 * step = floor(tick * fps / tickRate). The step walks "slots" (one per held step): loop wraps, once clamps to the
 * last slot, pingpong runs a triangle wave of period 2*total-2. Slots map to sequence entries by cumulative holdFrames.
 * Returns an index into the sequence.
 */
export function frameIndex(
  tick: number,
  tickRate: number,
  fps: number,
  holds: readonly number[] | readonly Hold[],
  loop: LoopMode,
): number {
  const hs = holds.map((h) => (typeof h === "number" ? h : h.holdFrames));
  if (hs.length === 0) throw new RangeError("sequence is empty");
  if (!hs.every((h) => Number.isInteger(h) && h >= 1)) throw new RangeError("holds must be integers >= 1");
  if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError("tick must be a non-negative integer");
  if (!Number.isSafeInteger(tickRate) || tickRate < 1) throw new RangeError("tickRate must be an integer >= 1");
  if (!Number.isSafeInteger(fps) || fps < 1) throw new RangeError("fps must be an integer >= 1");
  if (!Number.isSafeInteger(tick * fps)) throw new RangeError("tick * fps exceeds the safe integer range");

  const total = hs.reduce((a, b) => a + b, 0);
  const prod = tick * fps;
  const step = (prod - (prod % tickRate)) / tickRate; // exact floor division
  let slot: number;
  if (loop === "once") slot = Math.min(step, total - 1);
  else if (loop === "loop") slot = step % total;
  else if (total === 1) slot = 0;
  else {
    const period = 2 * total - 2;
    const m = step % period;
    slot = m < total ? m : period - m;
  }
  let acc = 0;
  for (let i = 0; i < hs.length; i++) {
    acc += hs[i] as number;
    if (slot < acc) return i;
  }
  return hs.length - 1;
}

