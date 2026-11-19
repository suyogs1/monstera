import { useDraft } from "../app/hooks";
import { StatusBadge } from "../ui/ModuleCard";
import { blocking, type CheckItem } from "./completeness";
import { levelTitle, readiness } from "./readiness";
import { useCompleteness } from "./useCompleteness";
import { useVerifiedPlan } from "./verified";

function Items({ items, severity }: { items: readonly CheckItem[]; severity: "error" | "warning" }) {
  const list = items.filter((i) => i.severity === severity);
  if (list.length === 0) return null;
  return (
    <ul className="issues" data-testid={`completeness-${severity}s`}>
      {list.map((i, n) => (
        <li key={`${i.class}-${i.pathText ?? ""}-${n}`} data-class={i.class} data-severity={i.severity}>
          <span className="issue-msg">{i.message}</span>
          <span className="issue-meta"> <code>{i.class}</code>{i.module ? <> · {i.module}</> : null}{i.pathText ? <> · <code>{i.pathText}</code></> : null}</span>
        </li>
      ))}
    </ul>
  );
}

/** The completeness check as a view of its result. Errors block export; warnings do not. */
export function CompletenessView({ items, settled }: { items: readonly CheckItem[]; settled: boolean }) {
  const errors = blocking(items);
  const warnings = items.length - errors.length;
  let status: string;
  if (errors.length > 0) status = `${errors.length} problem${errors.length === 1 ? "" : "s"} block export.`;
  else if (!settled) status = "Checking the stored files and the derived spec…";
  else status = "No problem blocks export.";
  return (
    <section aria-labelledby="completeness-h" data-testid="completeness">
      <header className="section-head">
        <h2 id="completeness-h">Completeness check</h2>
        <p>What is wrong with this project before it is exported. Errors block the export. Warnings do not.</p>
      </header>
      <p className={`status ${errors.length > 0 ? "bad" : settled ? "ok" : "pending"}`} role="status" data-testid="completeness-status" data-blocked={errors.length > 0 ? "1" : "0"}>{status}</p>
      <Items items={items} severity="error" />
      {warnings > 0 && <h3>Warnings</h3>}
      <Items items={items} severity="warning" />
      <p className="muted small">After you generate the source files in Native source, Studio also checks that they equal the engine plan for this draft.</p>
    </section>
  );
}

export function Completeness() {
  const { items, settled } = useCompleteness();
  return <CompletenessView items={items} settled={settled} />;
}

/** The readiness checklist as a view of its inputs. */
export function ReadinessView({ specSha256, generatedFor }: { specSha256: string | null; generatedFor: string | null }) {
  const r = readiness({ specSha256, generatedFor });
  return (
    <section aria-labelledby="readiness-h" data-testid="readiness">
      <header className="section-head">
        <h2 id="readiness-h">Release readiness</h2>
        <p>What has and has not been shown for spec <code>{specSha256 ? specSha256.slice(0, 12) : "none yet"}</code>, and what only you can do.</p>
      </header>
      <p className="notice" data-testid="readiness-not-claimed">{r.notClaimed}</p>
      <h3>Proven for this spec</h3>
      <ul className="cap-list" data-testid="readiness-proofs">
        {r.proofs.map((p) => (
          <li key={p.level} data-level={p.level} data-state={p.state}>
            <div><strong>{levelTitle(p.level)}</strong> <StatusBadge status={p.state === "proven" ? "implemented" : "planned"} label={p.state === "proven" ? "proven" : "not proven"} /></div>
            <p className="small">{p.detail}</p>
          </li>
        ))}
      </ul>
      <h3>Your steps</h3>
      <ul className="cap-list" data-testid="readiness-steps">
        {r.steps.map((s) => (
          <li key={s.id} data-step={s.id}><div><strong>{s.title}</strong></div><p className="small">{s.detail}</p></li>
        ))}
      </ul>
    </section>
  );
}

export function Readiness() {
  const draft = useDraft();
  const specSha256 = draft.validatedRevision === draft.revision && draft.validation?.ok ? draft.validation.sha256 : null;
  return <ReadinessView specSha256={specSha256} generatedFor={useVerifiedPlan()} />;
}
