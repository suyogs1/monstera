// Studio M2 batch 1 proof, in a real browser (Chrome via Playwright, Pyodide in a worker) against dist/.
//   1. every committed golden scenario reproduces its checkpoints, equal to host CPython (tick- and frame-driven)
//   2. plan() for both official games equals `monstera generate`: file set, contents, modes, manifest, jar
//   3. bundle size and engine/golden timings
// Run `npm run build` first. Writes docs/evidence/studio-m2/batch1.json. Exit code 1 on any failed check.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync } from "node:zlib";
import { chromium } from "playwright-core";

const here = fileURLToPath(new URL(".", import.meta.url));
const studio = join(here, "..");
const repo = join(studio, "..");
const dist = join(studio, "dist");
const evidenceDir = join(repo, "docs", "evidence", "studio-m2");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm" };
const GAMES = [
  { id: "pumpkin-blaster", path: "apps/pumpkin-blaster/monstera.spec.json" },
  { id: "trick-or-treat-rush", path: "apps/trick-or-treat-rush/monstera.spec.json" },
];
const LIMITS = { coldInitMs: 10000, brotliFirstLoadBytes: 15 * 1024 * 1024 };

if (!existsSync(join(dist, "index.html"))) throw new Error("dist/ is missing: run `npm run build` first");

// ------------------------------------------------------------------ host reference (CPython + real CLI)
function pythonCommand() {
  for (const [cmd, args] of [["python3", []], ["python", []], ["py", ["-3"]]]) {
    try { execFileSync(cmd, [...args, "--version"], { stdio: "pipe" }); return [cmd, args]; } catch { /* next */ }
  }
  throw new Error("no Python 3 interpreter found for the host reference");
}
const [PY, PYARGS] = pythonCommand();
const scratch = mkdtempSync(join(tmpdir(), "studio-m2-"));
const refFile = join(scratch, "reference.json");
const refOut = execFileSync(PY, [...PYARGS, join(here, "m2-reference.py"), refFile],
  { cwd: repo, env: { ...process.env, PYTHONIOENCODING: "utf-8" }, stdio: "pipe", maxBuffer: 1 << 26 }).toString("utf8").trim();
console.log(refOut);
const ref = JSON.parse(readFileSync(refFile, "utf8"));

// ------------------------------------------------------------------ serve dist/ and open it
const server = createServer((req, res) => {
  const url = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = join(dist, url);
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: "chrome" });
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(origin + "/");
await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });

const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });
// Key-order-insensitive deep equality, like Python's dict equality (which `scenario.check` relies on).
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const same = (a, b) => canon(a) === canon(b);

const timings = await page.evaluate(() => window.engine.timings);
check(`engine ready within ${LIMITS.coldInitMs} ms (localhost, cold)`, timings.totalMs <= LIMITS.coldInitMs,
  `${Math.round(timings.totalMs)} ms; ${timings.files} files (unpack ${Math.round(timings.unpackMs)} ms)`);

// ------------------------------------------------------------------ 1. golden scenarios
const t0 = Date.now();
const golden = await page.evaluate(() => window.engine.goldenReport());
const goldenWallMs = Date.now() - t0;
const hostByFile = new Map(ref.golden.map((r) => [r.file, r]));
check("the browser sees the same scenario files as the repository", same(golden.map((r) => r.file), ref.golden.map((r) => r.file)),
  `${golden.length} in the browser, ${ref.golden.length} on the host`);
const scenarioRows = golden.map((g) => {
  const h = hostByFile.get(g.file);
  const firstDiff = (a, b) => { const i = a.findIndex((c, k) => !same(c, b[k])); return i < 0 && a.length === b.length ? null : (a[i < 0 ? b.length : i] ?? b[i])?.tick ?? "length"; };
  return {
    file: g.file, frameDriven: g.frameDriven, ticks: g.ticks, checkpoints: g.committed.length,
    matchesCommitted: same(g.fresh, g.committed), firstDivergenceFromCommitted: firstDiff(g.fresh, g.committed),
    equalsHostCPython: Boolean(h) && same(g.fresh, h.fresh), engineCheckClean: g.checkIssues.length === 0 && h?.checkIssues.length === 0,
    finalHash: g.fresh.at(-1)?.hash, msBrowser: Math.round(g.ms * 10) / 10, msHost: h ? Math.round(h.ms * 10) / 10 : null,
  };
});
for (const r of scenarioRows) {
  check(`golden ${r.file}${r.frameDriven ? " (frame-driven)" : ""}: ${r.checkpoints} checkpoints, ${r.ticks} ticks`,
    r.matchesCommitted && r.equalsHostCPython && r.engineCheckClean,
    r.matchesCommitted ? `final hash ${r.finalHash}; browser ${r.msBrowser} ms, host ${r.msHost} ms`
      : `first divergence at tick ${r.firstDivergenceFromCommitted}; host-equal ${r.equalsHostCPython}, check-clean ${r.engineCheckClean}`);
}
check("the proof includes frame-driven scenarios", scenarioRows.some((r) => r.frameDriven), `${scenarioRows.filter((r) => r.frameDriven).length} frame-driven`);

// ------------------------------------------------------------------ 2. plan parity with `monstera generate`
const planRows = [];
for (const game of GAMES) {
  const plan = await page.evaluate((p) => window.engine.planTemplate(p), game.path);
  const cli = ref.generate[game.id];
  if (!plan.ok) { check(`plan ${game.id}`, false, JSON.stringify(plan.issues)); continue; }
  const browserFiles = Object.fromEntries(plan.files.map((f) => [f.path, f]));
  const cliPaths = Object.keys(cli.files).sort(), browserPaths = Object.keys(browserFiles).sort();
  const missing = cliPaths.filter((p) => !browserFiles[p]), extra = browserPaths.filter((p) => !cli.files[p]);
  const differs = cliPaths.filter((p) => browserFiles[p] && (browserFiles[p].sha256 !== cli.files[p].sha256 || browserFiles[p].size !== cli.files[p].size));
  check(`plan ${game.id}: file set, contents and sizes equal \`monstera generate\``, !missing.length && !extra.length && !differs.length,
    `${browserPaths.length} files; missing ${missing.length}, extra ${extra.length}, content differs ${differs.length}`);
  // plan() returns the integer mode; the manifest writes it as an octal string ("644").
  const modeDiff = Object.keys(cli.manifestModes).filter((p) => browserFiles[p]?.mode?.toString(8) !== String(cli.manifestModes[p]));
  const sample = modeDiff[0] ? `; e.g. ${modeDiff[0]}: browser ${JSON.stringify(browserFiles[modeDiff[0]]?.mode)} vs manifest ${JSON.stringify(cli.manifestModes[modeDiff[0]])}` : "";
  check(`plan ${game.id}: modes equal the CLI manifest`, !modeDiff.length, `${Object.keys(cli.manifestModes).length} modes; differs ${modeDiff.length}${sample}`);
  const manifest = browserFiles["MONSTERA-MANIFEST.json"]?.sha256;
  check(`plan ${game.id}: MONSTERA-MANIFEST.json equals the CLI output and the committed manifest`,
    manifest === cli.files["MONSTERA-MANIFEST.json"]?.sha256 && manifest === cli.committedManifestSha256, String(manifest));
  const jar = browserFiles[cli.jarPath]?.sha256;
  check(`plan ${game.id}: gradle-wrapper.jar equals the CLI output and the committed blob`,
    jar === cli.files[cli.jarPath]?.sha256 && jar === cli.committedJarSha256, `${cli.jarPath} ${jar}`);
  const expectedScenarios = golden.filter((g) => g.specPath === game.path).length;
  planRows.push({ project: game.id, files: browserPaths.length, specSha256: plan.specSha256, manifestSha256: manifest, jarSha256: jar,
    scenariosEmbedded: plan.scenarioCount, recordedScenarios: expectedScenarios, msPlan: Math.round(plan.ms) });
  check(`plan ${game.id}: embeds all ${expectedScenarios} recorded scenarios`, plan.scenarioCount === expectedScenarios, `${plan.scenarioCount}`);
}

// ------------------------------------------------------------------ 3. bundle size
const brotli = (b) => brotliCompressSync(b).length;
const assets = ["engine/engine-bundle.json", "pyodide/pyodide.mjs", "pyodide/pyodide.asm.js", "pyodide/pyodide.asm.wasm",
  "pyodide/python_stdlib.zip", "pyodide/pyodide-lock.json"];
const sizes = assets.map((n) => { const b = readFileSync(join(dist, n)); return { file: n, raw: b.length, brotli: brotli(b) }; });
const bundleFiles = JSON.parse(readFileSync(join(dist, "engine", "engine-bundle.json"), "utf8")).files;
const appFiles = readdirSync(join(dist, "assets")).map((n) => readFileSync(join(dist, "assets", n)));
const appBytes = [appFiles.reduce((a, b) => a + b.length, 0), appFiles.reduce((a, b) => a + brotli(b), 0)];
const total = sizes.reduce((a, s) => a + s.brotli, 0) + appBytes[1];
check(`first load (brotli estimate) within ${LIMITS.brotliFirstLoadBytes / 1048576} MiB`, total <= LIMITS.brotliFirstLoadBytes, `${(total / 1048576).toFixed(2)} MiB`);
const byKind = {
  scenarios: bundleFiles.filter((f) => f.p.startsWith("spec/scenarios/")),
  jar: bundleFiles.filter((f) => f.e === "b"),
};
const scenarioBytes = byKind.scenarios.reduce((a, f) => a + f.d.length, 0);

check("no console or page errors", errors.length === 0, errors.join(" | "));
const browserVersion = browser.version();
await browser.close();
server.close();
rmSync(scratch, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
const result = {
  verdict: failed.length ? "FAIL" : "PASS", browser: `Chrome ${browserVersion}`, hostPython: ref.hostPython.split("\n")[0],
  limits: LIMITS,
  engineTimings: timings,
  goldens: { count: scenarioRows.length, frameDriven: scenarioRows.filter((r) => r.frameDriven).length,
    checkpoints: scenarioRows.reduce((a, r) => a + r.checkpoints, 0), ticks: scenarioRows.reduce((a, r) => a + r.ticks, 0),
    wallMsAllInBrowserIncludingCheck: goldenWallMs, scenarios: scenarioRows },
  plans: planRows,
  bundle: { files: bundleFiles.length, scenarioFiles: byKind.scenarios.length, scenarioRawBytes: scenarioBytes,
    binaryFiles: byKind.jar.map((f) => ({ path: f.p, base64Bytes: f.d.length })), assets: sizes,
    appAssets: { raw: appBytes[0], brotli: appBytes[1] }, firstLoadBrotliBytes: total },
  checks,
};
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, "batch1.json"), JSON.stringify(result, null, 2) + "\n");
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
console.log(`\n${result.verdict}: ${checks.length - failed.length}/${checks.length} checks, Chrome ${browserVersion}`);
process.exit(failed.length ? 1 : 0);
