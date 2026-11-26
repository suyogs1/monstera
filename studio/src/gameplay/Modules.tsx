import { useEffect, useMemo, useState } from "react";
import { useDraft, useSession } from "../app/hooks";
import { gameplayInSync, type GameplayPlan, type GameplayReview } from "../derive/apply";
import type { GameplayIssue } from "../derive/gameplay";
import {
  addCollectible, addEnemy, freePair, issuesFor, gameplayIssues, removeCollectible, removeEnemy, setCollectible, setEnemy, setLives, setWinScore, type GameplayOpResult,
} from "../derive/gameplayOps";
import { NumInput } from "../levels/NumInput";
import { useProject } from "../project/context";
import type { GameplayManifest } from "../project/manifests";
import type { Json } from "../schema/schema";
import { useKindIds } from "../ui/fields";

const pathText = (p: readonly (string | number)[]) => p.join(".");
const rowText = (r: Json): string => {
  const o = (r ?? {}) as Record<string, unknown>;
  return `${String(o["a"])} + ${String(o["b"])}: score ${String(o["score"])}, lives ${String(o["lives"])}, removes first ${String(o["despawnA"])}, removes second ${String(o["despawnB"])}`;
};
const rows = (v: Json): Json[] => (Array.isArray(v) ? v : []);

function KindPick({ label, value, kinds, onChange }: { label: string; value: string; kinds: string[]; onChange(k: string): void }) {
  const unknown = value !== "" && !kinds.includes(value);
  return (
    <select aria-label={label} value={value} aria-invalid={unknown} onChange={(e) => onChange(e.target.value)}>
      {unknown && <option value={value}>{value} (no such kind)</option>}
      {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
    </select>
  );
}

type Review = Extract<GameplayReview, { ok: true }>;
export type Outcome = { kind: "applied"; ticks: number } | { kind: "refused"; stage: string; issues: { source: string; path: readonly (string | number)[]; message: string }[] };

/**
 * Gameplay Systems, Modules section. Three separate things, each with its own region and action:
 *   Edit      the gameplay manifest (lives, win score, collectibles, enemies). It never writes the spec,
 *   Derive    the switch that hands lives, winScore and collisions to this module (Game Designer then shows them read-only),
 *   Review    compiles and engine-checks the manifest against the current spec and shows the diff; nothing is written,
 *   Apply     commits exactly the reviewed result as one undo step, only if the project has not changed since the review.
 */
export function GameplayModules() {
  const project = useProject();
  const draft = useDraft();
  const session = useSession();
  const kinds = useKindIds();
  const manifests = project.manifests;
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const gameplay = manifests?.gameplay ?? null;
  const derivation = manifests?.project.derivation ?? null;
  const doc = draft.doc;
  const validated = draft.validatedRevision === draft.revision && draft.validation?.ok === true;
  const on = derivation?.gameplay === true;
  const issues = useMemo(() => (gameplay && doc ? gameplayIssues(gameplay, doc, on) : []), [gameplay, doc, on]);
  const inSync = useMemo(() => (manifests && doc && on ? gameplayInSync(doc, manifests) : false), [manifests, doc, on]);
  const stale = review !== null && (review.expected.doc !== doc || review.expected.manifests !== manifests);
  // A review describes one exact project state; any change (or turning derivation off) retires it.
  useEffect(() => { if (review !== null && (stale || !on)) setReview(null); }, [stale, on, review]);
  if (manifests === null || gameplay === null || derivation === null || doc === null) return <p className="muted">Open a project to edit its gameplay.</p>;

  const act = (r: GameplayOpResult, field: string) => {
    if (!r.ok) { setNotice(`Not applied: ${r.reason}`); return; }
    const out = project.commitManifest("gameplay", r.gameplay, field);
    setNotice(out.ok ? null : `Not applied: ${out.message}`);
    setOutcome(null);
  };
  const say = (r: { ok: true } | { ok: false; reason: string }) => { setNotice(r.ok ? null : `Not applied: ${r.reason}`); setOutcome(null); };

  const doReview = async () => {
    setBusy(true); setOutcome(null);
    try {
      const r = await session.reviewGameplay();
      if (r.ok) { setReview(r); } else { setReview(null); setOutcome({ kind: "refused", stage: r.stage, issues: r.issues }); }
    } finally { setBusy(false); }
  };
  const doApply = () => {
    if (review === null || stale) return;
    const r = session.applyReviewedGameplay(review);
    setReview(null);
    setOutcome(r.ok ? { kind: "applied", ticks: r.oracle.ticks } : { kind: "refused", stage: r.stage, issues: r.issues });
  };
  return (
    <GameplayModulesView gameplay={gameplay} kinds={kinds} issues={issues} on={on} validated={validated} inSync={inSync} busy={busy}
      notice={notice} plan={review?.plan ?? null} stale={stale} outcome={outcome}
      act={act} onToggle={(v) => say(project.setGameplayDerivation(v))} onReview={() => void doReview()} onApply={doApply} />
  );
}

export interface GameplayModulesViewProps {
  gameplay: GameplayManifest; kinds: string[]; issues: readonly GameplayIssue[];
  on: boolean; validated: boolean; inSync: boolean; busy: boolean;
  notice: string | null; plan: GameplayPlan | null; stale: boolean; outcome: Outcome | null;
  act(r: GameplayOpResult, field: string): void; onToggle(on: boolean): void; onReview(): void; onApply(): void;
}

/** The Modules view. Pure with respect to its props, so it renders without a session (component tests). */
export function GameplayModulesView({ gameplay, kinds, issues, on, validated, inSync, busy, notice, plan, stale, outcome, act, onToggle, onReview, onApply }: GameplayModulesViewProps) {
  const pair = freePair(gameplay, kinds) ?? ["", ""];
  const collectible = (c: GameplayManifest["collectibles"][number], i: number) => {
    const set = (patch: Partial<Omit<typeof c, "id">>, f: string) => act(setCollectible(gameplay, c.id, patch), `collectibles.${c.id}.${f}`);
    const row = issuesFor(issues, "collectibles", i);
    return (
      <tr key={c.id} data-testid={`collectible-${c.id}`} data-invalid={row.length > 0}>
        <td><code>{c.id}</code></td>
        <td><KindPick label={`${c.id} kind`} value={c.kind} kinds={kinds} onChange={(k) => set({ kind: k }, "kind")} /></td>
        <td><KindPick label={`${c.id} collected by`} value={c.collectorKind} kinds={kinds} onChange={(k) => set({ collectorKind: k }, "collectorKind")} /></td>
        <td><NumInput label={`${c.id} points`} value={c.points} kind="int" onCommit={(n) => set({ points: n }, "points")} /></td>
        <td><input type="checkbox" aria-label={`${c.id} removed when collected`} checked={c.despawn} onChange={(e) => set({ despawn: e.target.checked }, "despawn")} /></td>
        <td>
          <button type="button" aria-label={`Remove collectible ${c.id}`} onClick={() => act(removeCollectible(gameplay, c.id), `collectibles.${c.id}.remove`)}>Remove</button>
          {row.map((x, k) => <small key={k} className="issue-inline" role="alert" data-testid={`issue-collectibles-${i}`}> {pathText(x.path)}: {x.message}</small>)}
        </td>
      </tr>
    );
  };
  const enemy = (e: GameplayManifest["enemies"][number], i: number) => {
    const set = (patch: Partial<Omit<typeof e, "id">>, f: string) => act(setEnemy(gameplay, e.id, patch), `enemies.${e.id}.${f}`);
    const row = issuesFor(issues, "enemies", i);
    return (
      <tr key={e.id} data-testid={`enemy-${e.id}`} data-invalid={row.length > 0}>
        <td><code>{e.id}</code></td>
        <td><KindPick label={`${e.id} kind`} value={e.kind} kinds={kinds} onChange={(k) => set({ kind: k }, "kind")} /></td>
        <td><KindPick label={`${e.id} hits`} value={e.targetKind} kinds={kinds} onChange={(k) => set({ targetKind: k }, "targetKind")} /></td>
        <td><NumInput label={`${e.id} lives lost`} value={e.livesLost} kind="int" onCommit={(n) => set({ livesLost: n }, "livesLost")} /></td>
        <td><input type="checkbox" aria-label={`${e.id} removed on hit`} checked={e.despawnEnemy} onChange={(ev) => set({ despawnEnemy: ev.target.checked }, "despawnEnemy")} /></td>
        <td>
          <button type="button" aria-label={`Remove enemy ${e.id}`} onClick={() => act(removeEnemy(gameplay, e.id), `enemies.${e.id}.remove`)}>Remove</button>
          {row.map((x, k) => <small key={k} className="issue-inline" role="alert" data-testid={`issue-enemies-${i}`}> {pathText(x.path)}: {x.message}</small>)}
        </td>
      </tr>
    );
  };

  const reviewDisabled = !on || !validated || busy;
  return (
    <div className="gameplay-modules" data-testid="gameplay-modules">
      <p className="banner" data-testid="gameplay-banner">
        These forms edit the gameplay manifest only. The spec changes only when you review and apply.
      </p>
      <div className="gameplay-scope-strip" data-testid="gameplay-scope">
        <span className="scope-item is-implemented">
          <strong>Implemented:</strong> Lives, Win Score, Collectibles, Enemies (compiles to spec &amp; native)
        </span>
        <span className="scope-item is-planned">
          <strong>Roadmap (not in contract):</strong> Health, Power-ups, Progression —{" "}
          <a href="#/gameplay/planned">view contract audit</a>
        </span>
      </div>
      {notice !== null && <p className="status bad" role="alert" data-testid="gameplay-notice">{notice}</p>}
      <section className="card" aria-labelledby="gp-rules-h" data-testid="region-rules">
        <header><h3 id="gp-rules-h">Lives and winning</h3></header>
        <div className="field-grid">
          <label>Starting lives <NumInput label="Starting lives" value={gameplay.lives.start} kind="int" onCommit={(n) => act(setLives(gameplay, n), "lives.start")} /></label>
          <label>Winning score <NumInput label="Winning score" value={gameplay.score.winScore} kind="int" onCommit={(n) => act(setWinScore(gameplay, n), "score.winScore")} /></label>
        </div>
      </section>
      <section className="card" aria-labelledby="gp-coll-h" data-testid="region-collectibles">
        <header><h3 id="gp-coll-h">Collectibles</h3></header>
        <table className="inv-table"><thead><tr><th>Id</th><th>Kind</th><th>Collected by</th><th>Points</th><th>Removed</th><th /></tr></thead>
          <tbody>{gameplay.collectibles.map(collectible)}</tbody></table>
        <p className="actions small"><button type="button" data-testid="collectible-add" disabled={pair[0] === ""} onClick={() => act(addCollectible(gameplay, pair[0], pair[1]), "collectibles.add")}>Add collectible</button></p>
      </section>
      <section className="card" aria-labelledby="gp-enemy-h" data-testid="region-enemies">
        <header><h3 id="gp-enemy-h">Enemies</h3></header>
        <table className="inv-table"><thead><tr><th>Id</th><th>Kind</th><th>Hits</th><th>Lives lost</th><th>Removed</th><th /></tr></thead>
          <tbody>{gameplay.enemies.map(enemy)}</tbody></table>
        <p className="actions small"><button type="button" data-testid="enemy-add" disabled={pair[0] === ""} onClick={() => act(addEnemy(gameplay, pair[0], pair[1]), "enemies.add")}>Add enemy</button></p>
      </section>
      <section className="card" aria-labelledby="gp-derive-h" data-testid="region-derive">
        <header><h3 id="gp-derive-h">Derive the spec from gameplay</h3></header>
        <p className="muted small">
          Off by default. While on, this module owns lives, win score and the whole collision table: Game Designer shows them read-only.
          Turning it on or off never changes the spec; Review and Apply do, as one undoable step.
        </p>
        <div className="actions">
          <label className="checkbox">
            <input type="checkbox" data-testid="gameplay-derivation-toggle" checked={on} onChange={(e) => onToggle(e.target.checked)} />
            <span>Derive lives, win score and collisions from these forms</span>
          </label>
          <button type="button" data-testid="gameplay-review" disabled={reviewDisabled} onClick={onReview}>Review changes to the spec</button>
          <button type="button" data-testid="gameplay-apply" disabled={plan === null || stale} onClick={onApply}>Apply reviewed changes</button>
        </div>
        <p className="muted small" data-testid="gameplay-derivation-state" data-state={!on ? "off" : inSync ? "fresh" : "stale"}>
          {!on ? "Gameplay derivation is off: the spec is edited in Game Designer."
            : !validated ? "Waiting for the engine to check the draft before a review."
            : inSync ? "The spec matches these forms."
            : "The spec differs from these forms: review and apply to update it."}
        </p>
        {plan !== null && (
          <div className="status" data-testid="gameplay-review-result" data-ok="true">
            <p>The engine accepts the derived spec and the oracle ran {plan.oracle.ticks} ticks. Nothing has been written yet.</p>
            <table className="inv-table" data-testid="gameplay-diff">
              <thead><tr><th>Spec field</th><th>Now</th><th>After apply</th></tr></thead>
              <tbody>
                <tr><td><code>runtime.lives</code></td><td>{String(plan.diff.lives.before)}</td><td>{String(plan.diff.lives.after)}</td></tr>
                <tr><td><code>runtime.winScore</code></td><td>{String(plan.diff.winScore.before)}</td><td>{String(plan.diff.winScore.after)}</td></tr>
                <tr><td><code>runtime.collisions</code></td>
                  <td><ul>{rows(plan.diff.collisions.before).map((r, k) => <li key={k}>{rowText(r)}</li>)}</ul></td>
                  <td><ul>{rows(plan.diff.collisions.after).map((r, k) => <li key={k}>{rowText(r)}</li>)}</ul></td></tr>
              </tbody>
            </table>
            {plan.removedRows.length > 0 && (
              <p className="status pending" role="alert" data-testid="gameplay-removed">
                Applying removes {plan.removedRows.length} existing collision {plan.removedRows.length === 1 ? "row" : "rows"} that these forms do not produce:{" "}
                {plan.removedRows.map(rowText).join("; ")}. Undo restores them.
              </p>
            )}
          </div>
        )}
        {stale && <p className="status pending" data-testid="gameplay-review-stale">The project changed after this review. Review again before applying.</p>}
        {outcome !== null && (outcome.kind === "applied" ? (
          <p className="status ok" role="status" data-testid="gameplay-apply-result" data-ok="true">Applied. The oracle ran {outcome.ticks} ticks. Undo restores the previous spec.</p>
        ) : (
          <div className="status bad" role="alert" data-testid="gameplay-apply-result" data-ok="false">
            Not applied ({outcome.stage}); the spec is unchanged.
            <ul>{outcome.issues.map((i, k) => <li key={k}>{i.source}: {pathText(i.path)}: {i.message}</li>)}</ul>
          </div>
        ))}
      </section>
      {issues.length > 0 && (
        <section className="card" aria-labelledby="gp-issues-h" data-testid="region-issues">
          <header><h3 id="gp-issues-h">Problems in these forms</h3></header>
          <ul className="issue-list">{issues.map((i, k) => <li key={k} className="issue-inline" data-code={i.code}>{pathText(i.path)}: {i.message}</li>)}</ul>
        </section>
      )}
    </div>
  );
}
