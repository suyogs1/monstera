// World drawing rules shared by the live preview and Level Studio, so the two cannot drift. Display only (contract
// section 9): nothing here simulates or writes anything back, so floating point is allowed.
import type { CompiledEntity, CompiledSpawner } from "../derive/levels";
import { type Scheme } from "./input";
import { Layout, Texts, type Box, type Effect } from "./presentation";
import { RAW } from "./select";
import { frameRect, spriteFrameAt } from "../sprites/atlas/frame";

export interface AtlasMeta { png: string; frameWidth: number; frameHeight: number; columns: number; rows: number }
export interface Kind { id: string; color: string; glyph: string; effect: Effect; width: number; height: number; sprite?: { frames: number[]; ticksPerFrame: number } }
export interface Display {
  displayName: string; orientation: "landscape" | "portrait"; worldW: number; worldH: number; scheme: Scheme; swipeSpeed: number;
  palette: { primary: string; accent: string; background: string }; hud: { lifeGlyph: string; scoreLabel: string };
  screens: { startHint: string; winTitle: string; loseTitle: string }; kinds: Kind[];
  /** The spec's embedded atlas; absent when the spec has none (empty png). */
  atlas?: AtlasMeta;
}
/** Display fields of a parsed spec document. */
export function displayOfDoc(d: { project: { displayName: string }; game: any }): Display {
  const g = d.game;
  return {
    displayName: d.project.displayName, orientation: g.orientation, worldW: g.world.width, worldH: g.world.height,
    scheme: g.input.scheme, swipeSpeed: g.input.swipeSpeed, palette: g.palette, hud: g.hud, screens: g.screens,
    kinds: g.runtime.kinds.map((k: Kind) => ({ id: k.id, color: k.color, glyph: k.glyph, effect: k.effect, width: k.width, height: k.height, ...(k.sprite && k.sprite.frames.length > 0 ? { sprite: { frames: [...k.sprite.frames], ticksPerFrame: k.sprite.ticksPerFrame } } : {}) })),
    ...(g.atlas && g.atlas.png !== "" ? { atlas: { png: g.atlas.png, frameWidth: g.atlas.frameWidth, frameHeight: g.atlas.frameHeight, columns: g.atlas.columns, rows: g.atlas.rows } } : {}),
  };
}
/** Display fields of the running session's spec (the same text the engine was started with). */
export const displayOf = (text: string): Display => displayOfDoc(JSON.parse(text));

export function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a))})`;
}
const atlasImages = new Map<string, HTMLImageElement>();
/** The decoded atlas image once it has loaded (null before that, and where there is no DOM). Cached by the PNG text. */
export function atlasImage(atlas: AtlasMeta): HTMLImageElement | null {
  const cached = atlasImages.get(atlas.png);
  if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;
  if (typeof Image === "undefined") return null;
  const img = new Image();
  img.src = `data:image/png;base64,${atlas.png}`;
  atlasImages.set(atlas.png, img);
  return null;
}
/**
 * One entity of a kind inside its screen box: its atlas frame at the simulation tick when the kind has a sprite and the atlas has
 * loaded, otherwise a colour fill, or the kind's glyph centred in the box (the native apps fall back the same way).
 */
export function drawEntityBox(ctx: CanvasRenderingContext2D, kind: Kind, px: Box, tick = 0, atlas?: AtlasMeta): void {
  if (kind.sprite && atlas) {
    const index = spriteFrameAt(kind.sprite, tick);
    const rect = index === null ? null : frameRect(atlas, index);
    const img = rect === null ? null : atlasImage(atlas);
    if (rect && img) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, px.x, px.y, px.w, px.h);
      return;
    }
  }
  if (kind.glyph === "") { ctx.fillStyle = kind.color; ctx.fillRect(px.x, px.y, px.w, px.h); return; }
  ctx.font = `${Texts.glyphSize(px)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = kind.color;
  ctx.fillText(kind.glyph, px.x + px.w / 2, px.y + px.h / 2);
}
export function drawBackdrop(ctx: CanvasRenderingContext2D, L: Layout, d: Display): void {
  ctx.fillStyle = d.palette.background;
  ctx.fillRect(0, 0, L.viewW, L.viewH);
}
export function drawWorldFrame(ctx: CanvasRenderingContext2D, L: Layout, d: Display): void {
  ctx.strokeStyle = d.palette.primary; ctx.lineWidth = 2;
  ctx.strokeRect(L.world.x, L.world.y, L.world.w, L.world.h);
}
/** Screen box of a level placement (top-left x/y in raw units, size from its kind), same convention as the preview. */
export const placementBox = (e: CompiledEntity, k: Kind): Box => ({ x: e.x / RAW, y: e.y / RAW, w: k.width / RAW, h: k.height / RAW });
/** World box covered by a spawner's x/y ranges (spawn positions are the range, the entity extends by its size). */
export const spawnerBand = (s: CompiledSpawner, k: Kind): Box => ({
  x: s.xMin / RAW, y: s.yMin / RAW, w: (s.xMax - s.xMin + k.width) / RAW, h: (s.yMax - s.yMin + k.height) / RAW,
});
/**
 * A level's world: initial placements drawn as the preview draws entities, and each spawner as its x/y range (a
 * translucent band) with the kind glyph at the range start and a short arrow along its (vx, vy). No simulation runs.
 */
export function drawLevelWorld(ctx: CanvasRenderingContext2D, L: Layout, d: Display, entities: readonly CompiledEntity[], spawners: readonly CompiledSpawner[]): void {
  drawBackdrop(ctx, L, d);
  ctx.save();
  ctx.beginPath(); ctx.rect(L.world.x, L.world.y, L.world.w, L.world.h); ctx.clip();
  const kindOf = (id: string) => d.kinds.find((k) => k.id === id);
  for (const s of spawners) {
    const k = kindOf(s.kind);
    if (!k) continue;
    const band = L.toScreen(spawnerBand(s, k));
    ctx.fillStyle = withAlpha(k.color, 0.18); ctx.fillRect(band.x, band.y, band.w, band.h);
    ctx.strokeStyle = withAlpha(k.color, 0.6); ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.strokeRect(band.x, band.y, band.w, band.h); ctx.setLineDash([]);
    drawEntityBox(ctx, k, L.toScreen({ x: s.xMin / RAW, y: s.yMin / RAW, w: k.width / RAW, h: k.height / RAW }), 0, d.atlas);
    const len = Math.hypot(s.vx, s.vy);
    if (len > 0) {
      const cx = band.x + band.w / 2, cy = band.y + band.h / 2, ux = s.vx / len, uy = s.vy / len, a = Math.max(12, 28 * L.scale);
      ctx.strokeStyle = k.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + ux * a, cy + uy * a); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + ux * a, cy + uy * a); ctx.lineTo(cx + ux * a - (ux + uy * 0.6) * 5, cy + uy * a - (uy - ux * 0.6) * 5);
      ctx.moveTo(cx + ux * a, cy + uy * a); ctx.lineTo(cx + ux * a - (ux - uy * 0.6) * 5, cy + uy * a - (uy + ux * 0.6) * 5); ctx.stroke();
    }
  }
  for (const e of entities) {
    const k = kindOf(e.kind);
    if (!k) continue;
    const box = placementBox(e, k);
    if (L.visible(box) === null) continue;
    drawEntityBox(ctx, k, L.toScreen(box), 0, d.atlas);
  }
  ctx.restore();
  drawWorldFrame(ctx, L, d);
}
