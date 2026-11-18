// Memory measurement for Level Studio variant checking (task 4.3). Informational: it prints numbers and limitations and
// sets NO pass/fail threshold (no memory budget has been decided, so none is invented here).
//
// Method (reproducible: `npm run build && npm run levels:memory`, optional SMOKE_CHANNEL like the other scripts):
//   1. Chromium is started with --remote-debugging-port, --enable-precise-memory-info and --js-flags=--expose-gc.
//   2. A project with 10 deterministic, valid levels is built from the Pumpkin Blaster template (3 to 12 waves and
//      1 to 4 difficulty steps per level) and committed through the project's own levels action.
//   3. "Check all variants" is clicked in the Level Studio UI; the app compiles and validates the levels sequentially
//      (one at a time) through the real Pyodide worker.
//   4. While it runs, a sampler records back to back, with the DOM progress ("n/10") of each sample:
//        - page JS heap (CDP Performance.getMetrics JSHeapUsedSize and JSHeapTotalSize),
//        - engine worker JS heap (CDP Runtime.getHeapUsage on the worker target),
//        - resident memory of the whole browser process tree (Windows working set, Linux/macOS rss), which is the only
//          view that includes Pyodide's WebAssembly linear memory.
//      Before the check and after it (after a forced GC) the same three values are recorded again.
// Limitations, stated in the output as well: one machine and one browser build per run; samples are not synchronized
// with level boundaries; Windows working set and Linux rss include shared pages and differ in meaning; the JS heap
// numbers exclude WebAssembly memory; no soak run, no mobile device, no repeated runs; the numbers describe this
// run only and are not a budget.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { preview } from "vite";
import { resetStudioStorage } from "./storage.mjs";

const studio = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEVELS = 10;
const U = 65536;

/** 10 deterministic levels: no randomness, so every run measures the same project. */
function buildLevels() {
  const hostile = ["pumpkin", "bat", "ember"];
  const levels = [];
  for (let n = 1; n <= LEVELS; n++) {
    const waveCount = 3 + Math.round(((n - 1) * 9) / (LEVELS - 1)); // 3 .. 12
    const stepCount = 1 + ((n - 1) % 4); // 1 .. 4
    const waves = [], difficulty = [];
    for (let w = 0; w < waveCount; w++) {
      waves.push({
        id: `wave-${w + 1}`, stream: `s${n}-w${w + 1}`, kind: hostile[w % hostile.length], startTick: 30 * w, intervalTicks: 60 + 15 * (w % 5),
        xMin: 1880 * U, xMax: 1880 * U, yMin: 40 * U, yMax: (400 + 50 * (w % 10)) * U, vx: -(6 + (w % 6)) * U, vy: 0,
      });
    }
    for (let s = 0; s < stepCount; s++) {
      difficulty.push({ id: `step-${s + 1}`, waveId: `wave-${(s % waveCount) + 1}`, stream: `s${n}-d${s + 1}`, atTick: 900 + 300 * s, intervalTicks: 45, vx: -(12 + s) * U, vy: 0 });
    }
    levels.push({
      id: `level-${n}`, name: `Level ${n}`, order: n,
      placements: [{ id: "player-start", kind: "player", x: 80 * U, y: 495 * U, vx: 0, vy: 0, controlled: true }],
      waves, difficulty,
    });
  }
  return { schema: "monstera.studio.levels", version: 1, levels };
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = m.id ? pending.get(m.id) : null; if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  return {
    open: new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }),
    send: (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); }),
    close: () => ws.close(),
  };
}
/** Resident bytes of a process and all its descendants (Windows: working set; elsewhere: ps rss). */
function treeRssBytes(rootPid) {
  let rows;
  if (process.platform === "win32") {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress"], { encoding: "utf8", maxBuffer: 1 << 26 });
    rows = JSON.parse(r.stdout).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, bytes: Number(p.WorkingSetSize) }));
  } else {
    const r = spawnSync("ps", ["-eo", "pid=,ppid=,rss="], { encoding: "utf8", maxBuffer: 1 << 26 });
    rows = r.stdout.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number)).map(([pid, ppid, kib]) => ({ pid, ppid, bytes: kib * 1024 }));
  }
  const kids = new Map();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  let sum = 0;
  const walk = (pid) => { const self = rows.find((r) => r.pid === pid); if (self) sum += self.bytes; for (const k of kids.get(pid) ?? []) walk(k.pid); };
  walk(rootPid);
  return sum;
}
/** The root browser process: the one whose command line has our debugging port and is not a child (no --type=). */
function browserPid(port) {
  if (process.platform === "win32") {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'remote-debugging-port=${port}' -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1 -ExpandProperty ProcessId`], { encoding: "utf8" });
    return Number(r.stdout.trim());
  }
  const r = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", maxBuffer: 1 << 26 });
  const line = r.stdout.split("\n").find((l) => l.includes(`remote-debugging-port=${port}`) && !l.includes("--type="));
  return Number(line?.trim().split(/\s+/)[0]);
}
const mib = (b) => Math.round((b / 1048576) * 10) / 10;

const server = await preview({ root: studio, preview: { port: 0, host: "127.0.0.1", open: false } });
const origin = server.resolvedUrls.local[0];
const port = await freePort();
const browser = await chromium.launch({
  ...(process.env.SMOKE_CHANNEL ? { channel: process.env.SMOKE_CHANNEL } : {}),
  args: [`--remote-debugging-port=${port}`, "--enable-precise-memory-info", "--js-flags=--expose-gc"],
});
let exit = 1;
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(origin, { waitUntil: "load" });
  await resetStudioStorage(page);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
  await page.evaluate(() => window.session.loadTemplate("pumpkin-blaster"));
  await page.waitForFunction(() => { const s = window.session.store.getState(); return s.validation !== null && s.validatedRevision === s.revision; }, null, { timeout: 30000 });
  const committed = await page.evaluate((lv) => window.session.project.actions.setLevels(lv), buildLevels());
  if (!committed.ok) throw new Error(`the generated 10-level manifest was refused: ${committed.reason}`);
  await page.evaluate(() => { window.location.hash = "#/levels/editor"; });
  await page.waitForSelector('[data-testid="variants-check"]');

  // raw CDP to the browser: page and engine-worker targets
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const c = cdp(version.webSocketDebuggerUrl);
  await c.open;
  const targets = (await c.send("Target.getTargets")).targetInfos;
  const pageTarget = targets.find((t) => t.type === "page" && t.url.startsWith(origin));
  const workerTargets = targets.filter((t) => t.type === "worker" && t.url.startsWith(origin));
  const attach = async (t) => (await c.send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
  const pageSession = await attach(pageTarget);
  await c.send("Performance.enable", {}, pageSession);
  const workerSessions = await Promise.all(workerTargets.map(attach));
  const root = browserPid(port);
  const sample = async (label) => {
    const metrics = Object.fromEntries((await c.send("Performance.getMetrics", {}, pageSession)).metrics.map((m) => [m.name, m.value]));
    let worker = 0;
    for (const s of workerSessions) { try { worker += (await c.send("Runtime.getHeapUsage", {}, s)).usedSize; } catch { /* a worker that went away */ } }
    const progress = await page.evaluate(() => document.querySelector('[data-testid="variants-progress"]')?.textContent ?? "");
    return { label, tMs: Math.round(performance.now()), progress, pageHeapUsed: metrics.JSHeapUsedSize, pageHeapTotal: metrics.JSHeapTotalSize, workerHeapUsed: worker, rss: treeRssBytes(root) };
  };
  const gc = async () => { await c.send("HeapProfiler.collectGarbage", {}, pageSession); for (const s of workerSessions) { try { await c.send("HeapProfiler.collectGarbage", {}, s); } catch { /* ignore */ } } };

  await gc();
  const samples = [await sample("before check")];
  const started = performance.now();
  await page.click('[data-testid="variants-check"]');
  let done = false;
  const finished = page.waitForFunction(() => document.querySelectorAll('[data-testid="variants-table"] tbody tr').length > 0 && !document.querySelector('[data-testid="variants-progress"]'), null, { timeout: 600000, polling: 100 }).then(() => { done = true; });
  while (!done) { samples.push(await sample("during")); }
  await finished;
  const elapsedMs = Math.round(performance.now() - started);
  samples.push(await sample("after check"));
  await gc();
  samples.push(await sample("after check + gc"));

  const rows = await page.$$eval('[data-testid="variants-table"] tbody tr', (trs) => trs.map((tr) => ({ id: tr.getAttribute("data-testid").slice("variant-row-".length), status: tr.getAttribute("data-status") })));
  const peak = (k) => Math.max(...samples.map((s) => s[k]));
  const summary = {
    method: "see the header of scripts/level-memory.mjs",
    levels: LEVELS, variantsValid: rows.filter((r) => r.status === "valid").length, results: rows, elapsedMs, sampleCount: samples.length,
    environment: { node: process.version, chromium: browser.version(), os: `${os.type()} ${os.release()} ${os.arch()}`, totalMemMiB: mib(os.totalmem()), cpus: os.cpus().length },
    mib: {
      beforeCheck: { pageHeap: mib(samples[0].pageHeapUsed), workerHeap: mib(samples[0].workerHeapUsed), rssTree: mib(samples[0].rss) },
      peakDuring: { pageHeap: mib(peak("pageHeapUsed")), workerHeap: mib(peak("workerHeapUsed")), rssTree: mib(peak("rss")) },
      afterCheckAndGc: { pageHeap: mib(samples.at(-1).pageHeapUsed), workerHeap: mib(samples.at(-1).workerHeapUsed), rssTree: mib(samples.at(-1).rss) },
    },
    samples: samples.map((s) => ({ label: s.label, tMs: s.tMs, progress: s.progress, pageHeapMiB: mib(s.pageHeapUsed), workerHeapMiB: mib(s.workerHeapUsed), rssTreeMiB: mib(s.rss) })),
    limitations: [
      "one run on one machine and one browser build; no repeated runs, no soak, no mobile device",
      "samples are taken back to back, not at level boundaries, so a short peak between samples can be missed",
      "JS heap values exclude WebAssembly (Pyodide) linear memory; only the process-tree resident figure includes it",
      "resident figures are Windows working set or Linux/macOS rss: they include shared pages and are not comparable across systems",
      "no memory budget has been decided; these numbers are observations, not a pass or fail",
    ],
  };
  const growth = summary.mib.afterCheckAndGc.rssTree - summary.mib.beforeCheck.rssTree;
  summary.observation = `resident memory of the browser tree changed by ${Math.round(growth * 10) / 10} MiB between before the check and after it (after GC); one run, so this is not evidence of a leak or of its absence`;
  mkdirSync(join(studio, ".memory"), { recursive: true });
  writeFileSync(join(studio, ".memory", "memory-level-studio.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`levels ${LEVELS}, valid variants ${summary.variantsValid}/${LEVELS}, check took ${elapsedMs} ms, ${samples.length} samples`);
  console.log(`environment: node ${summary.environment.node}, chromium ${summary.environment.chromium}, ${summary.environment.os}, ${summary.environment.totalMemMiB} MiB RAM`);
  console.table({ "before check": summary.mib.beforeCheck, "peak during": summary.mib.peakDuring, "after check + gc": summary.mib.afterCheckAndGc });
  console.log("columns are MiB: page JS heap, engine worker JS heap, resident memory of the browser process tree");
  console.log(summary.observation);
  for (const l of summary.limitations) console.log(`limitation: ${l}`);
  console.log("written to studio/.memory/memory-level-studio.json (git-ignored)");
  if (problems.length > 0) console.log(`page errors: ${problems.join(" | ")}`);
  exit = summary.variantsValid === LEVELS && problems.length === 0 ? 0 : 1;
  c.close();
} finally {
  await browser.close();
  await server.close();
}
process.exit(exit);
