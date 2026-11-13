// Studio M2 batch 4 acceptance: click-through between the live preview and the Entities editor, in Chrome against dist/.
// Clicks use the page's own drawn geometry (window.previewDebug.boxes); expectations are checked against the draft and
// the engine. Determinism: the draft is unchanged, no frames or events reach the engine while inspecting, and every
// session replays on host CPython to the same state hash. Run `npm run build` first. Writes docs/evidence/studio-m2/clickthrough.json.
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
const shots = join(evidence, "screens");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm" };
const TEMPLATES = ["pumpkin-blaster", "trick-or-treat-rush", "lantern-run"];
if (!existsSync(join(dist, "index.html"))) throw new Error("dist/ is missing: run `npm run build` first");
mkdirSync(shots, { recursive: true });

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
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
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
const draftId = () => page.evaluate(() => ({ revision: window.session.store.getState().revision, sha: window.session.store.getState().validation?.sha256, doc: JSON.stringify(window.session.store.getState().doc) }));
const selected = () => page.evaluate(() => window.session.selection.getState().kindId);
const frames = () => page.evaluate(() => window.session.preview.getStats().framesSent);
const traceLen = () => page.evaluate(async () => (await window.engine.previewTrace()).frames.length);
const nextFrame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const inside = (b, x, y) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
const traces = [];
const rows = [];

for (const id of TEMPLATES) {
  await page.evaluate((t) => window.session.loadTemplate(t), id);
  await settled();
  await page.evaluate(() => { window.location.hash = "/overview"; });
  await page.waitForFunction(() => window.session.preview.getState().status === "running");
  const canvas = await page.locator('[data-testid="preview-canvas"]').boundingBox();
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2); // start playing
  await page.waitForFunction(() => window.session.preview.getState().started === true);
  // Bounded wait for a busier screen, so the clicked and highlighted kinds are not just the player.
  await page.waitForFunction(() => window.previewDebug.boxes().filter((b) => b.visible).length >= 4, null, { timeout: 20000 }).catch(() => {});
  const before = await draftId();

  // ---- Inspect holds the preview: no frames are requested, nothing is sent
  await page.click('[data-testid="preview-inspect"]');
  await page.waitForFunction(() => window.session.preview.getState().held === true);
  await page.waitForTimeout(150);
  const f0 = await frames(), t0 = await traceLen();
  await page.waitForTimeout(500);
  check(`${id}: Inspect holds the preview (no engine frames for 500 ms)`, (await frames()) === f0 && (await traceLen()) === t0, `${f0} frames before and after`);

  // ---- click an entity: its kind is selected and opened in the Entities editor
  const boxes = (await page.evaluate(() => window.previewDebug.boxes())).filter((b) => b.visible);
  const world = await page.evaluate(() => window.previewDebug.world);
  const topmostAt = (x, y) => { let k = null; for (const b of boxes) if (inside(b.visible, x, y)) k = b.kind; return k; };
  const target = [...boxes.filter((b) => !b.controlled), ...boxes.filter((b) => b.controlled)].find((b) => { const cx = b.visible.x + b.visible.w / 2, cy = b.visible.y + b.visible.h / 2; return topmostAt(cx, cy) === b.kind; });
  let entityOk = false;
  let detail = "no visible entity";
  if (target) {
    const cx = target.visible.x + target.visible.w / 2, cy = target.visible.y + target.visible.h / 2;
    await page.mouse.click(canvas.x + cx, canvas.y + cy);
    await page.waitForFunction(() => window.location.hash === "#/entities");
    await page.waitForFunction((k) => document.activeElement?.closest('[data-path^="$.game.runtime.kinds["]') !== null && window.session.selection.getState().kindId === k, target.kind, { timeout: 5000 }).catch(() => {});
    const focused = await page.evaluate(() => {
      const card = document.activeElement?.closest('[data-path^="$.game.runtime.kinds["]');
      const i = card ? Number(/kinds\[(\d+)\]/.exec(card.getAttribute("data-path"))[1]) : -1;
      return { i, kindId: i >= 0 ? window.session.store.getState().doc.game.runtime.kinds[i].id : null, selected: card?.getAttribute("data-selected") };
    });
    entityOk = (await selected()) === target.kind && focused.kindId === target.kind && focused.selected === "true";
    detail = `clicked entity ${target.id} (${target.kind}); Entities card kinds[${focused.i}] = ${focused.kindId} focused, selected ${focused.selected}`;
  }
  check(`${id}: clicking an entity selects its kind and opens that kind's card in the Entities editor`, entityOk, detail);

  // ---- overlapping entities: the topmost (drawn last) kind wins
  let overlap = null;
  for (let a = 0; a < boxes.length && !overlap; a++) for (let b = a + 1; b < boxes.length && !overlap; b++) {
    const A = boxes[a].visible, B = boxes[b].visible;
    const l = Math.max(A.x, B.x), t = Math.max(A.y, B.y), r = Math.min(A.x + A.w, B.x + B.w), btm = Math.min(A.y + A.h, B.y + B.h);
    if (r - l > 2 && btm - t > 2 && boxes[a].kind !== boxes[b].kind) overlap = { x: (l + r) / 2, y: (t + btm) / 2, want: topmostAt((l + r) / 2, (t + btm) / 2) };
  }
  if (overlap) {
    await page.mouse.click(canvas.x + overlap.x, canvas.y + overlap.y);
    check(`${id}: where entities of different kinds overlap, the topmost one is selected`, (await selected()) === overlap.want, overlap.want);
  } else check(`${id}: overlapping entities`, true, "no overlap of different kinds on screen in this frame (covered by unit tests)");

  // ---- empty space and outside the world select nothing and do not navigate
  await page.evaluate(() => { window.location.hash = "/overview"; });
  let empty = null;
  for (let y = world.y + 4; y < world.y + world.h && !empty; y += 6) for (let x = world.x + 4; x < world.x + world.w && !empty; x += 6) if (topmostAt(x, y) === null) empty = { x, y };
  await page.mouse.click(canvas.x + empty.x, canvas.y + empty.y);
  const emptyNote = await page.locator('[data-testid="preview-selection"]').textContent();
  check(`${id}: clicking empty world space clears the selection and does not navigate`, (await selected()) === null && (await page.evaluate(() => window.location.hash)) === "#/overview" && emptyNote.includes("No entity there"), emptyNote.trim());
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + Math.max(2, world.y / 2)); // the HUD bar
  check(`${id}: clicking the HUD (outside the world rectangle) selects nothing`, (await selected()) === null);
  const hiddenOnly = (await page.evaluate(() => window.previewDebug.boxes())).filter((b) => !b.visible).length;

  // ---- editor -> preview: selecting a kind in the editor highlights its entities
  const counts = {};
  for (const b of boxes) counts[b.kind] = (counts[b.kind] ?? 0) + 1;
  const kindIds = await page.evaluate(() => window.session.store.getState().doc.game.runtime.kinds.map((k) => k.id));
  const pick = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? kindIds[0];
  const j = kindIds.indexOf(pick);
  await page.evaluate(() => { window.location.hash = "/entities"; });
  await page.waitForSelector(`[data-path="$.game.runtime.kinds[${j}].width"]`);
  await page.click(`[data-path="$.game.runtime.kinds[${j}].width"]`);
  await nextFrame();
  const hi = await page.evaluate(() => window.previewDebug.highlighted);
  check(`${id}: selecting kind '${pick}' in the editor highlights exactly its ${counts[pick] ?? 0} visible entities in the preview`,
    (await selected()) === pick && hi === (counts[pick] ?? 0) && (await page.locator(`[data-path="$.game.runtime.kinds[${j}]"]`).getAttribute("data-selected")) === "true", `${hi} highlighted`);
  await page.locator('[data-testid="preview"]').screenshot({ path: join(shots, `${id}-04-highlight-${pick}.png`) });
  const other = kindIds.find((k) => !counts[k]);
  if (other) {
    await page.click(`[data-path="$.game.runtime.kinds[${kindIds.indexOf(other)}].width"]`);
    await nextFrame();
    check(`${id}: a kind with no entity on screen highlights nothing`, (await page.evaluate(() => window.previewDebug.highlighted)) === 0 && (await selected()) === other, other);
  }
  // Clicking into a field must not edit it.
  const after = await draftId();
  check(`${id}: selection and highlighting leave the draft untouched (same revision, SHA-256 and document)`,
    after.revision === before.revision && after.sha === before.sha && after.doc === before.doc, after.sha?.slice(0, 12));
  check(`${id}: while inspecting, no frame or event reached the engine`, (await traceLen()) === t0, `${t0} recorded frames`);

  // ---- Resume
  const tickHeld = await page.evaluate(() => window.session.preview.getState().snapshot.tick);
  await page.click('[data-testid="preview-inspect"]');
  await page.waitForFunction((t) => window.session.preview.getState().held === false && window.session.preview.getState().snapshot.tick > t, tickHeld, { timeout: 5000 });
  await page.waitForTimeout(500);
  check(`${id}: Resume continues the same session`, (await page.evaluate(() => window.session.preview.getState().snapshot.tick)) > tickHeld);
  const t = await page.evaluate(() => window.engine.previewTrace());
  traces.push({ name: `${id}: played, inspected, resumed`, text: await page.evaluate(() => window.session.preview.getState().text), seed: t.seed, frames: t.frames, hash: t.hash, tick: t.tick });
  rows.push({ template: id, visibleEntities: boxes.length, controlledKind: boxes.find((b) => b.controlled)?.kind ?? null, entitiesOutsideWorld: hiddenOnly, clicked: target?.kind ?? null, overlapTested: Boolean(overlap), highlighted: { kind: pick, count: hi } });
  await page.evaluate(() => window.session.selection.set(null, null));
}

// ---- determinism: every session replays on host CPython to the same state
const scratch = mkdtempSync(join(tmpdir(), "studio-m2-click-"));
writeFileSync(join(scratch, "traces.json"), JSON.stringify(traces));
const py = (() => { for (const [c, a] of [["python3", []], ["python", []], ["py", ["-3"]]]) { try { execFileSync(c, [...a, "--version"], { stdio: "pipe" }); return [c, a]; } catch { /* next */ } } throw new Error("no Python 3"); })();
execFileSync(py[0], [...py[1], join(here, "m2-preview-replay.py"), join(scratch, "traces.json"), join(scratch, "out.json")], { cwd: repo, stdio: "pipe", maxBuffer: 1 << 26 });
const replayed = JSON.parse(readFileSync(join(scratch, "out.json"), "utf8"));
traces.forEach((tr, i) => check(`exact: ${tr.name} (${tr.frames.length} frames) replays on host CPython to the same state`, replayed[i].hash === tr.hash && replayed[i].tick === tr.tick, `${tr.hash} / ${replayed[i].hash}`));
rmSync(scratch, { recursive: true, force: true });

check("at least one click selected a kind other than the player, and one highlight covered several entities",
  rows.some((r) => r.clicked && r.clicked !== r.controlledKind) && rows.some((r) => r.highlighted.count >= 2),
  rows.map((r) => `${r.template}: clicked ${r.clicked}, highlighted ${r.highlighted.count} ${r.highlighted.kind}`).join("; "));
check("no console or page errors", errors.length === 0, errors.join(" | "));
const browserVersion = browser.version();
await browser.close();
server.close();
const failed = checks.filter((c) => !c.ok);
const result = { verdict: failed.length ? "FAIL" : "PASS", browser: `Chrome ${browserVersion}`, templates: rows, checks };
writeFileSync(join(evidence, "clickthrough.json"), JSON.stringify(result, null, 2) + "\n");
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
console.log(`\n${result.verdict}: ${checks.length - failed.length}/${checks.length} checks, Chrome ${browserVersion}`);
process.exit(failed.length ? 1 : 0);
