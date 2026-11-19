// Kiro templates for the exported project (task 7.3, design 3.1). Pure: project id in, `PackFile`s out; they travel through
// the Task 7.1 exporter, which classifies `.kiro/steering/`, `.kiro/specs/` and `.kiro/hooks/` as write-once (the developer
// owns them after the first export). `.kiro/steering/monstera-generated.md` is the engine's file and is never produced here.
// The text is documentation and configuration only: no build reads it, and it holds no credential, unit id or endpoint.
import type { PackFile } from "./export";
const enc = new TextEncoder();
const file = (path: string, text: string): PackFile => ({ path, data: enc.encode(text) });
const ID = /^[a-z][a-z0-9-]{1,31}$/;
const steering = (title: string, body: string) => `---\ninclusion: always\n---\n# ${title}\n${body.trim()}\n`;
const OWNERSHIP = steering("Who owns which file (MONSTERA Studio export)", `
This project was exported by MONSTERA Studio. Every Studio-written file belongs to one class, recorded in
\`MONSTERA-STUDIO-MANIFEST.json\` (class and SHA-256 per file).

| Class | Paths | Rule |
|---|---|---|
| spec | \`monstera.spec.json\` | The source of truth for the generated native code. Edit it, then regenerate. |
| engine-owned | \`android/\`, \`ios/\`, \`MONSTERA-MANIFEST.json\`, \`.kiro/steering/monstera-generated.md\` | Produced by \`monstera generate\`. Never edit by hand. |
| studio-data | \`studio-pack/*.json\`, \`studio-pack/assets/\` | Studio's copy wins on re-export. Edit in Studio. |
| studio-scaffold | \`studio-pack/scaffold/\`, \`studio-pack/derived/\`, \`tools/\` | Written by Studio and drift-checked. A hand edit is reported as drift and is not overwritten silently. |
| write-once | \`extensions/\`, \`studio-pack/PROJECT-NOTES.md\`, \`.gitignore\`, the other \`.kiro/\` files | Yours after the first export. Studio never overwrites them. |

Put hand-written native code in \`extensions/\`. Studio does not merge or reverse-engineer native code.
`);
const UNITS = steering("Units and numbers in the spec", `
- Game quantities in \`monstera.spec.json\` are Q16.16 raw integers: 1 unit = 65536. Never write a float or a decimal.
- Pixels, ticks and frames per second are plain integers.
- Ids match \`^[a-z][a-z0-9-]{1,31}$\`, are unique in their list and are never renamed or reused.
- The simulation is deterministic: randomness comes from named streams derived from the seed. Do not add a clock, system
  randomness or floating point to anything that affects gameplay.
`);
const NEVER_EDIT = steering("Never edit generated output", `
- Do not edit files under \`android/\` or \`ios/\`, \`MONSTERA-MANIFEST.json\` or \`.kiro/steering/monstera-generated.md\`. Their
  headers say \`GENERATED ... do not edit\` and \`monstera verify\` reports a hand edit.
- To change behaviour, edit \`monstera.spec.json\` (or use Studio), then run \`monstera generate monstera.spec.json\`.
- Files under \`studio-pack/scaffold/\` are scaffolds and mocks, not a live backend or ad integration. Do not describe them as one.
- Production ad unit ids, API keys and service-account files do not belong in this repository. Keep them out of Studio and out of
  the spec; add them only in developer-owned files under \`extensions/\`, outside version control where the platform allows.
`);
const DRIFT = steering("Drift commands", `
Run these from the project root.

- \`sh tools/check-drift.sh\` compares every file listed in \`MONSTERA-STUDIO-MANIFEST.json\` with its recorded SHA-256 and reports
  each file as unchanged, edited, missing or unknown. A non-zero exit status means drift was found.
- \`monstera verify\` checks the engine-owned files against \`MONSTERA-MANIFEST.json\`. \`monstera generate --check\` checks that
  they still match \`monstera.spec.json\`. Both need the MONSTERA command line tool, which this project does not include.
- Drift is information, not an error to hide. Decide per file: keep your edit, or re-export from Studio and choose to overwrite.
`);
const hooks = JSON.stringify({
  version: "v1",
  hooks: [{
    name: "Check Studio drift when a Kiro Spec task completes",
    trigger: "PostTaskExec",
    description: "After a task completes, run the drift check over the files Studio wrote. A non-zero exit means a recorded file was edited, is missing or is unknown.",
    action: { type: "command", command: "sh tools/check-drift.sh", timeout: 60 },
  }],
}, null, 2) + "\n";
/** Kiro files for the export of project `projectId`. Throws on an id the spec schema would refuse. */
export function kiroTemplates(projectId: string): PackFile[] {
  if (!ID.test(projectId)) throw new Error(`'${projectId}' is not a valid project id`);
  const dir = `.kiro/specs/${projectId}`;
  return [
    file(".kiro/steering/studio-ownership.md", OWNERSHIP),
    file(".kiro/steering/studio-units.md", UNITS),
    file(".kiro/steering/studio-never-edit-generated.md", NEVER_EDIT),
    file(".kiro/steering/studio-drift.md", DRIFT),
    file(`${dir}/requirements.md`, `# Requirements: ${projectId}\n\nStarting point for your own work on this project. Replace this text with the requirements you add.\n\n## Requirement 1\n\nAs a player, I want <behaviour>, so that <outcome>.\n\n### Acceptance criteria\n\n1. WHEN <event> THEN the game SHALL <response>.\n`),
    file(`${dir}/design.md`, `# Design: ${projectId}\n\nDescribe how each requirement is met. State which file owns each fact: the spec, a Studio data file or code in \`extensions/\`.\n\n## Changes to monstera.spec.json\n\n## Native extensions\n\n## Verification\n`),
    file(`${dir}/tasks.md`, `# Tasks: ${projectId}\n\n- [ ] 1. Describe the first change here. Test: name the command that shows it works.\n`),
    file(".kiro/hooks/studio-drift-check.json", hooks),
  ];
}
