// The frame a kind's sprite shows (contract section 10, rule 3): frames[(t div ticksPerFrame) mod count] at simulation tick t.
// Integer arithmetic only, the same table the Kotlin and Swift presentation tests assert.
export interface SpriteLike { frames: readonly number[]; ticksPerFrame: number }
export interface AtlasLike { frameWidth: number; frameHeight: number; columns: number; rows: number }

/** The atlas frame index shown at a tick; null when the kind has no frames (the glyph or colour box is drawn instead). */
export function spriteFrameAt(sprite: SpriteLike, tick: number): number | null {
  const n = sprite.frames.length;
  if (n === 0 || !Number.isSafeInteger(tick) || tick < 0 || !Number.isSafeInteger(sprite.ticksPerFrame) || sprite.ticksPerFrame < 1) return null;
  return sprite.frames[Math.floor(tick / sprite.ticksPerFrame) % n] ?? null;
}

/** Source rectangle of a frame in the atlas image (frame n: column n mod columns, row n div columns). Null outside the atlas. */
export function frameRect(atlas: AtlasLike, index: number): { x: number; y: number; w: number; h: number } | null {
  if (!Number.isSafeInteger(index) || index < 0 || index >= atlas.columns * atlas.rows) return null;
  return { x: (index % atlas.columns) * atlas.frameWidth, y: Math.floor(index / atlas.columns) * atlas.frameHeight, w: atlas.frameWidth, h: atlas.frameHeight };
}
