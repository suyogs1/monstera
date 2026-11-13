import { goToPath } from "../app/navigate";
import { useDraft } from "../app/hooks";
import type { SectionId } from "../app/sections";
import { parseIssuePath } from "../draft/path";

export function ValidationPanel({ setSection }: { setSection: (id: SectionId) => void }) {
  const { validation, revision, validatedRevision } = useDraft();
  const pending = validatedRevision !== revision;
  const issues = validation?.issues ?? [];

  let status: string;
  if (!validation) status = "Checking with the engine…";
  else if (pending) status = "Checking with the engine…";
  else if (validation.ok) status = "Valid: the engine accepts this specification.";
  else status = `${issues.length} issue${issues.length === 1 ? "" : "s"} reported by the engine.`;

  return (
    <aside className="validation" aria-labelledby="validation-h">
      <h2 id="validation-h">Validation</h2>
      <p className={`status ${pending || !validation ? "pending" : validation.ok ? "ok" : "bad"}`} role="status" aria-live="polite" data-testid="validation-status">
        {status}
      </p>
      <p className="muted small">Results come from the MONSTERA engine running in this page (the same checks as <code>monstera validate</code>).</p>
      {!pending && issues.length > 0 && (
        <ul className="issues" data-testid="issues">
          {issues.map((issue, i) => {
            const path = parseIssuePath(issue.path);
            return (
              <li key={`${issue.path}-${issue.code}-${i}`}>
                <button type="button" disabled={!path} onClick={() => path && goToPath(path, setSection)} title={path ? "Go to the field" : undefined}>
                  <span className="issue-msg">{issue.message}</span>
                  <span className="issue-meta"><code>{issue.path}</code> · <code>{issue.code}</code></span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
