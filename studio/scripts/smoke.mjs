// Studio smoke test: a real browser against a running Studio, local production preview or a deployed URL.
//   node scripts/smoke.mjs                       serves dist/ with `vite preview` (run `npm run build` first)
//   SMOKE_URL=https://host/ node scripts/smoke.mjs   tests that URL; nothing is built or served
// Env: SMOKE_LABEL (report name, default local-preview or deployed), SMOKE_CHANNEL (e.g. "chrome" to use an installed
// Chrome; default is Playwright's Chromium), SMOKE_REPORT (JSON path, default docs/evidence/studio-m3b/smoke-<label>.json).
// Scope: load, engine start, validation, template switching, preview running, evidence binding. It does not play the game.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { preview } from "vite";
import { GAMES, specSha256 } from "./native-evidence.mjs";

const studio = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(studio, "..");
const remote = process.env.SMOKE_URL || null;
const label = process.env.SMOKE_LABEL || (remote ? "deployed" : "local-preview");
const reportPath = resolve(process.env.SMOKE_REPORT || join(repo, "docs", "evidence", "studio-m3b", `smoke-${label}.json`));
const OFFICIAL = "pumpkin-blaster";
const expectedSha = Object.fromEntries(GAMES.map((g) => [g.id, specSha256(readFileSync(join(repo, g.specPath)))]));

let server = null;
let origin = remote;
if (!remote) {
  server = await preview({ root: studio, preview: { port: 0, host: "127.0.0.1", strictPort: false, open: false } });
  origin = server.resolvedUrls.local[0];
}
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok), detail: String(detail) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `: ${detail}`}`); };
const problems = [];
const assets = [];
let browser = null;
let fatal = null;
try {
  browser = await chromium.launch(process.env.SMOKE_CHANNEL ? { channel: process.env.SMOKE_CHANNEL } : {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const base = new URL(origin).origin;
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console.error: ${m.text()}`); });
  page.on("requestfailed", (r) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
  const foreign = new Set();
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.origin !== base) { foreign.add(u.origin); return; }
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${u.pathname}`);
    if (/\.(wasm|zip|json|mjs)$/.test(u.pathname) && u.pathname.includes("pyodide")) {
      const h = r.headers();
      assets.push({ path: u.pathname, status: r.status(), contentType: h["content-type"] ?? null, cacheControl: h["cache-control"] ?? null, encoding: h["content-encoding"] ?? null });
    }
  });
  const text = async (sel) => (await page.locator(sel).first().textContent())?.trim() ?? "";
  const settled = () => page.waitForFunction(() => document.querySelector('[data-testid="validation-status"]')?.textContent?.startsWith("Checking") === false, null, { timeout: 30000 });
  const sha = () => page.evaluate(() => window.session.store.getState().validation?.sha256 ?? null);
  const edit = async (path, value) => { await page.evaluate(([p, v]) => window.session.store.set(p, v), [path, value]); await settled(); };
  const open = async (id) => { await page.evaluate((h) => { window.location.hash = h; }, `/${id}`); await page.waitForTimeout(50); };
  const nativeAttr = (a) => page.locator('[data-testid="native-apps"]').getAttribute(a);

  // ---- load and engine start
  const res = await page.goto(origin, { waitUntil: "load" });
  check("the page loads with HTTP 200", res?.status() === 200, res?.status());
  await page.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
  await settled();
  check("the engine starts (Pyodide worker ready, no startup failure shown)", (await page.locator(".boot.bad").count()) === 0);
  const status = await text('[data-testid="validation-status"]');
  check("the Python engine validates the default game", status.startsWith("Valid"), status);

  // ---- templates: engine verdict and canonical hash for each official game
  for (const g of GAMES) {
    await page.selectOption('[data-testid="template-select"]', g.id);
    await settled();
    const s = await text('[data-testid="validation-status"]');
    check(`template ${g.id} validates and the engine hash equals the committed spec's canonical SHA-256`, s.startsWith("Valid") && (await sha()) === expectedSha[g.id], s);
  }
  await page.selectOption('[data-testid="template-select"]', OFFICIAL);
  await settled();

  // ---- the engine really runs: an invalid edit is refused with issues, a valid edit changes the hash
  const original = await sha();
  const lives = await page.evaluate(() => window.session.store.getState().doc.game.runtime.lives);
  await edit(["game", "runtime", "lives"], 0);
  check("an invalid edit is rejected by the engine with listed issues", (await text('[data-testid="validation-status"]')).includes("issue") && (await page.locator('[data-testid="issues"] li').count()) >= 1);
  await edit(["game", "runtime", "lives"], lives);
  check("reverting the edit restores the original engine hash", (await sha()) === original && original === expectedSha[OFFICIAL]);

  // ---- preview
  await open("overview");
  await page.waitForFunction(() => window.session.preview.getState().status === "running", null, { timeout: 30000 });
  const f1 = await page.evaluate(() => window.session.preview.getStats().framesSent);
  await page.waitForFunction((n) => window.session.preview.getStats().framesSent > n, f1, { timeout: 15000 }).then(() => check("the preview is running and the engine is producing frames", true), () => check("the preview is running and the engine is producing frames", false, `framesSent stayed at ${f1}`));
  const colors = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="preview-canvas"]');
    if (!c) return 0;
    const t = document.createElement("canvas");
    t.width = c.width; t.height = c.height;
    const ctx = t.getContext("2d");
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, t.width, t.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length && seen.size < 8; i += 4 * 17) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return seen.size;
  });
  check("the preview canvas shows a drawn scene (at least 3 distinct colours)", colors >= 3, `${colors} colours sampled`);

  // ---- native evidence bound to the exact spec hash
  await open("determinism");
  const labels = [await text('[data-testid="native-app-label-android"]'), await text('[data-testid="native-app-label-ios"]')];
  check("the unedited official game shows its committed native evidence", (await nativeAttr("data-matched")) === "yes" && labels.join(",") === "SIMULATOR-TESTED,SIMULATOR-TESTED", labels.join(","));
  const hrefs = await page.$$eval('[data-testid^="native-app-links-"] a', (a) => a.map((x) => x.href));
  const codes = await Promise.all(hrefs.map((h) => page.evaluate(async (u) => (await fetch(u)).status, h)));
  check("the evidence links resolve", hrefs.length === 8 && codes.every((c) => c === 200), codes.join(","));
  await edit(["game", "runtime", "lives"], lives + 1);
  await open("determinism");
  check("after a spec edit the evidence status is removed (GENERATED, no platform cards)",
    (await nativeAttr("data-matched")) === "no" && (await nativeAttr("data-label")) === "GENERATED" && (await page.locator('[data-testid="native-app-android"]').count()) === 0);
  await edit(["game", "runtime", "lives"], lives);
  await open("determinism");
  check("editing back to the original hash restores the evidence", (await nativeAttr("data-matched")) === "yes");

  // ---- page health
  const stamp = await (async () => { await open("integration"); return text('[data-testid="inventory-stamp"]'); })();
  check("no page errors, console errors, failed requests or HTTP errors during the run", problems.length === 0, problems.slice(0, 5).join(" | "));
  check("every request stays on the Studio origin (no backend or third-party calls)", foreign.size === 0, [...foreign].join(","));
  const wasm = assets.find((a) => a.path.endsWith(".wasm"));
  check("the Pyodide WebAssembly file is served as application/wasm", wasm?.status === 200 && wasm.contentType?.startsWith("application/wasm"), wasm ? wasm.contentType : "not requested");
  var inventoryStamp = stamp;
} catch (e) {
  fatal = e;
  check("the smoke run completes without an unexpected error", false, e?.message?.split("\n")[0] ?? e);
} finally {
  await browser?.close();
  await server?.close();
}
const failed = checks.filter((c) => !c.ok);
const report = {
  label, target: remote ? new URL(remote).origin + new URL(remote).pathname : "local vite preview of studio/dist",
  scope: "load, engine start, validation, template switching, preview frames, evidence binding. No gameplay or input was exercised; no physical device was used.",
  verdict: failed.length === 0 ? "PASS" : "FAIL", checks,
  pyodideAssets: assets, inventoryStamp: typeof inventoryStamp === "string" ? inventoryStamp : null,
  problems, fatal: fatal ? String(fatal.message).split("\n")[0] : null,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(`\nsmoke ${label}: ${report.verdict} (${checks.length - failed.length}/${checks.length}) -> ${reportPath}`);
process.exit(failed.length ? 1 : 0);
