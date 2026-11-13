// Studio M2 end-to-end flow per template, in Chrome against dist/: edit -> validate -> preview restarts with the edit ->
// inspect an entity -> determinism check -> export, then revert to the template's exact SHA-256. Each step uses the
// same UI controls as a user; details of each capability are proven by the per-batch acceptance scripts.
// Run `npm run build` first. Writes docs/evidence/studio-m2/e2e.json.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = fileURLToPath(new URL(".", import.meta.url));
const studio = join(here, "..");
const repo = join(studio, "..");
const dist = join(studio, "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm" };
const TEMPLATES = ["pumpkin-blaster", "trick-or-treat-rush", "lantern-run"];
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
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(origin + "/");
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });

const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });
const settled = () => page.waitForFunction(() => document.querySelector('[data-testid="validation-status"]')?.textContent?.startsWith("Checking") === false, null, { timeout: 15000 });
const open = async (id) => { await page.evaluate((h) => { window.location.hash = h; }, `/${id}`); await page.waitForSelector(`[data-testid="${id}"], main`); };
const TERMINAL = ["match", "diverged", "error", "invalid", "no-goldens"];

for (const id of TEMPLATES) {
  const steps = [];
  await page.evaluate((t) => window.session.loadTemplate(t), id);
  await settled();
  const original = await page.evaluate(() => window.session.store.getState().validation.sha256);
  const lives = await page.evaluate(() => window.session.store.getState().doc.game.runtime.lives);

  // edit through the Rules control, validated by the engine
  await open("rules");
  await page.fill('[data-path="$.game.runtime.lives"]', String(lives + 1));
  await settled();
  const v = await page.evaluate(() => window.session.store.getState().validation);
  steps.push(["edit + validate", v.ok && v.sha256 !== original, `lives ${lives} -> ${lives + 1}, ${v.sha256.slice(0, 12)}`]);

  // preview restarts with the edited spec
  await page.waitForFunction((s) => window.session.preview.getState().sha256 === s && window.session.preview.getState().status === "running", v.sha256, { timeout: 5000 });
  steps.push(["preview runs the edit", (await page.evaluate(() => window.session.preview.getState().snapshot.lives)) === lives + 1, "engine lives match the edit"]);

  // inspect: click the first visible entity, its kind card opens
  await page.click('[data-testid="preview-inspect"]');
  await page.waitForFunction(() => window.session.preview.getState().held === true);
  const box = (await page.evaluate(() => window.previewDebug.boxes())).find((b) => b.visible);
  const canvas = await page.locator('[data-testid="preview-canvas"]').boundingBox();
  await page.mouse.click(canvas.x + box.visible.x + box.visible.w / 2, canvas.y + box.visible.y + box.visible.h / 2);
  await page.waitForFunction(() => window.location.hash === "#/entities");
  steps.push(["inspect selects the kind", (await page.evaluate(() => window.session.selection.getState().kindId)) !== null, await page.evaluate(() => window.session.selection.getState().kindId)]);
  await page.click('[data-testid="preview-inspect"]');

  // determinism check: a lives edit is a behaviour edit, so the recorded goldens diverge, as expected
  await open("determinism");
  await page.click('[data-testid="badge-run"]');
  await page.waitForFunction((t) => t.includes(document.querySelector('[data-testid="badge-verdict"]')?.dataset.verdict), TERMINAL, { timeout: 120000 });
  const verdict = await page.$eval('[data-testid="badge-verdict"]', (e) => e.dataset.verdict);
  const why = await page.$eval('[data-testid="badge-explanation"]', (e) => e.dataset.explanation);
  steps.push(["determinism check", verdict === "diverged" && why === "expected", `${verdict}, explanation ${why}`]);

  // export of the edited draft: goldens omitted, downloadable
  await open("export");
  await page.click('[data-testid="export-generate"]');
  await page.waitForSelector(`[data-testid="export-tree"][data-sha="${v.sha256}"]`, { timeout: 60000 });
  const omitted = await page.$eval('[data-testid="export-goldens"]', (e) => Number(e.dataset.omitted));
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="export-download"]')]);
  steps.push(["export (edited: goldens omitted)", omitted > 0 && dl.suggestedFilename() === `${id}-native-source.zip`, `${omitted} omitted; ${dl.suggestedFilename()}`]);

  // revert: back to the template's exact SHA-256, the badge matches again
  await open("rules");
  await page.fill('[data-path="$.game.runtime.lives"]', String(lives));
  await settled();
  await open("determinism");
  await page.click('[data-testid="badge-run"]');
  await page.waitForFunction((t) => t.includes(document.querySelector('[data-testid="badge-verdict"]')?.dataset.verdict), TERMINAL, { timeout: 120000 });
  const back = await page.evaluate(() => window.session.store.getState().validation.sha256);
  steps.push(["revert -> original SHA-256 and MATCH", back === original && (await page.$eval('[data-testid="badge-verdict"]', (e) => e.dataset.verdict)) === "match", back.slice(0, 12)]);

  check(`${id}: edit, validate, preview, inspect, determinism check, export, revert`, steps.every((s) => s[1]), steps.map(([n, ok, d]) => `${ok ? "ok" : "FAIL"} ${n} (${d})`).join("; "));
}
check("no console or page errors", errors.length === 0, errors.join(" | "));
const browserVersion = browser.version();
await browser.close();
server.close();
const failed = checks.filter((c) => !c.ok);
const result = { verdict: failed.length ? "FAIL" : "PASS", browser: `Chrome ${browserVersion}`, checks };
mkdirSync(join(repo, "docs", "evidence", "studio-m2"), { recursive: true });
writeFileSync(join(repo, "docs", "evidence", "studio-m2", "e2e.json"), JSON.stringify(result, null, 2) + "\n");
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
console.log(`\n${result.verdict}: ${checks.length - failed.length}/${checks.length} checks, Chrome ${browserVersion}`);
process.exit(failed.length ? 1 : 0);
