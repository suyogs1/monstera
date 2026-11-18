import { useState } from "react";
import type { Apply } from "./SheetEditor";
import { IntField } from "./IntField";
import {
  addAnimation, appendToSequence, FPS_RANGE, HOLD_RANGE, LOOP_MODES, moveInSequence, nextFreeId, removeAnimation, removeFromSequence,
  setAnimationKind, setFps, setHold, setLoop, type AnimationsManifest,
} from "./edit";
/** Animations: sheet, entity kind, fps, loop mode and the ordered frame sequence with per-entry holds. Presentational. */
export function AnimationEditor({ animations, kindIds, selectedId, onSelect, apply }: {
  animations: AnimationsManifest; kindIds: readonly string[]; selectedId: string | null; onSelect: (id: string | null) => void; apply: Apply;
}) {
  const [sheetId, setSheetId] = useState("");
  const [kind, setKind] = useState("");
  const [frameId, setFrameId] = useState("");
  const anim = animations.animations.find((a) => a.id === selectedId) ?? null;
  const sheet = anim ? animations.sheets.find((s) => s.id === anim.sheetId) : undefined;
  const newSheet = animations.sheets.find((s) => s.id === sheetId) ?? animations.sheets[0];
  const newKind = kindIds.includes(kind) ? kind : (kindIds[0] ?? "");
  const f = (field: string) => `animations.${anim?.id ?? ""}.${field}`;
  return (
    <section data-testid="animation-editor">
      <h3>Animations</h3>
      <p className="muted">Timing is in simulation ticks: a given tick always shows the same frame. Hold is how many steps an entry stays.</p>
      <ul className="asset-list">
        {animations.animations.map((a) => (
          <li key={a.id} data-testid={`animation-row-${a.id}`} data-selected={a.id === selectedId ? "true" : undefined}>
            <span><code>{a.id}</code> for <code>{a.kindRef}</code>, {a.fps} fps, {a.loop}, {a.sequence.length} entries</span>
            <button type="button" data-testid={`animation-select-${a.id}`} aria-pressed={a.id === selectedId} onClick={() => onSelect(a.id === selectedId ? null : a.id)}>Edit</button>
          </li>
        ))}
        {animations.animations.length === 0 && <li className="muted" data-testid="animation-empty">No animations yet.</li>}
      </ul>
      <fieldset data-testid="animation-new">
        <legend>New animation</legend>
        {animations.sheets.length === 0 ? <p className="muted">Create a sheet first.</p> : kindIds.length === 0 ? <p className="muted">The game has no entity kinds yet.</p> : (
          <div className="actions small">
            <label>Sheet <select data-testid="animation-new-sheet" value={newSheet?.id ?? ""} onChange={(e) => setSheetId(e.target.value)}>{animations.sheets.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
            <label>Entity <select data-testid="animation-new-kind" value={newKind} onChange={(e) => setKind(e.target.value)}>{kindIds.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
            <button type="button" data-testid="animation-create" onClick={() => { if (newSheet) apply(addAnimation(animations, nextFreeId("anim", animations.animations), newSheet.id, newKind), "animations.animations"); }}>Create animation</button>
          </div>
        )}
      </fieldset>
      {anim && (
        <div data-testid={`animation-detail-${anim.id}`}>
          <h4>{anim.id}</h4>
          <div className="actions small">
            <label>Frames per second ({FPS_RANGE.min} to {FPS_RANGE.max}) <IntField label="fps" value={anim.fps} testId="animation-fps" onApply={(n) => apply(setFps(animations, anim.id, n), f("fps"))} /></label>
            <label>Loop <select data-testid="animation-loop" value={anim.loop} onChange={(e) => apply(setLoop(animations, anim.id, e.target.value), f("loop"))}>{LOOP_MODES.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
            <label>Entity <select data-testid="animation-kind" value={anim.kindRef} onChange={(e) => apply(setAnimationKind(animations, anim.id, e.target.value), f("kind"))}>
              {(kindIds.includes(anim.kindRef) ? kindIds : [anim.kindRef, ...kindIds]).map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
          </div>
          <ol data-testid="sequence-list">
            {anim.sequence.map((e, i) => (
              <li key={i} data-testid={`sequence-row-${i}`}>
                <code>{e.frameId}</code>{" "}
                <label>Hold ({HOLD_RANGE.min} to {HOLD_RANGE.max}) <IntField label={`hold of entry ${i + 1}`} value={e.holdFrames} testId={`sequence-hold-${i}`} onApply={(n) => apply(setHold(animations, anim.id, i, n), f(`hold.${i}`))} /></label>{" "}
                <span className="actions small">
                  <button type="button" data-testid={`sequence-up-${i}`} disabled={i === 0} aria-label={`Move entry ${i + 1} up`} onClick={() => apply(moveInSequence(animations, anim.id, i, i - 1), f("sequence"))}>Up</button>
                  <button type="button" data-testid={`sequence-down-${i}`} disabled={i === anim.sequence.length - 1} aria-label={`Move entry ${i + 1} down`} onClick={() => apply(moveInSequence(animations, anim.id, i, i + 1), f("sequence"))}>Down</button>
                  <button type="button" data-testid={`sequence-remove-${i}`} aria-label={`Remove entry ${i + 1}`} onClick={() => apply(removeFromSequence(animations, anim.id, i), f("sequence"))}>Remove</button>
                </span>
              </li>
            ))}
          </ol>
          <div className="actions small">
            <label>Add frame{" "}
              <select data-testid="sequence-add-frame" value={sheet?.frames.some((x) => x.id === frameId) ? frameId : (sheet?.frames[0]?.id ?? "")} onChange={(e) => setFrameId(e.target.value)}>
                {(sheet?.frames ?? []).map((x) => <option key={x.id} value={x.id}>{x.id}</option>)}
              </select>
            </label>
            <button type="button" data-testid="sequence-add" onClick={() => apply(appendToSequence(animations, anim.id, sheet?.frames.some((x) => x.id === frameId) ? frameId : (sheet?.frames[0]?.id ?? "")), f("sequence"))}>Add to sequence</button>
            <button type="button" data-testid="animation-delete" onClick={() => { apply(removeAnimation(animations, anim.id), "animations.animations"); onSelect(null); }}>Delete animation</button>
          </div>
        </div>
      )}
    </section>
  );
}
