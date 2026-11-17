// Test helpers for Session persistence tests. Imported by tests only (never by application code).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineClient } from "../engine/client";
import type { DraftValidation, TemplateInfo, TemplateLoad } from "../engine/protocol";
import type { Schedule } from "../project/controller";
import { sha256Hex, stableText } from "../project/record";
import { pumpkinText } from "../project/testkit";
import { Session, type SessionDeps } from "./session";

const schemaDir = join(__dirname, "..", "..", "..", "spec", "schema");
const SCHEMAS = Object.fromEntries(
  ["monstera.spec.schema.json", "project.schema.json", "game.schema.json"].map((n) => [n, readFileSync(join(schemaDir, n), "utf8")]));

export const PUMPKIN_PATH = "apps/pumpkin-blaster/monstera.spec.json";

/**
 * Only what Session uses. validateDraft returns the canonical text a real engine would (sorted keys, two-space indent, one
 * trailing newline) and its SHA-256. `reject` makes it answer "not parseable" for a text, like the strict loader would.
 */
export class FakeEngine {
  templates: TemplateInfo[] = [{ id: "pumpkin-blaster", path: PUMPKIN_PATH, group: "official" }];
  engine: EngineClient["engine"] = { gitCommit: "e".repeat(40), dirty: false, source: "git" };
  onReply: EngineClient["onReply"];
  failInit: string | null = null;
  reject: (text: string) => boolean = () => false;
  validateCalls: string[] = [];
  /** Canonical text overrides by input text (to model an engine whose canonical form differs). */
  override = new Map<string, string>();
  /** When set, the engine reports this SHA-256 instead of the real one. */
  badSha: string | null = null;

  async init(): Promise<void> { if (this.failInit) throw new Error(this.failInit); }
  async schemas(): Promise<Record<string, string>> { return SCHEMAS; }

  /** Engine calls not yet answered; drain() waits for it to reach 0 (a real engine answers asynchronously too). */
  inflight = 0;

  async validateDraft(text: string): Promise<DraftValidation> {
    this.inflight++;
    try { return await this.answer(text); } finally { this.inflight--; }
  }

  private async answer(text: string): Promise<DraftValidation> {
    this.validateCalls.push(text);
    let parsed: unknown;
    try {
      if (this.reject(text)) throw new Error("rejected");
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, parsed: false, issues: [{ path: "$", code: "json.syntax", message: "not JSON" }], sha256: null, canonicalText: null };
    }
    const canonicalText = this.override.get(text) ?? stableText(parsed);
    return { ok: true, parsed: true, issues: [], sha256: this.badSha ?? await sha256Hex(canonicalText), canonicalText };
  }

  async template(path: string): Promise<TemplateLoad> {
    if (path !== PUMPKIN_PATH) throw new Error(`unknown template ${path}`);
    const v = await this.validateDraft(pumpkinText);
    return { ...v, path, fileText: pumpkinText, canonicalEqualsFile: v.canonicalText === pumpkinText };
  }
}

/** A manual clock: nothing runs until the test says so. */
export class ManualSchedule {
  private tasks: { fn: () => void; live: boolean }[] = [];
  readonly schedule: Schedule = (fn) => {
    const t = { fn, live: true };
    this.tasks.push(t);
    return () => { t.live = false; };
  };
  get pending(): number { return this.tasks.filter((t) => t.live).length; }
  /** Runs every live task once, in order (tasks they schedule wait for the next call). */
  runDue(): number {
    const due = this.tasks.filter((t) => t.live);
    this.tasks = [];
    for (const t of due) { t.live = false; t.fn(); }
    return due.length;
  }
}

export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

export interface Harness { session: Session; engine: FakeEngine; clock: ManualSchedule }

/** Polls (event ticks, no wall-clock sleeping) until the condition holds. */
export async function until(cond: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`until: ${what} never became true`);
}

export function harness(deps: Omit<SessionDeps, "engine" | "schedule"> = {}, engine = new FakeEngine()): Harness {
  const clock = new ManualSchedule();
  const session = new Session({ engine: engine as unknown as EngineClient, schedule: clock.schedule, ...deps });
  return { session, engine, clock };
}

/** Lets every scheduled validation and save run, and every write settle (event-driven; no sleeping on wall time). */
export async function drain(h: Harness): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await tick();
    while (h.engine.inflight > 0) await tick();
    if (h.clock.runDue() === 0) {
      await h.session.project.whenSettled();
      await tick();
      if (h.clock.pending === 0) return;
    }
  }
  throw new Error("drain: scheduled work never settled");
}
