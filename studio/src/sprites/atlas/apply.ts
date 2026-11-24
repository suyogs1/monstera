// Apply path of sprite authoring: plan -> engine validate -> oracle invariance check -> commit or reject.
//
// planSpriteApply writes exactly two kinds of path into a COPY of the specification: game.atlas and
// game.runtime.kinds[i].sprite. Every other value, including developer-owned content, is carried through unchanged. The
// copy is handed to the unmodified engine (validateDraft is the only authority on atlas and sprite validity, including the
// animated-kind limit) and the oracle is run on the spec before and after: a presentation edit that changes the oracle hash
// is refused. Nothing is committed unless both pass, and the commit goes through the controller's one derived-change seam
// (one undo step, refused if the project changed meanwhile).
import { getAt, setAt } from "../../draft/path";
import type { ApplyEngine, DerivationSink } from "../../derive/apply";
import type { Issue } from "../../engine/protocol";
import type { Json } from "../../schema/schema";
import type { AtlasValue } from "./build";

/** The oracle run covers this many ticks (the same bound as level apply). */
export const SPRITE_ORACLE_TICKS = 600;
export const SPRITE_ORACLE_SEED = 1;

export interface KindSprite { frames: number[]; ticksPerFrame: number }
export interface SpriteChange {
  /** The new game.atlas, or undefined to keep the current one. */
  atlas?: AtlasValue;
  /** New sprite per kind id. Kinds not listed are untouched. */
  sprites: Readonly<Record<string, KindSprite>>;
}
export type SpriteRefusal = { ok: false; stage: "precondition" | "engine" | "oracle"; message: string; issues: Issue[] };
export interface SpritePlan {
  ok: true; doc: Json; canonicalText: string; sha256: string;
  oracle: { ticks: number; hash: string };
}
export type SpriteApplyResult = SpritePlan | SpriteRefusal;

const refuse = (stage: SpriteRefusal["stage"], message: string, issues: Issue[] = []): SpriteRefusal => ({ ok: false, stage, message, issues });

/** Current atlas and per-kind sprites of a document (absent parts are reported as null, never defaulted). */
export function spritesOfDoc(doc: Json): { atlas: AtlasValue | null; kinds: { id: string; sprite: KindSprite | null }[] } {
  const atlas = getAt(doc, ["game", "atlas"]);
  const kinds = getAt(doc, ["game", "runtime", "kinds"]);
  const obj = (v: unknown): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);
  return {
    atlas: obj(atlas) ? (atlas as unknown as AtlasValue) : null,
    kinds: Array.isArray(kinds) ? kinds.filter(obj).map((k) => ({ id: String(k["id"]), sprite: obj(k["sprite"]) ? (k["sprite"] as unknown as KindSprite) : null })) : [],
  };
}

/** Engine issues for the atlas and sprite paths first (they are what the user just did), the rest after, each as one line. */
export function describeIssues(issues: readonly Issue[]): string[] {
  const own = (i: Issue) => i.path.startsWith("$.game.atlas") || /\.sprite(\.|$)/.test(i.path);
  return [...issues.filter(own), ...issues.filter((i) => !own(i))].map((i) => `${i.path}: ${i.message}`);
}

/** Next document for a change. Pure; null with the reason when a kind named by the change does not exist. */
export function applyChange(doc: Json, change: SpriteChange): { ok: true; doc: Json } | { ok: false; message: string } {
  let next = doc;
  if (change.atlas) next = setAt(next, ["game", "atlas"], change.atlas as unknown as Json);
  const kinds = getAt(next, ["game", "runtime", "kinds"]);
  if (!Array.isArray(kinds)) return { ok: false, message: "the specification has no game.runtime.kinds" };
  const ids = kinds.map((k) => (typeof k === "object" && k !== null && !Array.isArray(k) ? (k as Record<string, Json>)["id"] : undefined));
  for (const [kindId, sprite] of Object.entries(change.sprites)) {
    const at = ids.indexOf(kindId);
    if (at < 0) return { ok: false, message: `"${kindId}" is not a kind of this game` };
    next = setAt(next, ["game", "runtime", "kinds", at, "sprite"], { frames: [...sprite.frames], ticksPerFrame: sprite.ticksPerFrame });
  }
  return { ok: true, doc: next };
}

export async function planSpriteApply(doc: Json, change: SpriteChange, engine: ApplyEngine): Promise<SpriteApplyResult> {
  const next = applyChange(doc, change);
  if (!next.ok) return refuse("precondition", next.message);
  const verdict = await engine.validateDraft(JSON.stringify(next.doc, null, 2));
  if (!verdict.ok || verdict.canonicalText === null || verdict.sha256 === null) {
    const lines = describeIssues(verdict.issues);
    return refuse("engine", lines.length > 0 ? lines[0]! : "the engine could not read the changed specification", [...verdict.issues]);
  }
  const before = await engine.validateDraft(JSON.stringify(doc, null, 2));
  if (!before.ok || before.canonicalText === null) return refuse("precondition", "the current specification is not valid, so the effect of the change on the simulation cannot be checked");
  const a = await engine.oracleCheck(before.canonicalText, SPRITE_ORACLE_SEED, SPRITE_ORACLE_TICKS);
  const b = await engine.oracleCheck(verdict.canonicalText, SPRITE_ORACLE_SEED, SPRITE_ORACLE_TICKS);
  if (!a.ok) return refuse("oracle", `${a.stage}: ${a.message}`);
  if (!b.ok) return refuse("oracle", `${b.stage}: ${b.message}`);
  if (a.hash !== b.hash) return refuse("oracle", `the change altered the simulation (oracle hash ${a.hash} became ${b.hash}); sprites are presentation only, so nothing was applied`);
  return { ok: true, doc: JSON.parse(verdict.canonicalText) as Json, canonicalText: verdict.canonicalText, sha256: verdict.sha256, oracle: { ticks: b.ticks, hash: b.hash } };
}

/** Plans and, if the plan passes, commits it as one undo step. A refused plan leaves the project untouched. */
export async function applySprites(sink: DerivationSink, engine: ApplyEngine, change: SpriteChange): Promise<SpriteApplyResult> {
  const state = sink.currentState();
  if (state === null) return refuse("precondition", "there is no open project");
  const plan = await planSpriteApply(state.doc, change, engine);
  if (!plan.ok) return plan;
  const done = sink.commitDerived(state, plan.doc, state.manifests);
  return done.ok ? plan : refuse("precondition", done.message);
}
