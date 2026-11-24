// Turning what the user typed or picked into a kind's sprite value (frames + ticksPerFrame). Pure. The numeric bounds come from
// the engine schema (AtlasLimits); the cross-kind rule (how many kinds may animate) is the engine's and is reported by the apply
// path, so it is not repeated here.
import type { Animation, Sheet } from "../../project/manifests/types";
import type { AtlasLimits } from "./build";
import type { KindSprite } from "./apply";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** "0, 1 2" -> [0, 1, 2]. Each index must be a whole number below `frameCount`; at most `limits.maxSpriteFrames` of them. */
export function parseFrames(text: string, frameCount: number, limits: Pick<AtlasLimits, "maxSpriteFrames">): Parsed<number[]> {
  const parts = text.split(/[\s,]+/).filter((p) => p !== "");
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,4}$/.test(p)) return { ok: false, error: `"${p}" is not a frame number (use whole numbers such as 0, 1, 2)` };
    const n = Number(p);
    if (n >= frameCount) return { ok: false, error: frameCount === 0 ? "there is no atlas yet; build one first" : `frame ${n} does not exist; the atlas has ${frameCount} frames (0 to ${frameCount - 1})` };
    out.push(n);
  }
  if (out.length > limits.maxSpriteFrames) return { ok: false, error: `a kind may use at most ${limits.maxSpriteFrames} frames, ${out.length} were given` };
  return { ok: true, value: out };
}

export function parseTicksPerFrame(value: number, limits: Pick<AtlasLimits, "maxTicksPerFrame">): Parsed<number> {
  if (!Number.isSafeInteger(value) || value < 1 || value > limits.maxTicksPerFrame) return { ok: false, error: `ticks per frame must be a whole number from 1 to ${limits.maxTicksPerFrame}` };
  return { ok: true, value };
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * The sprite that shows an animation of the animations manifest: each sequence entry is shown for `holdFrames` x round(tickRate /
 * fps) ticks; the sprite has one equal interval per frame, so entries are repeated by their hold divided by the common hold. The
 * sprite always loops, so only `loop` animations convert. Frame ids are mapped to their position in the sheet (the atlas index).
 */
export function spriteFromAnimation(anim: Pick<Animation, "id" | "loop" | "fps" | "sequence">, sheet: Pick<Sheet, "id" | "frames">, tickRate: number, limits: Pick<AtlasLimits, "maxSpriteFrames" | "maxTicksPerFrame">): Parsed<KindSprite> {
  if (anim.loop !== "loop") return { ok: false, error: `animation "${anim.id}" is "${anim.loop}"; a native sprite always loops, so only loop animations can be assigned` };
  if (!Number.isSafeInteger(tickRate) || tickRate < 1) return { ok: false, error: "the specification has no usable simulation tick rate" };
  const base = Math.max(1, Math.round(tickRate / anim.fps));
  const common = anim.sequence.reduce((g, e) => gcd(g, e.holdFrames), 0) || 1;
  const frames: number[] = [];
  for (const e of anim.sequence) {
    const index = sheet.frames.findIndex((f) => f.id === e.frameId);
    if (index < 0) return { ok: false, error: `animation "${anim.id}" uses frame "${e.frameId}", which sheet "${sheet.id}" does not have` };
    for (let i = 0; i < e.holdFrames / common; i++) frames.push(index);
  }
  if (frames.length > limits.maxSpriteFrames) return { ok: false, error: `animation "${anim.id}" needs ${frames.length} frames at this timing; a kind may use at most ${limits.maxSpriteFrames}` };
  const ticks = base * common;
  if (ticks > limits.maxTicksPerFrame) return { ok: false, error: `animation "${anim.id}" would show each frame for ${ticks} ticks; the most allowed is ${limits.maxTicksPerFrame}` };
  return { ok: true, value: { frames, ticksPerFrame: ticks } };
}
