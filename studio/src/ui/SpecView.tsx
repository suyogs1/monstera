import { Fragment, useMemo, useState } from "react";
import { useDraft } from "../app/hooks";
import { diffLines, hunks } from "./diff";

const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?)|\b(true|false|null)\b/g;

function Highlighted({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) parts.push(text.slice(last, i));
    if (m[1] !== undefined) {
      parts.push(<span key={i} className={m[2] ? "tok-key" : "tok-str"}>{m[1]}</span>);
      if (m[2]) parts.push(m[2]);
    } else if (m[3] !== undefined) parts.push(<span key={i} className="tok-num">{m[3]}</span>);
    else parts.push(<span key={i} className="tok-lit">{m[4]}</span>);
    last = i + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export function SpecView() {
  const { validation, baseline, validatedRevision, revision } = useDraft();
  const [mode, setMode] = useState<"canonical" | "changes">("canonical");
  const text = validation?.canonicalText ?? null;
  const pending = validatedRevision !== revision;
  const changes = useMemo(
    () => (text !== null && baseline?.canonicalText ? hunks(diffLines(baseline.canonicalText, text)) : null), [text, baseline]);
  const edited = text !== null && baseline?.canonicalText != null && text !== baseline.canonicalText;

  return (
    <section aria-labelledby="spec-h" data-testid="spec-view">
      <header className="section-head">
        <h2 id="spec-h">Canonical specification</h2>
        <p>
          This is the file a draft exports as <code>monstera.spec.json</code>: the engine&apos;s own canonical form
          (sorted keys, two-space indent, one trailing newline). It is the only contract with the generator and with Kiro.
          Quantities are raw Q16.16 integers here (1 unit = 65536); the editors show them in game units.
        </p>
      </header>

      <dl className="facts">
        <div><dt>SHA-256</dt><dd data-testid="spec-sha"><code>{validation?.ok ? validation.sha256 : "not available while the draft is invalid"}</code></dd></div>
        <div><dt>State</dt><dd>{pending ? "checking…" : validation?.ok ? "valid" : `${validation?.issues.length ?? 0} issue(s)`}</dd></div>
        <div><dt>Compared with</dt><dd>{baseline ? <>{baseline.label} {edited ? <strong>(edited)</strong> : "(unchanged)"}</> : "nothing loaded"}</dd></div>
      </dl>

      <div className="tabs" role="tablist" aria-label="Specification view">
        <button role="tab" aria-selected={mode === "canonical"} onClick={() => setMode("canonical")}>Canonical JSON</button>
        <button role="tab" aria-selected={mode === "changes"} onClick={() => setMode("changes")}>Changes ({edited ? "edited" : "none"})</button>
      </div>

      {text === null ? (
        <p className="muted">The draft is not parseable JSON, so there is no canonical form yet. See the validation panel.</p>
      ) : mode === "canonical" ? (
        <pre className="code" tabIndex={0} aria-label="Canonical specification JSON">
          {text.replace(/\n$/, "").split("\n").map((line, i) => (
            <Fragment key={i}><span className="ln">{i + 1}</span><Highlighted text={line} />{"\n"}</Fragment>
          ))}
        </pre>
      ) : changes === null || !edited ? (
        <p className="muted">No changes: the draft equals {baseline?.label ?? "its starting point"}.</p>
      ) : (
        <pre className="code diff" tabIndex={0} aria-label="Changes against the starting point">
          {changes.map((l, i) => l.kind === "skip" ? (
            <span key={i} className="skip">{`… ${l.count} unchanged line${l.count === 1 ? "" : "s"}\n`}</span>
          ) : (
            <span key={i} className={l.kind}>{`${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}\n`}</span>
          ))}
        </pre>
      )}
    </section>
  );
}
