// Matching committed native app evidence (build + simulator launch) to the draft being edited.
// Evidence is bound to the exact canonical specification SHA-256 and to nothing else: not the template a draft started from,
// not the project id. An edited draft therefore never inherits a label; a draft that is edited back to the original does.
import type { GameEvidence, NativeIndex, NativeLabel } from "../../scripts/native-evidence.mjs";
export type { Check, CheckState, EvidenceFile, GameEvidence, NativeIndex, NativeLabel, PlatformEvidence } from "../../scripts/native-evidence.mjs";

export interface NativeAppMatch {
  /** Evidence recorded for exactly this specification. */
  exact: GameEvidence | null;
  /** Evidence for the same project id, recorded for a different specification. Never applies to the draft. */
  otherSpec: GameEvidence | null;
}
const SHA = /^[0-9a-f]{64}$/;
export function matchNativeApps(index: NativeIndex, sha: string | null, projectId: string | null): NativeAppMatch {
  const exact = sha !== null && SHA.test(sha) ? index.games.find((g) => g.specSha256 === sha) ?? null : null;
  const otherSpec = exact || !projectId ? null : index.games.find((g) => g.id === projectId) ?? null;
  return { exact, otherSpec };
}
/** The label a draft may carry from native evidence: only the matching evidence's, otherwise GENERATED. */
export function nativeLabelFor(index: NativeIndex, sha: string | null): NativeLabel {
  return matchNativeApps(index, sha, null).exact?.label ?? "GENERATED";
}
