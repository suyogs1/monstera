// Studio M2 batch 2 acceptance: the determinism badge in a real browser (Chrome via Playwright) against dist/.
// Every expected outcome comes from host CPython (m2-badge-reference.py) running the same draft text against the same
// recorded goldens with Python equality. Run `npm run build` first. Writes docs/evidence/studio-m2/badge.json.
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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm" };
const TEMPLATES = [
  { id: "pumpkin-blaster", path: "apps/pumpkin-blaster/monstera.spec.json" },
  { id: "trick-or-treat-rush", path: "apps/trick-or-treat-rush/monstera.spec.json" },
  { id: "lantern-run", path: "spec/samples/lantern-run/monstera.spec.json" },
];
const TERMINAL = ["match", "diverged", "error", "invalid", "no-goldens"];
if (!existsSync(join(dist, "index.html"))) throw new Error("dist/ is missing: run `npm run build` first");

// ------------------------------------------------------------------ drafts (edits on the committed template JSON)
const committed = Object.fromEntries(TEMPLATES.map((t) => [t.id, JSON.parse(
  execFileSync("git", ["show", `HEAD:${t.path}`], { cwd: repo, maxBuffer: 1 << 24 }).toString("utf8"))]));
const edited = (id, fn) => { const d = structuredClone(committed[id]); fn(d); return d; };
const pick = (current, ...options) => options.find((o) => o !== current);
const EFFECTS = { none: "burst", burst: "pickup", pickup: "none" };

// Every display-only pattern of the frozen spec v4 table (src/badge/classify.ts DISPLAY_ONLY_PATTERNS), every instance.
const DISPLAY_EDITS = {
  "project.displayName": (d) => { d.project.displayName = pick(d.project.displayName, "Renamed Game", "Other Game"); },
  "game.palette.primary": (d) => { d.game.palette.primary = pick(d.game.palette.primary, "#FFFFFF", "#FFFFF0"); },
  "game.palette.accent": (d) => { d.game.palette.accent = pick(d.game.palette.accent, "#FFFF00", "#FFFF66"); },
  "game.palette.background": (d) => { d.game.palette.background = pick(d.game.palette.background, "#000000", "#050505"); },
  "game.hud.lifeGlyph": (d) => { d.game.hud.lifeGlyph = pick(d.game.hud.lifeGlyph, "\u2605", "\u2665"); },
  "game.hud.scoreLabel": (d) => { d.game.hud.scoreLabel = pick(d.game.hud.scoreLabel, "POINTS", "pts"); },
  "game.screens.startHint": (d) => { d.game.screens.startHint = pick(d.game.screens.startHint, "Other hint", "Go"); },
  "game.screens.winTitle": (d) => { d.game.screens.winTitle = pick(d.game.screens.winTitle, "Other win", "Won"); },
  "game.screens.loseTitle": (d) => { d.game.screens.loseTitle = pick(d.game.screens.loseTitle, "Other lose", "Lost"); },
  "game.runtime.kinds[].color": (d) => { for (const k of d.game.runtime.kinds) k.color = pick(k.color, "#FFFFF0", "#FFFFFE"); },
  "game.runtime.kinds[].glyph": (d) => { for (const k of d.game.runtime.kinds) k.glyph = pick(k.glyph, "\u2605", "\u2665"); },
  "game.runtime.kinds[].effect": (d) => { for (const k of d.game.runtime.kinds) k.effect = EFFECTS[k.effect]; },
};
const BEHAVIOUR_EDITS = {
  "pumpkin-blaster": ["spawners[0].intervalTicks 60 -> 50", (d) => { d.game.runtime.spawners[0].intervalTicks = 50; }],
  "trick-or-treat-rush": ["spawners[0].intervalTicks halved", (d) => { d.game.runtime.spawners[0].intervalTicks = Math.max(1, d.game.runtime.spawners[0].intervalTicks >> 1); }],
  "lantern-run": ["runtime.lives + 1", (d) => { d.game.runtime.lives += 1; }],
};

const cases = [];
for (const t of TEMPLATES) {
  cases.push({ name: `${t.id}: unedited`, template: t.id, kind: "unedited", doc: committed[t.id] });
  cases.push({ name: `${t.id}: behaviour edit ${BEHAVIOUR_EDITS[t.id][0]}`, template: t.id, kind: "behaviour", doc: edited(t.id, BEHAVIOUR_EDITS[t.id][1]) });
  for (const [pattern, fn] of Object.entries(DISPLAY_EDITS)) {
    cases.push({ name: `${t.id}: display-only ${pattern}`, template: t.id, kind: "display", pattern, doc: edited(t.id, fn) });
  }
}

// ------------------------------------------------------------------ host reference
function pythonCommand() {
  for (const [cmd, args] of [["python3", []], ["python", []], ["py", ["-3"]]]) {
    try { execFileSync(cmd, [...args, "--version"], { stdio: "pipe" }); return [cmd, args]; } catch { /* next */ }
  }
  throw new Error("no Python 3 interpreter found for the host reference");
}
const [PY, PYARGS] = pythonCommand();
const scratch = mkdtempSync(join(tmpdir(), "studio-m2-badge-"));
writeFileSync(join(scratch, "cases.json"), JSON.stringify(cases.map((c) => ({ name: c.name, projectId: committed[c.template].project.id, text: JSON.stringify(c.doc) }))));
execFileSync(PY, [...PYARGS, join(here, "m2-badge-reference.py"), join(scratch, "cases.json"), join(scratch, "ref.json")],
  { cwd: repo, env: { ...process.env, PYTHONIOENCODING: "utf-8" }, stdio: "pipe", maxBuffer: 1 << 26 });
const host = Object.fromEntries(JSON.parse(readFileSync(join(scratch, "ref.json"), "utf8")).map((r) => [r.name, r]));

// ------------------------------------------------------------------ browser
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
const verdictKind = () => page.$eval('[data-testid="badge-verdict"]', (e) => e.dataset.verdict);
const open = async (id) => { await page.evaluate((h) => { window.location.hash = h; }, `/${id}`); await page.waitForSelector(`[data-testid="${id}"]`); };
const loadTemplate = async (id) => {
  // The picker asks before discarding an edited draft (covered by the M1 run); load through the function it calls.
  await page.evaluate((t) => window.session.loadTemplate(t), id);
  await page.waitForFunction((t) => window.session.store.getState().baseline?.templateId === t, id);
  await settled();
};
const runBadge = async () => {
  await page.evaluate(() => {
    window.__seen = [];
    const el = document.querySelector('[data-testid="badge-verdict"]');
    window.__obs?.disconnect();
    window.__obs = new MutationObserver(() => { window.__seen.push([el.dataset.verdict, !!document.querySelector("progress")]); });
    window.__obs.observe(el, { attributes: true, childList: true, subtree: true, characterData: true });
  });
  const t0 = Date.now();
  await page.click('[data-testid="badge-run"]');
  await page.waitForFunction((t) => t.includes(document.querySelector('[data-testid="badge-verdict"]')?.dataset.verdict), TERMINAL, { timeout: 120000 });
  return Date.now() - t0;
};
const state = () => page.evaluate(() => ({ run: window.session.badge.getState(), sha: window.session.store.getState().validation?.sha256 }));

await open("determinism");
check("the badge starts as not run (it never runs by itself)", (await verdictKind()) === "not-run");

const rows = [];
for (const c of cases) {
  await loadTemplate(c.template);
  if (c.kind !== "unedited") { await page.evaluate((d) => window.session.store.replace(d), c.doc); await settled(); }
  const ref = host[c.name];
  const shaNow = await page.evaluate(() => window.session.store.getState().validation?.sha256);
  if (!ref.valid || shaNow !== ref.sha256) { check(`${c.name}: draft is valid and its SHA-256 equals host CPython`, false, `host valid ${ref.valid}, ${ref.sha256} vs ${shaNow}`); continue; }
  const ms = await runBadge();
  const { run } = await state();
  const kind = await verdictKind();
  const why = await page.$eval('[data-testid="badge-explanation"]', (e) => e.dataset.explanation).catch(() => null);
  const hostDiverged = ref.scenarios.filter((s) => s.status === "diverged");
  const expectedKind = hostDiverged.length ? "diverged" : "match";
  const sameRows = run.results.length === ref.scenarios.length && run.results.every((r, i) => {
    const h = ref.scenarios[i];
    return r.file === h.file && r.status === h.status && r.draftSha256 === ref.sha256 &&
      (r.status === "match" || (r.divergentCheckpoints === h.divergentCheckpoints && r.firstDivergentTick === h.firstDivergentTick));
  });
  const seen = await page.evaluate(() => window.__seen);
  rows.push({ case: c.name, verdict: kind, scenarios: run.scenarios.length, diverged: hostDiverged.length,
    first: hostDiverged[0] ? `${hostDiverged[0].file.split("/").pop()} @ ${hostDiverged[0].firstDivergentTick}` : null,
    explanation: why, ms: Math.round(run.ms), wallMs: ms, sawRunning: seen.some(([v, p]) => v === "running" && p) });
  let explanationOk = true;
  if (c.kind === "display") explanationOk = why === "note";
  if (c.kind === "behaviour") explanationOk = expectedKind === "diverged" ? why === "expected" : why === "note";
  if (c.kind === "unedited") explanationOk = why === "note";
  check(`${c.name}: ${expectedKind.toUpperCase()} over all ${ref.scenarios.length} goldens, every scenario equal to host CPython`,
    kind === expectedKind && sameRows && run.sha256 === ref.sha256 && explanationOk && run.scenarios.length > 0,
    `${kind}; ${hostDiverged.length} diverged${hostDiverged[0] ? `, first ${hostDiverged[0].file.split("/").pop()} at tick ${hostDiverged[0].firstDivergentTick}` : ""}; explanation ${why}; ${Math.round(run.ms)} ms`);
  if (c.kind === "display") check(`${c.name}: the engine (host) agrees the display-only edit cannot diverge`, hostDiverged.length === 0);
}
check("every behaviour edit used here diverges (each template's badge demonstrably detects a change)",
  rows.filter((r) => r.case.includes("behaviour")).every((r) => r.verdict === "diverged"), rows.filter((r) => r.case.includes("behaviour")).map((r) => r.verdict).join(", "));
check("Lantern Run's 4 recorded goldens are included", rows.find((r) => r.case === "lantern-run: unedited")?.scenarios === 4);
check("progress is shown while a run is in progress", rows.filter((r) => r.case.endsWith("unedited")).every((r) => r.sawRunning), rows.map((r) => r.sawRunning).join(""));

// ---- the first divergence is shown with recorded and draft values
await loadTemplate("pumpkin-blaster");
await page.evaluate((d) => window.session.store.replace(d), cases.find((c) => c.name.startsWith("pumpkin-blaster: behaviour")).doc);
await settled();
await runBadge();
const firstText = await page.$eval('[data-testid="badge-first-divergence"] caption', (e) => e.textContent);
const hostFirst = host[cases.find((c) => c.name.startsWith("pumpkin-blaster: behaviour")).name].scenarios.find((s) => s.status === "diverged");
const firstIsFrames = (await state()).run.scenarios.find((s) => s.file === hostFirst.file).frameDriven;
check("the first divergent scenario and checkpoint are named (frames for a frame-driven scenario, ticks otherwise)",
  firstText.includes(hostFirst.file.split("/").pop().replace(".scenario.json", "")) && firstText.includes(`${firstIsFrames ? "frame" : "tick"} ${hostFirst.firstDivergentTick}`), firstText);

// ---- STALE immediately on an edit; the bound result returns only for the same SHA-256
await loadTemplate("pumpkin-blaster");
await runBadge();
const matchedSha = (await state()).run.sha256;
const lives = committed["pumpkin-blaster"].game.runtime.lives;
await page.evaluate(() => window.session.store.set(["game", "runtime", "lives"], 9));
await page.waitForFunction(() => true);
const immediate = await verdictKind();
const disabledWhilePending = await page.locator('[data-testid="badge-run"]').isDisabled();
await settled();
const afterValidation = await verdictKind();
check("an edit marks the result STALE immediately (before validation finishes) and after", immediate === "stale" && afterValidation === "stale", `${immediate} -> ${afterValidation}; run disabled while pending: ${disabledWhilePending}`);
await page.evaluate((v) => window.session.store.set(["game", "runtime", "lives"], v), lives);
await settled();
check("reverting to the exact SHA-256 shows the bound MATCH again (results are keyed by SHA-256)", (await verdictKind()) === "match" && (await state()).sha === matchedSha);

// ---- edit during a run: the run stops and is stale
await page.click('[data-testid="badge-run"]');
await page.waitForFunction(() => window.session.badge.getState()?.results.length >= 1, null, { timeout: 30000 });
await page.evaluate(() => window.session.store.set(["game", "runtime", "lives"], 8));
await page.waitForFunction(() => window.session.badge.getState()?.phase !== "running", null, { timeout: 30000 });
const mid = await state();
check("an edit during a run stops it between scenarios and the result is STALE", mid.run.phase === "cancelled" && (await verdictKind()) === "stale",
  `${mid.run.results.length}/${mid.run.scenarios.length} scenarios before the stop`);

// ---- invalid drafts and engine errors never produce MATCH
await page.evaluate(() => window.session.store.set(["game", "runtime", "lives"], 0));
await settled();
const before = JSON.stringify((await state()).run);
await page.evaluate(() => window.session.badge.start());
check("an invalid draft cannot be checked: the button is disabled, start() does nothing, the verdict is not MATCH",
  (await page.locator('[data-testid="badge-run"]').isDisabled()) && JSON.stringify((await state()).run) === before && (await verdictKind()) !== "match", await verdictKind());
const file0 = (await state()).run.scenarios[0].file;
const invalidText = JSON.stringify(edited("pumpkin-blaster", (d) => { d.game.runtime.lives = 0; }));
const g1 = await page.evaluate(([t, f]) => window.engine.badgeCheck(t, f), [invalidText, file0]);
const g2 = await page.evaluate(([f]) => window.engine.badgeCheck("{\"specVersion\": 4,", f), [file0]);
check("the engine glue reports an invalid or unparsable draft as invalid, with no comparison", g1.status === "invalid" && g2.status === "invalid" && !("checkpoints" in g1), `${g1.message} | ${g2.message}`);
const validText = JSON.stringify(committed["pumpkin-blaster"]);
const e1 = await page.evaluate((t) => window.engine.badgeCheck(t, "apps/pumpkin-blaster/monstera.spec.json"), validText);
const e2 = await page.evaluate((t) => window.engine.badgeCheck(t, "spec/scenarios/pumpkin-blaster/missing.scenario.json"), validText);
check("an engine exception (file outside the goldens, missing file) is an error, never a result", e1.status === "error" && e2.status === "error", `${e1.message} | ${e2.message}`);

// ---- origin of imported drafts: exact template only, or declared by the user; never chosen from project.id
const basis = () => page.$eval('[data-testid="badge-origin"]', (e) => e.dataset.basis);
const importDoc = async (doc, name) => { await page.evaluate(([t, n]) => window.session.importText(t, n), [JSON.stringify(doc), name]); await settled(); };
await importDoc(committed["pumpkin-blaster"], "copy-of-pumpkin.json");
await runBadge();
check("an imported file identical to a template (same canonical SHA-256) gets that template's goldens and MATCHes",
  (await basis()) === "identical" && (await verdictKind()) === "match" && (await state()).run.scenarios.length === 5);
const editedImport = edited("pumpkin-blaster", (d) => { d.game.runtime.lives = 7; });
await importDoc(editedImport, "edited-pumpkin.json");
await runBadge();
check("an edited import keeps project.id 'pumpkin-blaster' but has no known origin: NO GOLDENS, nothing chosen from project.id",
  (await basis()) === "none" && (await verdictKind()) === "no-goldens" && (await state()).run.scenarios.length === 0 && (await page.locator('[data-testid="origin-select"]').count()) === 1);
await page.selectOption('[data-testid="origin-select"]', "pumpkin-blaster");
await page.waitForFunction(() => window.session.store.getState().baseline?.origin?.basis === "declared");
check("declaring the origin makes the earlier NO GOLDENS result stale", (await verdictKind()) === "stale");
await runBadge();
const declared = await state();
const declaredWhy = await page.$eval('[data-testid="badge-explanation"]', (e) => e.dataset.explanation).catch(() => null);
check("a declared origin runs that template's goldens and is labelled as declared (the lives edit diverges, as expected)",
  (await basis()) === "declared" && (await verdictKind()) === "diverged" && declared.run.scenarios.length === 5 && declared.run.origin.basis === "declared" && declaredWhy === "expected",
  (await page.locator('[data-testid="badge-origin"]').innerText()).replace(/\s+/g, " ").slice(0, 140));
const orphan = edited("pumpkin-blaster", (d) => { d.project.id = "zz-no-goldens"; });
await importDoc(orphan, "orphan.json");
await runBadge();
check("an import of another project with no declared origin reports NO GOLDENS, not MATCH", (await verdictKind()) === "no-goldens");

// ---- screenshots of the panel for visual review
const shots = join(repo, "docs", "evidence", "studio-m2", "screens");
mkdirSync(shots, { recursive: true });
await loadTemplate("pumpkin-blaster");
await runBadge();
await page.locator("main").screenshot({ path: join(shots, "badge-match.png") });
await page.evaluate((d) => window.session.store.replace(d), cases.find((c) => c.name.startsWith("pumpkin-blaster: behaviour")).doc);
await settled();
await runBadge();
await page.locator("main").screenshot({ path: join(shots, "badge-diverged.png") });
await page.evaluate(() => window.session.store.set(["game", "runtime", "lives"], 9));
await page.locator("main").screenshot({ path: join(shots, "badge-stale.png") });
await settled();

// ---- native conformance: static, exact SHA-256 only
const reports = JSON.parse(readFileSync(join(studio, "src", "generated", "conformance.json"), "utf8")).reports;
for (const t of TEMPLATES) {
  await loadTemplate(t.id);
  const sha = (await state()).sha;
  const matched = await page.$eval('[data-testid="native-conformance"]', (e) => e.dataset.matched);
  const exact = reports.filter((r) => r.specSha256 === sha);
  const note = await page.$eval('[data-testid="native-conformance"]', (e) => e.textContent);
  check(`${t.id}: native conformance evidence is shown only for an exact SHA-256 match`, (matched === "yes") === (exact.length > 0) && (exact.length > 0 || note.includes("No committed native conformance report matches")),
    exact.length ? exact.map((r) => r.file).join(", ") : `no report for ${sha.slice(0, 12)}; ${reports.filter((r) => r.file.endsWith(`/${t.id}.report.json`)).map((r) => `${r.file} is for ${r.specSha256.slice(0, 12)}`).join("; ") || "none for this game"}`);
}
const pageText = await page.locator("main").innerText();
check("the badge is labelled 'oracle vs recorded goldens' and does not claim native or device results",
  pageText.includes("oracle vs recorded goldens") && !/device[- ]tested|native equivalent|runs on (android|ios)/i.test(pageText));

const external = requests.filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:"));
check("no request leaves the origin", external.length === 0, external.join(", ") || "all same-origin");
check("no console or page errors", errors.length === 0, errors.join(" | "));
const browserVersion = browser.version();
await browser.close();
server.close();
rmSync(scratch, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
const result = { verdict: failed.length ? "FAIL" : "PASS", browser: `Chrome ${browserVersion}`, cases: rows, checks };
mkdirSync(join(repo, "docs", "evidence", "studio-m2"), { recursive: true });
writeFileSync(join(repo, "docs", "evidence", "studio-m2", "badge.json"), JSON.stringify(result, null, 2) + "\n");
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
console.log(`\n${result.verdict}: ${checks.length - failed.length}/${checks.length} checks, Chrome ${browserVersion}`);
process.exit(failed.length ? 1 : 0);
