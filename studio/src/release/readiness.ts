// Release readiness checklist (task 8.1, R13.3). Pure.
//
// What has and has not been proven for ONE spec hash, then the steps only the developer can do. Studio compiles nothing,
// launches nothing and signs nothing, so the only level it can prove itself is "generated", and only for the hash the
// current engine plan was made for. Evidence for the other levels is accepted only as an input bound to a spec hash; a
// result recorded for another hash proves nothing here. The words "store-ready" appear only in NOT_CLAIMED, which negates them.
export const PROOF_LEVELS = ["generated", "compiled", "simulator-tested", "device-tested"] as const;
export type ProofLevel = (typeof PROOF_LEVELS)[number];
export type ProofState = "proven" | "not-proven";
export interface ProofItem { level: ProofLevel; state: ProofState; detail: string }
export interface DeveloperStep { id: string; title: string; detail: string }
/** Evidence a caller holds (for example a committed CI result). Studio itself produces none. */
export interface ProofEvidence { level: Exclude<ProofLevel, "generated">; specSha256: string; source: string }
export interface ReadinessInput {
  /** The draft's canonical spec hash, or null while the draft has none. */
  specSha256: string | null;
  /** The spec hash the current engine export plan was verified for, or null when no verified plan exists. */
  generatedFor: string | null;
  evidence?: readonly ProofEvidence[];
}
export const NOT_CLAIMED = "Studio does not claim that this project is store-ready: that needs the compiled, tested and signed result of your own build, and the steps below.";
export const DEVELOPER_STEPS: readonly DeveloperStep[] = [
  { id: "signing", title: "Signing", detail: "Create your own Android keystore and iOS signing identity. Studio holds no keys and signs nothing." },
  { id: "store-listing", title: "Store listing", detail: "Write the store descriptions, screenshots and age rating in the Play Console and App Store Connect." },
  { id: "privacy", title: "Privacy declarations", detail: "Complete the Play data-safety form and the App Store privacy details for what your build really collects." },
  { id: "ad-ids", title: "Real ad ids", detail: "Studio uses published test ids only. Create your own AdMob app and ad unit ids and add them yourself." },
  { id: "firebase-files", title: "Firebase files", detail: "Add your own google-services.json and GoogleService-Info.plist. They stay out of Git." },
];
const LEVEL_TEXT: Record<ProofLevel, { title: string; missing: string }> = {
  generated: { title: "Generated", missing: "No source files have been generated and verified for this spec hash in this session." },
  compiled: { title: "Compiled", missing: "Studio does not build. No compile result is recorded for this spec hash." },
  "simulator-tested": { title: "Launched on a simulator or emulator", missing: "Studio launches nothing. No simulator result is recorded for this spec hash." },
  "device-tested": { title: "Tested on a physical device", missing: "Studio tests nothing on devices. No device result is recorded for this spec hash." },
};
export const levelTitle = (l: ProofLevel): string => LEVEL_TEXT[l].title;
export function readiness(input: ReadinessInput): { proofs: ProofItem[]; steps: readonly DeveloperStep[]; notClaimed: string } {
  const hash = input.specSha256;
  const proofs: ProofItem[] = PROOF_LEVELS.map((level) => {
    if (hash === null) return { level, state: "not-proven", detail: "The draft has no validated spec hash yet." };
    if (level === "generated") {
      return input.generatedFor === hash
        ? { level, state: "proven", detail: `Source files were generated and verified against the engine plan for ${hash.slice(0, 12)}. This does not show that they compile.` }
        : { level, state: "not-proven", detail: LEVEL_TEXT[level].missing };
    }
    const hit = (input.evidence ?? []).find((e) => e.level === level && e.specSha256 === hash);
    return hit ? { level, state: "proven", detail: `Recorded for ${hash.slice(0, 12)}: ${hit.source}.` } : { level, state: "not-proven", detail: LEVEL_TEXT[level].missing };
  });
  return { proofs, steps: DEVELOPER_STEPS, notClaimed: NOT_CLAIMED };
}
