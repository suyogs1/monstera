// Acceptance run for Studio M1 in a real browser (Chrome via Playwright) against the production build (dist/).
// Reference values come from the repository itself: `git show HEAD:<spec>` bytes and `monstera validate --json`.
// Run `npm run build` first. Writes docs/evidence/studio-m1/acceptance.json. Exit code 1 on any failed check.
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
const evidenceDir = join(repo, "docs", "evidence", "studio-m1");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".zip": "application/zip" };
const LIMITS = { coldInitMs: 10000 };

if (!existsSync(join(dist, "index.html"))) throw new Error("dist/ is missing: run `npm run build` first");

const TEMPLATES = [
  { id: "pumpkin-blaster", path: "apps/pumpkin-blaster/monstera.spec.json" },
  { id: "trick-or-treat-rush", path: "apps/trick-or-treat-rush/monstera.spec.json" },
  { id: "lantern-run", path: "spec/samples/lantern-run/monstera.spec.json" },
];

// ------------------------------------------------------------------ references from the repository
const committed = Object.fromEntries(TEMPLATES.map((t) => [t.id,
  execFileSync("git", ["show", `HEAD:${t.path}`], { cwd: repo, maxBuffer: 1 << 24 }).toString("utf8")]));

function pythonCommand() {
  for (const [cmd, args] of [["python3", []], ["python", []], ["py", ["-3"]]]) {
    try { execFileSync(cmd, [...args, "--version"], { stdio: "pipe" }); return [cmd, args]; } catch { /* next */ }
  }
  throw new Error("no Python 3 interpreter found for the CLI reference");
}
const [PY, PYARGS] = pythonCommand();
const scratch = mkdtempSync(join(tmpdir(), "studio-m1-"));
function cliValidate(name, text) {
  const file = join(scratch, name);
  writeFileSync(file, text, "utf8");
  const code = "import sys; from monstera import cli; sys.exit(cli.main(sys.argv[1:]))";
  let out = "";
  try {
    out = execFileSync(PY, [...PYARGS, "-c", code, "validate", "--json", file],
      { cwd: repo, env: { ...process.env, PYTHONPATH: join(repo, "tools", "monstera"), PYTHONIOENCODING: "utf-8" }, stdio: "pipe" }).toString("utf8");
  } catch (e) { out = e.stdout.toString("utf8"); }
  return JSON.parse(out.trim().split("\n")[0]);
}

// ------------------------------------------------------------------ draft cases (edits applied to Pumpkin Blaster)
const base = JSON.parse(committed["pumpkin-blaster"]);
const edit = (fn) => { const d = structuredClone(base); fn(d); return JSON.stringify(d, null, 2); };
const CASES = [
  ...TEMPLATES.map((t) => ({ name: `${t.id}: unmodified`, file: `${t.id}.json`, text: committed[t.id] })),
  { name: "lives 5 -> 6 (valid, new hash)", file: "lives.json", text: edit((d) => { d.game.runtime.lives = 6; }) },
  { name: "palette.primary low contrast (semantic)", file: "contrast.json", text: edit((d) => { d.game.palette.primary = "#120A1F"; }) },
  { name: "tapKind unknown kind (semantic)", file: "kind.json", text: edit((d) => { d.game.input.tapKind = "nope"; }) },
  { name: "unknown property (schema)", file: "extra.json", text: edit((d) => { d.game.bonus = 1; }) },
  { name: "wrong type and range (schema)", file: "types.json", text: edit((d) => { d.game.runtime.lives = 0; d.project.id = "X"; }) },
  { name: "truncated JSON", file: "parse.json", text: '{"specVersion": 4,' },
  { name: "duplicate key", file: "dup.json", text: '{"specVersion": 4, "specVersion": 4}' },
];
const reference = CASES.map((c) => ({ name: c.name, ...cliValidate(c.file, c.text) }));

// ------------------------------------------------------------------ serve dist/
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
await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });

const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });

// ------------------------------------------------------------------ foundation checks
const timings = await page.evaluate(() => window.engine.timings);
check(`engine ready within ${LIMITS.coldInitMs} ms (localhost, cold)`, timings.totalMs <= LIMITS.coldInitMs, `${Math.round(timings.totalMs)} ms; ${timings.files} files`);

const loaded = await page.evaluate((paths) => Promise.all(paths.map((p) => window.engine.template(p))), TEMPLATES.map((t) => t.path));
TEMPLATES.forEach((t, i) => {
  const l = loaded[i];
  check(`${t.id}: valid, and the engine's canonical text equals the committed file byte for byte`,
    l.ok && l.canonicalEqualsFile && l.canonicalText === committed[t.id], `sha256 ${l.sha256}`);
});

const got = await page.evaluate((cases) => Promise.all(cases.map((c) => window.engine.validateDraft(c.text))), CASES);
const norm = (a) => a.map((i) => [i.code, i.message]);
CASES.forEach((c, i) => {
  const ref = reference[i], g = got[i];
  const refIssues = (ref.issues ?? []).map((x) => ({ code: x.code, message: x.message }));
  // A parse failure carries its line and column in the CLI path; the Studio keeps path "$" and appends it to the message.
  const parseCase = !g.parsed;
  const sameIssues = parseCase
    ? g.issues.length === 1 && refIssues.length === 1 && g.issues[0].code === refIssues[0].code && g.issues[0].message.startsWith(refIssues[0].message)
    : JSON.stringify(norm(g.issues)) === JSON.stringify(norm(refIssues));
  check(`validate parity with \`monstera validate --json\`: ${c.name}`,
    g.ok === ref.valid && (g.ok ? g.sha256 === ref.sha256 : true) && sameIssues,
    g.ok ? `valid, ${g.sha256}` : `${g.issues.length} issue(s): ${g.issues.map((x) => x.code).join(", ")}`);
});

// R2.2: edit, then revert, returns the original hash. Edits are made on parsed JSON; the engine canonicalizes.
const revert = await page.evaluate(async (text) => {
  const doc = JSON.parse(text);
  const original = await window.engine.validateDraft(JSON.stringify(doc));
  doc.game.runtime.lives = 9;
  const edited = await window.engine.validateDraft(JSON.stringify(doc));
  doc.game.runtime.lives = 5;
  const reverted = await window.engine.validateDraft(JSON.stringify(doc));
  return { original: original.sha256, edited: edited.sha256, reverted: reverted.sha256 };
}, committed["pumpkin-blaster"]);
check("edit then revert returns the original SHA-256 (R2.2)", revert.original && revert.edited !== revert.original && revert.reverted === revert.original, `${revert.original}`);

// ------------------------------------------------------------------ optional UI checks (added per batch)
const ui = await import("./acceptance-ui.mjs").then((m) => m.default, () => null);
if (ui) await ui({ page, origin, check, committed, TEMPLATES });

// ------------------------------------------------------------------ boundaries
const external = requests.filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:"));
check("no request leaves the origin (no backend, no third party)", external.length === 0, external.join(", ") || "all same-origin");
check("no console or page errors", errors.length === 0, errors.join(" | "));

const browserVersion = browser.version();
await browser.close();
server.close();
rmSync(scratch, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
const result = { verdict: failed.length ? "FAIL" : "PASS", browser: `Chrome ${browserVersion}`, engineTimings: timings, checks };
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, "acceptance.json"), JSON.stringify(result, null, 2) + "\n");
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
console.log(`\n${result.verdict}: ${checks.length - failed.length}/${checks.length} checks, Chrome ${browserVersion}`);
process.exit(failed.length ? 1 : 0);
