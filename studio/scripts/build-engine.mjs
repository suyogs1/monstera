// Packs the UNMODIFIED engine (and the data it reads) at its repository-relative paths and copies the
// pinned Pyodide runtime next to it. Output (git-ignored): public/engine/, public/pyodide/.
// Adapted from studio/spike/build-bundle.mjs; the spike stays untouched so M0 remains reproducible.
// M1 validates and serializes only, so scenarios and the Gradle wrapper jar are not bundled (M2 adds them).
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

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "__pycache__") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (!name.endsWith(".pyc") && !name.endsWith(".jar")) out.push(full); // the wrapper jar is only read by generate (M2)
  }
  return out;
}

const wanted = [
  ...walk(join(repo, "tools", "monstera", "monstera")),
  ...readdirSync(join(repo, "spec", "schema")).filter((n) => n.endsWith(".json")).sort()
    .map((n) => join(repo, "spec", "schema", n)),
  ...TEMPLATES.map((t) => join(repo, ...t.path.split("/"))),
];

// A Windows checkout may hold CRLF (git text=auto); the repository blob is LF. Bundle the LF form.
const lf = (s) => s.replace(/\r\n/g, "\n");
const files = wanted.map((full) => {
  const p = relative(repo, full).split(sep).join("/");
  const text = readFileSync(full).toString("utf8");
  const d = p.endsWith(".bat") ? text : lf(text);
  if (d.includes("\r") && !p.endsWith(".bat")) throw new Error(`${p} contains a lone CR`);
  return { p, d };
});

const outEngine = join(studio, "public", "engine");
const outPyodide = join(studio, "public", "pyodide");
rmSync(outEngine, { recursive: true, force: true });
rmSync(outPyodide, { recursive: true, force: true });
mkdirSync(outEngine, { recursive: true });
mkdirSync(outPyodide, { recursive: true });

const bundle = JSON.stringify({ files, templates: TEMPLATES });
writeFileSync(join(outEngine, "engine-bundle.json"), bundle);

const py = join(studio, "node_modules", "pyodide");
const runtime = ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
for (const n of runtime) copyFileSync(join(py, n), join(outPyodide, n));
const version = JSON.parse(readFileSync(join(py, "package.json"), "utf8")).version;
if (version !== "0.29.5") throw new Error(`Pyodide must be 0.29.5 (design D5), found ${version}`);

const brotli = (b) => brotliCompressSync(b).length;
const sizes = [["engine-bundle.json", bundle.length, brotli(Buffer.from(bundle))],
  ...runtime.map((n) => { const b = readFileSync(join(outPyodide, n)); return [`pyodide/${n}`, b.length, brotli(b)]; })];
console.log(`engine bundle: ${files.length} files; pyodide ${version}`);
for (const [n, raw, br] of sizes) console.log(`  ${n.padEnd(28)} raw ${raw}  brotli ${br}`);
console.log(`  total brotli ${sizes.reduce((a, s) => a + s[2], 0)}`);
