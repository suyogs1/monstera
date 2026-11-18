// The one fact the Readiness checklist needs from Export: the spec hash for which a generated file set was verified against
// the engine plan (verifyPlan found no error). Held in memory for the page session only; a reload clears it, which is correct:
// nothing is proven across sessions.
import { useSyncExternalStore } from "react";

let current: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function setVerifiedPlan(specSha256: string | null): void {
  if (current === specSha256) return;
  current = specSha256;
  for (const l of listeners) l();
}
export const useVerifiedPlan = (): string | null => useSyncExternalStore(subscribe, () => current);
