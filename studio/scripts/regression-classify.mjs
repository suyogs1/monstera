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

// Gate E1 (docs/STUDIO-FOUNDRY-GATE-E.md). The original freeze above is checked from 71c77e4 to E1_BASE, the pre-E1 main, and
// is never re-baselined. From E1_BASE to the current head only the paths below may change under tools/monstera and spec/schema:
// the spec v5 contract, its validation and bundling, and the two presentation layers. Every other path, including the oracle,
// emit_runtime and the runtime core templates of both platforms, must stay byte-identical to E1_BASE.
export const E1_BASE = "7f0292ba99ccc1b874bf30047ae175aacd021d9f";
export const E1_ALLOWED = Object.freeze({
  "spec/schema/game.schema.json": "M",
  "spec/schema/monstera.spec.schema.json": "M",
  "tools/monstera/monstera/atlas.py": "A",
  "tools/monstera/monstera/archcheck.py": "M",
  "tools/monstera/monstera/generate.py": "M",
  "tools/monstera/monstera/schema.py": "M",
  "tools/monstera/monstera/semantic.py": "M",
  "tools/monstera/monstera/templates/android/app/src/main/kotlin/GameScreen.kt.tmpl": "M",
  "tools/monstera/monstera/templates/android/presentation/Presentation.kt.tmpl": "M",
  "tools/monstera/monstera/templates/android/presentation/PresentationTest.kt.tmpl": "M",
  "tools/monstera/monstera/templates/ios/Package.swift.tmpl": "M",
  "tools/monstera/monstera/templates/ios/Presentation/Presentation.swift.tmpl": "M",
  "tools/monstera/monstera/templates/ios/Presentation/PresentationTests.swift.tmpl": "M",
  "tools/monstera/monstera/templates/ios/Sources/GameScene.swift.tmpl": "M",
  "tools/monstera/tests/test_presentation.py": "M",
  "tools/monstera/tests/test_sprites.py": "A",
});
// Gate E2 (docs/STUDIO-FOUNDRY-GATE-E.md, owner approval 2026-11-24): template-only extension wiring. No schema, oracle, emitter
// or runtime-core path is allowed here. The generated Gradle and SwiftPM projects compile developer-owned extensions/ roots, and
// the engine's own no-op defaults are compiled when a root is absent.
export const E2_ALLOWED = Object.freeze({
  "tools/monstera/monstera/templates/android/app/build.gradle.kts.tmpl": "M",
  "tools/monstera/monstera/templates/android/app/src/main/kotlin/MainActivity.kt.tmpl": "M",
  "tools/monstera/monstera/templates/android/extensions/MonsteraExtensions.kt.tmpl": "A",
  "tools/monstera/monstera/templates/ios/ExtensionDefaults/MonsteraExtensions.swift.tmpl": "A",
  "tools/monstera/monstera/templates/ios/ExtensionDefaults/Package.swift.tmpl": "A",
  "tools/monstera/monstera/templates/ios/Sources/ContentView.swift.tmpl": "M",
  "tools/monstera/tests/test_extensions.py": "A",
});
const ALLOWED = Object.freeze({ ...E1_ALLOWED, ...E2_ALLOWED });
// PR #61 (studio/atlas-native-proof): bounded, redacted subprocess diagnostics in `monstera conformance` and their tests. Unlike the
// lists above this exception is pinned to content: each path may only be modified (M) and its blob at HEAD must be exactly the one
// below, so any later edit to either file fails until it is reviewed and pinned again. Blobs are fixed constants, never read from HEAD.
export const DIAGNOSTICS_PINNED = Object.freeze({
  "tools/monstera/monstera/conformance.py": Object.freeze({ status: "M", blob: "9e096004a8d8c892e82afce923e65efda7b04af8" }),
  "tools/monstera/tests/test_scenarios.py": Object.freeze({ status: "M", blob: "c7f763a96781bac51422eb54093ce3462dca6fba" }),
});
export const E1_PASS_MESSAGE = "E1 changes are limited to the approved contract, validation, bundling and presentation paths; the runtime core and oracle are unchanged since the pre-E1 main.";
// input: { nameStatus: string (git diff --name-status --no-renames E1_BASE HEAD -- tools/monstera spec/schema),
//          blobs: { [path]: string|null } (blob at HEAD of each DIAGNOSTICS_PINNED path; a missing entry fails a pinned change) }
export function classifyE1Diff({ nameStatus, blobs = {} }) {
  const entries = nameStatus.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [status, ...rest] = l.split(/\t+/);
    return { status, path: rest.join("\t") };
  });
  const pinned = (e) => {
    const pin = DIAGNOSTICS_PINNED[e.path];
    return pin !== undefined && pin.status === e.status && blobs[e.path] === pin.blob;
  };
  const bad = entries.filter((e) => ALLOWED[e.path] !== e.status && !pinned(e));
  const pinnedBad = bad.filter((e) => DIAGNOSTICS_PINNED[e.path] !== undefined);
  if (pinnedBad.length > 0) {
    return { status: "FAIL", summary: `pinned diagnostics paths do not match their approved content: ${pinnedBad.map((e) => `${e.status} ${e.path} blob ${blobs[e.path] ?? "missing"}, approved ${DIAGNOSTICS_PINNED[e.path].status} ${DIAGNOSTICS_PINNED[e.path].blob}`).join("; ")}${bad.length > pinnedBad.length ? `; also outside the allowlists: ${bad.filter((e) => !pinnedBad.includes(e)).map((e) => `${e.status} ${e.path}`).join("; ")}` : ""}` };
  }
  if (bad.length > 0) return { status: "FAIL", summary: `changes outside the E1 and E2 allowlists: ${bad.map((e) => `${e.status} ${e.path}`).join("; ")}` };
  if (entries.length === 0) return { status: "PASS", summary: "no engine or schema change since the pre-E1 main" };
  return { status: "PASS", summary: `${E1_PASS_MESSAGE} (${entries.length} approved paths changed)` };
}
