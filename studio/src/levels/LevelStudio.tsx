import { useEffect, useMemo, useRef, useState } from "react";
import { useDraft, useSession } from "../app/hooks";
import { getAt } from "../draft/path";
import { derivationState, type ApplyResult } from "../derive/apply";
import { compileLevel } from "../derive/levels";
import { addLevel, duplicateLevel, moveLevel, type LevelOpResult } from "../derive/levelOps";
import { checkAllVariants, type VariantCheck } from "../derive/variants";
import { exportable, levelPackZip } from "../export/levelPack";
import { useProject } from "../project/context";
import type { LevelsManifest } from "../project/manifests";
import type { Json } from "../schema/schema";
import { useKindIds } from "../ui/fields";
import { LevelCanvas, displayOfDraft } from "./LevelCanvas";
import { LevelEditor, type Act } from "./LevelEditor";
import { LevelList } from "./LevelList";
import { Timeline } from "./Timeline";
import { Unsupported } from "./Unsupported";
import { downloadBytes } from "./variantsExport";

type Checked = { checks: VariantCheck[]; levels: LevelsManifest; doc: Json };
const count = (v: Json): number => (Array.isArray(v) ? v.length : 0);
const pathText = (p: readonly (string | number)[]) => p.join(".");

/**
 * Level Studio. Three separate things, each with its own region and its own action:
 *   Edit      which level the editor shows (UI state only; editing writes the levels manifest, never the spec),
 *   Active    which level derivation compiles (a project setting, changed only by an explicit choice),
 *   Apply     compiles the ACTIVE level into the spec through the task 4.2 path (engine check, oracle, one undo step).
 * Other levels are checked and exported as standalone variants without touching the spec.
 */
export function LevelStudio() {
  const project = useProject();
  const draft = useDraft();
  const session = useSession();
  const kinds = useKindIds();
  const manifests = project.manifests;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [applied, setApplied] = useState<ApplyResult | null>(null);
  const [applying, setApplying] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [derived, setDerived] = useState<"none" | "fresh" | "stale" | null>(null);
  const abort = useRef<AbortController | null>(null);

  const levels = manifests?.levels ?? null;
  const derivation = manifests?.project.derivation ?? null;
  const doc = draft.doc;
  const validated = draft.validatedRevision === draft.revision && draft.validation?.ok === true;
  const editing = levels === null ? null : levels.levels.find((l) => l.id === editingId) ?? levels.levels[0] ?? null;
  const activeId = derivation?.levels === true ? derivation.activeLevel : null;

  useEffect(() => {
    let live = true;
    if (doc === null || manifests === null) { setDerived(null); return; }
    void derivationState(doc, manifests).then((s) => { if (live) setDerived(s); });
    return () => { live = false; };
  }, [doc, manifests]);
  useEffect(() => () => abort.current?.abort(), []);

  const compiled = useMemo(() => (editing && levels && doc ? compileLevel(levels, doc, editing.id) : null), [editing, levels, doc]);
  const display = useMemo(() => displayOfDraft(doc), [doc]);
  const tickRate = Number(getAt(doc ?? undefined, ["game", "simulation", "tickRate"]) ?? 0);

  if (manifests === null || levels === null || derivation === null || doc === null) return <p className="muted">Open a project to edit its levels.</p>;

  const act: Act = (r: LevelOpResult, field: string) => {
    if (!r.ok) { setNotice(`Not applied: ${r.reason}`); return; }
    const out = project.setLevels(r.levels, field);
    setNotice(out.ok ? null : `Not applied: ${out.reason}`);
  };
  const say = (r: { ok: true } | { ok: false; reason: string }) => setNotice(r.ok ? null : `Not applied: ${r.reason}`);

  const onAdd = (name: string) => {
    const r = addLevel(levels, name);
    act(r, "add");
    if (r.ok) setEditingId(r.levels.levels.find((l) => !levels.levels.some((o) => o.id === l.id))?.id ?? null);
  };
  const onDuplicate = (id: string) => {
    const r = duplicateLevel(levels, id);
    act(r, "duplicate");
    if (r.ok) setEditingId(r.levels.levels.find((l) => !levels.levels.some((o) => o.id === l.id))?.id ?? null);
  };
  const onDelete = (id: string) => {
    const r = project.removeLevel(id);
    say(r);
    if (r.ok && editingId === id) setEditingId(null);
  };
  const apply = async () => {
    setApplying(true);
    try { setApplied(await session.applyActiveLevel()); } finally { setApplying(false); }
  };
  const check = async () => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    const run = { levels, doc };
    setChecked(null); setExportError(null); setProgress({ done: 0, total: levels.levels.length });
    const checks = await checkAllVariants(run.doc, run.levels, session.engine, { signal: ctl.signal, onProgress: (done, total) => setProgress({ done, total }) });
    if (!ctl.signal.aborted) setChecked({ checks, ...run });
    setProgress(null);
  };
  const download = () => {
    if (checked === null) return;
    try { downloadBytes(`${manifests.project.projectId || "project"}-level-variants.zip`, levelPackZip(checked.checks), "application/zip"); setExportError(null); }
    catch (e) { setExportError((e as Error).message); }
  };
  const stale = checked !== null && (checked.levels !== levels || checked.doc !== doc);
  const canExport = checked !== null && !stale && exportable(checked.checks).length > 0;
  const applyDisabled = !derivation.levels || !validated || applying;
  const activeName = levels.levels.find((l) => l.id === derivation.activeLevel)?.name;

  return (
    <div className="level-studio" data-testid="level-studio">
      <p className="banner" data-testid="level-banner">
        Only the <strong>active level</strong> compiles into the native spec. Every other level is a Studio-only variant: it is checked and
        exported as its own standalone spec, and the generated app cannot choose it.
      </p>
      {notice !== null && <p className="status bad" role="alert" data-testid="level-notice">{notice}</p>}

      <section className="card" aria-labelledby="lv-list-h" data-testid="region-levels">
        <header><h3 id="lv-list-h">Levels</h3></header>
        <LevelList levels={levels.levels} editingId={editing?.id ?? null} activeId={activeId}
          onEdit={setEditingId} onAdd={onAdd} onDuplicate={onDuplicate} onMove={(id, dir) => act(moveLevel(levels, id, dir), "move")} onDelete={onDelete} />
      </section>

      <section className="card" aria-labelledby="lv-edit-h" data-testid="region-edit">
        <header><h3 id="lv-edit-h">Edit level{editing ? `: ${editing.name}` : ""}</h3></header>
        <p className="muted small">Editing changes this level in the levels manifest only. The spec changes only when the active level is applied.</p>
        {editing === null ? <p className="muted">Add a level to start.</p> : (
          <>
            {derivation.levels && editing.id !== derivation.activeLevel && (
              <p className="muted small" data-testid="edit-not-active">This level is not the active one, so editing it does not change the spec.</p>
            )}
            <LevelEditor levels={levels} level={editing} kinds={kinds} act={act} />
            <h4>World preview</h4>
            {compiled === null || !compiled.ok ? (
              <ul className="issue-list" data-testid="compile-issues">
                {(compiled && !compiled.ok ? compiled.issues : []).map((i, k) => <li key={k} className="issue-inline">{i.source}: {pathText(i.path)}: {i.message}</li>)}
              </ul>
            ) : display !== null && (
              <>
                <LevelCanvas display={display} entities={compiled.initialEntities} spawners={compiled.spawners} />
                <h4>Spawn timeline</h4>
                <Timeline spawners={compiled.spawners} steps={editing.difficulty.length} tickRate={tickRate} />
              </>
            )}
          </>
        )}
      </section>

      <section className="card" aria-labelledby="lv-active-h" data-testid="region-active">
        <header><h3 id="lv-active-h">Active level and apply</h3></header>
        <p className="muted small">The active level is the one derivation compiles into the spec. Choosing it does not change the spec; Apply does, as one undoable step.</p>
        <div className="actions">
          <label className="checkbox">
            <input type="checkbox" data-testid="derivation-toggle" checked={derivation.levels}
              onChange={(e) => say(project.setLevelDerivation(e.target.checked))} />
            <span>Derive the spec from the active level</span>
          </label>
          <label>Active level{" "}
            <select data-testid="active-level-select" value={derivation.activeLevel} disabled={!derivation.levels} onChange={(e) => say(project.setActiveLevel(e.target.value))}>
              {!derivation.levels && <option value="">(derivation off)</option>}
              {levels.levels.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.id})</option>)}
            </select>
          </label>
          <button type="button" data-testid="apply-active" disabled={applyDisabled} onClick={() => void apply()}>
            Apply active level{activeName ? ` (${activeName})` : ""} to the spec
          </button>
        </div>
        <p className="muted small" data-testid="derivation-state" data-state={derived ?? ""}>
          {!derivation.levels ? "Level derivation is off: the spec is edited in Game Designer."
            : !validated ? "Waiting for the engine to check the draft before an apply."
            : derived === "fresh" ? "The spec matches the active level."
            : derived === "stale" ? "The spec is out of date: apply the active level to update it."
            : "The active level has not been applied yet."}
        </p>
        {applied !== null && (applied.ok ? (
          <p className="status ok" role="status" data-testid="apply-result" data-ok="true">
            Applied. Spawners {count(applied.diff.spawners.before)} to {count(applied.diff.spawners.after)}, initial entities {count(applied.diff.initialEntities.before)} to {count(applied.diff.initialEntities.after)}.
            The oracle ran {applied.oracle.ticks} ticks. Undo restores the previous spec.
          </p>
        ) : (
          <div className="status bad" role="alert" data-testid="apply-result" data-ok="false">
            Not applied ({applied.stage}); the spec is unchanged.
            <ul>{applied.issues.map((i, k) => <li key={k}>{i.source}: {pathText(i.path)}: {i.message}</li>)}</ul>
          </div>
        ))}
      </section>

      <section className="card" aria-labelledby="lv-var-h" data-testid="region-variants">
        <header><h3 id="lv-var-h">Variants</h3></header>
        <p className="muted small">Each level is compiled on its own into a copy of the spec (only initial entities and spawners replaced), checked by the engine, and run twice with the same seed to confirm the result is identical. Nothing here changes the spec.</p>
        <div className="actions">
          <button type="button" data-testid="variants-check" disabled={!validated || progress !== null || levels.levels.length === 0} onClick={() => void check()}>Check all variants</button>
          <button type="button" data-testid="variants-download" disabled={!canExport} onClick={download}>Download variants (ZIP)</button>
          {progress !== null && <span role="status" className="muted small" data-testid="variants-progress">Checking {progress.done}/{progress.total}</span>}
          {!validated && <span className="muted small">Waiting for a valid draft.</span>}
        </div>
        {exportError !== null && <p className="status bad" role="alert">{exportError}</p>}
        {stale && <p className="status pending" data-testid="variants-stale">The levels or the spec changed after this check. Check again before exporting.</p>}
        {checked !== null && (
          <table className={`inv-table${stale ? " is-stale" : ""}`} data-testid="variants-table">
            <thead><tr><th>Level</th><th>Result</th><th>Deterministic</th><th>SHA-256</th><th>Export path</th></tr></thead>
            <tbody>
              {checked.checks.map((c) => (
                <tr key={c.levelId} data-testid={`variant-row-${c.levelId}`} data-status={c.status}>
                  <td><code>{c.levelId}</code></td>
                  <td>{c.status === "valid" ? "valid" : `refused (${c.stage}): ${c.issues.map((i) => `${pathText(i.path)} ${i.message}`).join("; ")}`}</td>
                  <td>{c.deterministic ? "yes" : "no"}</td>
                  <td><code>{c.sha256?.slice(0, 12) ?? ""}</code></td>
                  <td><code>{c.status === "valid" ? `studio-pack/derived/levels/${c.levelId}/monstera.spec.json` : ""}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-labelledby="lv-unsup-h" data-testid="region-unsupported">
        <header><h3 id="lv-unsup-h">Not supported by the native app</h3></header>
        <Unsupported />
      </section>
    </div>
  );
}
