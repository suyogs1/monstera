import { useEffect, useState } from "react";
/** A whole-number field that applies on Enter or blur, so half typed values never reach the manifest. Non-integers are refused here. */
export function IntField({ label, value, onApply, testId }: { label: string; value: number; onApply: (n: number) => void; testId?: string }) {
  const [text, setText] = useState(String(value));
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(String(value)); setBad(false); }, [value]);
  const apply = () => {
    if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(Number(text))) { setBad(true); return; }
    setBad(false);
    if (Number(text) !== value) onApply(Number(text));
  };
  return (
    <>
      <input type="text" inputMode="numeric" autoComplete="off" spellCheck={false} className="mono num" aria-label={label} aria-invalid={bad}
        data-testid={testId} value={text}
        onChange={(e) => { setText(e.target.value); setBad(false); }}
        onBlur={apply} onKeyDown={(e) => { if (e.key === "Enter") apply(); }} />
      {bad && <small className="issue-inline" role="alert">whole number expected: not applied</small>}
    </>
  );
}
