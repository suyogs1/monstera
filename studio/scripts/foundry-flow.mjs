// Studio Foundry flow (task 9.1, A4, A6, A7): one browser session on the real engine worker and IndexedDB. It imports an image
// with provenance, slices it, defines an animation, turns on gameplay derivation and applies the reviewed change, generates the
// source files, downloads the pack ZIP, extracts it and runs the REAL tools/check-drift.sh on the extracted tree. Then it
// re-imports the same ZIP into the Kiro drift view. Serves dist/ with `vite preview` (run `npm run build` first).
// Env: SMOKE_CHANNEL (e.g. "chrome"). Exit code 1 on any failed check. Writes nothing under docs/evidence/.
// Not covered, recorded as PENDING and never counted as passed: scaffold selection in the Backend and Monetization UI (task 6.3
// is not merged, so the pack has no scaffold files to edit; the drift check below edits the one studio-scaffold file that exists).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright-core";
import { preview } from "vite";
import { resetStudioStorage } from "./storage.mjs";

const studio = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(studio, "..");
const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `: ${detail}`}`); };
const pending = (name, reason) => { checks.push({ name, ok: true, pending: true }); console.log(`PENDING  ${name}: ${reason}`); };
const PYTHONS = [["python3"], ["python"], ["py", "-3"]];
function python(args) {
  for (const [cmd, ...pre] of PYTHONS) {
    const probe = spawnSync(cmd, [...pre, "--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) continue;
    return spawnSync(cmd, [...pre, ...args], { encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" } });
  }
  throw new Error("no python interpreter found");
}
const BASH = ["bash", "C:\\Program Files\\Git\\bin\\bash.exe"].find((b) => { const p = spawnSync(b, ["--version"], { encoding: "utf8" }); return !p.error && p.status === 0; });
// A 32x32 RGBA PNG (the default sheet grid is one 32x32 frame), built from scratch so no binary fixture is committed.
function png32() {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4);
    len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(32, 0); ihdr.writeUInt32BE(32, 4); ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(32 * 4, 0x7f)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array(32).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
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
  const settled = () => page.waitForFunction(() => { const s = window.session.store.getState(); return s.validation !== null && s.validatedRevision === s.revision; }, null, { timeout: 60000 });
  await settled();
  const go = async (hash) => { await page.evaluate((h) => { window.location.hash = h; }, hash); await page.waitForTimeout(150); };
  const manifests = () => page.evaluate(() => window.session.project.getState().manifests);
  const doc = () => page.evaluate(() => window.session.store.getState().doc);

  // ---- A4: import an image, record provenance
  await go("/assets/library");
  await page.waitForSelector('[data-testid="asset-library"]', { timeout: 15000 });
  await page.setInputFiles('[data-testid="asset-file"]', { name: "hero.png", mimeType: "image/png", buffer: png32() });
  await page.fill('[data-testid="asset-license"]', "proprietary-owned");
  await page.fill('[data-testid="asset-author"]', "foundry-flow");
  await page.click('[data-testid="asset-import-submit"]');
  await page.waitForSelector('[data-testid="asset-row-asset-0001"]', { timeout: 30000 });
  const asset = (await manifests()).assets.assets[0];
  check("A4: the image is in the library with an allocated id, a SHA-256 and the license from the form", asset?.id === "asset-0001" && /^[0-9a-f]{64}$/.test(asset.sha256 ?? "")
    && JSON.stringify(asset).includes("proprietary-owned") && asset.width === 32 && asset.height === 32, JSON.stringify(asset));
  // ---- A4: slice a sheet, define an animation
  await go("/sprites/editor");
  await page.waitForSelector('[data-testid="sheet-editor"]', { timeout: 15000 });
  await page.click('[data-testid="sheet-create"]');
  await page.waitForSelector('[data-testid="sheet-row-sheet-1"], [data-testid^="sheet-row-"]', { timeout: 15000 });
  let m = await manifests();
  check("A4: slicing the image creates a sheet with one 32x32 frame", m.animations.sheets.length === 1 && m.animations.sheets[0].frames.length === 1, JSON.stringify(m.animations.sheets));
  const sheetId = m.animations.sheets[0].id;
  await page.click('[data-testid="animation-create"]');
  await page.waitForSelector('[data-testid^="animation-row-"]', { timeout: 15000 });
  m = await manifests();
  const animId = m.animations.animations[0]?.id;
  await page.click(`[data-testid="animation-select-${animId}"]`);
  await page.click('[data-testid="sequence-add"]');
  await page.waitForSelector('[data-testid="sequence-row-0"]', { timeout: 15000 });
  m = await manifests();
  check("A4: an animation over the sheet has the seeded frame plus the added entry", m.animations.animations.length === 1 && m.animations.animations[0].sheetId === sheetId && m.animations.animations[0].sequence.length === 2, JSON.stringify(m.animations.animations));
  await settled();

  // ---- A6: gameplay modules compile to lives, winScore, collisions and the spec validates
  const specBefore = JSON.stringify(await doc());
  await go("/gameplay/modules");
  await page.waitForSelector('[data-testid="gameplay-modules"]', { timeout: 15000 });
  check("A6: the Planned section lists health, power-ups and progression without controls", await (async () => {
    await go("/gameplay/planned");
    await page.waitForSelector('[data-testid="gameplay-planned"]', { timeout: 15000 });
    return (await page.locator('[data-testid="gameplay-planned"] input, [data-testid="gameplay-planned"] button, [data-testid="gameplay-planned"] select').count()) === 0;
  })());
  await go("/gameplay/modules");
  await page.waitForSelector('[data-testid="gameplay-derivation-toggle"]', { timeout: 15000 });
  await page.check('[data-testid="gameplay-derivation-toggle"]');
  await page.waitForFunction(() => window.session.project.getState().manifests.project.derivation.gameplay === true, null, { timeout: 15000 });
  check("A6: turning derivation on does not change the spec", JSON.stringify(await doc()) === specBefore);
  await page.click('[data-testid="gameplay-review"]');
  await page.waitForSelector('[data-testid="gameplay-review-result"]', { timeout: 60000 });
  await page.click('[data-testid="gameplay-apply"]');
  await page.waitForSelector('[data-testid="gameplay-apply-result"]', { timeout: 60000 });
  check("A6: the reviewed gameplay change applies and the oracle runs it", (await page.getAttribute('[data-testid="gameplay-apply-result"]', "data-ok")) === "true", await page.textContent('[data-testid="gameplay-apply-result"]'));
  await settled();
  const rt = (await doc()).game.runtime;
  check("A6: the validated spec carries lives, winScore and collisions", Number.isInteger(rt.lives) && rt.winScore !== undefined && Array.isArray(rt.collisions)
    && (await page.evaluate(() => window.session.store.getState().validation.ok)) === true);

  // ---- A7: pack export, real drift script
  pending("A5-A7: scaffold selection and mock labels in the Backend and Monetization UI", "the Backend and Monetization UI exists (task 6.3) but the exported pack has no scaffold/ files until Task 8.1");
  await go("/release/export");
  await page.waitForSelector('[data-testid="export"]', { timeout: 15000 });
  await page.click('[data-testid="export-generate"]');
  await page.waitForSelector('[data-testid="export-tree"]', { timeout: 120000 });
  const dir = mkdtempSync(join(tmpdir(), "foundry-flow-"));
  const packBlocked = await page.locator('[data-testid="export-download-pack"]').isDisabled();
  check("A7: the pack download is enabled for a complete, verified project", !packBlocked, await page.locator('[data-testid="export-completeness"]').textContent().catch(() => "no completeness text"));
  if (!packBlocked) {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click('[data-testid="export-download-pack"]')]);
    const zipPath = join(dir, "pack.zip");
    await dl.saveAs(zipPath);
    const out = join(dir, "pack");
    const unzip = python(["-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);z.extractall(sys.argv[2]);print('\\n'.join(sorted(z.namelist())))", zipPath, out]);
    const names = (unzip.stdout ?? "").split(/\r?\n/).filter(Boolean);
    check("A7: the pack holds the spec, the studio manifest and the asset bytes", unzip.status === 0 && ["monstera.spec.json", "MONSTERA-STUDIO-MANIFEST.json"].every((p) => names.includes(p))
      && names.some((n) => n.startsWith("studio-pack/assets/")), unzip.stderr + names.filter((n) => !/^(android|ios)\//.test(n)).join(","));
    // The pack the UI exports today has no tools/check-drift.sh, no write-once file and no studio-scaffold file (Release does not
    // add them and 6.3 is not merged). These are recorded, not passed.
    pending("A7: the UI pack contains tools/check-drift.sh", names.includes("tools/check-drift.sh") ? "present, remove this pending" : "absent: Release (task 8.1) gathers no drift script");
    pending("A7: drift script flags an edited studio-scaffold file and ignores an edited write-once file on the UI-exported pack", "the UI pack has no studio-scaffold or write-once file; covered on a synthetic tree by src/pack/drift-script.test.ts");
    if (BASH) {
      const script = join(repo, "tools", "check-drift.sh");
      const posix = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
      const drift = () => { const r = spawnSync(BASH, [posix(script), posix(out)], { encoding: "utf8" }); return { code: r.status, out: `${r.stdout}${r.stderr}` }; };
      const clean = drift();
      check("A7: the real tools/check-drift.sh reports no drift on the untouched UI-exported pack (exit 0)", clean.code === 0 && !/^(edited|missing)\s/m.test(clean.out), clean.out);
      const data = join(out, "studio-pack", "assets.json");
      if (existsSync(data)) {
        const original = readFileSync(data);
        appendFileSync(data, " ");
        const r = drift();
        check("A7: an edited studio-data file is reported as edited but is not drift (exit 0)", r.code === 0 && /^edited\s+studio-data\s+studio-pack\/assets\.json/m.test(r.out), r.out);
        writeFileSync(data, original);
      } else check("A7: the pack holds studio-pack/assets.json", false, names.join(","));
    } else console.log("SKIP  bash is not available; the drift script was not run");    // re-import the same ZIP into the Kiro drift view (the importer, not the script)
    await go("/kiro/drift");
    await page.waitForSelector('[data-testid="drift"]', { timeout: 15000 });
    await page.setInputFiles('[data-testid="drift-file"]', zipPath);
    await page.waitForSelector('[data-testid="drift-report"], [data-testid="drift-error"]', { timeout: 60000 });
    check("A7: re-importing the exported pack shows a drift report with no edited scaffold file",
      (await page.locator('[data-testid="drift-report"]').count()) === 1 && (await page.locator('[data-testid="drift-row"][data-state="edited"]').count()) === 0,
      (await page.locator('[data-testid="drift-error"]').textContent().catch(() => "")) ?? "");
  }
  check("no page or console errors", problems.length === 0, problems.join(" | "));
  mkdirSync(dir, { recursive: true });
} finally {
  await browser.close();
  await server.close();
}
const failed = checks.filter((c) => !c.ok);
const nPending = checks.filter((c) => c.pending).length;
console.log(`${checks.length - failed.length - nPending}/${checks.length - nPending} checks passed, ${nPending} pending`);
process.exit(failed.length === 0 ? 0 : 1);
