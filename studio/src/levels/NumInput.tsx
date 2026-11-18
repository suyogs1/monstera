import { useEffect, useState } from "react";
import { usePrefs } from "../app/prefs";
import { formatUnits, parseUnits, type ParseResult } from "../units/q16";

const parseInt10 = (t: string): ParseResult => (/^[+-]?\d+$/.test(t.trim()) && Number.isSafeInteger(Number(t)) ? { ok: true, raw: Number(t) } : { ok: false, reason: "whole number expected" });

/**
 * A number field for the levels manifest. "fixed" quantities are Q16.16 raw integers shown in game units or raw
 * (the display preference); "int" values (ticks) are plain integers. It writes only what parses; the manifest
 * validator, not this control, decides whether the value is allowed.
 */
export function NumInput({ label, value, kind, onCommit }: { label: string; value: number; kind: "fixed" | "int"; onCommit: (n: number) => void }) {
  const { mode } = usePrefs();
  const units = kind === "fixed" && mode === "units";
  const fmt = (n: number): string => (units ? formatUnits(n) : String(n));
  const parse = (t: string): ParseResult => (units ? parseUnits(t) : parseInt10(t));
  const [text, setText] = useState(fmt(value));
  const [bad, setBad] = useState<string | null>(null);
  useEffect(() => {
    const p = parse(text);
    if (!(p.ok && p.raw === value)) { setText(fmt(value)); setBad(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, units]);
  return (
    <>
      <input type="text" inputMode="decimal" autoComplete="off" spellCheck={false} className="mono num" aria-label={label} aria-invalid={bad !== null}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const p = parse(e.target.value);
          if (p.ok) { setBad(null); if (p.raw !== value) onCommit(p.raw); } else setBad(p.reason);
        }}
        onBlur={() => { if (bad !== null) { setText(fmt(value)); setBad(null); } }} />
      {bad !== null && <small className="issue-inline" role="alert">{bad}: not applied</small>}
    </>
  );
}
