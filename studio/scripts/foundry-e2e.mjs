// Studio Foundry end-to-end over A1 to A7 (task 9.1). Runs the existing Playwright scripts unchanged, plus foundry-flow.mjs for
// the steps no earlier script covers, and prints one table mapping every requirement to the script that proves it. A script that
// reports PENDING lines keeps them in the table; nothing pending is counted as passed. Serves dist/ (run `npm run build` first).
// Env: E2E_REPORT = path for the JSON result (default: none; docs/evidence/ is never written by this script).
// E2E_FULL=1 also runs the M1 and M2 acceptance scripts (A2 non-regression). They rewrite tracked files under docs/evidence/:
// restore them with `git checkout -- docs/evidence` afterwards. Default runs do not touch them.
// Exit code 1 if any script fails.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const studio = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = [
  { script: "smoke.mjs", covers: ["A1", "A2"], what: "17 smoke checks on the production preview" },
  { script: "shell.mjs", covers: ["A1"], what: "11 modules in the registry rail, each with its status, cards without controls" },
  { script: "a3-dashboard.mjs", covers: ["A3"], what: "create from template, edit in the Designer, save, reload, rename, duplicate, delete" },
  { script: "derive-apply.mjs", covers: ["A5", "A6"], what: "derived-spec apply path through the engine worker" },
  { script: "a5-levels.mjs", covers: ["A5"], what: "two levels, apply, variants, real monstera validate on every export" },
  { script: "foundry-flow.mjs", covers: ["A3", "A4", "A6", "A7"], what: "bundle export and import, image import with provenance, slice, animation, scaffold UI, gameplay apply, pack export, drift script, re-import" },
];
if (process.env.E2E_FULL === "1") {
  SCRIPTS.push({ script: "acceptance.mjs", covers: ["A2"], what: "M1 acceptance (regression)" }, { script: "m2-acceptance.mjs", covers: ["A2"], what: "M2 acceptance (regression)" });
}
const rows = [];
for (const s of SCRIPTS) {
  const t0 = Date.now();
  // smoke.mjs writes docs/evidence by default; keep its report out of the tracked tree.
  const env = { ...process.env, SMOKE_REPORT: process.env.SMOKE_REPORT || join(tmpdir(), "foundry-e2e-smoke.json") };
  const r = spawnSync(process.execPath, [join(studio, "scripts", s.script)], { cwd: studio, env, encoding: "utf8", maxBuffer: 1 << 28 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const lines = out.split(/\r?\n/);
  const summary = lines.filter((l) => /\d+\/\d+ (checks|passed)/.test(l)).pop() ?? lines.filter(Boolean).pop() ?? "";
  const pending = lines.filter((l) => l.startsWith("PENDING")).map((l) => l.slice("PENDING  ".length));
  const failed = lines.filter((l) => l.startsWith("FAIL"));
  rows.push({ ...s, ok: r.status === 0, exitCode: r.status, seconds: Math.round((Date.now() - t0) / 100) / 10, summary: summary.trim(), pending, failed });
  console.log(`${r.status === 0 ? "PASS" : "FAIL"}  ${s.script.padEnd(18)} ${s.covers.join(",").padEnd(10)} ${rows.at(-1).seconds} s  ${summary.trim()}`);
  for (const f of failed) console.log(`        ${f}`);
  for (const p of pending) console.log(`        PENDING ${p}`);
}
const report = { requirements: Object.fromEntries(["A1", "A2", "A3", "A4", "A5", "A6", "A7"].map((a) => [a, rows.filter((r) => r.covers.includes(a)).map((r) => ({ script: r.script, ok: r.ok }))])), scripts: rows };
if (process.env.E2E_REPORT) writeFileSync(process.env.E2E_REPORT, `${JSON.stringify(report, null, 2)}\n`);
const nPending = rows.reduce((n, r) => n + r.pending.length, 0);
console.log(`${rows.filter((r) => r.ok).length}/${rows.length} scripts passed, ${nPending} pending gaps (listed above)`);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
