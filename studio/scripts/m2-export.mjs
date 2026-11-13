// Studio M2 batch 5 acceptance: native source export in Chrome against dist/. Archives are downloaded through the UI
// and verified by Python's zipfile against `monstera generate` (m2-export-verify.py). Run `npm run build` first.
// Writes docs/evidence/studio-m2/export.json.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = fileURLToPath(new URL(".", import.meta.url));
const studio = join(here, "..");
const repo = join(studio, "..");
const dist = join(studio, "dist");
const evidence = join(repo, "docs", "evidence", "studio-m2");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm" };
const TEMPLATES = [
  { id: "pumpkin-blaster", spec: "apps/pumpkin-blaster/monstera.spec.json", goldens: 5 },
  { id: "trick-or-treat-rush", spec: "apps/trick-or-treat-rush/monstera.spec.json", goldens: 6 },
  { id: "lantern-run", spec: "spec/samples/lantern-run/monstera.spec.json", goldens: 4 },
];
if (!existsSync(join(dist, "index.html"))) throw new Error("dist/ is missing: run `npm run build` first");

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
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
const errors = [];
const requests = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("request", (r) => requests.push(r.url()));
await page.goto(origin + "/");
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });

const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });
const settled = () => page.waitForFunction(() => document.querySelector('[data-testid="validation-status"]')?.textContent?.startsWith("Checking") === false, null, { timeout: 15000 });
const scratch = mkdtempSync(join(tmpdir(), "studio-m2-export-"));
const cases = [];

async function exportNow(name) {
  await page.evaluate(() => { window.location.hash = "/export"; });
  await page.waitForSelector('[data-testid="export"]');
  const sha = await page.evaluate(() => window.session.store.getState().validation.sha256);
  const t0 = Date.now();
  await page.click('[data-testid="export-generate"]');
  await page.waitForSelector(`[data-testid="export-tree"][data-sha="${sha}"]`, { timeout: 60000 }); // the plan for THIS draft
  const planMs = Date.now() - t0;
  const goldens = await page.$eval('[data-testid="export-goldens"]', (e) => ({ included: Number(e.dataset.included), omitted: Number(e.dataset.omitted), text: e.textContent, role: e.getAttribute("role") }));
  const t1 = Date.now();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="export-download"]')]);
  const file = join(scratch, `${name}.zip`);
  await dl.saveAs(file);
  return { file, planMs, zipMs: Date.now() - t1, goldens, filename: dl.suggestedFilename(), treeFiles: await page.locator('[data-testid="export-tree"] [data-path-file]').count() };
}

const rows = [];
for (const t of TEMPLATES) {
  await page.evaluate((id) => window.session.loadTemplate(id), t.id);
  await settled();
  const sha = await page.evaluate(() => window.session.store.getState().validation.sha256);
  const r = await exportNow(t.id);
  check(`${t.id} (unedited): the export embeds its ${t.goldens} committed golden scenarios and says so`, r.goldens.included === t.goldens && r.goldens.omitted === 0, r.goldens.text.trim().slice(0, 90));
  cases.push({ name: `${t.id} unedited`, zip: r.file, projectId: t.id, specSha256: sha, kind: "cli", spec: t.spec, expectScenarios: t.goldens });
  rows.push({ case: `${t.id} unedited`, ...r, file: undefined, treeFiles: r.treeFiles });
}

// ---- edited drafts: scenarios=[] and a prominent explanation
for (const [id, edit, label] of [["pumpkin-blaster", 7, "apps/pumpkin-blaster/monstera.spec.json"], ["trick-or-treat-rush", 4, "apps/trick-or-treat-rush/monstera.spec.json"]]) {
  await page.evaluate((t) => window.session.loadTemplate(t), id);
  await settled();
  await page.evaluate((v) => window.session.store.set(["game", "runtime", "lives"], v), edit);
  await settled();
  const v = await page.evaluate(() => window.session.store.getState().validation);
  const r = await exportNow(`${id}-edited`);
  const expected = TEMPLATES.find((x) => x.id === id).goldens;
  check(`${id} (edited, lives ${edit}): exports with no scenarios and a prominent notice that ${expected} recorded goldens were omitted`,
    r.goldens.included === 0 && r.goldens.omitted === expected && r.goldens.role === "alert" && r.goldens.text.includes("Recorded goldens omitted"), r.goldens.text.trim().slice(0, 110));
  cases.push({ name: `${id} edited (lives ${edit})`, zip: r.file, projectId: id, specSha256: v.sha256, kind: "edited", text: v.canonicalText, label, layout: "app" });
  rows.push({ case: `${id} edited`, ...r, file: undefined });
}

// ---- stale and invalid drafts cannot be downloaded
await page.evaluate(() => window.session.store.set(["game", "runtime", "lives"], 5));
await page.waitForFunction(() => document.querySelector('[data-testid="export-stale"]') !== null);
check("after an edit the generated files are marked stale and the download is disabled", await page.locator('[data-testid="export-download"]').isDisabled());
await settled();
await page.evaluate(() => window.session.store.set(["game", "runtime", "lives"], 0));
await settled();
check("an invalid draft cannot be generated", await page.locator('[data-testid="export-generate"]').isDisabled());

// ---- labels
const text = await page.locator("main").innerText();
check("the export is labelled GENERATED and claims no compile, simulator or device result",
  text.includes("GENERATED") && /not compiled them/.test(text) && !/device[- ]tested|SIMULATOR-TESTED:|COMPILED:/i.test(text.replace("COMPILED and SIMULATOR-TESTED results exist only as committed evidence", "")));
check("no build button exists", (await page.locator('button:has-text("Build")').count()) === 0);
await page.evaluate(() => window.session.store.set(["game", "runtime", "lives"], 5));
await settled();
await page.click('[data-testid="export-generate"]');
await page.waitForSelector('[data-testid="export-tree"]');
await page.locator("main").screenshot({ path: join(evidence, "screens", "export-panel.png") });

const external = requests.filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:"));
check("no request leaves the origin (the ZIP is built in the page)", external.length === 0, external.join(", ") || "all same-origin");
check("no console or page errors", errors.length === 0, errors.join(" | "));
const browserVersion = browser.version();
await browser.close();
server.close();

// ---- independent verification with Python zipfile and the CLI
writeFileSync(join(scratch, "cases.json"), JSON.stringify(cases));
const py = (() => { for (const [c, a] of [["python3", []], ["python", []], ["py", ["-3"]]]) { try { execFileSync(c, [...a, "--version"], { stdio: "pipe" }); return [c, a]; } catch { /* next */ } } throw new Error("no Python 3"); })();
execFileSync(py[0], [...py[1], join(here, "m2-export-verify.py"), join(scratch, "cases.json"), join(scratch, "out.json")], { cwd: repo, stdio: "pipe", maxBuffer: 1 << 26, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
const verified = JSON.parse(readFileSync(join(scratch, "out.json"), "utf8"));
for (const v of verified) {
  const core = !v.problems && v.zipProblems.length === 0 && v.missing.length === 0 && v.extra.length === 0 && v.contentDiffers.length === 0 && v.modeDiffers.length === 0;
  check(`${v.name}: ZIP is valid (CRCs, regular files, safe unique paths) and equals ${v.reference}: paths, contents, modes`, core,
    v.problems ? v.problems.join("; ") : `${v.files} files; missing ${v.missing.length}, extra ${v.extra.length}, differ ${v.contentDiffers.length}, modes ${v.modeDiffers.length}; executables ${v.executables.join(", ")}; zip problems ${v.zipProblems.join(", ") || "none"}`);
  if (v.problems) continue;
  check(`${v.name}: manifest and the bundled spec carry the exact spec SHA-256; the Gradle wrapper JAR equals the committed binary`,
    v.manifestSpecShaOk && v.specAssetShaOk && v.jarEqualsCommittedTemplate, `manifest ${v.manifestSha256.slice(0, 12)} for ${v.manifestSpec?.path}; jar ${v.jarSha256.slice(0, 12)}`);
  if (v.equalsCommittedManifest !== undefined) check(`${v.name}: MONSTERA-MANIFEST.json equals the committed manifest`, v.equalsCommittedManifest);
  if (v.scenariosResourceEqualsCli !== undefined) check(`${v.name}: the embedded golden scenarios equal the CLI's (${v.scenariosEmbedded} scenarios, ${v.scenariosResourceBytes} bytes)`, v.scenariosResourceEqualsCli && v.scenariosResourceBytes > 0);
  if (v.cliRefuses !== undefined) check(`${v.name}: the CLI refuses this spec (stale goldens) and the export has no scenarios and the canonical draft`, v.cliRefuses && v.scenariosResourceIsEmpty && v.specAssetIsCanonicalDraft, v.cliMessage);
}
rmSync(scratch, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
const result = { verdict: failed.length ? "FAIL" : "PASS", browser: `Chrome ${browserVersion}`, exports: rows, verification: verified, checks };
writeFileSync(join(evidence, "export.json"), JSON.stringify(result, null, 2) + "\n");
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
console.log(`\n${result.verdict}: ${checks.length - failed.length}/${checks.length} checks, Chrome ${browserVersion}`);
process.exit(failed.length ? 1 : 0);
