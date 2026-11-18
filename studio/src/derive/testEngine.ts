// Test engine for derive tests: validateDraft is answered by the real Python CLI (`monstera validate`), the oracle by a counter
// (the real oracle runs in the browser harness). Imported by tests only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DraftValidation, OracleCheck } from "../engine/protocol";
import { stableText } from "../project/record";
import type { ApplyEngine } from "./apply";
const repo = join(__dirname, "..", "..", "..");
const dir = mkdtempSync(join(tmpdir(), "monstera-apply-"));
/** validateDraft answered by the real Python CLI; preview answered by a counter (the oracle itself is covered in the browser harness). */
function realValidate(text: string): DraftValidation {
  const file = join(dir, `d${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, text);
  let out = "";
  for (const c of [["python3"], ["python"], ["py", "-3"]]) {
    try { out = execFileSync(c[0] as string, [...c.slice(1), join(repo, "tools", "monstera", "monstera.py"), "validate", file, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); break; } catch (e: any) {
      if (e?.stdout) { out = String(e.stdout); break; }
    }
  }
  const r = JSON.parse(out) as { valid: boolean; issues: { path: string; code: string; message: string }[] };
  const canonicalText = stableText(JSON.parse(text));
  return { ok: r.valid, parsed: true, issues: r.issues, sha256: r.valid ? createHash("sha256").update(canonicalText).digest("hex") : null, canonicalText };
}
export class Engine implements ApplyEngine {
  calls = 0; failOracle: string | null = null;
  /** Runs while the oracle is "executing" (lets a test edit the project meanwhile). */
  during: (() => void) | null = null;
  /** When set, the engine answers with these issues instead of the CLI verdict (the CLI is lenient about level content). */
  forceIssues: { path: string; code: string; message: string }[] | null = null;
  async validateDraft(text: string) {
    const v = realValidate(text);
    return this.forceIssues ? { ...v, ok: false, sha256: null, issues: this.forceIssues } : v;
  }
  async oracleCheck(_text: string, seed: number, ticks: number): Promise<OracleCheck> {
    this.calls++;
    this.during?.();
    if (this.failOracle) return { ok: false, stage: "run", message: this.failOracle };
    return { ok: true, sha256: "", seed, ticks, ended: false, score: 0, lives: 3, entities: 0, hash: "0".repeat(16), ms: 0 };
  }
}
