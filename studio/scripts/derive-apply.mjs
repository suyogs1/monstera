// Browser proof for the level apply path (task 4.2), through the real Pyodide worker. Serves dist/ with `vite preview`
// (run `npm run build` first). Env: SMOKE_CHANNEL (e.g. "chrome") like scripts/smoke.mjs. Exit code 1 on any failed check.
//   1. a valid level is compiled, engine-validated, oracle-checked in the worker and committed (one undo step)
//   2. a candidate the engine rejects leaves the spec and every manifest unchanged, with the issue on the level field
//   3. the apply-path oracle does not touch the live Preview session or its trace
//   4. Designer controls for the derived pointers are disabled only while the owning derivation is on
// Nothing here is mocked: validation and the oracle run in the engine worker. Writes no evidence files.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { preview } from "vite";
import { resetStudioStorage } from "./storage.mjs";
const studio = join(dirname(fileURLToPath(import.meta.url)), "..");
const levelsText = readFileSync(join(studio, "src", "project", "manifests", "fixtures", "levels.valid.json"), "utf8")
  .replaceAll('"lantern"', '"star"').replaceAll('"keeper"', '"player"').replaceAll('"wisp"', '"bat"');
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
  await resetStudioStorage(page);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
  await page.evaluate(() => window.session.loadTemplate("pumpkin-blaster"));
  const settled = () => page.waitForFunction(() => { const s = window.session.store.getState(); return s.validation !== null && s.validatedRevision === s.revision; }, null, { timeout: 30000 });
  await settled();
  const state = () => page.evaluate(() => JSON.stringify({ doc: window.session.store.getState().doc, manifests: window.session.project.getState().manifests }));
  const commit = (name, value) => page.evaluate(([n, v]) => window.session.project.actions.commitManifest(n, v), [name, value]);
  const derivation = (levels, gameplay) => page.evaluate(([l, g]) => {
    const p = window.session.project.getState().manifests.project;
    return window.session.project.actions.commitManifest("project", { ...p, derivation: { levels: l, gameplay: g, activeLevel: l ? "level-1" : "" } });
  }, [levels, gameplay]);
  // ---- 1. valid level
  const levels = JSON.parse(levelsText);
  check("the levels manifest commits", (await commit("levels", levels)).ok);
  check("derivation switches on for levels", (await derivation(true, false)).ok);
  const before = await state();
  const applied = await page.evaluate(() => window.session.applyActiveLevel().then((r) => ({
    ok: r.ok, stage: r.stage, issues: r.issues, oracle: r.oracle, spawners: r.ok ? r.diff.spawners.after.length : null,
  })));
  check("a valid level is applied", applied.ok, JSON.stringify(applied.issues));
  check("the worker oracle ran the bounded tick count", applied.oracle?.ticks >= 600 && /^[0-9a-f]{16}$/.test(applied.oracle?.hash ?? ""), JSON.stringify(applied.oracle));
  await settled();
  const spawnersNow = await page.evaluate(() => window.session.store.getState().doc.game.runtime.spawners.length);
  check("the derived spawners are in the spec", spawnersNow === applied.spawners && spawnersNow === levels.levels[0].waves.length + levels.levels[0].difficulty.length, String(spawnersNow));
  const inputs = await page.evaluate(() => window.session.project.getState().manifests.project.derived.inputsSha256);
  check("the inputs hash is recorded", /^[0-9a-f]{64}$/.test(inputs));
  const afterApply = await state();
  check("the spec changed", afterApply !== before);
  check("one undo restores spec and manifests", (await page.evaluate(() => window.session.project.actions.undo())) && (await state()) === before);
  // ---- 2. rejected candidate
  const bad = JSON.parse(levelsText);
  bad.levels[0].waves[0].xMin = -2147483648;
  bad.levels[0].waves[0].xMax = 2147483647;
  check("a manifest-valid but engine-invalid level commits as a manifest", (await commit("levels", bad)).ok);
  const beforeBad = await state();
  const rejected = await page.evaluate(() => window.session.applyActiveLevel());
  check("the engine rejects it", rejected.ok === false && rejected.stage === "engine", JSON.stringify(rejected));
  check("the issue points at the level field", JSON.stringify(rejected.issues?.[0]?.path) === JSON.stringify(["levels", 0, "waves", 0, "xMax"]) && rejected.issues?.[0]?.source === "levels", JSON.stringify(rejected.issues));
  check("spec and manifests are unchanged", (await state()) === beforeBad);
  check("the original level commits again", (await commit("levels", levels)).ok);
  // ---- 3. live preview isolation
  const iso = await page.evaluate(async () => {
    const e = window.engine;
    const text = window.session.store.getState().validation.canonicalText;
    const start = await e.previewStart(text, 4242);
    for (let i = 0; i < 5; i++) await e.previewFrame(start.session, 16666667, []);
    const traceBefore = JSON.stringify(await e.previewTrace());
    const r = await window.session.applyActiveLevel();
    const traceAfter = JSON.stringify(await e.previewTrace());
    const frame = await e.previewFrame(start.session, 16666667, []);
    const traceFinal = await e.previewTrace();
    return { applied: r.ok, same: traceBefore === traceAfter, frameOk: frame.ok, session: start.session, traceSession: traceFinal?.session, frames: traceFinal?.frames.length };
  });
  check("applying a level while a preview runs succeeds", iso.applied);
  check("the live preview trace is untouched by the oracle", iso.same);
  check("the live preview session still steps and keeps its trace", iso.frameOk && iso.traceSession === iso.session && iso.frames === 6, JSON.stringify(iso));
  await page.evaluate(() => window.session.project.actions.undo());
  // ---- 4. locks in the Designer
  const go = async (hash) => { await page.evaluate((h) => { window.location.hash = h; }, hash); await page.waitForTimeout(150); };
  const probe = (prefix, addText) => page.evaluate(([p, t]) => {
    const fields = [...document.querySelectorAll(`input[data-path^="${p}"], select[data-path^="${p}"], textarea[data-path^="${p}"]`)];
    const buttons = [...document.querySelectorAll("button")].filter((b) => b.textContent.includes(t));
    return { fields: fields.length, fieldsDisabled: fields.filter((f) => f.matches(":disabled")).length, buttons: buttons.length, buttonsDisabled: buttons.filter((b) => b.disabled).length };
  }, [prefix, addText]);
  const expectLock = (name, p, locked) => {
    const ok = p.fields > 0 && p.buttons > 0 && (locked ? p.fieldsDisabled === p.fields && p.buttonsDisabled === p.buttons : p.fieldsDisabled === 0 && p.buttonsDisabled === 0);
    check(`${name} ${locked ? "disabled" : "enabled"}`, ok, JSON.stringify(p));
  };
  const SECTIONS = [["spawns", "$.game.runtime.spawners", "Add spawner", "levels"], ["entities", "$.game.runtime.initialEntities", "Add starting entity", "levels"], ["rules", "$.game.runtime.collisions", "Add rule", "gameplay"]];
  const passes = [["derivation off", false, false], ["levels derivation on", true, false], ["gameplay derivation on", false, true]];
  for (const [label, lv, gp] of passes) {
    check(`switch: ${label}`, (await derivation(lv, gp)).ok);
    for (const [slug, prefix, add, owner] of SECTIONS) {
      await go(`/designer/${slug}`);
      const locked = owner === "levels" ? lv : gp;
      expectLock(`${label}: ${slug} controls`, await probe(prefix, add), locked);
    }
    await go("/designer/entities");
    const kinds = await probe("$.game.runtime.kinds", "Add kind");
    check(`${label}: kind fields stay enabled`, kinds.fields > 0 && kinds.fieldsDisabled === 0, JSON.stringify(kinds));
  }
  check("no page or console errors", problems.length === 0, problems.join(" | "));
} finally {
  await browser.close();
  await server.close();
}
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
