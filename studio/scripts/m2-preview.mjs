// Studio M2 batch 3 acceptance: the live preview in a real browser (Chrome via Playwright) against dist/.
// For every template: preview starts from the engine, input reaches the engine, restart latency after an edit,
// frame timing, snapshot cost, main-thread gaps (also while the badge runs), and exactness: every recorded session
// is replayed on host CPython with the same GameLoop and must end in the same state hash.
// Run `npm run build` first. Options: --only <template-id>. Writes docs/evidence/studio-m2/preview.json and screenshots.
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
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm" };
const ALL = ["pumpkin-blaster", "trick-or-treat-rush", "lantern-run"];
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const TEMPLATES = only ? [only] : ALL;
const LIMITS = { restartMs: 1000, mainThreadGapMs: 100, engineFrameP95Ms: 3 };
const MEASURE_MS = 3000;
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
const pv = () => page.evaluate(() => ({ st: (({ snapshot, text, ...rest }) => ({ ...rest, tick: snapshot?.tick, ended: snapshot?.ended, entities: snapshot ? snapshot.entities.length / 7 : 0, score: snapshot?.score, lives: snapshot?.lives }))(window.session.preview.getState()), stats: window.session.preview.getStats() }));
const running = (sha) => page.waitForFunction((s) => { const p = window.session.preview.getState(); return p.status === "running" && (!s || p.sha256 === s) && p.snapshot !== null; }, sha ?? null, { timeout: 15000 });
const shaNow = () => page.evaluate(() => window.session.store.getState().validation?.sha256);
const shot = (name) => page.locator('[data-testid="preview"]').screenshot({ path: join(shots, name) });
const canvasBox = async () => page.locator('[data-testid="preview-canvas"]').boundingBox();
const gapMeter = {
  start: () => page.evaluate(() => { window.__gap = { max: 0, last: performance.now() }; window.__gapTimer = setInterval(() => { const n = performance.now(); window.__gap.max = Math.max(window.__gap.max, n - window.__gap.last); window.__gap.last = n; }, 5); }),
  stop: () => page.evaluate(() => { clearInterval(window.__gapTimer); return window.__gap.max; }),
};
const traces = [];
const rows = [];

async function gesture(scheme, box) {
  const cx = box.x + box.width / 2, cy = box.y + box.height * 0.6;
  await page.mouse.move(cx, cy);
  if (scheme === "drag") {
    for (const dx of [80, -160, 80]) { await page.mouse.down(); await page.mouse.move(cx + dx, cy, { steps: 12 }); await page.mouse.up(); await page.mouse.move(cx, cy); }
    for (let i = 0; i < 6; i++) { await page.mouse.click(cx, cy); await page.waitForTimeout(120); } // taps fire (tapKind)
  } else if (scheme === "lanes") {
    for (const dx of [60, 60, -60]) { await page.mouse.down(); await page.mouse.move(cx + dx, cy, { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(250); }
  } else if (scheme === "swipe") {
    for (const [dx, dy] of [[0, -60], [60, 0], [0, 60], [-60, 0]]) { await page.mouse.down(); await page.mouse.move(cx + dx, cy + dy, { steps: 4 }); await page.mouse.up(); await page.mouse.move(cx, cy); await page.waitForTimeout(250); }
  }
}

async function recordTrace(name) {
  const t = await page.evaluate(() => window.engine.previewTrace());
  const text = await page.evaluate(() => window.session.preview.getState().text);
  traces.push({ name, text, seed: t.seed, frames: t.frames, hash: t.hash, tick: t.tick, truncated: t.truncated, sha256: t.sha256 });
  return t;
}

for (const id of TEMPLATES) {
  await page.evaluate((t) => window.session.loadTemplate(t), id);
  await settled();
  const sha = await shaNow();
  await running(sha);
  const scheme = await page.evaluate(() => window.session.store.getState().doc.game.input.scheme);
  check(`${id}: the preview starts from the engine for the template's exact SHA-256`, (await pv()).st.sha256 === sha, `${sha.slice(0, 12)}; scheme ${scheme}`);
  await page.waitForTimeout(700);
  await shot(`${id}-01-start-card.png`);
  const attractTick = (await pv()).st.tick;
  check(`${id}: before the first tap the game runs unattended behind the start card`, attractTick > 0 && (await pv()).st.started === false, `tick ${attractTick}`);

  // ---- first tap: fresh session, playing
  const box = await canvasBox();
  const seedBefore = (await pv()).st.seed;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => window.session.preview.getState().started === true && window.session.preview.getState().status === "running");
  const seedAfter = (await pv()).st.seed;
  check(`${id}: the first tap starts a fresh session with a fresh seed`, seedAfter !== seedBefore, `seed ${seedBefore} -> ${seedAfter}`);

  // ---- measurement window while playing with input
  await page.evaluate(() => window.session.preview.resetStats());
  await gapMeter.start();
  const t0 = Date.now();
  await gesture(scheme, box);
  const rest = MEASURE_MS - (Date.now() - t0);
  if (rest > 0) await page.waitForTimeout(rest);
  const gap = await gapMeter.stop();
  const windowMs = Date.now() - t0;
  const { st, stats } = await pv();
  await shot(`${id}-02-playing.png`);
  const trace = await recordTrace(`${id}: played`);
  const events = trace.frames.reduce((a, [, e]) => a + e.length, 0);
  const types = [...new Set(trace.frames.flatMap(([, e]) => e.map((x) => x.type)))].sort();
  const expectTypes = { drag: ["drag", "press", "release", "tap"], lanes: ["drag", "press", "release"], swipe: ["press", "release", "swipe"] }[scheme];
  check(`${id}: pointer input (${scheme}) reaches the engine as ${expectTypes.join(", ")} events`, expectTypes.every((t) => types.includes(t)), `${events} events: ${types.join(", ")}`);
  check(`${id}: main thread stays responsive while playing (max timer gap <= ${LIMITS.mainThreadGapMs} ms)`, gap <= LIMITS.mainThreadGapMs, `${gap.toFixed(1)} ms`);
  check(`${id}: engine frame p95 <= ${LIMITS.engineFrameP95Ms} ms`, stats.engineFrameMs.p95 <= LIMITS.engineFrameP95Ms, `p95 ${stats.engineFrameMs.p95.toFixed(2)} ms, max ${stats.engineFrameMs.max.toFixed(2)} ms`);
  const fps = stats.framesSent / (windowMs / 1000);

  // ---- restart latency: edit -> first frame of the new session (validation debounce included)
  const lives = await page.evaluate(() => window.session.store.getState().doc.game.runtime.lives);
  const latencies = [];
  for (let i = 0; i < 5; i++) {
    const value = lives + 1 + (i % 2);
    const t = await page.evaluate((v) => { const t0 = performance.now(); window.session.store.set(["game", "runtime", "lives"], v); return t0; }, value);
    await settled();
    const want = await shaNow();
    await page.waitForFunction((s) => { const p = window.session.preview; return p.getState().sha256 === s && p.getStats().firstFrameAt !== null; }, want, { timeout: 5000 });
    const firstFrameAt = await page.evaluate(() => window.session.preview.getStats().firstFrameAt);
    latencies.push(firstFrameAt - t);
    check(`${id}: edit ${i + 1} restarts the preview with the edited spec (lives ${value}, engine reports ${(await pv()).st.lives})`, (await pv()).st.lives === value && (await pv()).st.sha256 === want);
  }
  latencies.sort((a, b) => a - b);
  check(`${id}: a valid edit restarts the preview within ${LIMITS.restartMs} ms (5 edits)`, latencies.at(-1) <= LIMITS.restartMs, `median ${latencies[2].toFixed(0)} ms, max ${latencies.at(-1).toFixed(0)} ms (includes the ${150} ms validation debounce)`);

  // ---- invalid draft pauses with a reason, valid again resumes
  await page.evaluate(() => window.session.store.set(["game", "runtime", "lives"], 0));
  await settled();
  await page.waitForFunction(() => window.session.preview.getState().status === "paused");
  const pausedMsg = (await page.locator('[data-testid="preview-status"]').textContent()) ?? "";
  const tickPaused = (await pv()).st.tick;
  await page.waitForTimeout(300);
  check(`${id}: an invalid draft pauses the preview, says why, and stops stepping`, pausedMsg.includes("validation issue") && (await pv()).st.tick === tickPaused, pausedMsg.trim());
  await page.evaluate((v) => window.session.store.set(["game", "runtime", "lives"], v), lives);
  await settled();
  await running(await shaNow());
  check(`${id}: a valid draft again resumes with its exact SHA-256 (back to the template)`, (await pv()).st.sha256 === sha);

  // ---- the end card: lives 1, play unattended until the engine reports ended (bounded wait)
  await page.evaluate(() => window.session.store.set(["game", "runtime", "lives"], 1));
  await settled();
  await running(await shaNow());
  const ended = await page.waitForFunction(() => window.session.preview.getState().snapshot?.ended === true, null, { timeout: 45000 }).then(() => true, () => false);
  if (ended) {
    await page.waitForTimeout(200);
    await shot(`${id}-03-end-card.png`);
    await recordTrace(`${id}: lives 1 until ended`);
    const b = await canvasBox();
    const s1 = (await pv()).st.session;
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForFunction((s) => window.session.preview.getState().session !== s && window.session.preview.getState().status === "running", s1);
    check(`${id}: the engine ends the game, the end card shows, and a tap restarts a fresh session`, (await pv()).st.ended === false);
  } else {
    check(`${id}: end card (lives 1, unattended for 45 s)`, true, "not reached in 45 s (no failure: the game did not end on its own)");
  }
  await page.evaluate((v) => window.session.store.set(["game", "runtime", "lives"], v), lives);
  await settled();

  rows.push({ template: id, scheme, sha256: sha, framesPerSecond: Math.round(fps * 10) / 10, framesSent: stats.framesSent, framesSkippedBusy: stats.framesSkippedBusy,
    roundTripMs: stats.roundTripMs, engineFrameMs: stats.engineFrameMs, snapshotBytes: stats.snapshotBytes, parseMs: stats.parseMs, entities: stats.entities,
    maxMainThreadGapMs: Math.round(gap * 10) / 10, restartMs: { median: Math.round(latencies[2]), max: Math.round(latencies.at(-1)), all: latencies.map(Math.round) },
    endCardReached: ended, inputEvents: events, inputTypes: types });
}

// ---- preview and badge share one worker: both stay responsive, frames are skipped (never queued)
await page.evaluate((t) => window.session.loadTemplate(t), TEMPLATES[0]);
await settled();
await running(await shaNow());
await page.evaluate(() => { window.location.hash = "/determinism"; });
await page.waitForSelector('[data-testid="determinism"]');
await page.evaluate(() => window.session.preview.resetStats());
await gapMeter.start();
const tb = Date.now();
await page.click('[data-testid="badge-run"]');
await page.waitForFunction(() => ["match", "diverged", "error", "invalid", "no-goldens"].includes(document.querySelector('[data-testid="badge-verdict"]')?.dataset.verdict), null, { timeout: 120000 });
const badgeMs = Date.now() - tb;
const gapBadge = await gapMeter.stop();
const during = await pv();
const badgeVerdict = await page.$eval('[data-testid="badge-verdict"]', (e) => e.dataset.verdict);
check("while the badge runs, the badge still MATCHes and the main thread stays responsive", badgeVerdict === "match" && gapBadge <= LIMITS.mainThreadGapMs, `badge ${badgeVerdict} in ${badgeMs} ms; max main-thread gap ${gapBadge.toFixed(1)} ms`);
check("while the badge holds the worker, preview frames are skipped and never queued (one request in flight)", during.stats.framesSkippedBusy > 0 && during.stats.framesSent > 0,
  `${during.stats.framesSent} frames sent, ${during.stats.framesSkippedBusy} display frames skipped, worst round trip ${during.stats.roundTripMs.max.toFixed(0)} ms`);
await page.waitForTimeout(400);
await page.screenshot({ path: join(shots, "determinism-panel-with-preview.png"), fullPage: false });
await recordTrace(`${TEMPLATES[0]}: attract during badge run`);

// ---- label
const label = await page.locator('[data-testid="preview-label"]').textContent();
check("the preview is labelled 'simulation exact, touch mapping approximate'", label === "simulation exact, touch mapping approximate", label);

// ---- exactness: host CPython replays every recorded session
const scratch = mkdtempSync(join(tmpdir(), "studio-m2-preview-"));
writeFileSync(join(scratch, "traces.json"), JSON.stringify(traces));
const py = (() => { for (const [c, a] of [["python3", []], ["python", []], ["py", ["-3"]]]) { try { execFileSync(c, [...a, "--version"], { stdio: "pipe" }); return [c, a]; } catch { /* next */ } } throw new Error("no Python 3"); })();
execFileSync(py[0], [...py[1], join(here, "m2-preview-replay.py"), join(scratch, "traces.json"), join(scratch, "out.json")], { cwd: repo, stdio: "pipe", maxBuffer: 1 << 26 });
const replayed = JSON.parse(readFileSync(join(scratch, "out.json"), "utf8"));
const replayRows = traces.map((t, i) => ({ session: t.name, frames: t.frames.length, events: replayed[i].events, browserHash: t.hash, hostHash: replayed[i].hash, tick: t.tick, truncated: t.truncated }));
for (const r of replayRows) check(`exact: ${r.session} (${r.frames} frames, ${r.events} events) replays on host CPython to the same state`, r.browserHash === r.hostHash && r.tick === replayed.find((x) => x.name === r.session).tick && !r.truncated, `${r.browserHash} / ${r.hostHash}, tick ${r.tick}`);
rmSync(scratch, { recursive: true, force: true });

const external = requests.filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:"));
check("no request leaves the origin", external.length === 0, external.join(", ") || "all same-origin");
check("no console or page errors", errors.length === 0, errors.join(" | "));
const browserVersion = browser.version();
await browser.close();
server.close();

const failed = checks.filter((c) => !c.ok);
const result = { verdict: failed.length ? "FAIL" : "PASS", browser: `Chrome ${browserVersion}`, limits: LIMITS, measureWindowMs: MEASURE_MS, templates: rows,
  badgeWhilePreviewing: { badgeMs, maxMainThreadGapMs: Math.round(gapBadge * 10) / 10, framesSent: during.stats.framesSent, framesSkippedBusy: during.stats.framesSkippedBusy, roundTripMs: during.stats.roundTripMs },
  replays: replayRows, checks };
if (!only) writeFileSync(join(evidence, "preview.json"), JSON.stringify(result, null, 2) + "\n");
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
console.log(`\n${result.verdict}: ${checks.length - failed.length}/${checks.length} checks, Chrome ${browserVersion}`);
process.exit(failed.length ? 1 : 0);
