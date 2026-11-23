// Release export with the pack (task 8.1, R13.2 + task 7.1). Pure. The archive is the Task 7.1 pack exporter's output: this file
// only decides whether export may run and gathers the files (generated tree from the verified engine plan, the canonical spec,
// the Studio manifests and asset bytes in the Task 1.5 layout). It defines no second pack format.
import { assetPath, manifestPath, SPEC_PATH } from "../export/bundle";
import type { ExportPlan } from "../engine/protocol";
import { emitScaffold } from "../integrations/scaffold/emit";
import { refuseSecrets } from "../integrations/secrets";
import { kiroTemplates } from "../pack/kiroTemplates";
import { exportPack, type ExportResult, type PackFile, type ScaffoldChoice } from "../pack/export";
import { MANIFEST_NAMES, serializeManifest, type ManifestMap } from "../project/manifests";
import { blocking, type CheckItem } from "./completeness";
type ReadyPlan = Extract<ExportPlan, { ok: true }>;
export interface ReleaseExportInput {
  /** Items of the completeness check (draft and project). */
  items: readonly CheckItem[];
  /** The engine plan and the result of verifyPlan on it. null when no source files were generated yet. */
  plan: ReadyPlan | null;
  planChecks: readonly CheckItem[];
  /** The canonical spec text of the validated draft. */
  specText: string | null;
  manifests: ManifestMap | null;
  /** Asset bytes by asset id. */
  assets: ReadonlyMap<string, Uint8Array>;
  /** Text of tools/check-drift.sh, written to the pack as a studio-scaffold file (mode 0755). */
  driftScript: string;
  existing?: readonly PackFile[];
  choices?: Readonly<Record<string, ScaffoldChoice>>;
}
export type ReleaseExport =
  | { ok: false; reason: "blocked"; blockers: CheckItem[] }
  | { ok: false; reason: "no-plan" | "no-project" | "missing-asset" | "secret" | "pack"; message: string; conflicts: Extract<ExportResult, { ok: false }>["conflicts"] }
  | Extract<ExportResult, { ok: true }>;
const enc = new TextEncoder();
function decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const refuse = (reason: "no-plan" | "no-project" | "missing-asset" | "secret", message: string): ReleaseExport => ({ ok: false, reason, message, conflicts: [] });
/** Every completeness error class and every plan error blocks; only a clean, verified project reaches the pack exporter. */
export async function releaseExport(input: ReleaseExportInput): Promise<ReleaseExport> {
  const blockers = blocking([...input.items, ...input.planChecks]);
  if (blockers.length > 0) return { ok: false, reason: "blocked", blockers };
  if (!input.plan) return refuse("no-plan", "Generate the source files first.");
  if (input.manifests === null || input.specText === null) return refuse("no-project", "No validated project is open.");
  let doc: unknown = null;
  try { doc = JSON.parse(input.specText); } catch { /* an unreadable spec has no values to scan; the plan check above blocks it */ }
  const secret = refuseSecrets({ doc, manifests: input.manifests });
  if (secret) return refuse("secret", `The pack was not exported: ${secret}.`);
  const files = new Map<string, PackFile>();
  const put = (path: string, data: Uint8Array, mode?: number) => files.set(path, { path, data, mode });
  for (const f of input.plan.files) put(f.path, decode(f.data), f.mode);
  put(SPEC_PATH, enc.encode(input.specText));
  for (const n of MANIFEST_NAMES) put(manifestPath(n), enc.encode(serializeManifest(n, input.manifests[n] as never)));
  for (const a of input.manifests.assets.assets) {
    const data = input.assets.get(a.id);
    if (!data) return refuse("missing-asset", `Asset ${a.id} has no stored file, so the pack cannot be exported.`);
    put(assetPath(a.id, a.file), data);
  }
  put("tools/check-drift.sh", enc.encode(input.driftScript), 0o755);
  for (const f of kiroTemplates(input.plan.projectId)) put(f.path, f.data);
  // A fixed build label keeps the pack deterministic; the scaffold has no other use for it.
  for (const f of emitScaffold(input.manifests.integrations, "studio")) put(`studio-pack/${f.path}`, enc.encode(f.text));
  const r = await exportPack({ files: [...files.values()], existing: input.existing, choices: input.choices });
  return r.ok ? r : { ok: false, reason: "pack", message: r.error, conflicts: r.conflicts };
}
