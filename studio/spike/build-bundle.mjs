// Packs the UNMODIFIED engine (and the data it reads) at its repository-relative paths, and copies
// the pinned Pyodide runtime next to it. Output: dist/ (git-ignored). Prints raw/gzip/brotli sizes.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "..", "..");
const dist = join(here, "dist");
const GAMES = ["pumpkin-blaster", "trick-or-treat-rush"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "__pycache__") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (!name.endsWith(".pyc")) out.push(full);
  }
  return out;
}

const wanted = [
  ...walk(join(repo, "tools", "monstera", "monstera")),
  ...readdirSync(join(repo, "spec", "schema")).filter((n) => n.endsWith(".json")).sort()
    .map((n) => join(repo, "spec", "schema", n)),
  ...GAMES.flatMap((g) => [
    join(repo, "apps", g, "monstera.spec.json"),
    ...readdirSync(join(repo, "spec", "scenarios", g)).filter((n) => n.endsWith(".json")).sort()
      .map((n) => join(repo, "spec", "scenarios", g, n)),
  ]),
];

const files = wanted.map((full) => {
  const data = readFileSync(full);
  const p = relative(repo, full).split(sep).join("/");
  const text = !p.endsWith(".jar");
  // A Windows checkout may hold CRLF in apps/** (git text=auto); the repository blob, and every Linux
  // checkout, is LF. Bundle the LF form. Only .bat files keep CRLF by design.
  const lf = (s) => (p.endsWith(".bat") ? s : s.replace(/\r\n/g, "\n"));
  return text ? { p, e: "u", d: lf(data.toString("utf8")) } : { p, e: "b", d: data.toString("base64") };
});
// Text must round-trip exactly; the engine hashes bytes.
for (const f of files) {
  const onDisk = readFileSync(join(repo, f.p)).toString("utf8");
  if (f.e === "u" && f.d !== (f.p.endsWith(".bat") ? onDisk : onDisk.replace(/\r\n/g, "\n"))) {
    throw new Error(`${f.p} does not round-trip as UTF-8`);
  }
  if (f.e === "u" && f.d.includes("\r") && !f.p.endsWith(".bat")) throw new Error(`${f.p} has CR`);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "pyodide"), { recursive: true });
const bundlePath = join(dist, "engine-bundle.json");
writeFileSync(bundlePath, JSON.stringify({ files }));

const py = join(here, "node_modules", "pyodide");
const runtime = ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
for (const n of runtime) copyFileSync(join(py, n), join(dist, "pyodide", n));
for (const n of ["worker.js", "harness.html", "glue.py"]) copyFileSync(join(here, n), join(dist, n));

const rows = [["engine-bundle.json", bundlePath], ...runtime.map((n) => [`pyodide/${n}`, join(dist, "pyodide", n)])];
const sizes = rows.map(([name, path]) => {
  const buf = readFileSync(path);
  return { name, raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length, brotli: brotliCompressSync(buf).length };
});
const total = sizes.reduce((a, s) => ({ raw: a.raw + s.raw, gzip: a.gzip + s.gzip, brotli: a.brotli + s.brotli }), { raw: 0, gzip: 0, brotli: 0 });
const report = {
  pyodide: JSON.parse(readFileSync(join(py, "package.json"), "utf8")).version,
  engineFiles: files.length,
  engineTextFiles: files.filter((f) => f.e === "u").length,
  engineBinaryFiles: files.filter((f) => f.e === "b").map((f) => f.p),
  sizes, total,
};
writeFileSync(join(dist, "bundle-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
