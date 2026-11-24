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

/**
 * Hand-computed cases: (minSecondsBetween, maxPerSession, shownCount, lastShownSeconds, nowSeconds) -> expected.
 * The same table is rendered into the Kotlin and Swift tests of the exported extensions, so all three
 * implementations are checked against numbers worked out by hand, not against each other.
 */
export const FREQUENCY_CASES: readonly (readonly [number, number, number, number, number, boolean])[] = [
  [120, 3, 0, -1, 0, true],      // nothing shown yet
  [120, 3, 1, 100, 219, false],  // 219 - 100 = 119 < 120
  [120, 3, 1, 100, 220, true],   // 220 - 100 = 120, exactly the spacing
  [120, 3, 3, 100, 9999, false], // 3 shown of 3 allowed
  [120, 3, 2, 100, 100, false],  // same second: 0 < 120
  [0, 5, 2, 50, 50, true],       // no spacing needed
  [0, 0, 0, -1, 0, false],       // a cap of 0 means never
  [60, 1, 0, -1, 1000, true],    // first show is never spaced
  [60, 1, 1, 0, 1000, false],    // cap of 1 reached
  [30, 2, 1, 0, 29, false],      // 29 < 30
  [30, 2, 1, 0, 30, true],       // 30 >= 30
];
/** True when a placement may be shown now. maxPerSession 0 means never. */
export function canShowAd(minSecondsBetween: number, maxPerSession: number, shownCount: number, lastShownSeconds: number, nowSeconds: number): boolean {
  if (shownCount >= maxPerSession) return false;
  if (lastShownSeconds < 0) return true;
  return nowSeconds - lastShownSeconds >= minSecondsBetween;
}
