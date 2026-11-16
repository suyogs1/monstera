// The Studio capability registry (studio/capabilities.json): the single place that says what each module and capability is,
// today and as targeted, and whether it reaches the generated native apps. UI headers, the generated matrix in
// docs/STUDIO-CAPABILITIES.md and the consistency test all read this one file. It holds no logic about the game.
import registryJson from "../../capabilities.json";
import schemaJson from "../../schemas/capabilities.schema.json";
import { compileSchema, validate, type Issue } from "../project/manifests/schema";

export const STATUSES = ["implemented", "prototype", "mock", "planned", "unsupported"] as const;
export type CapabilityStatus = (typeof STATUSES)[number];
export const NATIVE_OUTPUTS = ["compiles to native", "studio only", "scaffold", "mock", "planned"] as const;
export type NativeOutput = (typeof NATIVE_OUTPUTS)[number];
/** The 11 Studio modules, in navigation order (mission order). */
export const MODULE_ORDER = [
  ["dashboard", "Project Dashboard"], ["designer", "Game Designer"], ["assets", "Asset Studio"], ["sprites", "Sprite and Animation Editor"],
  ["levels", "Level Studio"], ["gameplay", "Gameplay Systems"], ["backend", "Backend and Services"], ["monetization", "Monetization"],
  ["kiro", "Kiro Development"], ["preview", "Preview and Device Lab"], ["release", "Build and Release"],
] as const;
export type ModuleId = (typeof MODULE_ORDER)[number][0];

export interface ModuleEntry {
  id: ModuleId; title: string; status: CapabilityStatus; targetStatus: CapabilityStatus; nativeOutput: NativeOutput; limits: string;
}
export interface CapabilityEntry {
  id: string; module: ModuleId | "shared"; title: string; status: CapabilityStatus; targetStatus: CapabilityStatus; nativeOutput: NativeOutput;
  evidence: string[]; limits: string; requires: string; designRow: string;
}
export interface CapabilityRegistry { schema: "monstera.studio.capabilities"; version: 1; modules: ModuleEntry[]; capabilities: CapabilityEntry[] }

export const REGISTRY = registryJson as CapabilityRegistry;
const COMPILED = compileSchema(schemaJson);

export interface RegistryContext {
  /** True when the repository-relative path exists. Injected so the check is pure (tests pass `fs.existsSync`). */
  pathExists: (repoPath: string) => boolean;
  /** Text of `.kiro/specs/studio-foundry/design.md`, for the native-output table check. */
  designText: string;
}

export function moduleEntry(id: ModuleId, registry: CapabilityRegistry = REGISTRY): ModuleEntry {
  const m = registry.modules.find((x) => x.id === id);
  if (!m) throw new Error(`no registry entry for module ${id}`);
  return m;
}

const issue = (code: string, message: string, path: (string | number)[] = []): Issue => ({ path, code, message });
const NEEDS_EVIDENCE: readonly CapabilityStatus[] = ["implemented", "prototype", "mock"];

/** Cells of the design table "| Capability | Sidecar | Reaches the native apps? | Status | Why |", keyed by the first cell. */
export function designTableRows(designText: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  const lines = designText.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.startsWith("| Capability | Sidecar | Reaches the native apps? |"));
  if (start < 0) return rows;
  for (let i = start + 2; i < lines.length && (lines[i] ?? "").startsWith("|"); i++) {
    const cells = (lines[i] as string).split("|").slice(1, -1).map((c) => c.trim());
    if (cells[0]) rows.set(cells[0], cells);
  }
  return rows;
}

/** Every rule the registry must satisfy. Returns the problems; an empty list means consistent. */
export function validateRegistry(registry: CapabilityRegistry, ctx: RegistryContext): Issue[] {
  const out = validate(registry, COMPILED);
  if (out.length > 0) return out;

  if (registry.modules.map((m) => m.id).join() !== MODULE_ORDER.map(([id]) => id).join()) out.push(issue("modules", "modules must be the 11 Studio modules in navigation order", ["modules"]));
  registry.modules.forEach((m, i) => {
    const want = MODULE_ORDER[i];
    if (want && m.title !== want[1]) out.push(issue("title", `module ${m.id} must be titled "${want[1]}"`, ["modules", i, "title"]));
  });

  const ids = new Set<string>();
  registry.capabilities.forEach((c, i) => {
    const at = (f: string) => ["capabilities", i, f];
    if (ids.has(c.id)) out.push(issue("duplicate-id", `capability id "${c.id}" is used twice`, at("id")));
    ids.add(c.id);
    if (NEEDS_EVIDENCE.includes(c.status)) {
      if (c.evidence.length === 0) out.push(issue("evidence-missing", `${c.id} is ${c.status} and needs at least one evidence path`, at("evidence")));
      c.evidence.forEach((p, j) => { if (!ctx.pathExists(p)) out.push(issue("evidence-not-found", `${c.id}: evidence path "${p}" does not exist`, [...at("evidence"), j])); });
      if (c.requires !== "") out.push(issue("requires-set", `${c.id} is ${c.status}; "requires" is for planned or unsupported capabilities`, at("requires")));
    } else {
      if (c.evidence.length > 0) out.push(issue("evidence-unexpected", `${c.id} is ${c.status} and cannot cite evidence`, at("evidence")));
      if (c.status === "planned" && c.requires === "") out.push(issue("requires-missing", `${c.id} is planned and must say what it needs`, at("requires")));
      if (c.status === "unsupported" && c.requires === "") out.push(issue("requires-missing", `${c.id} is unsupported and must say why`, at("requires")));
    }
    if (c.nativeOutput === "mock" && c.status === "implemented") out.push(issue("mock-implemented", `${c.id} is a mock and cannot be "implemented"`, at("status")));
    if (c.status === "unsupported" && c.targetStatus !== "unsupported") out.push(issue("target", `${c.id} is unsupported and cannot target ${c.targetStatus}`, at("targetStatus")));
  });

  registry.modules.forEach((m, i) => {
    const caps = registry.capabilities.filter((c) => c.module === m.id);
    if (caps.length === 0) out.push(issue("no-capabilities", `module ${m.id} has no capability entries`, ["modules", i]));
    if (m.status === "planned" && caps.some((c) => c.status === "implemented" || c.status === "prototype" || c.status === "mock")) out.push(issue("module-planned", `module ${m.id} is planned but has a built capability`, ["modules", i, "status"]));
    if (m.status === "implemented" && !caps.some((c) => c.status === "implemented")) out.push(issue("module-implemented", `module ${m.id} is implemented but none of its capabilities is`, ["modules", i, "status"]));
    if (m.status === "unsupported") out.push(issue("module-unsupported", `module ${m.id} cannot be unsupported`, ["modules", i, "status"]));
  });

  // Native output must match the table in design section 0, in both directions.
  const rows = designTableRows(ctx.designText);
  if (rows.size === 0) out.push(issue("design-table", "the native-output table was not found in design.md", ["designText"]));
  const claimed = new Set<string>();
  registry.capabilities.forEach((c, i) => {
    if (c.designRow === "") return;
    claimed.add(c.designRow);
    const row = rows.get(c.designRow);
    if (!row) { out.push(issue("design-row", `${c.id}: design.md has no table row "${c.designRow}"`, ["capabilities", i, "designRow"])); return; }
    const reaches = row[2] ?? "", status = row[3] ?? "";
    const yes = reaches.startsWith("**Yes");
    if (yes !== (c.nativeOutput === "compiles to native")) out.push(issue("native-output", `${c.id}: registry says "${c.nativeOutput}" but design.md says "${reaches}"`, ["capabilities", i, "nativeOutput"]));
    if (status === "scaffold / mock") {
      if (c.nativeOutput !== "scaffold" && c.nativeOutput !== "mock") out.push(issue("native-output", `${c.id}: design.md says scaffold / mock`, ["capabilities", i, "nativeOutput"]));
    } else if (status === "planned") {
      if (c.nativeOutput !== "planned") out.push(issue("native-output", `${c.id}: design.md says planned`, ["capabilities", i, "nativeOutput"]));
    } else if (status !== c.targetStatus) out.push(issue("target", `${c.id}: design.md targets "${status}" but the registry targets "${c.targetStatus}"`, ["capabilities", i, "targetStatus"]));
  });
  for (const key of rows.keys()) if (!claimed.has(key)) out.push(issue("design-row-unclaimed", `design.md row "${key}" has no registry capability`, ["designText"]));
  return out;
}