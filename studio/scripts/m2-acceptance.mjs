// Final Studio M2 acceptance: runs the complete verification matrix once, in order, and writes
// docs/evidence/studio-m2/acceptance.json (results, environment, limitations). It never keeps a change to the M1
// evidence: the M1 regression result is stored as M2 evidence (m1-regression.json) and the committed M1 file is restored.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, release, type } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const studio = join(here, "..");
const repo = join(studio, "..");
const ev = join(repo, "docs", "evidence", "studio-m2");
const M1 = "docs/evidence/studio-m1/acceptance.json";
const shell = process.platform === "win32";

function run(name, cmd, args, cwd, summary) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd, shell, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const line = out.split(/\r?\n/).filter((l) => summary.test(l)).map((l) => l.trim()).join(" | ");
  const row = { name, command: [cmd, ...args].join(" "), exitCode: r.status, ok: r.status === 0, seconds: Math.round((Date.now() - t0) / 100) / 10, summary: line };
  console.log(`${row.ok ? "PASS" : "FAIL"}  ${name}  (${row.seconds} s)  ${line}`);
  return row;
}

const matrix = [];
matrix.push(run("monstera gates", "git", ["-c", "alias.monstera=!tools/monstera/bin/monstera", "monstera", "gates"], repo, /unit-tests|gates:/));
matrix.push(run("Studio unit tests (Vitest)", "npx", ["vitest", "--run"], studio, /Tests |Test Files/));
matrix.push(run("TypeScript and production build", "npm", ["run", "build"], studio, /engine bundle:|total brotli|built in|error/));
matrix.push(run("M1 acceptance (regression)", "node", ["scripts/acceptance.mjs"], studio, /checks, Chrome/));
copyFileSync(join(repo, M1), join(ev, "m1-regression.json"));
execFileSync("git", ["checkout", "--", M1], { cwd: repo });
matrix.push(run("M2 batch 1: engine bundle, 33 goldens, plan parity", "node", ["scripts/m2-batch1.mjs"], studio, /checks, Chrome/));
matrix.push(run("M2 badge acceptance", "node", ["scripts/m2-badge.mjs"], studio, /checks, Chrome/));
matrix.push(run("M2 preview acceptance", "node", ["scripts/m2-preview.mjs"], studio, /checks, Chrome/));
matrix.push(run("M2 click-through acceptance", "node", ["scripts/m2-clickthrough.mjs"], studio, /checks, Chrome/));
matrix.push(run("M2 export acceptance", "node", ["scripts/m2-export.mjs"], studio, /checks, Chrome/));
matrix.push(run("M2 end-to-end (all three templates)", "node", ["scripts/m2-e2e.mjs"], studio, /checks, Chrome/));

const read = (n) => (existsSync(join(ev, n)) ? JSON.parse(readFileSync(join(ev, n), "utf8")) : null);
const files = ["m1-regression.json", "batch1.json", "badge.json", "preview.json", "clickthrough.json", "export.json", "e2e.json"];
const evidence = Object.fromEntries(files.map((f) => { const j = read(f); return [f, j ? { verdict: j.verdict, checks: j.checks.length, failed: j.checks.filter((c) => !c.ok).length, browser: j.browser } : null]; }));
const b1 = read("batch1.json"), pv = read("preview.json");
const git = (...a) => execFileSync("git", a, { cwd: repo }).toString().trim();
const py = spawnSync("py", ["-3", "--version"], { shell, encoding: "utf8" }).stdout?.trim() || spawnSync("python3", ["--version"], { shell, encoding: "utf8" }).stdout?.trim();

const result = {
  milestone: "G4 M2: live preview, determinism badge, click-through, native source export",
  verdict: matrix.every((m) => m.ok) && Object.values(evidence).every((e) => e && e.verdict === "PASS") ? "PASS" : "FAIL",
  base: git("rev-parse", "main"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), head: git("rev-parse", "HEAD"),
  workingTree: "uncommitted M2 change on top of head (this file is written before the commit)",
  environment: { os: `${type()} ${release()}`, cpu: cpus()[0]?.model, node: process.version, python: py, browser: evidence["badge.json"]?.browser, pyodide: "0.29.5" },
  matrix,
  evidence,
  measurements: {
    coldEngineReadyMs: b1 ? Math.round(b1.engineTimings.totalMs) : null,
    firstLoadBrotliMiB: b1 ? Math.round(b1.bundle.firstLoadBrotliBytes / 10485.76) / 100 : null,
    goldenScenarios: b1 ? { count: b1.goldens.count, frameDriven: b1.goldens.frameDriven, checkpoints: b1.goldens.checkpoints, ticks: b1.goldens.ticks } : null,
    preview: pv ? pv.templates.map((t) => ({ template: t.template, fps: t.framesPerSecond, engineFrameP95Ms: t.engineFrameMs.p95, maxMainThreadGapMs: t.maxMainThreadGapMs, restartMaxMs: t.restartMs.max })) : null,
  },
  labels: "Studio shows GENERATED only. Nothing in M2 was compiled, run on a simulator or a device by Studio; no native conformance report matches a current template SHA-256 (refresh is a separate pre-M3 task).",
  limitations: [
    "All browser evidence is from one Windows machine on localhost (Chrome via Playwright); no CI or deployed run (M3).",
    "Committed native conformance reports (docs/evidence/g2-conformance, g3-conformance) were recorded for older spec SHA-256s; Studio shows them as non-matching. Refresh before M3 evidence finalization.",
    "Edited drafts export with scenarios=[]; the CLI refuses such specs until `monstera scenarios record`; their parity is against generate.plan(..., scenarios=[]), not the CLI.",
    "Preview touch mapping is approximate (browser pointer events; drags coalesced while the worker is busy); the engine's response is exact (host replays).",
    "Preview and badge share one Pyodide worker: the preview stutters (frames skipped, never queued) while a badge run holds it.",
    "The preview's presentation (layout, effects, texts) is a TypeScript copy of the generated Presentation.kt, display only; template changes to it must be mirrored by hand.",
    "The app-layout ZIP contains exactly the generator-owned files; the hand-maintained spec beside them is exported separately (it is also inside the archive as android/app/src/main/assets/monstera.spec.json).",
  ],
};
writeFileSync(join(ev, "acceptance.json"), JSON.stringify(result, null, 2) + "\n");
console.log(`\n${result.verdict}: ${matrix.filter((m) => m.ok).length}/${matrix.length} matrix steps; acceptance.json written`);
process.exit(result.verdict === "PASS" ? 0 : 1);
