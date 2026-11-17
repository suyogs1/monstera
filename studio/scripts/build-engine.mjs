// Packs the UNMODIFIED engine (and the data it reads) at its repository-relative paths and copies the
// pinned Pyodide runtime next to it. Output (git-ignored): public/engine/, public/pyodide/.
// Adapted from studio/spike/build-bundle.mjs; the spike stays untouched so M0 remains reproducible.
// M2 restores what M1 left out: golden scenarios (and the sample specs they reference) and the Gradle wrapper jar.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync } from "node:zlib";

const here = fileURLToPath(new URL(".", import.meta.url));
const studio = join(here, "..");
const repo = join(studio, "..");

// Templates: the two official games (apps/) and one clearly separate Kiro-authored sample (spec/samples/).
const TEMPLATES = [
  { id: "pumpkin-blaster", path: "apps/pumpkin-blaster/monstera.spec.json", group: "official" },
  { id: "trick-or-treat-rush", path: "apps/trick-or-treat-rush/monstera.spec.json", group: "official" },
  { id: "lantern-run", path: "spec/samples/lantern-run/monstera.spec.json", group: "kiro-sample" },
];

// Binary files are stored base64 ({ e: "b" }); the engine reads the Gradle wrapper jar when it plans a project.
const BINARY = (p) => p.endsWith(".jar");
function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "__pycache__") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (!name.endsWith(".pyc")) out.push(full);
  }
  return out;
}

// Scenarios reference a spec by repository path; every referenced spec must be present (checked below).
const SCENARIO_SPECS = ["spec/samples/monstera-sample", "spec/samples/boundary-lab"]
  .map((d) => join(repo, ...d.split("/"), "monstera.spec.json"));

const wanted = [
  ...walk(join(repo, "tools", "monstera", "monstera")),
  ...readdirSync(join(repo, "spec", "schema")).filter((n) => n.endsWith(".json")).sort()
    .map((n) => join(repo, "spec", "schema", n)),
  ...walk(join(repo, "spec", "scenarios")).filter((f) => f.endsWith(".scenario.json")),
  ...TEMPLATES.map((t) => join(repo, ...t.path.split("/"))),
  ...SCENARIO_SPECS,
];

// A Windows checkout may hold CRLF (git text=auto); the repository blob is LF. Bundle the LF form.
const lf = (s) => s.replace(/\r\n/g, "\n");
const files = wanted.map((full) => {
  const p = relative(repo, full).split(sep).join("/");
  if (BINARY(p)) return { p, e: "b", d: readFileSync(full).toString("base64") };
  const text = readFileSync(full).toString("utf8");
  const d = p.endsWith(".bat") ? text : lf(text);
  if (d.includes("\r") && !p.endsWith(".bat")) throw new Error(`${p} contains a lone CR`);
  return { p, d };
});

// Every binary must equal the blob git stores (a checkout filter must never alter it), and every spec a bundled
// scenario points at must be bundled.
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
for (const f of files.filter((x) => x.e === "b")) {
  const blob = execFileSync("git", ["show", `HEAD:${f.p}`], { cwd: repo, maxBuffer: 1 << 26 });
  if (sha256(blob) !== sha256(Buffer.from(f.d, "base64"))) throw new Error(`${f.p} differs from the committed blob`);
}
const have = new Set(files.map((f) => f.p));
for (const f of files.filter((x) => x.p.startsWith("spec/scenarios/"))) {
  const ref = JSON.parse(f.d).spec.path;
  if (!have.has(ref)) throw new Error(`${f.p} references ${ref}, which is not in the bundle`);
}

// Engine identity: the repository commit whose engine files were just packed (git rev-parse HEAD), not the Kiro
// inventory stamp. HEAD (not "last commit touching the engine paths") because it needs no history depth, so it is also
// right in shallow clones, and the bundled files ARE the tree at HEAD. `dirty` is true when any packed input differs
// from HEAD, so a bundle built from uncommitted engine files never claims a clean commit. Same fallback convention as
// build-inventory.mjs: no git => VERCEL_GIT_COMMIT_SHA (dirty unknown, recorded as false). Neither => the build fails;
// there is no placeholder.
function engineIdentity() {
  const isSha = (s) => /^[0-9a-f]{40}$/.test(s);
  let sha = "";
  try {
    sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", ...wanted.map((f) => relative(repo, f).split(sep).join("/"))], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim().length > 0;
    if (!isSha(sha)) throw new Error(`git rev-parse HEAD returned ${JSON.stringify(sha)}`);
    return { gitCommit: sha, dirty, source: "git" };
  } catch (e) {
    const env = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").trim().toLowerCase();
    if (isSha(env)) return { gitCommit: env, dirty: false, source: "VERCEL_GIT_COMMIT_SHA" };
    throw new Error(`cannot determine the engine git commit (git: ${e instanceof Error ? e.message : e}; VERCEL_GIT_COMMIT_SHA is not a 40-hex commit). The build refuses to write a placeholder.`);
  }
}
const engine = engineIdentity();
const outEngine = join(studio, "public", "engine");
const outPyodide = join(studio, "public", "pyodide");
rmSync(outEngine, { recursive: true, force: true });
rmSync(outPyodide, { recursive: true, force: true });
mkdirSync(outEngine, { recursive: true });
mkdirSync(outPyodide, { recursive: true });

const bundle = JSON.stringify({ engine, files, templates: TEMPLATES });
writeFileSync(join(outEngine, "engine-bundle.json"), bundle);

const py = join(studio, "node_modules", "pyodide");
const runtime = ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
for (const n of runtime) copyFileSync(join(py, n), join(outPyodide, n));
const version = JSON.parse(readFileSync(join(py, "package.json"), "utf8")).version;
if (version !== "0.29.5") throw new Error(`Pyodide must be 0.29.5 (design D5), found ${version}`);

const brotli = (b) => brotliCompressSync(b).length;
const sizes = [["engine-bundle.json", bundle.length, brotli(Buffer.from(bundle))],
  ...runtime.map((n) => { const b = readFileSync(join(outPyodide, n)); return [`pyodide/${n}`, b.length, brotli(b)]; })];
console.log(`engine bundle: ${files.length} files; engine commit ${engine.gitCommit.slice(0, 7)}${engine.dirty ? " (dirty)" : ""} via ${engine.source}; pyodide ${version}`);
for (const [n, raw, br] of sizes) console.log(`  ${n.padEnd(28)} raw ${raw}  brotli ${br}`);
console.log(`  total brotli ${sizes.reduce((a, s) => a + s[2], 0)}`);
