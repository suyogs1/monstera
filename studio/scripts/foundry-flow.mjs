// Studio Foundry flow (task 9.1, A4, A6, A7): one browser session on the real engine worker and IndexedDB. It imports an image
// with provenance, slices it, defines an animation, turns on gameplay derivation and applies the reviewed change, generates the
// source files, exports and re-imports the project bundle (A3), drives the Backend and Monetization scaffold UI (task 6.3),
// downloads the pack ZIP, extracts it and runs the REAL tools/check-drift.sh on the extracted tree (clean, edited scaffold,
// edited write-once, missing scaffold). Then it re-imports an edited ZIP into the Kiro drift view and compares the view with
// the script. Serves dist/ with `vite preview` (run `npm run build` first).
// Env: SMOKE_CHANNEL (e.g. "chrome"). Exit code 1 on any failed check. Writes nothing under docs/evidence/.
// Nothing is recorded as PENDING here any more; a PENDING line would mean a step could not run.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  const dir = mkdtempSync(join(tmpdir(), "foundry-flow-"));
  const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
  // The project as the user sees it: engine canonical spec, its hash, manifests with sorted keys, and every asset's SHA-256.
  const projectState = () => page.evaluate(async () => {
    const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
    const hex = async (b) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
    const s = window.session.store.getState(), p = window.session.project.getState();
    const assets = {};
    for (const a of p.manifests.assets.assets) assets[a.id] = await hex(await window.session.project.assetBytes(a.id));
    return { key: p.projectKey, canonical: s.validation.canonicalText, sha: s.validation.sha256, manifests: JSON.stringify(sortKeys(p.manifests)), assets };
  });

  // ---- A3 second half: export the project bundle, import it, find the identical project
  await go("/dashboard");
  await page.waitForSelector('[data-testid="bundle-export"]', { timeout: 15000 });
  const exported = await projectState();
  const [bdl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click('[data-testid="bundle-export"]')]);
  const bundlePath = join(dir, "bundle.zip");
  await bdl.saveAs(bundlePath);
  const bundleBytes = readFileSync(bundlePath);
  const bundleNames = (python(["-c", "import sys,zipfile;print('\\n'.join(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))", bundlePath]).stdout ?? "").split(/\r?\n/).filter(Boolean);
  check("A3: the bundle holds the spec, every manifest and the asset bytes", bundleNames.includes("monstera.spec.json") && bundleNames.some((n) => n === "studio-pack/project.json")
    && bundleNames.some((n) => n.startsWith("studio-pack/assets/asset-0001/")), bundleNames.join(","));
  await page.setInputFiles('[data-testid="bundle-import-file"]', bundlePath);
  await page.waitForFunction((k) => window.session.project.getState().projectKey !== k, exported.key, { timeout: 60000 });
  await settled();
  await page.waitForFunction(() => (document.querySelector('[data-testid="project-notice"]')?.textContent ?? "").includes("Imported"), null, { timeout: 15000 });
  const imported = await projectState();
  check("A3: importing the bundle opens a new project with the identical spec, manifests and asset bytes",
    imported.key !== exported.key && imported.canonical === exported.canonical && imported.sha === exported.sha && imported.manifests === exported.manifests
    && JSON.stringify(imported.assets) === JSON.stringify(exported.assets) && Object.keys(imported.assets).length === 1, `${imported.key} vs ${exported.key}`);
  const reExport = await page.evaluate(async () => {
    const r = await window.session.exportBundleBytes();
    if (!r.ok) return { error: r.message };
    return { hex: [...new Uint8Array(await crypto.subtle.digest("SHA-256", r.bytes))].map((x) => x.toString(16).padStart(2, "0")).join("") };
  });
  check("A3: exporting the imported project again gives a byte-identical bundle", reExport.hex === sha256(bundleBytes), JSON.stringify(reExport));
  const hostile = join(dir, "hostile.zip");
  python(["-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1],'w');z.writestr('../x','x');z.close()", hostile]);
  await page.setInputFiles('[data-testid="bundle-import-file"]', hostile);
  await page.waitForFunction(() => (document.querySelector('[data-testid="project-notice"]')?.textContent ?? "").includes("Could not import"), null, { timeout: 15000 });
  const afterHostile = await projectState();
  check("A3: a hostile bundle (a ../x entry) is refused with a notice and the open project is unchanged", afterHostile.key === imported.key && afterHostile.manifests === imported.manifests && afterHostile.canonical === imported.canonical
    && (await page.getAttribute('[data-testid="project-notice"]', "role")) === "alert");

  // ---- A6/task 6.3: the Backend and Monetization scaffold UI, for real
  await go("/backend/firebase");
  await page.waitForSelector('[data-testid="backend-firebase"]', { timeout: 15000 });
  check("A6: the Backend view carries the permanent scaffold banner and has no text, password or free-form input",
    (await page.locator('[data-testid="scaffold-banner"][data-kind="backend"]').count()) === 1
    && (await page.locator('[data-testid="backend-firebase"] input:not([type="checkbox"]), [data-testid="backend-firebase"] textarea').count()) === 0);
  const auth = page.locator('[data-testid="backend-firebase"] label').filter({ hasText: /^\s*auth\s*$/ }).locator("input");
  if (!(await auth.isChecked())) await auth.check();
  await page.waitForFunction(() => window.session.project.getState().manifests.integrations.backend.services.auth === true, null, { timeout: 15000 });
  // The preview re-renders after the manifest commit; wait for it instead of reading it in the same tick.
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="scaffold-preview"]')].some((e) => /AUTH: Boolean = true/.test(e.textContent ?? "")), null, { timeout: 15000 }).catch(() => undefined);
  const previews = await page.locator('[data-testid="scaffold-preview"]').allTextContents();
  // configFiles is read-only and empty in a new project: the list shows exactly what the manifest holds.
  const configCount = await page.locator('[data-testid="config-files"] li').count();
  const configWant = (await manifests()).integrations.backend.configFiles.length;
  check("A6: choosing the auth service writes it to the integrations manifest and the scaffold preview shows it, labelled GENERATED",
    previews.length > 0 && previews.every((t) => t.includes("GENERATED")) && previews.some((t) => /AUTH: Boolean = true/.test(t)) && configCount === configWant,
    `previews=${previews.length} generated=${previews.filter((t) => t.includes("GENERATED")).length} auth=${previews.some((t) => /AUTH: Boolean = true/.test(t))} configFiles=${configCount}`);
  await settled();
  await go("/monetization/placements");
  await page.waitForSelector('[data-testid="monetization-placements"]', { timeout: 15000 });
  const modeOptions = await page.locator('[data-testid="monetization-placements"] select').first().locator("option").allTextContents();
  const unitFields = await page.locator('[data-testid="monetization-placements"] input, [data-testid="monetization-placements"] textarea').evaluateAll((els) => els.filter((e) => /unit|app.?id|key/i.test(`${e.getAttribute("aria-label") ?? ""} ${e.name ?? ""}`)).length);
  check("A6: the Monetization view carries the banner, offers only mock and test, and has no ad unit id field",
    (await page.locator('[data-testid="scaffold-banner"][data-kind="monetization"]').count()) === 1 && JSON.stringify(modeOptions) === JSON.stringify(["mock", "test"]) && unitFields === 0, JSON.stringify(modeOptions));
  const placementsBefore = (await manifests()).integrations.monetization.placements.length;
  await page.click('[data-testid="placement-add"]');
  await page.waitForFunction((n) => window.session.project.getState().manifests.integrations.monetization.placements.length === n + 1, placementsBefore, { timeout: 15000 });
  check("A6: adding a placement shows a new placement form and no refusal notice",
    (await page.locator('fieldset[data-testid^="placement-"]').count()) === placementsBefore + 1 && (await page.locator('[data-testid="integrations-notice"]').count()) === 0);
  await go("/monetization/mock");
  await page.waitForSelector('[data-testid="monetization-mock"]', { timeout: 15000 });
  const mockPreviews = await page.locator('[data-testid="scaffold-preview"]').allTextContents();
  check("A6: the mock view lists the frequency rules and labels every previewed file GENERATED and MOCK",
    (await page.locator('[data-testid="frequency-rules"] li').count()) > 1 && mockPreviews.length > 0 && mockPreviews.every((t) => t.includes("GENERATED")) && mockPreviews.some((t) => t.includes("MOCK")));
  await settled();

  // ---- A7: pack export, real drift script
  await go("/release/export");
  await page.waitForSelector('[data-testid="export"]', { timeout: 15000 });
  await page.click('[data-testid="export-generate"]');
  await page.waitForSelector('[data-testid="export-tree"]', { timeout: 120000 });
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
    const SCAFFOLD = "studio-pack/scaffold/android/AdService.kt";
    const ONCE = ".kiro/steering/studio-ownership.md";
    check("A7: the UI pack contains the drift script, the scaffold files and the Kiro files", names.includes("tools/check-drift.sh") && names.includes(SCAFFOLD) && names.includes("studio-pack/scaffold/SETUP.md") && names.includes(ONCE)
      && names.includes(".kiro/hooks/studio-drift-check.json"), names.filter((n) => !/^(android|ios)\//.test(n)).join(","));
    const firebaseKt = join(out, "studio-pack", "scaffold", "android", "FirebaseServices.kt");
    check("A7: the exported scaffold carries the service chosen in the UI", existsSync(firebaseKt) && /AUTH: Boolean = true/.test(readFileSync(firebaseKt, "utf8")));
    const classes = JSON.parse(readFileSync(join(out, "MONSTERA-STUDIO-MANIFEST.json"), "utf8")).files ?? [];
    const classOfPath = (p) => classes.find((f) => f.path === p)?.class;
    check("A7: the ownership manifest classes the drift script and scaffold as studio-scaffold and the Kiro file as write-once",
      classOfPath("tools/check-drift.sh") === "studio-scaffold" && classOfPath(SCAFFOLD) === "studio-scaffold" && classOfPath(ONCE) === "write-once" && classOfPath("studio-pack/assets.json") === "studio-data",
      JSON.stringify(classes.slice(0, 3)));
    const posix = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
    if (BASH) {
      const drift = (tree = out) => { const r = spawnSync(BASH, [posix(join(tree, "tools", "check-drift.sh")), posix(tree)], { encoding: "utf8" }); return { code: r.status, out: `${r.stdout}${r.stderr}` }; };
      const clean = drift();
      check("A7: the pack's own tools/check-drift.sh reports no drift on the untouched UI-exported pack (exit 0)", clean.code === 0 && !/^(edited|missing)\s/m.test(clean.out), clean.out);
      const touch = (rel, fn) => { const p = join(out, rel); const original = readFileSync(p); try { return fn(p); } finally { writeFileSync(p, original); } };
      const e1 = touch(SCAFFOLD, (p) => { appendFileSync(p, " "); return drift(); });
      check("A7: an edited studio-scaffold file is reported as edited and is drift (exit 1)", e1.code === 1 && /^edited\s+studio-scaffold\s+studio-pack\/scaffold\/android\/AdService\.kt/m.test(e1.out), `${e1.code} ${e1.out}`);
      const e2 = touch(ONCE, (p) => { appendFileSync(p, "\nmine\n"); return drift(); });
      check("A7: an edited write-once file is listed as edited but is not drift (exit 0)", e2.code === 0 && /^edited\s+write-once\s+\.kiro\/steering\/studio-ownership\.md/m.test(e2.out) && /scaffold-drift=0/.test(e2.out), `${e2.code} ${e2.out}`);
      const e3 = touch(SCAFFOLD, (p) => { rmSync(p); return drift(); });
      check("A7: a deleted studio-scaffold file is reported as missing and is drift (exit 1)", e3.code === 1 && /^missing\s+studio-scaffold\s+studio-pack\/scaffold\/android\/AdService\.kt/m.test(e3.out), `${e3.code} ${e3.out}`);
      const data = join(out, "studio-pack", "assets.json");
      if (existsSync(data)) {
        const original = readFileSync(data);
        appendFileSync(data, " ");
        const r = drift();
        check("A7: an edited studio-data file is reported as edited but is not drift (exit 0)", r.code === 0 && /^edited\s+studio-data\s+studio-pack\/assets\.json/m.test(r.out), r.out);
        writeFileSync(data, original);
      } else check("A7: the pack holds studio-pack/assets.json", false, names.join(","));
      // ---- re-import an EDITED ZIP into the Kiro drift view and compare it with the script on the same tree
      const editedZip = join(dir, "edited.zip");
      const edit = python(["-c", "import sys,zipfile\nsrc,dst,a,b=sys.argv[1:5]\nzi=zipfile.ZipFile(src);zo=zipfile.ZipFile(dst,'w',zipfile.ZIP_DEFLATED)\nfor i in zi.infolist():\n    d=zi.read(i.filename)\n    if i.filename in (a,b): d+=b'\\n// edited\\n'\n    zo.writestr(i,d)\nzo.close()", zipPath, editedZip, SCAFFOLD, ONCE]);
      const out2 = join(dir, "edited");
      python(["-c", "import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", editedZip, out2]);
      const scriptRows = new Set(drift(out2).out.split(/\r?\n/).map((l) => l.match(/^(unchanged|edited|missing|unknown)\s+(\S+)\s+(.+)$/)).filter(Boolean).map((m) => `${m[1]}|${m[2]}|${m[3]}`));
      await go("/kiro/drift");
      await page.waitForSelector('[data-testid="drift"]', { timeout: 15000 });
      await page.setInputFiles('[data-testid="drift-file"]', editedZip);
      await page.waitForSelector('[data-testid="drift-report"], [data-testid="drift-error"]', { timeout: 60000 });
      const viewRows = new Set(await page.locator('[data-testid="drift-row"]').evaluateAll((rs) => rs.map((r) => `${r.getAttribute("data-state")}|${r.children[1].textContent}|${r.children[2].textContent}`)));
      const summary = (await page.textContent('[data-testid="drift-summary"]').catch(() => "")) ?? "";
      check("A7: re-importing the edited pack flags the edited scaffold file as drift and the edited write-once file as not drift",
        edit.status === 0 && viewRows.has(`edited|studio-scaffold|${SCAFFOLD}`) && viewRows.has(`edited|write-once|${ONCE}`) && /1 scaffold file drifted/.test(summary), `${edit.stderr} ${summary}`);
      const same = scriptRows.size > 0 && [...scriptRows].every((r) => viewRows.has(r)) && [...viewRows].every((r) => scriptRows.has(r));
      check("A7: the Drift view and the real check-drift.sh give the same (state, class, path) rows on the same tree", same,
        `only script: ${[...scriptRows].filter((r) => !viewRows.has(r)).join("; ")} only view: ${[...viewRows].filter((r) => !scriptRows.has(r)).join("; ")}`);
    } else console.log("SKIP  bash is not available; the drift script was not run");
    // re-import the untouched ZIP into the Kiro drift view (the importer, not the script)
    await go("/kiro/drift");
    await page.waitForSelector('[data-testid="drift"]', { timeout: 15000 });
    await page.setInputFiles('[data-testid="drift-file"]', zipPath);
    await page.waitForFunction(() => /0 edited, 0 missing/.test(document.querySelector('[data-testid="drift-summary"]')?.textContent ?? "") || document.querySelector('[data-testid="drift-error"]') !== null, null, { timeout: 60000 });
    check("A7: re-importing the untouched exported pack shows a drift report with no edited scaffold file",
      (await page.locator('[data-testid="drift-report"]').count()) === 1 && (await page.locator('[data-testid="drift-row"][data-state="edited"]').count()) === 0,
      (await page.locator('[data-testid="drift-error"]').textContent().catch(() => "")) ?? "");
  }
  check("no page or console errors", problems.length === 0, problems.join(" | "));
} finally {
  await browser.close();
  await server.close();
}
const failed = checks.filter((c) => !c.ok);
const nPending = checks.filter((c) => c.pending).length;
console.log(`${checks.length - failed.length - nPending}/${checks.length - nPending} checks passed, ${nPending} pending`);
process.exit(failed.length === 0 ? 0 : 1);
