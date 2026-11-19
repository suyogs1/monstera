// Handoff prompts for Kiro Development (task 7.4, design 8.3 `kiro-manual`). Static text the user copies into Kiro. Studio has no
// channel to Kiro: nothing here is sent anywhere, and nothing reads an answer back except through a file the user imports.
// The pack prompts name the exported files and commands that task 7.1 to 7.3 produce.
export interface HandoffPrompt { id: "validate" | "change" | "continue-export" | "propose"; title: string; text: string }
export const specPathOf = (projectId: string): string => `spec/samples/${projectId}/monstera.spec.json`;
export const PROPOSAL_EXAMPLE = JSON.stringify({
  schema: "monstera.studio.proposal", version: 1, target: "levels", summary: "Slow the first wave.",
  ops: [{ op: "set", path: "/levels/0/waves/0/vy", value: "262144" }],
}, null, 2);
/** The repository prompts: validate and change the spec in the MONSTERA repository (unchanged since Developer Integration). */
export function repositoryPrompts(projectId: string): HandoffPrompt[] {
  const path = specPathOf(projectId);
  return [
    {
      id: "validate", title: "Validate this draft",
      text: `Validate ${path} with the monstera validate_spec tool. Do not change any file yet. ` +
        `Explain every issue in plain language and propose the smallest fix for each.`,
    },
    {
      id: "change", title: "Change this game",
      text: `Using the game-author agent, change the game in ${path}: <describe the change>. ` +
        `Follow .kiro/steering/10-game-authoring.md, validate with validate_spec, and show me the diff before generating anything.`,
    },
  ];
}
/** The pack prompts: work inside a project exported from Studio, using its ownership manifest and drift check. */
export function packPrompts(): HandoffPrompt[] {
  return [
    {
      id: "continue-export", title: "Continue an exported project",
      text:
        "This directory is a project exported from MONSTERA Studio. Read .kiro/steering/ first. " +
        "MONSTERA-STUDIO-MANIFEST.json lists every Studio-written file with its class. " +
        "Do not edit android/, ios/ or studio-pack/scaffold/ by hand. Put native code in extensions/. " +
        "Before and after your change run `bash tools/check-drift.sh` and tell me every file it reports as edited or missing. " +
        "Change the game by editing monstera.spec.json, then validate and regenerate with the monstera tools. Task: <describe the change>.",
    },
    {
      id: "propose", title: "Propose a change for Studio to review",
      text:
        "Do not edit the project. Write one file, studio-proposal.json, that proposes this change: <describe the change>. " +
        "Format: schema \"monstera.studio.proposal\", version 1, target one of spec, levels, gameplay, animations, assets-metadata, " +
        "a summary, and ops. Each op has \"op\" (add, set or remove), a JSON pointer \"path\" into the target document, and \"value\" " +
        "as JSON text (empty for remove). Use whole-number Q16.16 raw values, no decimals. Example:\n" + PROPOSAL_EXAMPLE + "\n" +
        "I will import the file into Studio, which validates it, shows the difference and applies it only if I accept.",
    },
  ];
}
export const handoffPrompts = (projectId: string): HandoffPrompt[] => [...repositoryPrompts(projectId), ...packPrompts()];
