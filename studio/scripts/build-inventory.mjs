// Builds the Developer Integration inventory from the repository's actual Kiro configuration.
// Nothing here is typed by hand: agents, hooks, workflows, steering, prompts, the MCP settings and the MCP tool
// list are read from .kiro/ and tools/monstera-mcp/server.py, stamped with the commit they were read at.
// Output (git-ignored): src/generated/inventory.json. It never contacts Kiro or any service.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const studio = join(here, "..");
const repo = join(studio, "..");
const kiro = join(repo, ".kiro");

const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim();
const readText = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const files = (dir, ext) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(ext)).sort() : []);

const SOURCES = [".kiro/agents", ".kiro/hooks", ".kiro/workflows", ".kiro/steering", ".kiro/prompts", ".kiro/settings/mcp.json", "tools/monstera-mcp/server.py"];

// ------------------------------------------------------------------ commit stamp
function stamp() {
  try {
    const sha = git("rev-parse", "HEAD");
    const dirty = git("status", "--porcelain", "--", ...SOURCES).length > 0;
    let branch = "";
    try { branch = git("rev-parse", "--abbrev-ref", "HEAD"); } catch { /* detached or unavailable */ }
    return { sha, short: sha.slice(0, 7), dirty, branch, source: "git" };
  } catch {
    const sha = process.env.VERCEL_GIT_COMMIT_SHA;
    if (sha) return { sha, short: sha.slice(0, 7), dirty: false, branch: process.env.VERCEL_GIT_COMMIT_REF ?? "", source: "VERCEL_GIT_COMMIT_SHA" };
    return { sha: null, short: "unknown", dirty: false, branch: "", source: "unavailable" };
  }
}

// ------------------------------------------------------------------ agents
function agents() {
  return files(join(kiro, "agents"), ".json").map((file) => {
    const a = JSON.parse(readText(join(kiro, "agents", file)));
    const rules = a.permissions?.rules ?? [];
    return {
      file: `.kiro/agents/${file}`, name: a.name ?? file.replace(/\.json$/, ""), description: a.description ?? "",
      tools: a.tools ?? [], includesMcpJson: a.includeMcpJson === true,
      writeAllow: rules.filter((r) => r.capability === "fs_write" && r.effect === "allow").flatMap((r) => r.match ?? []),
      writeDeny: rules.filter((r) => r.capability === "fs_write" && r.effect === "deny").flatMap((r) => r.match ?? []),
      shellAllow: rules.filter((r) => r.capability === "shell" && r.effect === "allow").flatMap((r) => r.match ?? []),
      resources: a.resources ?? [], prompt: a.prompt ?? "",
    };
  });
}

// ------------------------------------------------------------------ hooks
function hooks() {
  return files(join(kiro, "hooks"), ".json").flatMap((file) => {
    const j = JSON.parse(readText(join(kiro, "hooks", file)));
    const list = Array.isArray(j.hooks) ? j.hooks : [j];
    return list.map((h) => ({
      file: `.kiro/hooks/${file}`, name: h.name ?? file, trigger: h.trigger ?? h.when?.type ?? "", matcher: h.matcher ?? "",
      description: h.description ?? "", actionType: h.action?.type ?? (h.then?.type ?? ""),
      command: h.action?.command ?? h.then?.command ?? "",
    }));
  });
}

// ------------------------------------------------------------------ workflows
function collectAgents(node, out) {
  if (Array.isArray(node)) node.forEach((n) => collectAgents(n, out));
  else if (node && typeof node === "object") {
    if (typeof node.agent === "string") out.add(node.agent);
    Object.values(node).forEach((v) => collectAgents(v, out));
  }
}
function workflows() {
  return files(join(kiro, "workflows"), ".workflow.json").map((file) => {
    const w = JSON.parse(readText(join(kiro, "workflows", file)));
    const used = new Set();
    collectAgents(w.steps, used);
    return { file: `.kiro/workflows/${file}`, name: w.name ?? file, description: w.description ?? "", inputs: Object.keys(w.inputs ?? {}), agents: [...used].sort() };
  });
}

// ------------------------------------------------------------------ steering
function steering() {
  return files(join(kiro, "steering"), ".md").map((file) => {
    const text = readText(join(kiro, "steering", file));
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    const body = fm ? text.slice(text.indexOf("\n---\n", 4) + 5) : text;
    const get = (k) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1]?.trim() ?? "";
    return {
      file: `.kiro/steering/${file}`, title: /^#\s+(.+)$/m.exec(body)?.[1] ?? file,
      inclusion: get("inclusion") || "always", pattern: get("fileMatchPattern"),
    };
  });
}

// ------------------------------------------------------------------ prompts
function prompts() {
  return files(join(kiro, "prompts"), ".md").map((file) => {
    const body = readText(join(kiro, "prompts", file));
    return { file: `.kiro/prompts/${file}`, title: /^#\s+(.+)$/m.exec(body)?.[1] ?? file, body };
  });
}

// ------------------------------------------------------------------ MCP
function mcp() {
  const settings = JSON.parse(readText(join(kiro, "settings", "mcp.json")));
  const servers = Object.entries(settings.mcpServers ?? {}).map(([name, s]) => ({
    name, command: [s.command, ...(s.args ?? [])].join(" "), disabled: s.disabled === true, autoApprove: s.autoApprove ?? [],
  }));
  const src = readText(join(repo, "tools", "monstera-mcp", "server.py"));
  const tools = [];
  const re = /@server\.tool\(([^\n]*)\)\n(?:@\w+\n)*def (\w+)\(([\s\S]*?)\)(?: ->[^\n:]*(?:\[[^\n]*?\])?)?:[^\n]*\n\s+"""([\s\S]*?)"""/g;
  for (const m of src.matchAll(re)) {
    const ann = m[1];
    const access = /READ_ONLY/.test(ann) ? "read-only"
      : /WRITES/.test(ann) ? "can write files"
      : /readOnlyHint=True/.test(ann) ? "read-only" : "may write output files";
    const doc = m[4].replace(/\s+/g, " ").trim();
    tools.push({ name: m[2], params: m[3].replace(/#.*$/gm, "").replace(/\s+/g, " ").trim(), access, summary: doc.split(/(?<=\.)\s/)[0] ?? doc, description: doc });
  }
  return { servers, tools, source: "tools/monstera-mcp/server.py" };
}

const inventory = {
  commit: stamp(),
  sources: SOURCES,
  mcp: mcp(), agents: agents(), hooks: hooks(), workflows: workflows(), steering: steering(), prompts: prompts(),
};

if (inventory.mcp.tools.length === 0) throw new Error("no MCP tools were found in server.py; the extraction pattern needs attention");
const out = join(studio, "src", "generated");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
console.log(`inventory @ ${inventory.commit.short}${inventory.commit.dirty ? " (dirty)" : ""}: ${inventory.agents.length} agents, ` +
  `${inventory.mcp.tools.length} MCP tools, ${inventory.hooks.length} hooks, ${inventory.workflows.length} workflows, ` +
  `${inventory.steering.length} steering files, ${inventory.prompts.length} prompts`);
