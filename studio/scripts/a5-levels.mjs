// A5 end to end (task 4.3): author two levels in Level Studio, apply the active one, check every level as its own
// variant through the real Pyodide worker, download the variants ZIP, and run the REAL `monstera validate` CLI on every
// exported file. Serves dist/ with `vite preview` (run `npm run build` first). Env: SMOKE_CHANNEL (e.g. "chrome").
// Exit code 1 on any failed check. Writes nothing under docs/evidence/.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { preview } from "vite";
import { resetStudioStorage } from "./storage.mjs";

const studio = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(studio, "..");
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `: ${detail}`}`); };
const PYTHONS = [["python3"], ["python"], ["py", "-3"]];
function python(args) {
  for (const [cmd, ...pre] of PYTHONS) {
    const probe = spawnSync(cmd, [...pre, "--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) continue; // e.g. the Windows Store "python" alias
    return spawnSync(cmd, [...pre, ...args], { encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" } });
  }
  throw new Error("no python interpreter found");
}
const server = await preview({ root: studio, preview: { port: 0, host: "127.0.0.1", open: false } });
const origin = server.resolvedUrls.local[0];
const browser = await chromium.launch(process.env.SMOKE_CHANNEL ? { channel: process.env.SMOKE_CHANNEL } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console.error: ${m.text()}`); });
  await page.goto(origin, { waitUntil: "load" });
  await resetStudioStorage(page);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
  await page.evaluate(() => window.session.loadTemplate("pumpkin-blaster"));
  const settled = () => page.waitForFunction(() => { const s = window.session.store.getState(); return s.validation !== null && s.validatedRevision === s.revision; }, null, { timeout: 30000 });
  await settled();
  const docText = () => page.evaluate(() => JSON.stringify(window.session.store.getState().doc));
  const manifests = () => page.evaluate(() => window.session.project.getState().manifests);
  const rt = await page.evaluate(() => window.session.store.getState().doc.game.runtime);
  const player = rt.initialEntities.find((e) => e.controlled) ?? rt.initialEntities[0];
  const U = 65536;
  const unit = (raw) => String(raw / U);
  const baseDoc = await docText();

  await page.evaluate(() => { window.location.hash = "#/levels/editor"; });
  await page.waitForSelector('[data-testid="level-studio"]', { timeout: 15000 });
  check("Level Studio opens at its own route and says only the active level compiles", (await page.textContent('[data-testid="level-banner"]')).includes("active level"));
  check("unsupported capabilities are listed with reasons and have no controls",
    (await page.locator('[data-testid="unsupported-list"] li').count()) >= 5 && (await page.locator('[data-testid="unsupported-list"] input, [data-testid="unsupported-list"] button, [data-testid="unsupported-list"] select').count()) === 0);
  check("the page has editing, active/apply and variants as separate regions", (await page.locator('[data-testid="region-edit"], [data-testid="region-active"], [data-testid="region-variants"]').count()) === 3);

  // ---- author two levels through the real controls
  const addLevel = async (name) => { await page.fill('[data-testid="level-new-name"]', name); await page.click('[data-testid="level-add"]'); };
  const ed = (sel) => page.locator(`[data-testid="level-editor"] ${sel}`);
  await addLevel("Dusk");
  await page.waitForSelector('[data-testid="level-row-dusk"]');
  await page.click('[data-testid="placement-add"]');
  await ed('select[aria-label="placement kind"]').selectOption("player");
  await ed('input[aria-label="placement x"]').fill(unit(player.x));
  await ed('input[aria-label="placement y"]').fill(unit(player.y));
  await ed('input[aria-label="placement controlled"]').check();
  await page.click('[data-testid="wave-add"]');
  await ed('select[aria-label="wave kind"]').selectOption("bat");
  await ed('input[aria-label="wave start tick"]').fill("30");
  await ed('input[aria-label="wave interval ticks"]').fill("90");
  // the same right-edge spawn the Pumpkin Blaster bats use (units: x 1880, y 40 to 990, moving left)
  // maxima first: the manifest refuses a minimum above the current maximum, one field at a time
  await ed('input[aria-label="wave x max"]').fill("1880");
  await ed('input[aria-label="wave x min"]').fill("1880");
  await ed('input[aria-label="wave y max"]').fill("990");
  await ed('input[aria-label="wave y min"]').fill("40");
  await ed('input[aria-label="wave vx"]').fill("-9");
  await page.click('[data-testid="step-add"]');
  await ed('input[aria-label="step at tick"]').fill("600");
  let ms = await manifests();
  const dusk = ms.levels.levels.find((l) => l.id === "dusk");
  check("Dusk holds the authored placement, wave and difficulty step", dusk?.placements.length === 1 && dusk.placements[0].kind === "player" && dusk.placements[0].controlled === true
    && dusk.waves.length === 1 && dusk.waves[0].startTick === 30 && dusk.waves[0].intervalTicks === 90 && dusk.waves[0].yMin === 40 * U && dusk.difficulty.length === 1 && dusk.difficulty[0].atTick === 600, JSON.stringify(dusk));
  check("the world preview and timeline render for the editing level", (await page.locator('[data-testid="level-canvas"]').getAttribute("data-spawners")) === "2"
    && (await page.locator('[data-testid="level-timeline"] g[data-kind]').count()) === 2 && (await page.locator('[data-testid="tl-row-1"]').getAttribute("data-start")) === "600");

  await addLevel("Midnight");
  await page.waitForSelector('[data-testid="level-row-midnight"]');
  await page.click('[data-testid="wave-add"]');
  await ed('select[aria-label="wave kind"]').selectOption("bat");
  await ed('input[aria-label="wave interval ticks"]').fill("60");
  await ed('input[aria-label="wave x max"]').fill("1880");
  await ed('input[aria-label="wave x min"]').fill("1880");
  await ed('input[aria-label="wave y max"]').fill("900");
  await ed('input[aria-label="wave y min"]').fill("100");
  await ed('input[aria-label="wave vx"]').fill("-12");
  check("editing and adding levels never changed the spec", (await docText()) === baseDoc);

  // ---- list management: duplicate, reorder, delete
  await page.click('[data-testid="level-duplicate-dusk"]');
  await page.waitForSelector('[data-testid="level-row-dusk-copy"]');
  const order = () => page.$$eval('[data-testid="levels-list"] li[data-testid^="level-row-"]', (els) => els.map((e) => e.getAttribute("data-testid").slice("level-row-".length)));
  check("duplicate lands right after its source with a fresh id", JSON.stringify(await order()) === JSON.stringify(["dusk", "dusk-copy", "midnight"]), JSON.stringify(await order()));
  await page.click('[data-testid="level-up-midnight"]');
  check("move up reorders", JSON.stringify(await order()) === JSON.stringify(["dusk", "midnight", "dusk-copy"]), JSON.stringify(await order()));
  await page.click('[data-testid="level-delete-dusk-copy"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="level-row-dusk-copy"]'));
  check("delete removes an unreferenced level", JSON.stringify(await order()) === JSON.stringify(["dusk", "midnight"]));
  check("every list edit is one undo step: undo brings the copy back, redo removes it", await page.evaluate(() => {
    const a = window.session.project.actions;
    const ids = () => window.session.project.getState().manifests.levels.levels.map((l) => l.id).join(",");
    const before = ids(); a.undo(); const undone = ids(); a.redo(); return undone === "dusk,midnight,dusk-copy" && ids() === before;
  }));

  // ---- active level, apply
  await page.click('[data-testid="derivation-toggle"]');
  await page.waitForFunction(() => window.session.project.getState().manifests.project.derivation.levels === true);
  check("the first level becomes active when derivation is turned on", (await manifests()).project.derivation.activeLevel === "dusk");
  await page.click('[data-testid="level-delete-dusk"]');
  const blocked = await page.textContent('[data-testid="level-notice"]');
  check("deleting the active level is blocked with the reference named", blocked.includes("project: active level") && (await order()).includes("dusk"), blocked);
  check("turning derivation on did not change the spec", (await docText()) === baseDoc);
  await page.click('[data-testid="level-edit-midnight"]');
  await ed('input[aria-label="wave interval ticks"]').fill("75");
  check("editing a non-active level leaves the spec byte-identical", (await docText()) === baseDoc && (await page.locator('[data-testid="edit-not-active"]').count()) === 1);
  const before = JSON.stringify({ doc: await docText(), m: await manifests() });
  await page.click('[data-testid="apply-active"]');
  await page.waitForSelector('[data-testid="apply-result"]', { timeout: 60000 });
  check("Apply compiles the active level through the 4.2 path", (await page.getAttribute('[data-testid="apply-result"]', "data-ok")) === "true", await page.textContent('[data-testid="apply-result"]'));
  await settled();
  check("the spec now holds the active level's spawners (waves + steps)", await page.evaluate(() => window.session.store.getState().doc.game.runtime.spawners.length) === 2);
  check("one undo restores spec and manifests", await page.evaluate(() => window.session.project.actions.undo()) && JSON.stringify({ doc: await docText(), m: await manifests() }) === before);
  await settled();
  // a candidate the engine rejects must leave everything unchanged
  await page.evaluate(() => {
    const lv = structuredClone(window.session.project.getState().manifests.levels);
    const w = lv.levels.find((l) => l.id === "dusk").waves[0];
    w.yMin = -2147483648; w.yMax = 2147483647;
    return window.session.project.actions.setLevels(lv, "a5-bad");
  });
  const beforeBad = JSON.stringify({ doc: await docText(), m: await manifests() });
  await page.click('[data-testid="apply-active"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="apply-result"]')?.getAttribute("data-ok") === "false", null, { timeout: 60000 });
  check("an engine-rejected level is refused and nothing changes", JSON.stringify({ doc: await docText(), m: await manifests() }) === beforeBad
    && (await page.textContent('[data-testid="apply-result"]')).includes("levels.0.waves.0"), await page.textContent('[data-testid="apply-result"]'));
  await page.evaluate(() => window.session.project.actions.undo());
  check("the bad edit is undone", (await manifests()).levels.levels[0].waves[0].yMin === 40 * U);

  // ---- variants
  const specBeforeVariants = await docText();
  await page.click('[data-testid="variants-check"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="variants-table"] tbody tr').length === 2, null, { timeout: 120000 });
  const rows = () => page.$$eval('[data-testid="variants-table"] tbody tr', (trs) => trs.map((tr) => ({ id: tr.getAttribute("data-testid"), status: tr.getAttribute("data-status"), text: tr.textContent })));
  const first = await rows();
  check("both levels are valid and deterministic variants", first.length === 2 && first.every((r) => r.status === "valid" && r.text.includes("yes")), JSON.stringify(first));
  check("checking variants never changed the spec", (await docText()) === specBeforeVariants);
  await page.click('[data-testid="variants-check"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="variants-table"] tbody tr').length === 2 && !document.querySelector('[data-testid="variants-progress"]'), null, { timeout: 120000 });
  check("a second check gives the same hashes", JSON.stringify(await rows()) === JSON.stringify(first));

  const dir = mkdtempSync(join(tmpdir(), "a5-levels-"));
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.click('[data-testid="variants-download"]')]);
  const zipPath = join(dir, "variants.zip");
  await download.saveAs(zipPath);
  const ids = ["dusk", "midnight"];
  const idsPath = join(dir, "ids.json");
  writeFileSync(idsPath, JSON.stringify(ids));
  const outPath = join(dir, "validate.json");
  const extracted = join(dir, "extracted");
  const py = python([join(studio, "scripts", "validate-exported-levels.py"), zipPath, idsPath, outPath, extracted]);
  process.stdout.write(py.stdout ?? "");
  check("the archive holds exactly studio-pack/derived/levels/<id>/monstera.spec.json and the real monstera validate accepts every file", py.status === 0, `${py.stdout}${py.stderr}`);
  // The shell wrapper too, where bash exists (Linux CI, Git Bash).
  const bash = ["bash", "C:\\Program Files\\Git\\bin\\bash.exe"].find((b) => { const p = spawnSync(b, ["--version"], { encoding: "utf8" }); return !p.error && p.status === 0; });
  const posix = (p) => p.replace(/\\/g, "/");
  if (bash) {
    for (const id of ids) {
      const f = join(extracted, "studio-pack", "derived", "levels", id, "monstera.spec.json");
      const r = spawnSync(bash, [posix(join(repo, "tools", "monstera", "bin", "monstera")), "validate", posix(f)], { encoding: "utf8", cwd: repo });
      check(`tools/monstera/bin/monstera validate accepts ${id}`, r.status === 0, `${r.stdout}${r.stderr}`);
    }
  } else console.log("SKIP  bash is not available; the CLI was run through python (above)");
  check("the exported files are the engine's canonical text of the checked variants", ids.every((id) => {
    const file = join(extracted, "studio-pack", "derived", "levels", id, "monstera.spec.json");
    if (!existsSync(file)) return false;
    const t = readFileSync(file, "utf8");
    return t.endsWith("\n") && JSON.parse(t).game.runtime.spawners.length >= 1;
  }));
  check("no page or console errors", problems.length === 0, problems.join(" | "));
} finally {
  await browser.close();
  await server.close();
}
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
