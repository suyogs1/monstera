import { describe, expect, it } from "vitest";
import { APPROVED_BLOB, BASELINE_BLOB, DIAGNOSTICS_PINNED, E1_ALLOWED, E1_BASE, E2_ALLOWED, EXCEPTION_PATH, PASS_MESSAGE, classifyE1Diff, classifyEngineSchemaDiff } from "../../scripts/regression-classify.mjs";

const base = {
  nameStatus: `M\t${EXCEPTION_PATH}`,
  numstat: `25\t0\t${EXCEPTION_PATH}`,
  baselineBlob: BASELINE_BLOB as string | null,
  currentBlob: APPROVED_BLOB as string | null,
};

describe("task 9.2 engine/schema freeze (baseline 71c77e4, approved blob fixed)", () => {
  it("pins the approved constants", () => {
    expect(BASELINE_BLOB).toBe("47c6b54d017008c86b4a8b3a1570a3ef69852618");
    expect(APPROVED_BLOB).toBe("cd3dfa631a5176b5fb28c457ff089a21687a79df");
  });

  it("passes the approved exact blob (25 added, 0 deleted) with the exact message", () => {
    const r = classifyEngineSchemaDiff(base);
    expect(r.status).toBe("PASS");
    expect(r.summary).toBe(
      "The original G6 baseline is preserved. The only engine-tree difference is the exact, approved Task 4.2 test-only addition to test_studio_glue.py.",
    );
    expect(r.summary).toBe(PASS_MESSAGE);
  });

  it("fails when one extra line is added (different blob, 26 added)", () => {
    expect(classifyEngineSchemaDiff({ ...base, currentBlob: "a".repeat(40), numstat: `26\t0\t${EXCEPTION_PATH}` }).status).toBe("FAIL");
    expect(classifyEngineSchemaDiff({ ...base, numstat: `26\t0\t${EXCEPTION_PATH}` }).status).toBe("FAIL");
  });

  it("fails when one line is deleted (different blob, 1 deleted)", () => {
    expect(classifyEngineSchemaDiff({ ...base, currentBlob: "b".repeat(40), numstat: `25\t1\t${EXCEPTION_PATH}` }).status).toBe("FAIL");
    expect(classifyEngineSchemaDiff({ ...base, numstat: `25\t1\t${EXCEPTION_PATH}` }).status).toBe("FAIL");
  });

  it("fails when a different file is added under tools/monstera", () => {
    const r = classifyEngineSchemaDiff({ ...base, nameStatus: `${base.nameStatus}\nA\ttools/monstera/tests/test_other.py` });
    expect(r.status).toBe("FAIL");
  });

  it("fails on a generator change", () => {
    expect(classifyEngineSchemaDiff({ ...base, nameStatus: `${base.nameStatus}\nM\ttools/monstera/monstera/generate.py` }).status).toBe("FAIL");
  });

  it("fails on a change under spec/schema", () => {
    expect(classifyEngineSchemaDiff({ ...base, nameStatus: `${base.nameStatus}\nM\tspec/schema/monstera.spec.schema.json` }).status).toBe("FAIL");
  });

  it("fails when the file is missing at the baseline", () => {
    const r = classifyEngineSchemaDiff({ ...base, baselineBlob: null, nameStatus: `A\t${EXCEPTION_PATH}` });
    expect(r.status).toBe("FAIL");
  });

  it("fails when the file is deleted", () => {
    expect(classifyEngineSchemaDiff({ ...base, nameStatus: `D\t${EXCEPTION_PATH}`, currentBlob: null }).status).toBe("FAIL");
  });
});
describe("Gate E1 engine diff (pre-E1 main to HEAD, explicit allowlist)", () => {
  const ns = (rows: [string, string][]) => rows.map(([s, p]) => `${s}\t${p}`).join("\n");
  it("the E1 base is the pre-E1 main and never the original G6 baseline", () => {
    expect(E1_BASE).toBe("7f0292ba99ccc1b874bf30047ae175aacd021d9f");
    expect(E1_BASE.startsWith("71c77e4")).toBe(false);
  });
  it("passes for no change and for approved paths with their approved status", () => {
    expect(classifyE1Diff({ nameStatus: "" }).status).toBe("PASS");
    expect(classifyE1Diff({ nameStatus: ns(Object.entries(E1_ALLOWED).map(([p, s]) => [s, p])) }).status).toBe("PASS");
  });
  it("fails for the oracle, emit_runtime, a runtime core template, an unknown file or a wrong status", () => {
    for (const path of [
      "tools/monstera/monstera/oracle/sim.py",
      "tools/monstera/monstera/emit_runtime.py",
      "tools/monstera/monstera/templates/android/runtime/Simulation.kt.tmpl",
      "tools/monstera/monstera/templates/ios/Runtime/Simulation.swift.tmpl",
      "spec/schema/project.schema.json",
    ]) {
      const r = classifyE1Diff({ nameStatus: ns([["M", path]]) });
      expect(r.status, path).toBe("FAIL");
      expect(r.summary).toContain(path);
    }
    expect(classifyE1Diff({ nameStatus: ns([["D", "tools/monstera/monstera/semantic.py"]]) }).status).toBe("FAIL");
    expect(classifyE1Diff({ nameStatus: ns([["M", "tools/monstera/monstera/atlas.py"]]) }).status).toBe("FAIL"); // added, not modified, since E1_BASE
  });
  it("lists no runtime core or oracle path", () => {
    for (const p of Object.keys(E1_ALLOWED)) expect(p).not.toMatch(/oracle\/|emit_runtime|\/runtime\/|\/Runtime\//);
  });
});
describe("Gate E2 engine diff (template-only extension wiring)", () => {
  const ns = (rows: [string, string][]) => rows.map(([s, p]) => `${s}\t${p}`).join("\n");
  it("accepts exactly the approved E2 template paths and nothing in the schema, oracle, emitters or runtime core", () => {
    expect(classifyE1Diff({ nameStatus: ns(Object.entries(E2_ALLOWED).map(([p, s]) => [s, p])) }).status).toBe("PASS");
    for (const p of Object.keys(E2_ALLOWED)) {
      expect(p).not.toMatch(/oracle\/|emit_|\/runtime\/|\/Runtime\/|^spec\/schema/);
      expect(p).toMatch(/\/templates\/|tests\/test_extensions\.py$/);
    }
  });
  it("still fails for a schema or runtime-core change and for a wrong status on an E2 path", () => {
    expect(classifyE1Diff({ nameStatus: ns([["M", "spec/schema/game.schema.json"], ["M", "tools/monstera/monstera/templates/android/runtime/Fixed.kt.tmpl"]]) }).status).toBe("FAIL");
    expect(classifyE1Diff({ nameStatus: ns([["M", "tools/monstera/monstera/templates/ios/ExtensionDefaults/Package.swift.tmpl"]]) }).status).toBe("FAIL");
  });
});
describe("PR #61 conformance diagnostics (content-pinned exception)", () => {
  const ns = (rows: [string, string][]) => rows.map(([s, p]) => `${s}\t${p}`).join("\n");
  const CONF = "tools/monstera/monstera/conformance.py";
  const TEST = "tools/monstera/tests/test_scenarios.py";
  const approved = { [CONF]: "9e096004a8d8c892e82afce923e65efda7b04af8", [TEST]: "c7f763a96781bac51422eb54093ce3462dca6fba" };
  const both = ns([["M", CONF], ["M", TEST]]);
  it("pins exactly the two paths, as modifications, to fixed blobs, and leaves the E1 and E2 lists without them", () => {
    expect(Object.keys(DIAGNOSTICS_PINNED).sort()).toEqual([CONF, TEST]);
    for (const [p, pin] of Object.entries(DIAGNOSTICS_PINNED)) {
      expect(pin).toEqual({ status: "M", blob: approved[p] });
      expect(Object.isFrozen(pin)).toBe(true);
      expect(E1_ALLOWED[p]).toBeUndefined();
      expect(E2_ALLOWED[p]).toBeUndefined();
    }
    expect(Object.isFrozen(DIAGNOSTICS_PINNED)).toBe(true);
  });
  it("passes with the approved blobs, alone or together with the approved E1 and E2 paths", () => {
    expect(classifyE1Diff({ nameStatus: both, blobs: approved }).status).toBe("PASS");
    expect(classifyE1Diff({ nameStatus: ns([["M", CONF]]), blobs: approved }).status).toBe("PASS");
    const all = ns([...Object.entries({ ...E1_ALLOWED, ...E2_ALLOWED }).map(([p, s]) => [s, p] as [string, string]), ["M", CONF], ["M", TEST]]);
    expect(classifyE1Diff({ nameStatus: all, blobs: approved }).status).toBe("PASS");
  });
  it("fails for a different blob of either file (any later edit), naming the path and both blobs", () => {
    for (const p of [CONF, TEST]) {
      const r = classifyE1Diff({ nameStatus: both, blobs: { ...approved, [p]: "0".repeat(40) } });
      expect(r.status).toBe("FAIL");
      expect(r.summary).toContain(p);
      expect(r.summary).toContain("0".repeat(40));
      expect(r.summary).toContain(approved[p]);
    }
  });
  it("fails closed when the blob is missing or the caller passes none", () => {
    expect(classifyE1Diff({ nameStatus: both, blobs: { [TEST]: approved[TEST] } }).status).toBe("FAIL");
    expect(classifyE1Diff({ nameStatus: both, blobs: { ...approved, [CONF]: null } }).status).toBe("FAIL");
    expect(classifyE1Diff({ nameStatus: both }).status).toBe("FAIL");
  });
  it("fails for an unexpected status even with the approved blob (added, deleted, typechange)", () => {
    for (const s of ["A", "D", "T"]) {
      expect(classifyE1Diff({ nameStatus: ns([[s, CONF]]), blobs: approved }).status, s).toBe("FAIL");
      expect(classifyE1Diff({ nameStatus: ns([[s, TEST]]), blobs: approved }).status, s).toBe("FAIL");
    }
  });
  it("fails for an extra path next to the approved diagnostics change, including another test file and the oracle", () => {
    for (const extra of ["tools/monstera/tests/test_presentation_extra.py", "tools/monstera/monstera/oracle/sim.py", "tools/monstera/monstera/cli.py", "spec/schema/conformance.schema.json"]) {
      const r = classifyE1Diff({ nameStatus: `${both}\nM\t${extra}`, blobs: { ...approved, [extra]: approved[CONF] } });
      expect(r.status, extra).toBe("FAIL");
      expect(r.summary).toContain(extra);
    }
  });
});
