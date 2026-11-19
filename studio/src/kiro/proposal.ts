// Proposal inbox (task 7.4, requirement 12.2): a proposal is data produced elsewhere (for example by Kiro). It is parsed
// with the strict manifest reader, its operations are applied to a COPY of the target, and the copy is validated by the same
// engine or manifest schemas as a manual edit. Nothing is committed here: planProposal returns a plan, the caller shows the
// diff and commits only on acceptance. A rejected or refused proposal therefore changes nothing.
import { lockedBy, POINTER_OWNERS } from "../derive/ownership";
import { ORACLE_SEED, ORACLE_TICKS, type ApplyEngine } from "../derive/apply";
import { parseManifest, validateManifest, type ManifestMap, type ProposalManifest } from "../project/manifests";
import { parseStrictJson } from "../project/manifests/strictJson";
import type { Json } from "../schema/schema";
export type Proposal = ProposalManifest;
export type ProposalParse = { ok: true; proposal: Proposal } | { ok: false; message: string };
export function parseProposal(text: string): ProposalParse {
  const r = parseManifest("proposal", text);
  if (r.ok) return { ok: true, proposal: r.value };
  const first = r.issues[0];
  return { ok: false, message: first ? `${first.path.length > 0 ? first.path.join(".") + ": " : ""}${first.message}` : "not a proposal" };
}
/** Manifest each non-spec target edits. `assets-metadata` is the assets manifest: bytes never travel in a proposal. */
const MANIFEST_OF = { animations: "animations", "assets-metadata": "assets", gameplay: "gameplay", levels: "levels" } as const;
export interface ProposalDiffRow { op: "add" | "remove" | "set"; path: string; before: string; after: string }
export type ProposalRefusal = { ok: false; stage: "precondition" | "apply" | "validate" | "engine" | "oracle"; message: string; opIndex?: number };
export interface ProposalPlan {
  ok: true;
  proposal: Proposal;
  doc: Json;
  manifests: ManifestMap;
  diff: ProposalDiffRow[];
}
export type ProposalResult = ProposalPlan | ProposalRefusal;
const refuse = (stage: ProposalRefusal["stage"], message: string, opIndex?: number): ProposalRefusal => ({ ok: false, stage, message, ...(opIndex === undefined ? {} : { opIndex }) });
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
const unescape = (s: string): string => s.replace(/~1/g, "/").replace(/~0/g, "~");
const segments = (pointer: string): string[] => (pointer === "" ? [] : pointer.slice(1).split("/").map(unescape));
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const show = (v: unknown): string => (v === undefined ? "" : JSON.stringify(v));
const index = (seg: string, len: number, allowEnd: boolean): number | null => {
  if (allowEnd && seg === "-") return len;
  if (!/^(0|[1-9][0-9]*)$/.test(seg)) return null;
  const n = Number(seg);
  return n < len || (allowEnd && n === len) ? n : null;
};
/** Applies one operation to a deep copy of `root`. Returns the new root and the value that was there before, or a reason. */
function applyOp(root: unknown, op: Proposal["ops"][number], value: unknown): { ok: true; root: unknown; before: unknown } | { ok: false; message: string } {
  const segs = segments(op.path);
  if (segs.some((s) => FORBIDDEN.has(s))) return { ok: false, message: "the path names a forbidden key" };
  if (segs.length === 0) return { ok: false, message: "the path must name a field inside the target, not the whole document" };
  const next = clone(root);
  let node: unknown = next;
  for (const s of segs.slice(0, -1)) {
    if (isArr(node)) { const i = index(s, node.length, false); if (i === null) return { ok: false, message: `no element '${s}' on the way to ${op.path}` }; node = node[i]; }
    else if (isObj(node) && Object.prototype.hasOwnProperty.call(node, s)) node = node[s];
    else return { ok: false, message: `nothing at '${s}' on the way to ${op.path}` };
  }
  const last = segs[segs.length - 1] as string;
  if (isArr(node)) {
    const i = index(last, node.length, op.op === "add");
    if (i === null) return { ok: false, message: `no element '${last}' in the array at ${op.path}` };
    const before = node[i];
    if (op.op === "add") node.splice(i, 0, value);
    else if (op.op === "set") node[i] = value;
    else node.splice(i, 1);
    return { ok: true, root: next, before };
  }
  if (!isObj(node)) return { ok: false, message: `${op.path} is inside a value that has no fields` };
  const has = Object.prototype.hasOwnProperty.call(node, last);
  if (op.op === "add" && has) return { ok: false, message: `${op.path} already exists; use set to replace it` };
  if (op.op !== "add" && !has) return { ok: false, message: `${op.path} does not exist` };
  const before = node[last];
  if (op.op === "remove") delete node[last]; else node[last] = value;
  return { ok: true, root: next, before };
}
function applyAll(start: unknown, proposal: Proposal): { ok: true; root: unknown; diff: ProposalDiffRow[] } | ProposalRefusal {
  let root = start;
  const diff: ProposalDiffRow[] = [];
  for (const [i, op] of proposal.ops.entries()) {
    let value: unknown;
    if (op.op !== "remove") {
      const parsed = parseStrictJson(op.value);
      if (!parsed.ok) return refuse("apply", `operation ${i + 1}: ${parsed.issue.message}`, i);
      value = parsed.value;
    }
    const r = applyOp(root, op, value);
    if (!r.ok) return refuse("apply", `operation ${i + 1}: ${r.message}`, i);
    root = r.root;
    diff.push({ op: op.op, path: op.path, before: show(r.before), after: op.op === "remove" ? "" : show(value) });
  }
  return { ok: true, root, diff };
}
/**
 * Checks a proposal against the current project without changing it. A `spec` proposal must pass the unmodified engine and a
 * bounded oracle run, and may not touch a pointer owned by a module whose derivation is on. Any other target must pass its
 * manifest schema and internal checks.
 */
export async function planProposal(state: { doc: Json; manifests: ManifestMap }, proposal: Proposal, engine: ApplyEngine): Promise<ProposalResult> {
  if (proposal.ops.length === 0) return refuse("precondition", "the proposal has no operations");
  if (proposal.target === "spec") {
    for (const [i, op] of proposal.ops.entries()) {
      const path = segments(op.path);
      const owner = lockedBy(path, state.manifests.project.derivation);
      if (owner !== null) return refuse("precondition", `operation ${i + 1}: ${op.path} is derived by the ${owner} module while its derivation is on; change that module instead`, i);
      const d = state.manifests.project.derivation;
      for (const m of ["levels", "gameplay"] as const) {
        if (d[m] && POINTER_OWNERS[m].some((p) => path.length < p.length && path.every((s, k) => s === p[k]))) return refuse("precondition", `operation ${i + 1}: ${op.path} contains fields derived by the ${m} module while its derivation is on`, i);
      }
    }
    const r = applyAll(state.doc, proposal);
    if (!r.ok) return r;
    const verdict = await engine.validateDraft(JSON.stringify(r.root, null, 2));
    if (!verdict.ok || verdict.canonicalText === null || verdict.sha256 === null) {
      const first = verdict.issues[0];
      return refuse("engine", first ? `the engine rejected the result: ${first.path} ${first.message}` : "the engine could not read the result");
    }
    const run = await engine.oracleCheck(verdict.canonicalText, ORACLE_SEED, ORACLE_TICKS);
    if (!run.ok) return refuse("oracle", `${run.stage}: ${run.message}`);
    const doc = JSON.parse(verdict.canonicalText) as Json;
    const manifests: ManifestMap = { ...state.manifests, project: { ...state.manifests.project, spec: { ...state.manifests.project.spec, currentSha256: verdict.sha256 } } };
    return { ok: true, proposal, doc, manifests, diff: r.diff };
  }
  const name = MANIFEST_OF[proposal.target as keyof typeof MANIFEST_OF];
  const r = applyAll(state.manifests[name], proposal);
  if (!r.ok) return r;
  const checked = validateManifest(name, r.root);
  if (!checked.ok) {
    const first = checked.issues[0];
    return refuse("validate", `the ${name} manifest would be invalid: ${first ? `${first.path.join(".")} ${first.message}` : "unknown reason"}`);
  }
  return { ok: true, proposal, doc: state.doc, manifests: { ...state.manifests, [name]: checked.value }, diff: r.diff };
}
