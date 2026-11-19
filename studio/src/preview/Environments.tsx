import type { EnvRow } from "./envTable";

/** The environments table of the Preview and Device Lab module (R11.2). Rows come from `environmentTable`; nothing is added here. */
export function Environments({ rows, sha }: { rows: EnvRow[]; sha: string | null }) {
  return (
    <section className="card" aria-labelledby="env-h" data-testid="environments">
      <header><h3 id="env-h">Test environments for this spec hash</h3></header>
      <p className="muted small">
        Which checks exist at which environment for exactly this specification{sha ? <> (SHA-256 <code>{sha.slice(0, 12)}</code>)</> : null}.
        Each state is read from a committed record or from this page&apos;s own check. An absent record reads <em>no evidence for this hash</em>;
        nothing is inferred from another environment, another hash or the template this draft started from.
      </p>
      <table className="inv-table" data-testid="environments-rows">
        <thead><tr><th scope="col">Environment</th><th scope="col">State</th><th scope="col">Source record</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.env} data-env={r.env} data-state={r.state}>
              <th scope="row"><code>{r.env}</code></th>
              <td><strong>{r.state}</strong><br /><span className="muted small">{r.detail}</span></td>
              <td className="small">{r.sources.length ? r.sources.map((s) => <div key={s}><code>{s}</code></div>) : <span className="muted">none</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
