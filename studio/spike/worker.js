// Pyodide worker: unpacks the unmodified engine into the virtual filesystem and calls glue.py.
import { loadPyodide } from "/pyodide/pyodide.mjs";

let py;
const timings = {};

async function init() {
  const t0 = performance.now();
  py = await loadPyodide({ indexURL: "/pyodide/" });
  timings.pyodideMs = performance.now() - t0;

  const t1 = performance.now();
  const res = await fetch("/engine-bundle.json");
  const bundle = await res.json();
  timings.bundleFetchMs = performance.now() - t1;

  const t2 = performance.now();
  const made = new Set();
  for (const f of bundle.files) {
    const full = "/repo/" + f.p;
    const dir = full.slice(0, full.lastIndexOf("/"));
    if (!made.has(dir)) { py.FS.mkdirTree(dir); made.add(dir); }
    const data = f.e === "u"
      ? new TextEncoder().encode(f.d)
      : Uint8Array.from(atob(f.d), (c) => c.charCodeAt(0));
    py.FS.writeFile(full, data);
  }
  timings.unpackMs = performance.now() - t2;
  timings.files = bundle.files.length;

  const t3 = performance.now();
  const glue = await (await fetch("/glue.py")).text();
  py.FS.writeFile("/glue.py", glue);
  py.runPython("import sys; sys.path.insert(0, '/'); import glue");
  timings.importEngineMs = performance.now() - t3;
  timings.totalMs = performance.now() - t0;
  timings.memoryBytes = py._module?.HEAP8?.length ?? null;
}

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  try {
    if (cmd === "init") { await init(); self.postMessage({ id, ok: true, value: timings }); return; }
    const t = performance.now();
    const fn = py.pyimport("glue")[cmd];
    const out = fn(...(args ?? []));
    self.postMessage({ id, ok: true, value: out, ms: performance.now() - t });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
