// Pure frame list operations (task 3.1). Inputs are never mutated.
import type { Frame } from "../project/manifests/types";
import type { Result } from "./slice";

const ID = /^[a-z][a-z0-9-]{1,31}$/;

export function reorderFrame(frames: readonly Frame[], from: number, to: number): Result<Frame[]> {
  const ok = (i: number) => Number.isInteger(i) && i >= 0 && i < frames.length;
  if (!ok(from) || !ok(to)) return { ok: false, error: `index out of range 0..${frames.length - 1}` };
  const out = frames.slice();
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved as Frame);
  return { ok: true, value: out };
}

/** Insert a copy of frames[index] right after it under newId. The id must be valid and unused (ids are never reused). */
export function duplicateFrame(frames: readonly Frame[], index: number, newId: string): Result<Frame[]> {
  const src = frames[index];
  if (!Number.isInteger(index) || !src) return { ok: false, error: "no frame at that index" };
  if (!ID.test(newId)) return { ok: false, error: `invalid frame id "${newId}"` };
  if (frames.some((f) => f.id === newId)) return { ok: false, error: `frame id "${newId}" already exists` };
  const out = frames.slice();
  out.splice(index + 1, 0, { ...src, id: newId });
  return { ok: true, value: out };
}

/** Animation ids whose sequences reference the frame. */
export function framesUsedBy(
  frameId: string,
  animations: readonly { id: string; sequence: readonly { frameId: string }[] }[],
): string[] {
  return animations.filter((a) => a.sequence.some((s) => s.frameId === frameId)).map((a) => a.id);
}

/** Remove a frame. Blocked while an animation uses it, naming the animations. */
export function removeFrame(
  frames: readonly Frame[],
  id: string,
  animations: readonly { id: string; sequence: readonly { frameId: string }[] }[] = [],
): Result<Frame[]> {
  if (!frames.some((f) => f.id === id)) return { ok: false, error: `no frame "${id}"` };
  const users = framesUsedBy(id, animations);
  if (users.length > 0) return { ok: false, error: `frame "${id}" is used by animation ${users.join(", ")}` };
  return { ok: true, value: frames.filter((f) => f.id !== id) };
}

/** Remove every sequence entry for a frame (the confirmed variant of removal). */
export function dropFromSequence<T extends { frameId: string }>(sequence: readonly T[], id: string): T[] {
  return sequence.filter((s) => s.frameId !== id);
}
