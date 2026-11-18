// Asset limits (design section 8, task 2.1). Pure functions; every check fails closed.
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 4096;
export const MAX_ASSETS = 256;

export interface LibraryUsage {
  readonly count: number;
  readonly totalBytes: number;
}

export type LimitResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const isCount = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/** Whether a file of `size` bytes may be added to a project that already holds `usage`. */
export function checkAddLimits(usage: LibraryUsage, size: number): LimitResult {
  if (!isCount(size) || !isCount(usage.count) || !isCount(usage.totalBytes)) return { ok: false, reason: "invalid size" };
  if (size === 0) return { ok: false, reason: "empty file" };
  if (size > MAX_FILE_BYTES) return { ok: false, reason: `file exceeds ${MAX_FILE_BYTES} bytes` };
  if (usage.count + 1 > MAX_ASSETS) return { ok: false, reason: `project already holds ${MAX_ASSETS} assets` };
  if (usage.totalBytes + size > MAX_PROJECT_BYTES) return { ok: false, reason: `project would exceed ${MAX_PROJECT_BYTES} bytes` };
  return { ok: true };
}

/** Whether image dimensions are positive integers within the per-side limit. */
export function checkDimensions(width: number, height: number): LimitResult {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return { ok: false, reason: "invalid image dimensions" };
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) return { ok: false, reason: `image side exceeds ${MAX_IMAGE_SIDE} px` };
  return { ok: true };
}
