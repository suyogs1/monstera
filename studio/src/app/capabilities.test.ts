import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMatrix, MATRIX_PATH } from "../../scripts/render-capabilities.mjs";
import {
  MODULE_ORDER, NATIVE_OUTPUTS, REGISTRY, STATUSES, designTableRows, moduleEntry, validateRegistry,
  type CapabilityRegistry,
} from "./capabilities";

const repo = join(__dirname, "..", "..", "..");
const designText = readFileSync(join(repo, ".kiro", "specs", "studio-foundry", "design.md"), "utf8");
const ctx = { pathExists: (p: string) => existsSync(join(repo, p)), designText };
const copy = (): CapabilityRegistry => JSON.parse(JSON.stringify(REGISTRY));
const problems = (r: CapabilityRegistry, c = ctx) => validateRegistry(r, c).map((i) => `${i.code}@${i.path.join(".")}`);
const at = (r: CapabilityRegistry, id: string) => r.capabilities.findIndex((c) => c.id === id);
const cap = (r: CapabilityRegistry, id: string) => r.capabilities.find((c) => c.id === id) as CapabilityRegistry["capabilities"][number];

describe("the committed registry", () => {
  it("is consistent with the repository and with the design table (acceptance test of task 0.4)", () => {
    expect(validateRegistry(REGISTRY, ctx)).toEqual([]);
  });
  it("has one entry for each of the 11 modules, in navigation order, with the mission's names", () => {
    expect(REGISTRY.modules.map((m) => [m.id, m.title])).toEqual(MODULE_ORDER.map(([id, title]) => [id, title]));
    for (const [id] of MODULE_ORDER) expect(moduleEntry(id).nativeOutput).toBeTruthy();
  });
  it("uses only the five statuses and the five native-output values", () => {
    const statuses = new Set<string>(STATUSES), outputs = new Set<string>(NATIVE_OUTPUTS);
    for (const e of [...REGISTRY.modules, ...REGISTRY.capabilities]) {
      expect(statuses.has(e.status), e.id).toBe(true);
      expect(statuses.has(e.targetStatus), e.id).toBe(true);
      expect(outputs.has(e.nativeOutput), e.id).toBe(true);
    }
  });
  it("every implemented, prototype or mock capability cites evidence that exists", () => {
    const built = REGISTRY.capabilities.filter((c) => ["implemented", "prototype", "mock"].includes(c.status));
    expect(built.length).toBeGreaterThan(8);
    for (const c of built) {
      expect(c.evidence.length, c.id).toBeGreaterThan(0);
      for (const p of c.evidence) expect(existsSync(join(repo, p)), `${c.id}: ${p}`).toBe(true);
    }
  });
  it("reports today's state: modules that are not built are planned, the built ones say what is missing", () => {
    for (const id of ["dashboard", "gameplay", "backend", "monetization"] as const) expect(moduleEntry(id).status, id).toBe("planned");
    for (const id of ["designer", "preview"] as const) expect(moduleEntry(id).status, id).toBe("implemented");
    for (const id of ["kiro", "release", "levels", "assets", "sprites"] as const) expect(moduleEntry(id).status, id).toBe("prototype");
    expect(cap(REGISTRY, "security-headers").status).toBe("prototype");
    expect(cap(REGISTRY, "security-headers").limits).toMatch(/Not deployed/);
  });
  it("assets, sprites and integrations never claim to reach native output; only v4 capabilities do", () => {
    for (const id of ["asset-library", "sprite-atlas", "level-variants"]) expect(cap(REGISTRY, id).nativeOutput, id).toBe("studio only");
    for (const id of ["integrations-scaffold", "admob-mock"]) expect(["scaffold", "mock"], id).toContain(cap(REGISTRY, id).nativeOutput);
    for (const id of ["gameplay-core", "level-compile", "designer-editing"]) expect(cap(REGISTRY, id).nativeOutput, id).toBe("compiles to native");
    expect(REGISTRY.capabilities.filter((c) => c.nativeOutput === "compiles to native" && c.status !== "implemented" && c.targetStatus === "planned")).toEqual([]);
  });
  it("covers every row of the design table and only those rows", () => {
    const rows = designTableRows(designText);
    expect(rows.size).toBe(8);
    expect(REGISTRY.capabilities.filter((c) => c.designRow !== "").map((c) => c.designRow).sort()).toEqual([...rows.keys()].sort());
  });
  it("never uses live, connected, production or store-ready except in a sentence that negates it or for an unbuilt capability's title", () => {
    const risky = /\b(live|connected|production|store-ready)\b/i, negated = /\b(no|not|never|cannot|neither|nor|without|unsupported)\b/i;
    const texts: { where: string; text: string }[] = [];
    for (const m of REGISTRY.modules) texts.push({ where: `module ${m.id}`, text: m.limits });
    for (const c of REGISTRY.capabilities) {
      texts.push({ where: `${c.id}.limits`, text: c.limits }, { where: `${c.id}.requires`, text: c.requires });
      if (!["planned", "unsupported"].includes(c.status)) texts.push({ where: `${c.id}.title`, text: c.title });
    }
    for (const { where, text } of texts) for (const sentence of text.split(/(?<=[.;:])\s+/)) {
      if (risky.test(sentence)) expect(negated.test(sentence), `${where}: "${sentence}"`).toBe(true);
    }
  });
});

describe("the generated matrix", () => {
  it("docs/STUDIO-CAPABILITIES.md equals the rendering of the registry", () => {
    const have = readFileSync(MATRIX_PATH, "utf8").replace(/\r\n/g, "\n");
    expect(have).toBe(renderMatrix(REGISTRY));
  });
  it("shows every module and capability and the generated-file header", () => {
    const text = renderMatrix(REGISTRY);
    expect(text.startsWith("<!-- GENERATED by studio/scripts/render-capabilities.mjs")).toBe(true);
    for (const m of REGISTRY.modules) expect(text).toContain(`| ${m.title} |`);
    for (const c of REGISTRY.capabilities) expect(text).toContain(c.title.replace(/\|/g, "\\|"));
  });
  it("is deterministic", () => { expect(renderMatrix(REGISTRY)).toBe(renderMatrix(copy())); });
});

describe("what the consistency check rejects", () => {
  it("an unknown status or native output, an extra property and a missing module", () => {
    const a = copy(); (cap(a, "designer-editing") as { status: string }).status = "live";
    expect(problems(a)).toContain(`enum@capabilities.${at(a, "designer-editing")}.status`);
    const b = copy(); (cap(b, "designer-editing") as { nativeOutput: string }).nativeOutput = "native";
    expect(problems(b)).toContain(`enum@capabilities.${at(b, "designer-editing")}.nativeOutput`);
    const c = copy(); (c.capabilities[0] as unknown as Record<string, unknown>)["extra"] = 1;
    expect(problems(c)).toContain("additional@capabilities.0.extra");
    const d = copy(); d.modules.pop();
    expect(problems(d)).toContain("modules@modules");
    const e = copy(); [e.modules[1], e.modules[2]] = [e.modules[2]!, e.modules[1]!];
    expect(problems(e)).toContain("modules@modules");
  });
  it("a module that is renamed, has no capabilities, or has an inconsistent status", () => {
    const a = copy(); a.modules[0]!.title = "Home";
    expect(problems(a)).toContain("title@modules.0.title");
    const b = copy(); b.capabilities = b.capabilities.filter((c) => c.module !== "backend");
    expect(problems(b)).toContain("no-capabilities@modules.6");
    const c = copy(); moduleEntry("designer", c).status = "planned";
    expect(problems(c)).toContain("module-planned@modules.1.status");
    const d = copy(); moduleEntry("assets", d).status = "implemented";
    expect(problems(d)).toContain("module-implemented@modules.2.status");
    const e = copy(); moduleEntry("assets", e).status = "unsupported";
    expect(problems(e)).toContain("module-unsupported@modules.2.status");
  });
  it("evidence rules: missing, not found, unexpected, requires missing or misplaced", () => {
    const a = copy(); cap(a, "designer-editing").evidence = [];
    expect(problems(a)).toContain(`evidence-missing@capabilities.${at(a, "designer-editing")}.evidence`);
    const b = copy(); cap(b, "designer-editing").evidence = ["docs/evidence/does-not-exist.json"];
    expect(problems(b)).toContain(`evidence-not-found@capabilities.${at(b, "designer-editing")}.evidence.0`);
    const c = copy(); cap(c, "gameplay-core").evidence = ["docs/evidence/studio-m1/acceptance.json"];
    expect(problems(c).some((p) => p.startsWith("evidence-unexpected@"))).toBe(true);
    const d = copy(); cap(d, "gameplay-core").requires = "";
    expect(problems(d).some((p) => p.startsWith("requires-missing@"))).toBe(true);
    const e = copy(); cap(e, "designer-editing").requires = "something";
    expect(problems(e).some((p) => p.startsWith("requires-set@"))).toBe(true);
    const f = copy(); cap(f, "firebase-live").requires = "";
    expect(problems(f).some((p) => p.startsWith("requires-missing@"))).toBe(true);
    const g = copy(); cap(g, "firebase-live").targetStatus = "mock";
    expect(problems(g).some((p) => p.startsWith("target@"))).toBe(true);
  });
  it("a mock cannot be called implemented, and ids must be unique", () => {
    const a = copy(); const c = cap(a, "designer-editing"); c.nativeOutput = "mock";
    expect(problems(a)).toContain(`mock-implemented@capabilities.${at(a, "designer-editing")}.status`);
    const b = copy(); b.capabilities[1]!.id = b.capabilities[0]!.id;
    expect(problems(b)).toContain("duplicate-id@capabilities.1.id");
  });
  it("native output and target must agree with the design table, and every table row needs a capability", () => {
    const a = copy(); cap(a, "asset-library").nativeOutput = "compiles to native";
    expect(problems(a).some((p) => p.startsWith("native-output@"))).toBe(true);
    const b = copy(); cap(b, "gameplay-core").nativeOutput = "studio only";
    expect(problems(b).some((p) => p.startsWith("native-output@"))).toBe(true);
    const c = copy(); cap(c, "level-compile").targetStatus = "implemented";
    expect(problems(c).some((p) => p.startsWith("target@"))).toBe(true);
    const d = copy(); cap(d, "integrations-scaffold").nativeOutput = "compiles to native";
    expect(problems(d).some((p) => p.startsWith("native-output@"))).toBe(true);
    const e = copy(); cap(e, "gameplay-unbuilt-modules").nativeOutput = "scaffold";
    expect(problems(e).some((p) => p.startsWith("native-output@"))).toBe(true);
    const f = copy(); cap(f, "asset-library").designRow = "A row that does not exist";
    expect(problems(f)).toContain(`design-row@capabilities.${at(f, "asset-library")}.designRow`);
    const g = copy(); cap(g, "asset-library").designRow = "";
    expect(problems(g)).toContain("design-row-unclaimed@designText");
    expect(problems(REGISTRY as CapabilityRegistry, { ...ctx, designText: "no table here" })).toContain("design-table@designText");
  });
});