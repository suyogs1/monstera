import { useEffect, useState } from "react";
import { NumInput } from "../levels/NumInput";
import { useProject } from "../project/context";
import type { IntegrationsManifest } from "../project/manifests";
import { ScaffoldBanner } from "./Banner";
import { previewFiles } from "./Backend";
import {
  DEVELOPER_NOTE, FREQUENCY_TITLE, ID_HELP, MOCK_INTRO, MOCK_LABEL, MOCK_PREVIEW_TITLE, MOCK_TITLE, MODE_HELP, MODE_LABEL, NOT_APPLIED, PLACEMENTS_INTRO,
  PLACEMENTS_TITLE, REWARD_HELP,
} from "./labels";
import { addPlacement, removePlacement, setMode, setPlacement, type IntegrationsOpResult, type PlacementField } from "./ops";
import { AD_TRIGGERS, AD_TYPES, INTEGRATIONS_MODES } from "./manifest";
import { FREQUENCY_FINAL, FREQUENCY_RULES } from "./scaffold";
/** A text field that commits on blur or Enter, so half-typed names are never validated. */
function TextCommit({ label, value, onCommit }: { label: string; value: string; onCommit(v: string): void }) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  const commit = () => { if (text !== value) onCommit(text); };
  return (
    <input type="text" className="mono" autoComplete="off" spellCheck={false} aria-label={label} value={text}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
  );
}
export interface PlacementsViewProps {
  integrations: IntegrationsManifest; notice: string | null;
  onMode(mode: "mock" | "test"): void; onAdd(): void; onRemove(id: string): void; onField(id: string, field: PlacementField, value: string | number): void;
}
/** Pure view of the placements editor. The mode list is `INTEGRATIONS_MODES`: mock and test only. */
export function PlacementsView({ integrations, notice, onMode, onAdd, onRemove, onField }: PlacementsViewProps) {
  const m = integrations.monetization;
  return (
    <section className="module-body" data-testid="monetization-placements">
      <h2>{PLACEMENTS_TITLE}</h2>
      <ScaffoldBanner kind="monetization" />
      <p className="muted">{PLACEMENTS_INTRO}</p>
      <p className="muted">{DEVELOPER_NOTE}</p>
      {notice !== null && <p className="notice" role="alert" data-testid="integrations-notice">{notice}</p>}
      <label>{MODE_LABEL}{" "}
        <select aria-label={MODE_LABEL} value={m.mode} onChange={(e) => onMode(e.target.value === "test" ? "test" : "mock")}>
          {INTEGRATIONS_MODES.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </label>
      <small className="muted">{MODE_HELP}</small>
      {m.placements.map((p) => (
        <fieldset key={p.id} data-testid={`placement-${p.id}`}>
          <legend>{p.id} <span className="muted">[{MOCK_LABEL}]</span></legend>
          <label>Placement name <TextCommit label={`Placement name ${p.id}`} value={p.id} onCommit={(v) => onField(p.id, "id", v)} /></label>
          <small className="muted">{ID_HELP}</small>
          <label>Type{" "}
            <select aria-label={`Type ${p.id}`} value={p.type} onChange={(e) => onField(p.id, "type", e.target.value)}>
              {AD_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <label>Trigger{" "}
            <select aria-label={`Trigger ${p.id}`} value={p.trigger} onChange={(e) => onField(p.id, "trigger", e.target.value)}>
              {AD_TRIGGERS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <label>Seconds between <NumInput label={`Seconds between ${p.id}`} kind="int" value={p.minSecondsBetween} onCommit={(n) => onField(p.id, "minSecondsBetween", n)} /></label>
          <label>Most per session <NumInput label={`Most per session ${p.id}`} kind="int" value={p.maxPerSession} onCommit={(n) => onField(p.id, "maxPerSession", n)} /></label>
          {p.type === "rewarded" ? (
            <>
              <label>Reward kind <TextCommit label={`Reward kind ${p.id}`} value={p.rewardKind} onCommit={(v) => onField(p.id, "rewardKind", v)} /></label>
              <label>Reward amount <NumInput label={`Reward amount ${p.id}`} kind="int" value={p.rewardAmount} onCommit={(n) => onField(p.id, "rewardAmount", n)} /></label>
            </>
          ) : <small className="muted">{REWARD_HELP}</small>}
          <button type="button" onClick={() => onRemove(p.id)}>Remove {p.id}</button>
        </fieldset>
      ))}
      <button type="button" data-testid="placement-add" onClick={onAdd}>Add placement</button>
    </section>
  );
}
export interface MockBehaviourViewProps { integrations: IntegrationsManifest }
/** Pure, read-only explanation of the mock service and the scaffold that carries it. */
export function MockBehaviourView({ integrations }: MockBehaviourViewProps) {
  const files = previewFiles(integrations, (p) => /\/(AdPlacements|AdService|MockRewardedAdService)\./.test(p));
  return (
    <section className="module-body" data-testid="monetization-mock">
      <h2>{MOCK_TITLE} <span className="muted">[{MOCK_LABEL}]</span></h2>
      <ScaffoldBanner kind="monetization" />
      <p className="muted">{MOCK_INTRO}</p>
      <h3>{FREQUENCY_TITLE}</h3>
      <ol data-testid="frequency-rules">
        {FREQUENCY_RULES.map((r) => <li key={r.when}><code>{r.when}</code>: {r.result ? "may show" : "may not show"}</li>)}
        <li>otherwise may show when <code>{FREQUENCY_FINAL}</code></li>
      </ol>
      <h3>{MOCK_PREVIEW_TITLE}</h3>
      {files.map((f) => (
        <details key={f.path}>
          <summary><code>{f.path}</code></summary>
          <pre className="mono" data-testid="scaffold-preview">{f.text}</pre>
        </details>
      ))}
    </section>
  );
}
export function Placements() {
  const project = useProject();
  const [notice, setNotice] = useState<string | null>(null);
  const integrations = project.manifests?.integrations ?? null;
  if (integrations === null) return <p className="muted">Open a project to edit its ad placements.</p>;
  const apply = (r: IntegrationsOpResult, field: string) => {
    if (!r.ok) { setNotice(`${NOT_APPLIED}${r.reason}`); return; }
    const out = project.commitManifest("integrations", r.integrations, field);
    setNotice(out.ok ? null : `${NOT_APPLIED}${out.message}`);
  };
  return (
    <PlacementsView integrations={integrations} notice={notice}
      onMode={(mode) => apply(setMode(integrations, mode), "mode")}
      onAdd={() => apply(addPlacement(integrations), "placements")}
      onRemove={(id) => apply(removePlacement(integrations, id), `remove-${id}`)}
      onField={(id, field, value) => apply(setPlacement(integrations, id, field, value), `${id}.${field}`)} />
  );
}
export function MockBehaviour() {
  const integrations = useProject().manifests?.integrations ?? null;
  if (integrations === null) return <p className="muted">Open a project to see the mock ad behaviour.</p>;
  return <MockBehaviourView integrations={integrations} />;
}

