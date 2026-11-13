// Pointer to engine events, following the generated Android shell (GameScreen.kt.tmpl): press on pointer down and
// release on up; a tap is a gesture that never moved more than TAP_SLOP_PX; drag deltas are sent continuously
// (schemes drag and tap) as raw Q16.16 world units; at the end of a drag, `lanes` sends one +-swipeSpeed drag for a
// mostly horizontal gesture and `swipe` sends one swipe in the dominant direction. The first tap starts a session and
// a tap on the end card restarts it. This mapping is approximate (browser pointer events, not Compose gestures);
// the engine's response to the events it produces is exact.
import type { EngineEvent } from "../engine/protocol";

export const TAP_SLOP_PX = 12;
export const RAW_ONE = 65536;
export type Scheme = "drag" | "swipe" | "lanes" | "tap";
export type Action = "start" | "restart" | null;
export interface Mapped { events: EngineEvent[]; action: Action }

export const event = (type: EngineEvent["type"], dx = 0, dy = 0, dir: EngineEvent["dir"] = "none"): EngineEvent => ({ type, dx, dy, dir });

export class PointerMapper {
  private down = false;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private totalX = 0;
  private totalY = 0;

  constructor(private readonly scheme: Scheme, private readonly swipeSpeed: number) {}

  /** `started`: the session has left the start card. Events are only sent while started (as in the shell). */
  pointerDown(x: number, y: number, started: boolean): Mapped {
    this.down = true; this.dragging = false;
    this.lastX = x; this.lastY = y; this.totalX = 0; this.totalY = 0;
    return { events: started ? [event("press")] : [], action: null };
  }

  /** `scale`: screen pixels per world unit (Layout.scale). */
  pointerMove(x: number, y: number, started: boolean, scale: number): Mapped {
    if (!this.down) return { events: [], action: null };
    const dx = x - this.lastX, dy = y - this.lastY;
    this.lastX = x; this.lastY = y;
    this.totalX += dx; this.totalY += dy;
    if (!this.dragging && Math.max(Math.abs(this.totalX), Math.abs(this.totalY)) > TAP_SLOP_PX) this.dragging = true;
    if (!this.dragging || !started || scale <= 0 || this.scheme === "swipe" || this.scheme === "lanes") return { events: [], action: null };
    return { events: [event("drag", Math.round((dx / scale) * RAW_ONE), Math.round((dy / scale) * RAW_ONE))], action: null };
  }

  pointerUp(started: boolean, ended: boolean): Mapped {
    if (!this.down) return { events: [], action: null };
    this.down = false;
    const events: EngineEvent[] = started ? [event("release")] : [];
    if (!this.dragging) {
      if (!started) return { events, action: "start" };
      if (ended) return { events, action: "restart" };
      return { events: [...events, event("tap")], action: null };
    }
    if (!started) return { events, action: null };
    const ax = Math.abs(this.totalX), ay = Math.abs(this.totalY);
    if (this.scheme === "lanes" && ax > ay && ax > TAP_SLOP_PX) {
      events.push(event("drag", this.totalX > 0 ? this.swipeSpeed : -this.swipeSpeed, 0));
    } else if (this.scheme === "swipe" && Math.max(ax, ay) > TAP_SLOP_PX) {
      events.push(event("swipe", 0, 0, ax > ay ? (this.totalX > 0 ? "right" : "left") : (this.totalY > 0 ? "down" : "up")));
    }
    return { events, action: null };
  }

  pointerCancel(started: boolean): Mapped {
    const was = this.down;
    this.down = false; this.dragging = false;
    return { events: was && started ? [event("release")] : [], action: null };
  }
}

/** Keyboard equivalents (accessibility; also approximate): Enter/Space tap, arrows swipe/lane/drag a twentieth of the world. */
export function keyEvents(key: string, scheme: Scheme, swipeSpeed: number, worldWRaw: number, worldHRaw: number, started: boolean, ended: boolean): Mapped {
  if (key === "Enter" || key === " ") {
    if (!started) return { events: [], action: "start" };
    if (ended) return { events: [], action: "restart" };
    return { events: [event("press"), event("release"), event("tap")], action: null };
  }
  const dirs: Record<string, [EngineEvent["dir"], number, number]> = { ArrowLeft: ["left", -1, 0], ArrowRight: ["right", 1, 0], ArrowUp: ["up", 0, -1], ArrowDown: ["down", 0, 1] };
  const d = dirs[key];
  if (!d || !started) return { events: [], action: null };
  const [dir, sx, sy] = d;
  if (scheme === "swipe") return { events: [event("swipe", 0, 0, dir)], action: null };
  if (scheme === "lanes") return { events: sx ? [event("drag", sx * swipeSpeed, 0)] : [], action: null };
  return { events: [event("drag", Math.round(sx * worldWRaw / 20), Math.round(sy * worldHRaw / 20))], action: null };
}

/** Consecutive drags are summed so the pending list stays bounded while the worker is busy. */
export function coalesce(pending: EngineEvent[], next: EngineEvent[]): EngineEvent[] {
  const out = pending.slice();
  for (const e of next) {
    const last = out[out.length - 1];
    if (e.type === "drag" && last?.type === "drag") out[out.length - 1] = event("drag", clamp32(last.dx + e.dx), clamp32(last.dy + e.dy));
    else out.push(e);
  }
  return out;
}
const clamp32 = (v: number) => Math.max(-2147483648, Math.min(2147483647, v));
