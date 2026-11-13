import { useSection, useDraft } from "../../app/hooks";
import { goToPath } from "../../app/navigate";
import { facts, ruleSentences, spawnLines } from "../../brain/summary";
import { Card, Field, FieldGrid, ReadOnly } from "../fields";

export function Overview() {
  const { doc, validation, baseline, revision, validatedRevision } = useDraft();
  const [, setSection] = useSection();
  if (doc === null) return null;
  const pending = validatedRevision !== revision;
  const edited = validation?.canonicalText != null && baseline?.canonicalText != null && validation.canonicalText !== baseline.canonicalText;
  const rules = ruleSentences(doc);
  const spawns = spawnLines(doc);

  return (
    <section aria-labelledby="overview-h">
      <header className="section-head">
        <h2 id="overview-h">Project Brain</h2>
        <p>
          One specification describes the whole game. This page reads it back in plain words and links each line to the
          control that changes it. Everything you edit here is the same <code>monstera.spec.json</code> that Kiro and the
          generator use.
        </p>
      </header>

      <dl className="facts health" data-testid="health">
        <div><dt>Engine verdict</dt><dd className={pending ? "pending" : validation?.ok ? "ok" : "bad"}>{pending || !validation ? "checking…" : validation.ok ? "valid" : `${validation.issues.length} issue(s)`}</dd></div>
        <div><dt>Starting point</dt><dd>{baseline?.label ?? "none"} {edited ? <strong>· edited</strong> : "· unchanged"}</dd></div>
        <div><dt>Spec SHA-256</dt><dd><code>{validation?.ok ? validation.sha256?.slice(0, 16) + "…" : "n/a while invalid"}</code></dd></div>
      </dl>

      <Card title="Identity">
        <FieldGrid>
          <Field path={["project", "displayName"]} label="Game name" />
          <Field path={["project", "id"]} label="Project id" />
          <Field path={["project", "identifier"]} label="App identifier" />
          <Field path={["project", "version", "name"]} label="Version" />
          <Field path={["project", "version", "code"]} label="Build number" />
          <ReadOnly path={["specVersion"]} label="Specification format" note="Owned by the engine; a new format version is a migration, not an edit." />
        </FieldGrid>
      </Card>

      <Card title="The game at a glance">
        <ul className="tiles">
          {facts(doc).map((f) => (
            <li key={f.label}>
              <button type="button" className="tile" onClick={() => goToPath(f.path, setSection)}>
                <span className="muted small">{f.label}</span>
                <strong>{f.value}</strong>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <div className="two-col">
        <Card title="Rules at a glance">
          {rules.length === 0 ? <p className="muted">No collision rules yet.</p> : (
            <ul className="sentences" data-testid="rule-sentences">
              {rules.map((r) => <li key={r.path.join(".")}><button type="button" className="link" onClick={() => goToPath(r.path, setSection)}>{r.text}</button></li>)}
            </ul>
          )}
        </Card>
        <Card title="Spawn rhythm">
          {spawns.length === 0 ? <p className="muted">Nothing spawns yet.</p> : (
            <ul className="sentences" data-testid="spawn-sentences">
              {spawns.map((r) => <li key={r.path.join(".")}><button type="button" className="link" onClick={() => goToPath(r.path, setSection)}>{r.text}</button></li>)}
            </ul>
          )}
          <p className="muted small">Difficulty is not a setting. It comes from these spawners: more of them, shorter intervals, later start ticks.</p>
        </Card>
      </div>
    </section>
  );
}
