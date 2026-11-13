// Click-through between the preview and the Entities editor. Display only: nothing here reaches the engine.
// Selection is by kind id (stable across edits that reorder or remove kinds); hit-testing uses exactly the boxes the
// canvas draws (interpolated for display, clipped to the world rectangle).
import type { PreviewSnapshot } from "../engine/protocol";
import { intersect, type Box, type Layout } from "./presentation";

export const RAW = 65536;
export const STRIDE = 7; // id, kind, x, y, vx, vy, controlled

export interface KindSize { width: number; height: number }

/** The world-unit box entity `i` is drawn at (position interpolated by the loop's alpha, display only). */
export function entityBox(s: PreviewSnapshot, i: number, kinds: KindSize[]): Box | null {
  const k = kinds[s.entities[i + 1]!];
  if (!k) return null;
  const a = s.alpha / RAW;
  return { x: (s.entities[i + 2]! + s.entities[i + 4]! * a) / RAW, y: (s.entities[i + 3]! + s.entities[i + 5]! * a) / RAW, w: k.width / RAW, h: k.height / RAW };
}

/** The kind index under screen point (px, py), or null. Only the visible part of a box counts (outside the world
 *  rectangle nothing is hit); where boxes overlap, the entity drawn last (on top) wins. */
export function hitTest(s: PreviewSnapshot, kinds: KindSize[], L: Layout, px: number, py: number): number | null {
  const inside = (b: Box) => px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
  if (!inside(L.world)) return null;
  let hit: number | null = null;
  for (let i = 0; i < s.entities.length; i += STRIDE) {
    const box = entityBox(s, i, kinds);
    if (!box) continue;
    const visible = intersect(L.toScreen(box), L.world);
    if (visible && inside(visible)) hit = s.entities[i + 1]!;
  }
  return hit;
}

export interface SelectionState { kindId: string | null; source: "preview" | "editor" | null; at: number }
type Listener = () => void;

export class Selection {
  private st: SelectionState = { kindId: null, source: null, at: 0 };
  private readonly listeners = new Set<Listener>();
  getState = (): SelectionState => this.st;
  subscribe = (l: Listener): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  set(kindId: string | null, source: SelectionState["source"]): void {
    if (this.st.kindId === kindId && this.st.source === source) return;
    this.st = { kindId, source, at: this.st.at + 1 };
    for (const l of this.listeners) l();
  }
}
