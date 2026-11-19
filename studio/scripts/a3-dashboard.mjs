// A3 first half (task 1.3): create a project from a template on the Dashboard, edit it in the Designer, let it save,
// reload the page and find the identical project; then rename, duplicate, open and delete from the Dashboard with the real
// controls, the real engine worker and the real IndexedDB. Serves dist/ with `vite preview` (run `npm run build` first).
// Env: SMOKE_CHANNEL (e.g. "chrome"). Exit code 1 on any failed check. Writes nothing under docs/evidence/.
// The second half of A3 (export bundle, import bundle) belongs to task 1.5.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { preview } from "vite";
import { resetStudioStorage, storedProjects, waitSaved } from "./storage.mjs";
const studio = join(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `: ${detail}`}`); };
const server = await preview({ root: studio, preview: { port: 0, host: "127.0.0.1", open: false } });
const origin = server.resolvedUrls.local[0];
const browser = await chromium.launch(process.env.SMOKE_CHANNEL ? { channel: process.env.SMOKE_CHANNEL } : {});
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console.error: ${m.text()}`); });
  const dialogs = [];
  page.on("dialog", (d) => { if (d.type() === "confirm") { dialogs.push(d.message()); void d.accept(); } });
  await page.goto(origin, { waitUntil: "load" });
  await resetStudioStorage(page);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
  const settled = () => page.waitForFunction(() => {
    const s = window.session.store.getState(), p = window.session.project.getState();
    return s.validation !== null && s.validatedRevision === s.revision && !p.dirty && p.status === "saved";
  }, null, { timeout: 30000 });
  await settled();
  const go = async (hash) => { await page.evaluate((h) => { window.location.hash = h; }, hash); await page.waitForTimeout(100); };
  const rows = () => page.locator('[data-testid="project-list"] > ul > li');
  const key = () => page.evaluate(() => window.session.project.getState().projectKey);

  await go("/dashboard");
  await page.waitForSelector('[data-testid="project-list"]', { timeout: 15000 });
  check("the Dashboard opens at #/dashboard/projects and its header shows the registry status", (await page.evaluate(() => window.location.hash)) === "#/dashboard/projects"
    && (await page.locator('[data-testid="module-header"][data-module="dashboard"]').count()) === 1);
  check("it says the projects exist only in this browser", (await page.textContent('[data-testid="browser-only"]')).includes("only in this browser"));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="project-list"] > ul > li').length === 1, null, { timeout: 15000 });
  const first = await key();
  check("the first project is listed and marked open", (await page.locator(`[data-testid="project-${first}"]`).getAttribute("data-open")) === "true");

  // ---- create from a template through the real control
  await page.click('[data-testid="create-from-template"]');
  await page.waitForFunction((k) => window.session.project.getState().projectKey !== k, first, { timeout: 30000 });
  await settled();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="project-list"] > ul > li').length === 2, null, { timeout: 15000 });
  const second = await key();
  check("creating from a template adds a project and opens it; the first one is still listed", (await rows().count()) === 2 && second !== first
    && (await page.locator(`[data-testid="project-${first}"]`).getAttribute("data-open")) === "false");

  // ---- edit in the Designer, save, reload
  await go("/designer/overview");
  const name = page.locator('[data-path="$.project.displayName"]');
  await name.waitFor({ timeout: 15000 });
  await name.fill("A3 Dashboard Game");
  await page.keyboard.press("Tab");
  await settled();
  await waitSaved(page);
  const before = await page.evaluate(() => ({ doc: JSON.stringify(window.session.store.getState().doc), manifests: JSON.stringify(window.session.project.getState().manifests), key: window.session.project.getState().projectKey }));
  check("the edit is in the stored record of the open project", (await storedProjects(page)).find((r) => r.projectKey === second)?.specText.includes("A3 Dashboard Game") === true);
  await page.reload();
  await page.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
  await settled();
  const after = await page.evaluate(() => ({ doc: JSON.stringify(window.session.store.getState().doc), manifests: JSON.stringify(window.session.project.getState().manifests), key: window.session.project.getState().projectKey }));
  check("after a reload the identical project is open (same key, same spec, same manifests)", before.key === after.key && before.doc === after.doc && before.manifests === after.manifests);

  // ---- Dashboard: status cards, rename, duplicate, open, delete
  await go("/dashboard/status");
  await page.waitForSelector('[data-testid="status-cards"]', { timeout: 15000 });
  const hashCard = await page.textContent('[data-testid="status-hash-value"]');
  const topHash = await page.textContent('[data-testid="topbar-hash"]');
  check("the status cards read the same hash as the top bar", /^[0-9a-f]{64}$/.test(hashCard ?? "") && (hashCard ?? "").startsWith(topHash ?? "?"), `${hashCard} ${topHash}`);
  check("validation, determinism, evidence, studio data and storage cards are present",
    (await page.locator('[data-testid="status-validation"], [data-testid="status-determinism"], [data-testid="status-evidence"], [data-testid="status-modules"], [data-testid="status-storage"]').count()) === 5);
  check("determinism says it was not run instead of claiming a result", (await page.textContent('[data-testid="status-determinism"]')).includes("Not run"));

  await go("/dashboard/projects");
  await page.waitForSelector(`[data-testid="project-${first}"]`, { timeout: 15000 });
  await page.fill(`[data-testid="project-name-${first}"]`, "First renamed");
  await page.click(`[data-testid="project-rename-${first}"]`);
  await page.waitForFunction((k) => document.querySelector(`[data-testid="project-${k}"] h3`)?.textContent?.startsWith("First renamed"), first, { timeout: 15000 });
  check("renaming a stored project changes its name in the list", (await storedProjects(page)).find((r) => r.projectKey === first)?.name === "First renamed");
  await page.fill(`[data-testid="project-name-${second}"]`, "Open renamed");
  await page.click(`[data-testid="project-rename-${second}"]`);
  await settled();
  check("renaming the open project is saved through the normal save", (await storedProjects(page)).find((r) => r.projectKey === second)?.name === "Open renamed");

  await page.click(`[data-testid="project-duplicate-${first}"]`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="project-list"] > ul > li').length === 3, null, { timeout: 15000 });
  const stored = await storedProjects(page);
  const copy = stored.find((r) => r.name === "First renamed copy");
  const orig = stored.find((r) => r.projectKey === first);
  check("duplicating adds a copy with the same specification and the same project id, and does not open it", copy !== undefined && copy.specText === orig.specText && copy.projectId === orig.projectId && (await key()) === second);

  await page.click(`[data-testid="project-open-${first}"]`);
  await page.waitForFunction((k) => window.session.project.getState().projectKey === k, first, { timeout: 30000 });
  await settled();
  check("opening a project makes it the open one, and the editors show it", (await page.locator(`[data-testid="project-${first}"]`).getAttribute("data-open")) === "true"
    && (await page.evaluate(() => window.session.store.getState().doc.project.displayName)) !== "A3 Dashboard Game");

  dialogs.length = 0;
  await page.click(`[data-testid="project-delete-${copy.projectKey}"]`);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="project-list"] > ul > li').length === 2, null, { timeout: 15000 });
  check("deleting asks first, names the project and what is lost, and removes only that project",
    dialogs.length === 1 && dialogs[0].includes("First renamed copy") && dialogs[0].includes("cannot be undone")
    && (await storedProjects(page)).every((r) => r.projectKey !== copy.projectKey) && (await storedProjects(page)).length === 2);

  dialogs.length = 0;
  await page.click(`[data-testid="project-delete-${first}"]`);
  await page.waitForFunction((k) => window.session.project.getState().projectKey !== k, first, { timeout: 30000 });
  await settled();
  check("deleting the open project opens another one first", dialogs.length === 1 && dialogs[0].includes("opens another project") && (await key()) === second && (await storedProjects(page)).length === 1);
  check("no page or console errors", problems.length === 0, problems.join(" | "));
} finally {
  await browser.close();
  await server.close();
}
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
