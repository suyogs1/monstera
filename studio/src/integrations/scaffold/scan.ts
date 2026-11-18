// Text scanners applied to every emitted scaffold file (design 8.2): the secret rules from task 6.1 and the honesty rule
// that "live", "connected", "production" and "store-ready" appear only in a sentence that negates them.
import { secretRules } from "../secrets";

const CLAIM = /\b(live|connected|production|store-ready)\b/i;
const NEGATION = /\b(no|not|never|without|none|nor)\b|n't\b/i;

/** Sentences that use a claim word without a negation. */
export function unnegatedClaims(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n/).filter((s) => CLAIM.test(s) && !NEGATION.test(s)).map((s) => s.trim());
}

/** Problems found in one emitted file: secret rule names and unnegated claim sentences. */
export function scanScaffoldText(text: string): string[] {
  return [...secretRules(text).map((r) => `secret:${r}`), ...unnegatedClaims(text).map((s) => `claim:${s}`)];
}
