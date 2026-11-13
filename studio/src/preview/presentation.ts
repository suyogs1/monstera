// Display-only port of the generated presentation module (templates/android/presentation/Presentation.kt.tmpl):
// layout, clipping, effects inferred from state differences, and HUD/card texts. Contract section 9: it reads engine
// output and writes nothing back, so floating point is allowed. It is NOT simulation: every tick comes from the engine.

export interface Box { x: number; y: number; w: number; h: number }

export function intersect(a: Box, b: Box): Box | null {
  const l = Math.max(a.x, b.x), t = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  return r > l && btm > t ? { x: l, y: t, w: r - l, h: btm - t } : null;
}

export const contains = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

export const HUD_MIN = 40;
export const HUD_FRACTION = 0.09;
export const HUD_MAX_FRACTION = 0.25;

/** HUD bar across the top, the world fitted (aspect kept, centred) into the rest; everything else is letterbox. */
export class Layout {
  readonly hudHeight: number;
  readonly hud: Box;
  readonly scale: number;
  readonly world: Box;

  constructor(readonly viewW: number, readonly viewH: number, worldW: number, worldH: number, insetTop = 0, insetBottom = 0) {
    this.hudHeight = Math.min(Math.max(HUD_MIN, Math.min(viewW, viewH) * HUD_FRACTION), viewH * HUD_MAX_FRACTION);
    this.hud = { x: 0, y: insetTop, w: viewW, h: this.hudHeight };
    const top = insetTop + this.hudHeight;
    const availH = viewH - top - insetBottom;
    this.scale = worldW <= 0 || worldH <= 0 || viewW <= 0 || availH <= 0 ? 0 : Math.min(viewW / worldW, availH / worldH);
    const w = worldW * this.scale, h = worldH * this.scale;
    this.world = { x: (viewW - w) / 2, y: top + (availH - h) / 2, w, h };
  }

  toScreen(b: Box): Box { return { x: this.world.x + b.x * this.scale, y: this.world.y + b.y * this.scale, w: b.w * this.scale, h: b.h * this.scale }; }
  visible(b: Box): Box | null { return intersect(this.toScreen(b), this.world); }
}

export type Effect = "none" | "burst" | "pickup";
export interface Tracked { id: number; kind: number; box: Box }
interface Particle { x: number; y: number; vx: number; vy: number; size: number; kind: number; age: number }
interface Ring { x: number; y: number; maxRadius: number; kind: number; age: number }
interface Popup { text: string; x: number; y: number; age: number }

export const PARTICLE_SECONDS = 0.4, RING_SECONDS = 0.3, POPUP_SECONDS = 0.6, FLASH_SECONDS = 0.25, SHAKE_SECONDS = 0.15;
const SHAKE_UNITS = 12, POPUP_RISE = 60, MAX_PARTICLES = 96, MAX_RINGS = 16, MAX_POPUPS = 8;
const D = 0.70710677;
const DIRECTIONS: [number, number][] = [[1, 0], [D, D], [0, 1], [-D, D], [-1, 0], [-D, -D], [0, -1], [D, -D]];

/** Effects from what changed between two frames (an effect kind vanished fully inside the world; lives went down). */
export class EffectTracker {
  private previous = new Map<number, Tracked>();
  private lastScore: number | null = null;
  private lastLives: number | null = null;
  private shakeAge = SHAKE_SECONDS;
  readonly particles: Particle[] = [];
  readonly rings: Ring[] = [];
  readonly popups: Popup[] = [];
  flash = 0;

  constructor(private readonly effects: Effect[], private readonly worldBox: Box) {}

  observe(score: number, lives: number, entities: Tracked[]): void {
    const now = new Map<number, Tracked>();
    for (const e of entities) now.set(e.id, e);
    const scoreDelta = this.lastScore === null ? 0 : score - this.lastScore;
    let popupDone = false;
    for (const [id, gone] of this.previous) {
      if (now.has(id)) continue;
      const effect = this.effects[gone.kind] ?? "none";
      if (effect === "none" || !contains(this.worldBox, gone.box)) continue;
      const cx = gone.box.x + gone.box.w / 2, cy = gone.box.y + gone.box.h / 2;
      const reach = Math.max(gone.box.w, gone.box.h);
      if (effect === "burst") {
        for (const [dx, dy] of DIRECTIONS) {
          if (this.particles.length < MAX_PARTICLES) {
            this.particles.push({ x: cx, y: cy, vx: dx * reach * 2, vy: dy * reach * 2, size: Math.max(4, reach * 0.12), kind: gone.kind, age: 0 });
          }
        }
      } else if (this.rings.length < MAX_RINGS) {
        this.rings.push({ x: cx, y: cy, maxRadius: reach, kind: gone.kind, age: 0 });
      }
      if (!popupDone && scoreDelta > 0 && this.popups.length < MAX_POPUPS) {
        this.popups.push({ text: `+${scoreDelta}`, x: cx, y: cy, age: 0 });
        popupDone = true;
      }
    }
    if (this.lastLives !== null && lives < this.lastLives) { this.flash = 1; this.shakeAge = 0; }
    this.previous = now;
    this.lastScore = score;
    this.lastLives = lives;
  }

  advance(dt: number): void {
    if (dt <= 0) return;
    for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.age += dt; }
    for (const r of this.rings) r.age += dt;
    for (const p of this.popups) { p.age += dt; p.y -= POPUP_RISE * dt; }
    remove(this.particles, (p) => p.age >= PARTICLE_SECONDS);
    remove(this.rings, (r) => r.age >= RING_SECONDS);
    remove(this.popups, (p) => p.age >= POPUP_SECONDS);
    this.flash = Math.max(0, this.flash - dt / FLASH_SECONDS);
    this.shakeAge += dt;
  }

  shakeX(): number { return this.shakeAge >= SHAKE_SECONDS ? 0 : SHAKE_UNITS * (1 - this.shakeAge / SHAKE_SECONDS) * (Math.trunc(this.shakeAge * 60) % 2 === 0 ? 1 : -1); }
  shakeY(): number { return this.shakeX() * -0.5; }
  ringRadius(r: Ring): number { return r.maxRadius * r.age / RING_SECONDS; }
}

function remove<T>(list: T[], gone: (x: T) => boolean): void {
  let j = 0;
  for (const x of list) if (!gone(x)) list[j++] = x;
  list.length = j;
}

export const MAX_LIFE_GLYPHS = 8;
export const Texts = {
  lives(glyph: string, lives: number): string {
    const n = Math.max(0, lives);
    if (glyph === "") return `lives ${n}`;
    return glyph.repeat(Math.min(n, MAX_LIFE_GLYPHS)) + (n > MAX_LIFE_GLYPHS ? ` +${n - MAX_LIFE_GLYPHS}` : "");
  },
  score: (label: string, score: number) => `${label} ${score}`,
  endTitle: (lives: number, win: string, lose: string) => (lives > 0 ? win : lose),
  glyphSize: (b: Box) => Math.min(b.w, b.h) * 0.9,
};
