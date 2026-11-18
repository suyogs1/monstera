// Manifest-level editing operations for sheets, frames and animations (task 3.2). Pure: every function takes the animations
// manifest and returns a new one (or the exact reason it refused); nothing is mutated and nothing is committed here. The UI
// commits the result through ProjectActions.commitManifest, which validates it again. Slicing, frame list rules and timing stay
// in slice.ts, frames.ts and timeline.ts; this file only applies them to the manifest. Public for the preview player (task 3.3).
import type { Animation, AnimationsManifest, Asset, Frame, Sheet } from "../project/manifests/types";
import { dropFromSequence, duplicateFrame, framesUsedBy, reorderFrame, removeFrame } from "./frames";
import { MAX_FRAMES_PER_SHEET, sliceGrid, type Grid, type Result } from "./slice";
import type { LoopMode } from "./timeline";

export type { Animation, AnimationsManifest, Frame, Sheet, Grid, Result, LoopMode };
export type SequenceEntry = Animation["sequence"][number];
export type Rect = Pick<Frame, "x" | "y" | "w" | "h">;
/** The part of an asset the editors need: its id and pixel size. */
export type SheetImage = Pick<Asset, "id" | "kind" | "width" | "height">;

export const MAX_SHEETS = 64;
export const MAX_ANIMATIONS = 256;
export const MAX_SEQUENCE = 256;
export const FPS_RANGE = { min: 1, max: 60 } as const;
export const HOLD_RANGE = { min: 1, max: 60 } as const;
export const LOOP_MODES: readonly LoopMode[] = ["once", "loop", "pingpong"];
export const DEFAULT_FPS = 8;
export const DEFAULT_GRID: Grid = { frameWidth: 32, frameHeight: 32, columns: 1, rows: 1, margin: 0, spacing: 0 };
const ID = /^[a-z][a-z0-9-]{1,31}$/;
const KIND_ID = /^[a-z][a-z0-9-]{0,31}$/;
const fail = <T>(error: string): Result<T> => ({ ok: false, error });
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
const byId = <T extends { id: string }>(a: readonly T[]): T[] => a.slice().sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

export function emptyAnimations(): Pick<AnimationsManifest, "sheets" | "animations"> {
  return { sheets: [], animations: [] };
}
/** Smallest `<prefix>-<n>` (n >= 1) not used in the list. */
export function nextFreeId(prefix: string, used: readonly { id: string }[]): string {
  const ids = new Set(used.map((u) => u.id));
  for (let n = 1; ; n++) if (!ids.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}
/** Next frame id `f<n>` after the highest numeric one in the sheet (manual frames never take a freed number below it). */
export function nextFrameId(frames: readonly Frame[]): string {
  let max = -1;
  for (const f of frames) { const m = /^f(\d+)$/.exec(f.id); if (m) max = Math.max(max, Number(m[1])); }
  return `f${max + 1}`;
}

function withSheet(m: AnimationsManifest, sheetId: string, fn: (s: Sheet) => Result<Sheet>): Result<AnimationsManifest> {
  const s = m.sheets.find((x) => x.id === sheetId);
  if (!s) return fail(`no sheet "${sheetId}"`);
  const r = fn(s);
  return r.ok ? { ok: true, value: { ...m, sheets: m.sheets.map((x) => (x.id === sheetId ? r.value : x)) } } : r;
}
function withAnimation(m: AnimationsManifest, id: string, fn: (a: Animation) => Result<Animation>): Result<AnimationsManifest> {
  const a = m.animations.find((x) => x.id === id);
  if (!a) return fail(`no animation "${id}"`);
  const r = fn(a);
  return r.ok ? { ok: true, value: { ...m, animations: m.animations.map((x) => (x.id === id ? r.value : x)) } } : r;
}
const animationsOfSheet = (m: AnimationsManifest, sheetId: string) => m.animations.filter((a) => a.sheetId === sheetId);

// ---- sheets ----

/** Add a sheet for an image asset and slice it by the grid. The id must be new (sheets are kept sorted by id). */
export function addSheet(m: AnimationsManifest, id: string, image: SheetImage, grid: Grid): Result<AnimationsManifest> {
  if (!ID.test(id)) return fail(`invalid sheet id "${id}"`);
  if (m.sheets.some((s) => s.id === id)) return fail(`sheet id "${id}" already exists`);
  if (m.sheets.length >= MAX_SHEETS) return fail(`at most ${MAX_SHEETS} sheets`);
  if (image.kind !== "image") return fail(`asset "${image.id}" is not an image`);
  const sliced = sliceGrid(grid, image.width, image.height);
  if (!sliced.ok) return sliced;
  return { ok: true, value: { ...m, sheets: byId([...m.sheets, { id, assetId: image.id, grid: { ...grid }, frames: sliced.value }]) } };
}
/** Re-slice a sheet with a new grid. Replaces every frame; refused when an animation uses a frame id the new grid lacks. */
export function resliceSheet(m: AnimationsManifest, sheetId: string, image: SheetImage, grid: Grid): Result<AnimationsManifest> {
  return withSheet(m, sheetId, (s) => {
    const sliced = sliceGrid(grid, image.width, image.height);
    if (!sliced.ok) return sliced;
    const ids = new Set(sliced.value.map((f) => f.id));
    for (const a of animationsOfSheet(m, sheetId)) {
      const gone = a.sequence.find((e) => !ids.has(e.frameId));
      if (gone) return fail(`animation "${a.id}" uses frame "${gone.frameId}", which the new grid does not produce`);
    }
    return { ok: true, value: { ...s, grid: { ...grid }, frames: sliced.value } };
  });
}
/** Delete a sheet. Blocked while an animation is on it. */
export function removeSheet(m: AnimationsManifest, sheetId: string): Result<AnimationsManifest> {
  if (!m.sheets.some((s) => s.id === sheetId)) return fail(`no sheet "${sheetId}"`);
  const users = animationsOfSheet(m, sheetId);
  if (users.length > 0) return fail(`sheet "${sheetId}" is used by animation ${users.map((a) => a.id).join(", ")}`);
  return { ok: true, value: { ...m, sheets: m.sheets.filter((s) => s.id !== sheetId) } };
}

// ---- frames ----

const rectError = (r: Rect, image: SheetImage): string | null => {
  if (![r.x, r.y, r.w, r.h].every(isInt)) return "x, y, width and height must be whole pixels";
  if (r.w < 1 || r.h < 1) return "width and height must be at least 1";
  if (r.x < 0 || r.y < 0) return "x and y must be 0 or more";
  if (r.x + r.w > image.width || r.y + r.h > image.height) return `rectangle ends at ${r.x + r.w},${r.y + r.h}, image is ${image.width}x${image.height}`;
  return null;
};
/** Add a manual rectangle frame with the next free `f<n>` id. */
export function addFrame(m: AnimationsManifest, sheetId: string, rect: Rect, image: SheetImage): Result<AnimationsManifest> {
  return withSheet(m, sheetId, (s) => {
    const e = rectError(rect, image);
    if (e) return fail(e);
    if (s.frames.length >= MAX_FRAMES_PER_SHEET) return fail(`at most ${MAX_FRAMES_PER_SHEET} frames per sheet`);
    return { ok: true, value: { ...s, frames: [...s.frames, { id: nextFrameId(s.frames), x: rect.x, y: rect.y, w: rect.w, h: rect.h }] } };
  });
}
function setRect(m: AnimationsManifest, sheetId: string, frameId: string, image: SheetImage, edit: (f: Frame) => Rect): Result<AnimationsManifest> {
  return withSheet(m, sheetId, (s) => {
    const f = s.frames.find((x) => x.id === frameId);
    if (!f) return fail(`no frame "${frameId}" in sheet "${sheetId}"`);
    const next = edit(f);
    const e = rectError(next, image);
    if (e) return fail(e);
    return { ok: true, value: { ...s, frames: s.frames.map((x) => (x.id === frameId ? { ...x, ...next } : x)) } };
  });
}
/** Move a frame so its top left corner is at x,y (size unchanged). */
export const moveFrame = (m: AnimationsManifest, sheetId: string, frameId: string, x: number, y: number, image: SheetImage) =>
  setRect(m, sheetId, frameId, image, (f) => ({ x, y, w: f.w, h: f.h }));
/** Resize a frame to w,h (top left corner unchanged). */
export const resizeFrame = (m: AnimationsManifest, sheetId: string, frameId: string, w: number, h: number, image: SheetImage) =>
  setRect(m, sheetId, frameId, image, (f) => ({ x: f.x, y: f.y, w, h }));
export function reorderSheetFrame(m: AnimationsManifest, sheetId: string, from: number, to: number): Result<AnimationsManifest> {
  return withSheet(m, sheetId, (s) => { const r = reorderFrame(s.frames, from, to); return r.ok ? { ok: true, value: { ...s, frames: r.value } } : r; });
}
/** Duplicate frames[index] after itself with the next free `f<n>` id. */
export function duplicateSheetFrame(m: AnimationsManifest, sheetId: string, index: number): Result<AnimationsManifest> {
  return withSheet(m, sheetId, (s) => {
    if (s.frames.length >= MAX_FRAMES_PER_SHEET) return fail(`at most ${MAX_FRAMES_PER_SHEET} frames per sheet`);
    const r = duplicateFrame(s.frames, index, nextFrameId(s.frames));
    return r.ok ? { ok: true, value: { ...s, frames: r.value } } : r;
  });
}
/** Animation ids that use a frame of a sheet. */
export const animationsUsingFrame = (m: AnimationsManifest, sheetId: string, frameId: string): string[] =>
  framesUsedBy(frameId, animationsOfSheet(m, sheetId));
/**
 * Remove a frame. While an animation uses it the removal is blocked and names the animations; with `dropFromSequences` (the
 * user's confirmation) the entries are removed from those sequences instead. An animation left with no entries blocks it again.
 */
export function removeSheetFrame(m: AnimationsManifest, sheetId: string, frameId: string, dropFromSequences = false): Result<AnimationsManifest> {
  const own = animationsOfSheet(m, sheetId);
  const removed = withSheet(m, sheetId, (s) => {
    const r = removeFrame(s.frames, frameId, dropFromSequences ? [] : own);
    return r.ok ? { ok: true, value: { ...s, frames: r.value } } : r;
  });
  if (!removed.ok || !dropFromSequences) return removed;
  const users = new Set(framesUsedBy(frameId, own));
  const emptied = own.find((a) => users.has(a.id) && dropFromSequence(a.sequence, frameId).length === 0);
  if (emptied) return fail(`animation "${emptied.id}" would be left with no frames; delete it or add another frame first`);
  return { ok: true, value: { ...removed.value, animations: removed.value.animations.map((a) => (users.has(a.id) ? { ...a, sequence: dropFromSequence(a.sequence, frameId) } : a)) } };
}

// ---- animations ----

/** New animation on a sheet: first frame, 8 fps, loop. The sheet needs at least one frame (a sequence cannot be empty). */
export function addAnimation(m: AnimationsManifest, id: string, sheetId: string, kindRef: string): Result<AnimationsManifest> {
  if (!ID.test(id)) return fail(`invalid animation id "${id}"`);
  if (m.animations.some((a) => a.id === id)) return fail(`animation id "${id}" already exists`);
  if (m.animations.length >= MAX_ANIMATIONS) return fail(`at most ${MAX_ANIMATIONS} animations`);
  const sheet = m.sheets.find((s) => s.id === sheetId);
  if (!sheet) return fail(`no sheet "${sheetId}"`);
  const first = sheet.frames[0];
  if (!first) return fail(`sheet "${sheetId}" has no frames`);
  if (!KIND_ID.test(kindRef)) return fail(`invalid kind "${kindRef}"`);
  const a: Animation = { id, sheetId, kindRef, fps: DEFAULT_FPS, loop: "loop", sequence: [{ frameId: first.id, holdFrames: 1 }] };
  return { ok: true, value: { ...m, animations: byId([...m.animations, a]) } };
}
export function removeAnimation(m: AnimationsManifest, id: string): Result<AnimationsManifest> {
  if (!m.animations.some((a) => a.id === id)) return fail(`no animation "${id}"`);
  return { ok: true, value: { ...m, animations: m.animations.filter((a) => a.id !== id) } };
}
export function setFps(m: AnimationsManifest, id: string, fps: number): Result<AnimationsManifest> {
  if (!isInt(fps) || fps < FPS_RANGE.min || fps > FPS_RANGE.max) return fail(`fps must be a whole number from ${FPS_RANGE.min} to ${FPS_RANGE.max}`);
  return withAnimation(m, id, (a) => ({ ok: true, value: { ...a, fps } }));
}
export function setLoop(m: AnimationsManifest, id: string, loop: string): Result<AnimationsManifest> {
  if (!(LOOP_MODES as readonly string[]).includes(loop)) return fail(`loop must be one of ${LOOP_MODES.join(", ")}`);
  return withAnimation(m, id, (a) => ({ ok: true, value: { ...a, loop: loop as LoopMode } }));
}
export function setAnimationKind(m: AnimationsManifest, id: string, kindRef: string): Result<AnimationsManifest> {
  if (!KIND_ID.test(kindRef)) return fail(`invalid kind "${kindRef}"`);
  return withAnimation(m, id, (a) => ({ ok: true, value: { ...a, kindRef } }));
}
/** Append a frame of the animation's sheet to the end of its sequence (a frame may appear more than once). */
export function appendToSequence(m: AnimationsManifest, id: string, frameId: string): Result<AnimationsManifest> {
  return withAnimation(m, id, (a) => {
    const sheet = m.sheets.find((s) => s.id === a.sheetId);
    if (!sheet?.frames.some((f) => f.id === frameId)) return fail(`frame "${frameId}" is not in sheet "${a.sheetId}"`);
    if (a.sequence.length >= MAX_SEQUENCE) return fail(`at most ${MAX_SEQUENCE} entries in a sequence`);
    return { ok: true, value: { ...a, sequence: [...a.sequence, { frameId, holdFrames: 1 }] } };
  });
}
export function removeFromSequence(m: AnimationsManifest, id: string, index: number): Result<AnimationsManifest> {
  return withAnimation(m, id, (a) => {
    if (!isInt(index) || index < 0 || index >= a.sequence.length) return fail("no entry at that position");
    if (a.sequence.length === 1) return fail("an animation needs at least one frame");
    return { ok: true, value: { ...a, sequence: a.sequence.filter((_, i) => i !== index) } };
  });
}
export function moveInSequence(m: AnimationsManifest, id: string, from: number, to: number): Result<AnimationsManifest> {
  return withAnimation(m, id, (a) => {
    const ok = (i: number) => isInt(i) && i >= 0 && i < a.sequence.length;
    if (!ok(from) || !ok(to)) return fail(`position out of range 0..${a.sequence.length - 1}`);
    const seq = a.sequence.slice();
    const [moved] = seq.splice(from, 1);
    seq.splice(to, 0, moved as SequenceEntry);
    return { ok: true, value: { ...a, sequence: seq } };
  });
}
export function setHold(m: AnimationsManifest, id: string, index: number, holdFrames: number): Result<AnimationsManifest> {
  if (!isInt(holdFrames) || holdFrames < HOLD_RANGE.min || holdFrames > HOLD_RANGE.max) return fail(`hold must be a whole number from ${HOLD_RANGE.min} to ${HOLD_RANGE.max}`);
  return withAnimation(m, id, (a) => {
    if (!isInt(index) || index < 0 || index >= a.sequence.length) return fail("no entry at that position");
    return { ok: true, value: { ...a, sequence: a.sequence.map((e, i) => (i === index ? { ...e, holdFrames } : e)) } };
  });
}
