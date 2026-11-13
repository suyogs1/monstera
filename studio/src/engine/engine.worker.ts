// Pyodide worker: unpacks the unmodified engine into the virtual filesystem and calls glue.py.
// Pyodide itself is a same-origin static file loaded at run time (not bundled by Vite).
import glueSource from "./glue.py?raw";
import type { WorkerRequest, WorkerResponse, EngineTimings } from "./protocol";

interface PyProxyLike { toJs?: () => unknown; destroy?: () => void }
interface PyodideLike {
  FS: { mkdirTree(p: string): void; writeFile(p: string, d: string | Uint8Array): void };
  runPython(code: string): unknown;
  pyimport(name: string): Record<string, (...a: unknown[]) => unknown> & PyProxyLike;
}
interface BundleFile { p: string; d: string }
interface Bundle { files: BundleFile[]; templates: unknown[] }

let py: PyodideLike | undefined;
let glue: (PyodideLike["pyimport"] extends (n: string) => infer R ? R : never) | undefined;

async function init(base: string): Promise<{ timings: EngineTimings; templates: unknown[] }> {
  const t0 = performance.now();
  const mod = (await import(/* @vite-ignore */ `${base}pyodide/pyodide.mjs`)) as {
    loadPyodide(o: { indexURL: string }): Promise<PyodideLike>;
  };
  py = await mod.loadPyodide({ indexURL: `${base}pyodide/` });
  const pyodideMs = performance.now() - t0;

  const t1 = performance.now();
  const bundle = (await (await fetch(`${base}engine/engine-bundle.json`)).json()) as Bundle;
  const bundleFetchMs = performance.now() - t1;

  const t2 = performance.now();
  const made = new Set<string>();
  for (const f of bundle.files) {
    const full = `/repo/${f.p}`;
    const dir = full.slice(0, full.lastIndexOf("/"));
    if (!made.has(dir)) { py.FS.mkdirTree(dir); made.add(dir); }
    py.FS.writeFile(full, new TextEncoder().encode(f.d));
  }
  const unpackMs = performance.now() - t2;

  const t3 = performance.now();
  py.FS.writeFile("/glue.py", glueSource);
  py.runPython("import sys; sys.path.insert(0, '/'); import glue");
  glue = py.pyimport("glue");
  const importEngineMs = performance.now() - t3;
  return {
    templates: bundle.templates,
    timings: { pyodideMs, bundleFetchMs, unpackMs, importEngineMs, totalMs: performance.now() - t0, files: bundle.files.length },
  };
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  const reply = (r: WorkerResponse) => self.postMessage(r);
  try {
    if (msg.cmd === "init") {
      reply({ id: msg.id, ok: true, value: await init(msg.base) });
      return;
    }
    const fn = glue?.[msg.fn];
    if (!fn) throw new Error(`engine function '${msg.fn}' is not available (engine not ready?)`);
    reply({ id: msg.id, ok: true, value: fn(...msg.args) });
  } catch (err) {
    reply({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
