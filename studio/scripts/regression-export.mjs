// Task 9.2 check 3 (A9, R14.2): the specs the REAL Studio export produces must pass `monstera generate --check` and `verify`.
// For each template it loads the project in the UI, clicks Generate and Download pack, extracts the ZIP, asserts the exported
// monstera.spec.json is equal, as a parsed document, to the committed template spec (so the committed goldens still apply and the spec is
// unedited), then runs the CLI on that spec path (so the manifest label matches) against the extracted tree.
// Serves dist/ with `vite preview` (run `npm run build` first). Env: SMOKE_CHANNEL. Writes nothing into the repository.
// Output: PASS/FAIL per step, then a final line `regression-export: PASS|FAIL|PENDING`. Exit 1 only on FAIL.
// PENDING (exit 0) when dist/ or a browser is missing locally; FAIL when CI=true.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { preview } from "vite";
import { resetStudioStorage } from "./storage.mjs";
const studio = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(studio, "..");
const CI = process.env.CI === "true";
const TEMPLATES = [
  ["pumpkin-blaster", "apps/pumpkin-blaster/monstera.spec.json"],
  ["trick-or-treat-rush", "apps/trick-or-treat-rush/monstera.spec.json"],
  // lantern-run is a fixture-layout sample: the pack download refuses it ("README.md is not part of the pack layout"), so the plain ZIP is used.
  ["lantern-run", "spec/samples/lantern-run/monstera.spec.json", "export-download"],
];
let failed = 0;
const line = (ok, name, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n${detail.split(/\r?\n/).map((l) => `      ${l}`).join("\n")}` : ""}`); };
const finish = (status, reason = "") => { console.log(`regression-export: ${status}${reason ? ` (${reason})` : ""}`); process.exit(status === "FAIL" ? 1 : 0); };
const unavailable = (reason) => finish(CI ? "FAIL" : "PENDING", reason);
const PYTHONS = [["python3"], ["python"], ["py", "-3"]];
const py = PYTHONS.find(([c, ...pre]) => { const p = spawnSync(c, [...pre, "--version"], { encoding: "utf8" }); return !p.error && p.status === 0; });
if (!py) finish("FAIL", "no Python 3 found");
const python = (args, cwd) => spawnSync(py[0], [...py.slice(1), ...args], { encoding: "utf8", cwd, env: { ...process.env, PYTHONUTF8: "1" } });
// zipfile.extractall drops Unix modes. Apply the mode each entry carries (high 16 bits of external attributes) so the executable bit of gradlew is checked as exported.
const UNZIP_WITH_MODES = "import sys,os,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nz.extractall(sys.argv[2])\nfor i in z.infolist():\n m=(i.external_attr>>16)&0o777\n if m and not i.is_dir(): os.chmod(os.path.join(sys.argv[2],i.filename),m)";
const monstera = (args) => { const r = python([join("tools", "monstera", "monstera.py"), ...args], repo); return { cmd: `monstera ${args.join(" ")}`, exit: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }; };
if (!existsSync(join(studio, "dist", "index.html"))) unavailable("studio/dist is missing; run `npm run build` first");
const server = await preview({ root: studio, preview: { port: 0, host: "127.0.0.1", open: false } });
let browser;
try {
  try { browser = await chromium.launch(process.env.SMOKE_CHANNEL ? { channel: process.env.SMOKE_CHANNEL } : {}); }
  catch (e) { await server.close(); unavailable(`no browser could be launched: ${String(e.message).split("\n")[0]}`); }
  const problems = [];
  const dir = mkdtempSync(join(tmpdir(), "regression-export-"));
  for (const [id, specPath, button = "export-download-pack"] of TEMPLATES) {
    // A fresh browser context per template: each export starts from an empty Studio, not from the previous project.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => problems.push(`${id} pageerror: ${e.message}`));
    await page.goto(server.resolvedUrls.local[0], { waitUntil: "load" });
    await resetStudioStorage(page);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 90000 });
    await page.evaluate((t) => window.session.loadTemplate(t), id);
    await page.waitForFunction(() => { const s = window.session.store.getState(); return s.validation !== null && s.validatedRevision === s.revision; }, null, { timeout: 60000 });
    await page.evaluate((h) => { window.location.hash = h; }, "/release/export");
    await page.waitForSelector('[data-testid="export-generate"]', { timeout: 15000 });
    await page.click('[data-testid="export-generate"]');
    await page.waitForSelector('[data-testid="export-tree"]', { timeout: 120000 });
    if (await page.locator(`[data-testid="${button}"]`).isDisabled()) { line(false, `${id}: ${button} is enabled`, (await page.locator('[data-testid="export-completeness"]').textContent().catch(() => "no completeness text")) ?? ""); continue; }
    let dl;
    try { [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click(`[data-testid="${button}"]`)]); }
    catch (e) { line(false, `${id}: ${button} starts a download`, `${String(e.message).split("\n")[0]}\n${((await page.locator('[data-testid="export"]').innerText().catch(() => "")) ?? "").slice(0, 1500)}`); continue; }
    const zip = join(dir, `${id}.zip`), extracted = join(dir, id);
    await dl.saveAs(zip);
    const un = python(["-c", UNZIP_WITH_MODES, zip, extracted]);
    // The pack ZIP is rooted at the tree and carries monstera.spec.json; the plain ZIP holds <id>/ and embeds the spec as an Android asset.
    const pack = button === "export-download-pack";
    const out = pack ? extracted : join(extracted, id);
    const exportedSpec = join(out, pack ? "monstera.spec.json" : join("android", "app", "src", "main", "assets", "monstera.spec.json"));
    if (un.status !== 0) { line(false, `${id}: the pack ZIP extracts`, un.stderr); continue; }
    // The export is the canonical form of the spec; the committed file is pretty-printed. Compare the parsed documents.
    const canon = (v) => JSON.stringify(Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
    const same = canon(JSON.parse(readFileSync(exportedSpec, "utf8"))) === canon(JSON.parse(readFileSync(join(repo, specPath), "utf8")));
    line(same, `${id}: exported monstera.spec.json equals ${specPath} as a parsed document (unedited)`);
    if (!same) continue;
    const g = monstera(["generate", specPath, "--check", "--out", out]);
    line(g.exit === 0, `${id}: ${g.cmd} -> exit ${g.exit}`, g.out.split(/\r?\n/).slice(-6).join("\n"));
    const v = monstera(["verify", out]);
    line(v.exit === 0, `${id}: ${v.cmd} -> exit ${v.exit}`, v.out.split(/\r?\n/).slice(-6).join("\n"));
  }
  line(problems.length === 0, "no page errors", problems.join(" | "));
} finally {
  await browser?.close();
  await server.close();
}
finish(failed ? "FAIL" : "PASS");
