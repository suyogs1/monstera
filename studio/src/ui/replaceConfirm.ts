// The user-facing half of the replacement preflight (Session.replacementRefusal): when replacing the open project would lose
// data the Session refuses; this asks once, with the consequences written out, and retries only on an explicit yes.
import type { ReplaceOptions, ReplaceOutcome } from "../app/session";

/** The confirmation text: what would be lost, including a memory-only project, in the user's words. */
export function discardQuestion(refusal: Extract<ReplaceOutcome, { code: "would-lose-data" }>): string {
  const reasons = refusal.risks.length > 0 ? refusal.risks.map((r) => r.message).join("\n\n") : refusal.message;
  return `${reasons}\n\nReplace the open project anyway? Whatever is not saved will be lost and cannot be recovered. Choose Cancel to keep working, or export a recovery file first.`;
}

/** Runs a replacement; on a data-loss refusal asks the user and, only if they agree, runs it again with discardUnsaved. */
export async function replaceWithConfirm(
  run: (opts: ReplaceOptions) => Promise<ReplaceOutcome>,
  confirm: (text: string) => boolean = (t) => window.confirm(t),
): Promise<ReplaceOutcome> {
  const first = await run({});
  if (first.ok || first.code !== "would-lose-data") return first;
  if (!confirm(discardQuestion(first))) return { ok: false, message: "Cancelled. The open project was not changed." };
  return run({ discardUnsaved: true });
}
