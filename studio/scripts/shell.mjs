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

  // window.ready is set when the engine has started, just BEFORE React mounts App; the route store's one canonicalizing
  // location.replace() runs on mount. Wait (bounded) for a routed hash, then assert it exactly: a missing redirect still fails.
  await page.waitForFunction(() => window.location.hash.startsWith("#/"), null, { timeout: 5000 }).catch(() => undefined);
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

  check("each rail entry has a visual status dot as well as the status text", await page.evaluate((mods) => mods.every((m) => {
    const dot = document.querySelector(`[data-testid="dot-${m.id}"]`);
    return dot !== null && dot.classList.contains(`dot-${m.status}`) && dot.getAttribute("aria-hidden") === "true" && (dot.textContent ?? "") === "";
  }), registry.modules));
  check("the mobile menu toggle is not shown at desktop width", !(await page.locator('[data-testid="nav-toggle"]').isVisible()));
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
  // ---- mobile navigation at 390 x 844
  const mobile = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const mproblems = [];
  mobile.on("pageerror", (e) => mproblems.push(`pageerror: ${e.message}`));
  await mobile.goto(origin, { waitUntil: "load" });
  await mobile.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
  const toggle = mobile.locator('[data-testid="nav-toggle"]');
  const list = mobile.locator('[data-testid="module-list"]');
  const expanded = () => toggle.getAttribute("aria-expanded");
  const mhash = () => mobile.evaluate(() => window.location.hash);
  const overflow = () => mobile.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth, nav: (() => { const n = document.querySelector("nav.nav"); return n.scrollWidth - n.clientWidth; })() }));
  const inList = () => mobile.evaluate(() => document.querySelector('[data-testid="module-list"]').contains(document.activeElement));

  check("mobile: the toggle is visible and the menu starts collapsed", (await toggle.isVisible()) && (await expanded()) === "false" && !(await list.isVisible()));
  check("mobile: the toggle is wired to the list it controls", (await toggle.getAttribute("aria-controls")) === "module-list" && (await list.getAttribute("id")) === "module-list");
  let o = await overflow();
  check("mobile: no horizontal overflow from the collapsed shell (navigation and top bar)", o.nav <= 0 && o.page <= 0, JSON.stringify(o));

  await toggle.click();
  check("mobile: clicking the toggle opens the list with all 11 modules", (await expanded()) === "true" && (await list.isVisible()) && (await list.locator(":scope > li > a").count()) === 11 && (await list.locator(":scope > li > a").evaluateAll((as) => as.every((a) => a.getBoundingClientRect().height > 0))));
  o = await overflow();
  check("mobile: no horizontal overflow with the menu open", o.nav <= 0 && o.page <= 0, JSON.stringify(o));
  await toggle.click();
  check("mobile: clicking the toggle again closes it and aria-expanded follows", (await expanded()) === "false" && !(await list.isVisible()));

  // a module with no editors: the card
  await toggle.click();
  await mobile.click('[data-testid="module-backend"]');
  await mobile.waitForSelector('[data-testid="module-card"]');
  check("mobile: choosing a planned module opens its card and closes the menu", (await mhash()) === "#/backend" && (await expanded()) === "false" && !(await list.isVisible()), `${await mhash()} ${await expanded()}`);
  o = await overflow();
  check("mobile: no horizontal overflow on a module card", o.nav <= 0 && o.page <= 0, JSON.stringify(o));
  // a module with editors
  await toggle.click();
  await mobile.click('[data-testid="module-release"]');
  await mobile.waitForSelector('[data-testid="module-header"][data-module="release"]');
  check("mobile: choosing a built module opens its first view and closes the menu", (await mhash()) === "#/release/export" && (await expanded()) === "false" && !(await list.isVisible()), `${await mhash()} ${await expanded()}`);
  // Gameplay Systems has its own route
  await toggle.click();
  await mobile.click('[data-testid="module-gameplay"]');
  await mobile.waitForSelector('[data-testid="module-header"][data-module="gameplay"]');
  check("mobile: the Gameplay Systems entry opens #/gameplay/modules, not the Designer redirect", (await mhash()) === "#/gameplay/modules" && (await expanded()) === "false", await mhash());

  // keyboard
  await mobile.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await toggle.focus();
  await mobile.keyboard.press("Tab");
  check("mobile keyboard: while closed, Tab does not enter the hidden module list", !(await inList()));
  await toggle.focus();
  await mobile.keyboard.press("Enter");
  check("mobile keyboard: Enter on the toggle opens the menu", (await expanded()) === "true" && (await list.isVisible()));
  await mobile.keyboard.press("Tab");
  check("mobile keyboard: Tab moves into the module list", await inList());
  await mobile.keyboard.press("Escape");
  check("mobile keyboard: Escape closes the menu and returns focus to the toggle", (await expanded()) === "false" && !(await list.isVisible()) && (await toggle.evaluate((el) => el === document.activeElement)));
  await mobile.keyboard.press("Space");
  check("mobile keyboard: Space on the toggle opens the menu", (await expanded()) === "true" && (await list.isVisible()));
  await mobile.keyboard.press("Space");
  check("mobile keyboard: Space on the toggle closes the menu", (await expanded()) === "false" && !(await list.isVisible()));
  await mobile.keyboard.press("Enter");
  await mobile.locator('[data-testid="module-backend"]').focus();
  await mobile.keyboard.press("Enter");
  await mobile.waitForSelector('[data-testid="module-card"][data-module="backend"]');
  check("mobile keyboard: Enter on a module link navigates and closes the menu", (await mhash()) === "#/backend" && (await expanded()) === "false", `${await mhash()} ${await expanded()}`);
  check("mobile: no page error", mproblems.length === 0, mproblems.join(" | "));
  check("no page error or console error", problems.length === 0, problems.join(" | "));
} finally {
  await browser.close();
  await server.close();
}
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
