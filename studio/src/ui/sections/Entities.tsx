import { useEffect, useId, useState } from "react";
import { useSection, useSession } from "../../app/hooks";
import { goToPath } from "../../app/navigate";
import { addInitialEntity, addKind, removeInitialEntity, removeKind, renameKind, kindReferences, type KindRef } from "../../draft/ops";
import { getAt, toIssuePath, toPattern, type Path } from "../../draft/path";
import { Card, Field, FieldGrid, KindSelect, useDoc, useFieldInfo, useFieldIssues, useValue } from "../fields";

const RT: Path = ["game", "runtime"];

function KindIdField({ index }: { index: number }) {
  const { store } = useSession();
  const doc = useDoc();
  const path: Path = [...RT, "kinds", index, "id"];
  const value = String(useValue(path) ?? "");
  const info = useFieldInfo(toPattern(path));
  const issues = useFieldIssues(path);
  const id = useId();
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { setText(value); }, [value]);

  // A rename rewrites every reference, so it is applied once, when the user confirms the new id (Enter or leaving the field).
  const commit = () => {
    if (doc === null || text === value) { setError(null); return; }
    if (info?.regex && !new RegExp(info.regex).test(text)) {
      setError(info.description ?? "This is not a valid kind id.");
      return;
    }
    const r = renameKind(doc, value, text);
    if (!r.ok) { setError(r.reason); return; }
    store.replace(r.doc);
    setError(null);
    setNote(r.updatedReferences === 0 ? "Renamed." : `Renamed. ${r.updatedReferences} reference${r.updatedReferences === 1 ? "" : "s"} updated.`);
  };

  return (
    <div className={`field${error || issues.length ? " has-issue" : ""}`}>
      <label htmlFor={id}>Kind id</label>
      <input id={id} type="text" className="mono" value={text} spellCheck={false}
        data-path={toIssuePath(path)} data-pattern={toPattern(path)} aria-invalid={Boolean(error) || issues.length > 0} aria-describedby={`${id}-help`}
        onChange={(e) => { setText(e.target.value); setError(null); setNote(null); }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setText(value); setError(null); } }} />
      <small id={`${id}-help`} className="help">{info?.description} Renaming updates every place that uses it; press Enter or leave the field to apply.</small>
      {error && <small className="issue-inline" role="alert">{error}</small>}
      {note && !error && <small className="note" role="status">{note}</small>}
      {issues.map((i) => <small key={i.code} className="issue-inline" role="alert">{i.message}</small>)}
    </div>
  );
}

function Swatch({ index }: { index: number }) {
  const color = String(useValue([...RT, "kinds", index, "color"]) ?? "#000000");
  const glyph = String(useValue([...RT, "kinds", index, "glyph"]) ?? "");
  const w = Number(useValue([...RT, "kinds", index, "width"]) ?? 1), h = Number(useValue([...RT, "kinds", index, "height"]) ?? 1);
  const ratio = h > 0 && w > 0 ? Math.min(4, Math.max(0.25, w / h)) : 1;
  return (
    <span className="swatch" style={{ background: /^#[0-9A-Fa-f]{6}$/.test(color) ? color : "transparent", aspectRatio: String(ratio) }} aria-hidden="true">
      {glyph}
    </span>
  );
}

function KindCard({ index }: { index: number }) {
  const { store } = useSession();
  const [, setSection] = useSection();
  const doc = useDoc();
  const id = String(useValue([...RT, "kinds", index, "id"]) ?? "");
  const [blocked, setBlocked] = useState<{ reason: string; references: KindRef[] } | null>(null);
  const uses = doc === null ? 0 : kindReferences(doc, id).length;
  const base = [...RT, "kinds", index];

  const onRemove = () => {
    if (doc === null) return;
    const r = removeKind(doc, id);
    if (r.ok) { store.replace(r.doc); setBlocked(null); } else setBlocked({ reason: r.reason, references: r.references });
  };

  return (
    <Card dataPath={toIssuePath(base)} title={<><Swatch index={index} /> <span className="mono">{id || "(no id)"}</span></>}
      aside={<span className="muted small">used in {uses} place{uses === 1 ? "" : "s"}</span>}>
      <FieldGrid>
        <KindIdField index={index} />
        <Field path={[...base, "width"]} label="Width" />
        <Field path={[...base, "height"]} label="Height" />
        <Field path={[...base, "lifetimeTicks"]} label="Lifetime (ticks)" />
        <Field path={[...base, "exitPolicy"]} label="At the world edge" />
        <Field path={[...base, "color"]} label="Colour" />
        <Field path={[...base, "glyph"]} label="Symbol" />
        <Field path={[...base, "effect"]} label="Vanish effect" />
      </FieldGrid>
      <div className="row-actions">
        <button type="button" className="danger" onClick={onRemove}>Remove kind</button>
      </div>
      {blocked && (
        <div className="blocked" role="alert">
          <p>{blocked.reason}. Change these first:</p>
          <ul>{blocked.references.map((r) => (
            <li key={r.path.join(".")}><button type="button" className="link" onClick={() => goToPath(r.path, setSection)}>{r.label}</button></li>
          ))}</ul>
        </div>
      )}
    </Card>
  );
}

function StartingEntity({ index }: { index: number }) {
  const { store } = useSession();
  const doc = useDoc();
  const base = [...RT, "initialEntities", index];
  return (
    <Card dataPath={toIssuePath(base)} title={`Starting entity ${index + 1}`}>
      <FieldGrid>
        <KindSelect path={[...base, "kind"]} label="Kind" />
        <Field path={[...base, "x"]} label="Left position" />
        <Field path={[...base, "y"]} label="Top position" />
        <Field path={[...base, "vx"]} label="Velocity, horizontal" />
        <Field path={[...base, "vy"]} label="Velocity, vertical" />
        <Field path={[...base, "controlled"]} label="Controlled by the player" />
      </FieldGrid>
      <div className="row-actions">
        <button type="button" className="danger" onClick={() => doc !== null && store.replace(removeInitialEntity(doc, index))}>Remove</button>
      </div>
    </Card>
  );
}

export function Entities() {
  const { store } = useSession();
  const doc = useDoc();
  const kinds = doc === null ? 0 : (Array.isArray(getAt(doc, [...RT, "kinds"])) ? (getAt(doc, [...RT, "kinds"]) as unknown[]).length : 0);
  const starts = doc === null ? 0 : (Array.isArray(getAt(doc, [...RT, "initialEntities"])) ? (getAt(doc, [...RT, "initialEntities"]) as unknown[]).length : 0);
  return (
    <section aria-labelledby="entities-h">
      <header className="section-head">
        <h2 id="entities-h">Entities</h2>
        <p>
          Every kind of thing in the game: the player, hazards, pickups, bullets, background decoration. Positions are the
          top-left corner. Sizes and positions are in world units (the world is set under Gameplay).
        </p>
      </header>

      <h3 className="group">Kinds ({kinds})</h3>
      {Array.from({ length: kinds }, (_, i) => <KindCard key={i} index={i} />)}
      <button type="button" className="primary" onClick={() => { if (doc !== null) { const r = addKind(doc); store.replace(r.doc); } }}>Add kind</button>

      <h3 className="group">Starting entities ({starts})</h3>
      <p className="muted">What exists when a session begins. At least one is normally the player.</p>
      {Array.from({ length: starts }, (_, i) => <StartingEntity key={i} index={i} />)}
      <button type="button" onClick={() => { if (doc !== null) store.replace(addInitialEntity(doc)); }}>Add starting entity</button>
    </section>
  );
}
