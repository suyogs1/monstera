import type {
  DraftValidation, EngineFunction, EngineTimings, TemplateInfo, TemplateLoad, WorkerRequest, WorkerResponse,
} from "./protocol";

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type Pending = { resolve(v: unknown): void; reject(e: Error): void };

/** Typed client for the Pyodide worker. It forwards calls to the engine and parses JSON; it computes nothing. */
export class EngineClient {
  private readonly worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  templates: TemplateInfo[] = [];
  timings: EngineTimings | undefined;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.value);
      else p.reject(new Error(e.data.error));
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || "engine worker crashed"));
      this.pending.clear();
    };
  }

  private send(req: WithoutId<WorkerRequest>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  async init(): Promise<void> {
    const base = new URL(import.meta.env.BASE_URL, document.baseURI).href;
    const r = (await this.send({ cmd: "init", base })) as { timings: EngineTimings; templates: TemplateInfo[] };
    this.timings = r.timings;
    this.templates = r.templates;
  }

  private async call<T>(fn: EngineFunction, ...args: string[]): Promise<T> {
    return JSON.parse((await this.send({ cmd: "call", fn, args })) as string) as T;
  }

  info() { return this.call<{ python: string; repoRoot: string; schemaDigests: Record<string, string> }>("info"); }
  schemas() { return this.call<Record<string, string>>("schemas"); }
  validateDraft(text: string) { return this.call<DraftValidation>("validate_draft", text); }
  template(path: string) { return this.call<TemplateLoad>("template", path); }
}
