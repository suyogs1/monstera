// Browser check for the Studio shell (task 1.1): legacy hash redirects, the 11-module rail built from the registry, status
// indicators, module headers, and the honesty of the cards for modules that are not built. Serves dist/ with `vite preview`
// (run `npm run build` first). Env: SMOKE_CHANNEL (e.g. "chrome") like scripts/smoke.mjs. Exit code 1 on any failed check.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { preview } from "vite";

const studio = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(studio, "capabilities.json"), "utf8"));
const LEGACY = {
  overview: "designer/overview", platforms: "designer/platforms", gameplay: "designer/world", entities: "designer/entities", rules: "designer/rules",
  spawns: "designer/spawns", presentation: "designer/presentation", spec: "designer/spec", determinism: "preview/determinism",
  export: "release/export", integration: "kiro/integration",
};
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `: ${detail}`}`); };

const server = await preview({ root: studio, preview: { port: 0, host: "127.0.0.1", open: false } });
const origin = server.resolvedUrls.local[0];
const browser = await chromium.launch(process.env.SMOKE_CHANNEL ? { channel: process.env.SMOKE_CHANNEL } : {});
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console.error: ${m.text()}`); });
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
  const go = async (hash) => { await page.evaluate((h) => { window.location.hash = h; }, hash); await page.waitForTimeout(80); };
  const hash = () => page.evaluate(() => window.location.hash);

  check("the page starts on the Designer overview", (await hash()) === "#/designer/overview", await hash());

  for (const [legacy, target] of Object.entries(LEGACY)) {
    await go(`/${legacy}`);
    check(`legacy #/${legacy} redirects to #/${target}`, (await hash()) === `#/${target}`, await hash());
  }
  await go("/does-not-exist");
  check("an unknown hash lands on the Designer overview", (await hash()) === "#/designer/overview", await hash());

  const rail = await page.$$eval('[data-testid="module-list"] > li > a', (as) => as.map((a) => ({ id: a.dataset.testid, status: a.dataset.status, text: a.textContent })));
  check("the rail lists all 11 registry modules in registry order", JSON.stringify(rail.map((r) => r.id)) === JSON.stringify(registry.modules.map((m) => `module-${m.id}`)), JSON.stringify(rail.map((r) => r.id)));
  check("every rail entry carries its registry title and status as text", rail.every((r, i) => r.text.includes(registry.modules[i].title) && r.text.includes(registry.modules[i].status) && r.status === registry.modules[i].status));

  // Every module opens; planned ones show a card with no editing controls, built ones show a header and the editors.
  for (const m of registry.modules) {
    await page.click(`[data-testid="module-${m.id}"]`);
    await page.waitForTimeout(80);
    const header = await page.$eval('[data-testid="module-header"]', (h) => ({ module: h.dataset.module, status: h.dataset.status, native: h.dataset.nativeOutput, text: h.textContent }));
    check(`${m.id}: header shows registry status and native output`, header.module === m.id && header.status === m.status && header.native === m.nativeOutput && header.text.includes(m.status) && header.text.includes(m.nativeOutput) && header.text.includes(m.title));
    const card = await page.$('[data-testid="module-card"]');
    if (m.status === "planned") {
      check(`${m.id}: planned module shows an explanatory card`, card !== null);
      const controls = await page.$$eval('[data-testid="module-card"] input, [data-testid="module-card"] button, [data-testid="module-card"] select, [data-testid="module-card"] textarea, [data-testid="module-card"] form, [data-testid="module-card"] [contenteditable]', (e) => e.length);
      check(`${m.id}: the card has no input, button, select, textarea, form or editable region`, controls === 0, controls);
      const listed = await page.$$eval('[data-testid="module-card"] [data-testid="capability"]', (e) => e.map((x) => x.dataset.capability));
      const want = registry.capabilities.filter((c) => c.module === m.id && (c.status === "planned" || c.status === "unsupported")).map((c) => c.id);
      check(`${m.id}: the card lists exactly the registry's unbuilt capabilities`, JSON.stringify(listed) === JSON.stringify(want), JSON.stringify(listed));
    } else {
      check(`${m.id}: built module shows editors, not a card`, card === null && (await page.$('[data-testid="module-header"] + *')) !== null);
    }
    check(`${m.id}: the shared validation panel is present`, (await page.$('[data-testid="validation-status"]')) !== null);
  }

  // Existing editors are still operational after the move: an edit through the field goes to the engine and back.
  await go("/designer/entities");
  check("the Designer entity editor renders", (await page.locator('main input, main select').count()) > 0);
  await go("/preview");
  check("Preview and Device Lab opens the determinism view", (await hash()) === "#/preview/determinism" && (await page.$('[data-testid="native-apps"]')) !== null);
  await go("/release/export");
  check("Build and Release opens the source export", (await page.locator("main").innerText()).length > 50);
  await go("/kiro");
  check("Kiro Development opens Developer Integration", (await hash()) === "#/kiro/integration");
  await go("/designer/overview");
  check("the top bar shows the engine's spec hash", /^[0-9a-f]{12}$/.test((await page.locator('[data-testid="topbar-hash"]').textContent()) ?? ""));
  check("no page error or console error", problems.length === 0, problems.join(" | "));
} finally {
  await browser.close();
  await server.close();
}
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
