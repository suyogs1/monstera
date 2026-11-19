import { describe, expect, it } from "vitest";
import { APPROVED_BLOB, BASELINE_BLOB, EXCEPTION_PATH, PASS_MESSAGE, classifyEngineSchemaDiff } from "../../scripts/regression-classify.mjs";

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
