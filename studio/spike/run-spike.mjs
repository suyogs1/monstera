// Runs the M0 spike in a real browser (Chrome via Playwright), compares every result with the
// reference produced by the CLI / host CPython, and writes docs/evidence/studio-spike/spike-result.json.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { chromium } from "playwright-core";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = join(here, "dist");
const evidenceDir = join(here, "..", "..", "docs", "evidence", "studio-spike");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".wasm": "application/wasm", ".py": "text/plain", ".zip": "application/zip" };

// Pass criteria (design.md, M0). Anything outside them is reported as FAIL, not tuned away.
const LIMITS = { coldInitMs: 10000, tickP95Ms: 3, mainThreadGapMs: 100, brotliFirstLoadBytes: 15 * 1024 * 1024 };

const server = createServer((req, res) => {
  const url = req.url === "/" ? "/harness.html" : req.url.split("?")[0];
  if (url === "/favicon.ico") { res.writeHead(204).end(); return; }
  const file = join(dist, url);
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "max-age=3600" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const reference = JSON.parse(readFileSync(join(dist, "reference.json"), "utf8"));
const bundle = JSON.parse(readFileSync(join(dist, "bundle-report.json"), "utf8"));
const games = Object.keys(reference.liveScenario);

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext();
const fetched = [];
async function load(label) {
  const page = await context.newPage();
  page.on("response", async (r) => { try { fetched.push({ label, url: r.url().replace(base, ""), bytes: (await r.body()).length }); } catch {} });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(base + "/");
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  return { page, errors };
}

const cold = await load("cold");
const t0 = Date.now();
const result = await cold.page.evaluate(
  ([projects, cases, edits]) => window.runSpike(projects, cases, edits),
  [games.map((id) => ({ id, liveScenario: reference.liveScenario[id] })), reference.cases.map(({ name, file, text }) => ({ name, file, text })),
   reference.edits.map((e) => ({ project: e.project, scenario: e.scenario, pointer: e.pointer, value: e.value }))]);
const coldWallMs = Date.now() - t0;
await cold.page.close();

// Warm start: new page, HTTP cache populated.
const warm = await load("warm");
const warmInit = await warm.page.evaluate(() => window.runSpike([], [], []).then((r) => r.initTimings));
await warm.page.close();
const browserVersion = browser.version();
await browser.close();
server.close();

// ------------------------------------------------------------------ comparison
const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });

// 1. validate parity
// `monstera validate --json` sorts object keys; compare issues field by field.
const norm = (issues) => issues.map((i) => [i.path, i.code, i.message]);
let diffs = [];
reference.validate.forEach((ref, i) => {
  const got = result.validate[i];
  const same = got.name === ref.name && got.valid === ref.valid && got.sha256 === ref.sha256 &&
    JSON.stringify(norm(got.issues)) === JSON.stringify(norm(ref.issues));
  if (!same) diffs.push(ref.name);
  if (got.valueParity === false) diffs.push(`${ref.name} (value path)`);
});
check("validate parity with `monstera validate --json`", diffs.length === 0 && result.validate.length === reference.validate.length,
  `${reference.validate.length} cases (${reference.validate.filter((r) => !r.valid).length} invalid, ${reference.validate.filter((r) => r.valid).length} valid); differences: ${diffs.join(", ") || "none"}`);
check("schema digests visible in the worker", Object.keys(result.info.schemaDigests).length >= 4, Object.keys(result.info.schemaDigests).join(", "));

// 2. plan parity
for (const g of games) {
  const plan = result.projects[g].plan, ref = reference.generate[g];
  const got = Object.fromEntries(plan.files.map((f) => [f.path, f]));
  const paths = Object.keys(ref.files).sort();
  const missing = paths.filter((p) => !got[p]);
  const extra = Object.keys(got).filter((p) => !ref.files[p]);
  const wrong = paths.filter((p) => got[p] && (got[p].sha256 !== ref.files[p].sha256 || got[p].size !== ref.files[p].size));
  const modeWrong = Object.keys(ref.manifestModes).filter((p) => got[p] && got[p].mode.toString(8) !== ref.manifestModes[p]);
  check(`plan ${g}: file set, contents and sizes equal CLI generate`, !missing.length && !extra.length && !wrong.length,
    `${paths.length} files; missing ${missing.length}, extra ${extra.length}, content differs ${wrong.length}`);
  check(`plan ${g}: modes equal the CLI manifest`, !modeWrong.length, `${Object.keys(ref.manifestModes).length} modes; differs ${modeWrong.length}`);
  check(`plan ${g}: MONSTERA-MANIFEST.json equals CLI output and the committed manifest`,
    got["MONSTERA-MANIFEST.json"]?.sha256 === ref.files["MONSTERA-MANIFEST.json"].sha256 &&
    got["MONSTERA-MANIFEST.json"]?.sha256 === ref.committedManifestSha256, got["MONSTERA-MANIFEST.json"]?.sha256);
  check(`plan ${g}: binary asset (gradle-wrapper.jar) reproduced`, plan.binary.length > 0 && plan.binary.every((p) => got[p].sha256 === ref.files[p].sha256), plan.binary.join(", "));
}

// 3. golden scenarios
for (const g of games) {
  const gold = result.projects[g].golden;
  const bad = gold.filter((s) => !s.match || s.checkIssues.length);
  check(`golden ${g}: every scenario reproduces its committed checkpoints in the browser`, gold.length > 0 && !bad.length,
    `${gold.length} scenarios, ${gold.reduce((a, s) => a + s.checkpoints, 0)} checkpoints, ${gold.reduce((a, s) => a + s.ticks, 0)} ticks; failing: ${bad.map((s) => s.name).join(", ") || "none"}`);
}

// 4. edited specs vs host CPython
reference.edits.forEach((ref, i) => {
  const got = result.edits[i].result;
  const same = got.valid === ref.valid && got.editedSha256 === ref.editedSha256 && got.firstDivergentTick === ref.firstDivergentTick &&
    got.divergentCheckpoints === ref.divergentCheckpoints && JSON.stringify(got.hashes) === JSON.stringify(ref.hashes);
  const noop = ref.value === ref.original;
  check(`edit ${ref.project} spawners[0].intervalTicks ${ref.original} -> ${ref.value}: Pyodide equals host CPython`, same,
    `first divergent tick ${got.firstDivergentTick}, ${got.divergentCheckpoints}/${got.checkpoints} checkpoints differ`);
  check(`edit ${ref.project} ${noop ? "no-op does not diverge" : "behaviour change diverges"}`, noop ? got.divergentCheckpoints === 0 : got.divergentCheckpoints > 0);
});

// 5. live stepping equals host
for (const g of games) {
  const live = result.projects[g].live, ref = reference.live[g];
  check(`live ${g}: per-tick stepping final hash equals host CPython`, live.hash === ref.hash && live.finalTick === ref.finalTick && live.ended === ref.ended,
    `${live.ticks} ticks, hash ${live.hash}`);
}

// 6. budgets
const fetchedCold = fetched.filter((f) => f.label === "cold");
const totalFetchedRaw = fetchedCold.reduce((a, f) => a + f.bytes, 0);
check("cold engine ready in budget (localhost, no network latency)", result.initTimings.totalMs <= LIMITS.coldInitMs, `${Math.round(result.initTimings.totalMs)} ms <= ${LIMITS.coldInitMs}`);
const worstP95 = Math.max(...games.map((g) => result.projects[g].live.p95Ms));
check("per-tick step p95 within budget", worstP95 <= LIMITS.tickP95Ms, `worst p95 ${worstP95.toFixed(3)} ms <= ${LIMITS.tickP95Ms}`);
check("main thread stays responsive while the worker computes", result.mainThreadMaxGapMs <= LIMITS.mainThreadGapMs, `max timer gap ${Math.round(result.mainThreadMaxGapMs)} ms <= ${LIMITS.mainThreadGapMs}`);
check("first-load size (brotli estimate) within budget", bundle.total.brotli <= LIMITS.brotliFirstLoadBytes, `${(bundle.total.brotli / 1048576).toFixed(2)} MiB <= ${LIMITS.brotliFirstLoadBytes / 1048576}`);
check("no page errors", cold.errors.length === 0, cold.errors.join(" | "));

const verdict = checks.every((c) => c.ok) ? "PASS" : "FAIL";
const out = {
  verdict, checks, limits: LIMITS,
  environment: { browser: `Chrome ${browserVersion} (Playwright ${"1.65.0"}, channel chrome)`, node: process.version, os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, hostPython: reference.hostPython.split("\n")[0] },
  runtime: { pyodide: bundle.pyodide, python: result.info.python.split("\n")[0], engineFiles: bundle.engineFiles },
  size: { bundle, networkBytesColdRaw: totalFetchedRaw, requestsCold: fetchedCold.length },
  timings: { cold: result.initTimings, warm: warmInit, coldWallMsForWholeRun: coldWallMs, mainThreadMaxGapMs: result.mainThreadMaxGapMs },
  projects: Object.fromEntries(games.map((g) => [g, { planMs: result.projects[g].plan.msPlan, loadScenariosMs: result.projects[g].plan.msLoadScenarios,
    planCallMs: result.projects[g].planCallMs, files: result.projects[g].plan.files.length, scenarios: result.projects[g].golden.map((s) => ({ name: s.name, ticks: s.ticks, frames: s.frames, checkpoints: s.checkpoints, match: s.match, ms: Math.round(s.ms) })), live: result.projects[g].live }])),
  edits: result.edits.map((e) => ({ project: e.project, scenario: e.scenario, pointer: e.pointer.join("."), value: e.value, ...e.result, hashes: undefined })),
};
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, "spike-result.json"), JSON.stringify(out, null, 2) + "\n");
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  [" + c.detail + "]" : ""}`);
console.log(`\nVERDICT: ${verdict}`);
process.exit(verdict === "PASS" ? 0 : 1);
