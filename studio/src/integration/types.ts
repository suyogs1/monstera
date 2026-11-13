/** Shape of src/generated/inventory.json, written by scripts/build-inventory.mjs from the repository files. */
export interface Inventory {
  commit: { sha: string | null; short: string; dirty: boolean; branch: string; source: "git" | "VERCEL_GIT_COMMIT_SHA" | "unavailable" };
  sources: string[];
  mcp: {
    source: string;
    servers: { name: string; command: string; disabled: boolean; autoApprove: string[] }[];
    tools: { name: string; params: string; access: string; summary: string; description: string }[];
  };
  agents: {
    file: string; name: string; description: string; tools: string[]; includesMcpJson: boolean;
    writeAllow: string[]; writeDeny: string[]; shellAllow: string[]; resources: string[]; prompt: string;
  }[];
  hooks: { file: string; name: string; trigger: string; matcher: string; description: string; actionType: string; command: string }[];
  workflows: { file: string; name: string; description: string; inputs: string[]; agents: string[] }[];
  steering: { file: string; title: string; inclusion: string; pattern: string }[];
  prompts: { file: string; title: string; body: string }[];
}
