// Controls bound to a JSON path of the draft. Labels are hand-written (the layouts are composed by hand); the
// description, constraints, enum values and the Q16.16 unit come from the engine's schema. A control never
// judges a value: it writes what the user typed when it is well formed and shows the engine's verdict beside it.
import { useEffect, useId, useState, type ReactNode } from "react";
import { usePrefs } from "../app/prefs";
import { useDraft, useSession } from "../app/hooks";
import { toIssuePath, toPattern, type Path } from "../draft/path";
import { getAt } from "../draft/path";
import { kindIds } from "../draft/ops";
import type { Issue } from "../engine/protocol";
import type { FieldInfo, Json } from "../schema/schema";
import { formatUnits, parseUnits, type ParseResult } from "../units/q16";

export function useValue(path: Path): Json | undefined {
  return getAt(useDraft().doc ?? undefined, path);
}

export function useFieldInfo(pattern: string): FieldInfo | undefined {
  return useSession().schema?.field(pattern);
}

/** Engine issues reported exactly at this path. Hidden while a newer edit is still being checked. */
export function useFieldIssues(path: Path): Issue[] {
  const { validation, revision, validatedRevision } = useDraft();
  if (!validation || revision !== validatedRevision) return [];
  const key = toIssuePath(path);
  return validation.issues.filter((i) => i.path === key);
}

export function useDoc(): Json | null {
  return useDraft().doc;
}

export function useKindIds(): string[] {
  const doc = useDoc();
  return doc === null ? [] : kindIds(doc);
}

function constraintText(info: FieldInfo, raw: boolean): string {
  const bits: string[] = [];
  if (info.unit === "q16" && !raw) {
    const short = (n: number) => { const t = formatUnits(n); return t.includes(".") && t.length > 10 ? `${t.slice(0, t.indexOf(".") + 5)}…` : t; };
    if (info.minimum !== undefined && info.maximum !== undefined) bits.push(`${short(info.minimum)} to ${short(info.maximum)} units`);
    bits.push("exact to 1/65536");
  } else if (info.type === "integer" || info.type === "number") {
    if (info.minimum !== undefined && info.maximum !== undefined) bits.push(`${info.minimum} to ${info.maximum}`);
    else if (info.exclusiveMinimum !== undefined && info.maximum !== undefined) bits.push(`above ${info.exclusiveMinimum}, up to ${info.maximum}`);
    if (info.unit === "q16") bits.push("raw Q16.16 integer");
  } else if (info.type === "string" && !info.enum) {
    if (info.minLength !== undefined && info.maxLength !== undefined) bits.push(`${info.minLength} to ${info.maxLength} characters`);
    else if (info.maxLength !== undefined) bits.push(`up to ${info.maxLength} characters`);
  }
  return bits.join(" · ");
}

interface ShellProps {
  label: string;
  help?: string | undefined;
  info: FieldInfo | undefined;
  issues: Issue[];
  raw?: boolean;
  inputId: string;
  children: ReactNode;
  extra?: ReactNode;
  wide?: boolean;
}

function Shell({ label, help, info, issues, raw, inputId, children, extra, wide }: ShellProps) {
  const text = help ?? info?.description ?? "";
  const constraint = info ? constraintText(info, raw === true) : "";
  return (
    <div className={`field${wide ? " wide" : ""}${issues.length ? " has-issue" : ""}`}>
      <label htmlFor={inputId}>{label}</label>
      {children}
      {extra}
      {(text || constraint) && (
        <small id={`${inputId}-help`} className="help">
          {text}{text && constraint ? " " : ""}{constraint && <span className="constraint">{constraint}</span>}
        </small>
      )}
      {issues.map((i) => <small key={i.code + i.message} className="issue-inline" role="alert">{i.message}</small>)}
    </div>
  );
}

// ------------------------------------------------------------------ text input that edits numbers without clobbering partial input
function NumberBox(props: {
  path: Path; value: Json | undefined; format: (n: number) => string; parse: (t: string) => ParseResult;
  onCommit: (n: number) => void; id: string; describedBy: string; invalid: boolean; mono?: boolean;
}) {
  const current = typeof props.value === "number" ? props.value : undefined;
  const [text, setText] = useState(current === undefined ? "" : props.format(current));
  const [local, setLocal] = useState<string | null>(null);

  useEffect(() => {
    // Keep what the user typed while it still means the same number; otherwise follow the document (reset, rename, import).
    const p = props.parse(text);
    if (!(p.ok && p.raw === current)) { setText(current === undefined ? "" : props.format(current)); setLocal(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, props.format]);

  return (
    <>
      <input
        id={props.id} type="text" inputMode="decimal" autoComplete="off" spellCheck={false}
        className={props.mono ? "mono" : undefined}
        value={text}
        data-path={toIssuePath(props.path)} data-pattern={toPattern(props.path)}
        aria-invalid={props.invalid || local !== null} aria-describedby={props.describedBy}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          const p = props.parse(t);
          if (p.ok) { setLocal(null); if (p.raw !== current) props.onCommit(p.raw); } else setLocal(p.reason);
        }}
        onBlur={() => { if (local !== null) { setText(current === undefined ? "" : props.format(current)); setLocal(null); } }}
      />
      {local && <small className="issue-inline" role="alert">{local}: not applied</small>}
    </>
  );
}

const parseInteger = (t: string): ParseResult => (/^[+-]?\d+$/.test(t.trim()) && Number.isSafeInteger(Number(t)) ? { ok: true, raw: Number(t) } : { ok: false, reason: "whole number expected" });
const parseDecimal = (t: string): ParseResult => (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t.trim()) ? { ok: true, raw: Number(t) } : { ok: false, reason: "number expected" });
const asText = (n: number) => String(n);

interface FieldProps { path: Path; label: string; help?: string; wide?: boolean; note?: string }

/** Picks the control from the schema: enum, boolean, colour, text, Q16.16 quantity, integer or number. */
export function Field({ path, label, help, wide, note }: FieldProps) {
  const { store } = useSession();
  const { mode } = usePrefs();
  const info = useFieldInfo(toPattern(path));
  const value = useValue(path);
  const issues = useFieldIssues(path);
  const id = useId();
  const describedBy = `${id}-help`;
  const common = { "data-path": toIssuePath(path), "data-pattern": toPattern(path), "aria-invalid": issues.length > 0, "aria-describedby": describedBy };
  const set = (v: Json) => store.set(path, v);
  if (!info) return <p className="issue-inline">No schema entry for {toPattern(path)}.</p>;

  if (info.enum) {
    const options = info.enum.map(String);
    const odd = typeof value === "string" && !options.includes(value) ? value : undefined;
    return (
      <Shell label={label} help={help} info={info} issues={issues} inputId={id} wide={wide}>
        <select id={id} value={typeof value === "string" || typeof value === "number" ? String(value) : ""} {...common}
          onChange={(e) => set(info.type === "integer" ? Number(e.target.value) : e.target.value)}>
          {odd !== undefined && <option value={odd}>{odd} (not allowed)</option>}
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Shell>
    );
  }

  if (info.type === "boolean") {
    return (
      <div className={`field check${issues.length ? " has-issue" : ""}`}>
        <label className="checkbox">
          <input id={id} type="checkbox" checked={value === true} {...common} onChange={(e) => set(e.target.checked)} />
          <span>{label}</span>
        </label>
        {(help ?? info.description) && <small id={describedBy} className="help">{help ?? info.description}</small>}
        {issues.map((i) => <small key={i.code} className="issue-inline" role="alert">{i.message}</small>)}
      </div>
    );
  }

  if (info.type === "string") {
    const text = typeof value === "string" ? value : "";
    if (info.defs.includes("color")) {
      const valid = /^#[0-9A-Fa-f]{6}$/.test(text);
      return (
        <Shell label={label} help={help} info={info} issues={issues} inputId={id} wide={wide}
          extra={undefined}>
          <span className="color-row">
            <input type="color" aria-label={`${label} colour picker`} value={valid ? text.toLowerCase() : "#000000"}
              onChange={(e) => set(e.target.value.toUpperCase())} />
            <input id={id} type="text" className="mono" value={text} maxLength={7} spellCheck={false} {...common}
              onChange={(e) => set(e.target.value.toUpperCase())} />
          </span>
        </Shell>
      );
    }
    return (
      <Shell label={label} help={help} info={info} issues={issues} inputId={id} wide={wide}
        extra={info.defs.includes("glyph") ? <EmojiPicker onPick={(g) => set(g)} /> : undefined}>
        <input id={id} type="text" value={text} spellCheck={false} {...common} onChange={(e) => set(e.target.value)} />
      </Shell>
    );
  }

  if (info.type === "integer" || info.type === "number") {
    const q16 = info.unit === "q16";
    const raw = q16 && mode === "raw";
    const display = q16 && !raw;
    const current = typeof value === "number" ? value : undefined;
    return (
      <Shell label={label} help={help} info={info} issues={issues} inputId={id} raw={raw} wide={wide}
        extra={<>
          {display && current !== undefined && <span className="rawchip" aria-label={`raw value ${current}`}>raw {current}</span>}
          {note && <small className="note">{note}</small>}
        </>}>
        <NumberBox path={path} value={value} id={id} describedBy={describedBy} invalid={issues.length > 0} mono
          format={display ? formatUnits : asText}
          parse={display ? parseUnits : info.type === "integer" || q16 ? parseInteger : parseDecimal}
          onCommit={(n) => set(n)} />
      </Shell>
    );
  }
  return <p className="issue-inline">Unsupported field type at {toPattern(path)}.</p>;
}

// ------------------------------------------------------------------ kind references
export function KindSelect({ path, label, help, allowNone, wide }: FieldProps & { allowNone?: boolean }) {
  const { store } = useSession();
  const info = useFieldInfo(toPattern(path));
  const value = useValue(path);
  const issues = useFieldIssues(path);
  const ids = useKindIds();
  const id = useId();
  const current = typeof value === "string" ? value : "";
  const unknown = current !== "" && !ids.includes(current);
  // The shared kind-id definition describes the id format, which is irrelevant to choosing from a list.
  // A field's own description (for example "Entity kind spawned by a tap") is kept.
  const genericOnly = /^Lowercase ASCII identifier/.test(info?.description ?? "");
  return (
    <Shell label={label} help={help ?? (genericOnly ? "" : undefined)} info={info} issues={issues} inputId={id} wide={wide}>
      <select id={id} value={current} data-path={toIssuePath(path)} data-pattern={toPattern(path)} aria-invalid={issues.length > 0}
        aria-describedby={`${id}-help`} onChange={(e) => store.set(path, e.target.value)}>
        {allowNone && <option value="">(none)</option>}
        {unknown && <option value={current}>{current} (no such kind)</option>}
        {ids.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
    </Shell>
  );
}

/** Set of enum values stored as an array, e.g. project.targets. */
export function EnumSetField({ path, label, help }: FieldProps) {
  const { store } = useSession();
  const pattern = `${toPattern(path)}[]`;
  const info = useFieldInfo(pattern);
  const value = useValue(path);
  const issues = useFieldIssues(path);
  const id = useId();
  const chosen = Array.isArray(value) ? value.map(String) : [];
  const options = (info?.enum ?? []).map(String);
  return (
    <fieldset className={`field${issues.length ? " has-issue" : ""}`} data-path={toIssuePath(path)} data-pattern={pattern} tabIndex={-1} aria-describedby={`${id}-help`}>
      <legend>{label}</legend>
      <span className="checks">
        {options.map((o) => (
          <label key={o} className="checkbox">
            <input type="checkbox" checked={chosen.includes(o)}
              onChange={(e) => store.set(path, e.target.checked ? options.filter((x) => x === o || chosen.includes(x)) : chosen.filter((x) => x !== o))} />
            <span>{o}</span>
          </label>
        ))}
      </span>
      <small id={`${id}-help`} className="help">{help ?? info?.description ?? ""}</small>
      {issues.map((i) => <small key={i.code} className="issue-inline" role="alert">{i.message}</small>)}
    </fieldset>
  );
}

// ------------------------------------------------------------------ read-only value (engine-managed and derived facts)
export function ReadOnly({ path, label, note }: { path: Path; label: string; note: string }) {
  const value = useValue(path);
  const id = useId();
  return (
    <div className="field">
      <span id={id}>{label}</span>
      <output aria-labelledby={id} data-path={toIssuePath(path)} data-pattern={toPattern(path)} className="mono readonly" tabIndex={-1}>{String(value ?? "")}</output>
      <small className="help">{note}</small>
    </div>
  );
}

const EMOJI = ["🎃", "👻", "🦇", "🕷️", "💀", "🧙", "🧛", "🍬", "🍭", "🔥", "⭐", "🌙", "🕯️", "🛸", "🚀", "💎", "❤️", "♥", "🏃", "⚰️", "🪦", "🐍", "🐸", "🍎"];

function EmojiPicker({ onPick }: { onPick(g: string): void }) {
  return (
    <details className="emoji">
      <summary>Pick a symbol</summary>
      <span className="emoji-grid" role="group" aria-label="Symbols">
        {EMOJI.map((g) => <button key={g} type="button" onClick={() => onPick(g)} aria-label={`Use ${g}`}>{g}</button>)}
        <button type="button" onClick={() => onPick("")} aria-label="No symbol (draw the colour)">none</button>
      </span>
    </details>
  );
}

export function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="field-grid">{children}</div>;
}

export function Card({ title, aside, children, dataPath, selected, onActivate }: {
  title: ReactNode; aside?: ReactNode; children: ReactNode; dataPath?: string;
  /** Click-through: the card is the selected kind (highlighted in the preview); onActivate runs on focus or click inside. */
  selected?: boolean; onActivate?: () => void;
}) {
  return (
    <section className={selected ? "card selected" : "card"} data-path={dataPath} data-selected={selected ? "true" : undefined}
      tabIndex={dataPath ? -1 : undefined} onFocusCapture={onActivate} onPointerDown={onActivate}>
      <header><h3>{title}</h3>{aside}</header>
      {children}
    </section>
  );
}
