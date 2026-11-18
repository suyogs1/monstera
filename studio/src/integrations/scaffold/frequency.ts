// Frequency limit for ad placements (task 6.2): specified once here, tested here, and rendered as text into the Kotlin
// and Swift scaffolds. The rule expressions use syntax that is valid and identical in TypeScript, Kotlin and Swift, so the
// emitted text is the same expressions. Integer seconds only; lastShownSeconds is -1 when nothing was shown yet.
export interface FrequencyRule { when: string; result: boolean }
export const FREQUENCY_PARAMS = ["minSecondsBetween", "maxPerSession", "shownCount", "lastShownSeconds", "nowSeconds"] as const;
export const FREQUENCY_RULES: readonly FrequencyRule[] = [
  { when: "shownCount >= maxPerSession", result: false },
  { when: "lastShownSeconds < 0", result: true },
];
export const FREQUENCY_FINAL = "nowSeconds - lastShownSeconds >= minSecondsBetween";

/** True when a placement may be shown now. maxPerSession 0 means never. */
export function canShowAd(minSecondsBetween: number, maxPerSession: number, shownCount: number, lastShownSeconds: number, nowSeconds: number): boolean {
  if (shownCount >= maxPerSession) return false;
  if (lastShownSeconds < 0) return true;
  return nowSeconds - lastShownSeconds >= minSecondsBetween;
}
