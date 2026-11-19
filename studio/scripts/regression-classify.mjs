// Classifies the engine/schema freeze for the task 9.2 proof against baseline 71c77e4.
// The single permitted exception under tools/monstera and spec/schema is the approved task 4.2 (#20) test-only change
// to tools/monstera/tests/test_studio_glue.py. The approved blob is a fixed constant, never derived from HEAD.
export const EXCEPTION_PATH = "tools/monstera/tests/test_studio_glue.py";
export const BASELINE_BLOB = "47c6b54d017008c86b4a8b3a1570a3ef69852618";
export const APPROVED_BLOB = "cd3dfa631a5176b5fb28c457ff089a21687a79df";
export const APPROVED_ADDED = 25;
export const APPROVED_DELETED = 0;

export const PASS_MESSAGE =
  "The original G6 baseline is preserved. The only engine-tree difference is the exact, approved Task 4.2 test-only addition to test_studio_glue.py.";

// input: { nameStatus: string (git diff --name-status --no-renames BASE), numstat: string (git diff --numstat BASE),
//          baselineBlob: string|null (blob of EXCEPTION_PATH at BASE), currentBlob: string|null (blob of EXCEPTION_PATH now) }
export function classifyEngineSchemaDiff({ nameStatus, numstat, baselineBlob, currentBlob }) {
  const lines = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const fail = (reason) => ({ status: "FAIL", summary: reason });
  if (baselineBlob !== BASELINE_BLOB) return fail(`${EXCEPTION_PATH} at baseline is ${baselineBlob ?? "missing"}, expected ${BASELINE_BLOB}`);
  const entries = lines(nameStatus).map((l) => {
    const [status, ...rest] = l.split(/\t+/);
    return { status, path: rest.join("\t") };
  });
  const others = entries.filter((e) => e.path !== EXCEPTION_PATH);
  if (others.length > 0) return fail(`disallowed changes: ${others.map((e) => `${e.status} ${e.path}`).join("; ")}`);
  if (entries.length === 0) {
    return currentBlob === BASELINE_BLOB
      ? { status: "PASS", summary: "git diff is empty" }
      : fail(`${EXCEPTION_PATH} blob ${currentBlob ?? "missing"} does not match the baseline or the approved blob`);
  }
  if (currentBlob !== APPROVED_BLOB) return fail(`${EXCEPTION_PATH} blob is ${currentBlob ?? "missing"}, approved blob is ${APPROVED_BLOB}`);
  const stat = lines(numstat).map((l) => l.split(/\t+/)).find((p) => p[2] === EXCEPTION_PATH);
  if (!stat || Number(stat[0]) !== APPROVED_ADDED || Number(stat[1]) !== APPROVED_DELETED) {
    return fail(`${EXCEPTION_PATH} numstat is ${stat ? `${stat[0]} added, ${stat[1]} deleted` : "missing"}, expected ${APPROVED_ADDED} added, ${APPROVED_DELETED} deleted`);
  }
  return { status: "PASS", summary: PASS_MESSAGE };
}
