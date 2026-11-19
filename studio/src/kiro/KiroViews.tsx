import { useEffect, useState } from "react";
import { useDraft, useSession } from "../app/hooks";
import { useProject } from "../project/context";
import type { DriftReport } from "./drift";
import { driftFromZip } from "./drift";
import { parseProposal, type Proposal, type ProposalDiffRow, type ProposalPlan } from "./proposal";
const MAX_PICKED = 64 * 1024 * 1024;
const STATE_TEXT = { unchanged: "unchanged", edited: "edited", missing: "missing", unknown: "unknown" } as const;
/** Pure view of a drift report (also used by tests). */
export function DriftTable({ report }: { report: DriftReport }) {
  const { counts, drift } = report;
  return (
    <div data-testid="drift-report">
      <p data-testid="drift-summary">
        {counts.unchanged} unchanged, {counts.edited} edited, {counts.missing} missing, {counts.unknown} unknown.{" "}
        {drift.length === 0 ? "No scaffold drift." : `${drift.length} scaffold file${drift.length === 1 ? "" : "s"} drifted: the check script exits with 1.`}
      </p>
      {report.invalid.length > 0 && (
        <ul role="alert">{report.invalid.map((i) => <li key={i.path}><code>{i.path}</code> does not pass its schema: {i.message}</li>)}</ul>
      )}
      <table className="inv-table">
        <thead><tr><th scope="col">State</th><th scope="col">Class</th><th scope="col">File</th></tr></thead>
        <tbody>
          {report.files.map((f) => (
            <tr key={f.path} data-testid="drift-row" data-state={f.state}>
              <td>{STATE_TEXT[f.state]}</td><td>{f.class ?? "-"}</td><th scope="row"><code>{f.path}</code></th>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Edited or missing studio-scaffold files are drift. Edits to studio-data files are informational. Write-once files may be edited
        freely. Engine-owned files and the spec are checked by the engine&apos;s own <code>monstera verify</code>, not here.
      </p>
    </div>
  );
}
/** Drift view: classify a re-imported export. Nothing is uploaded; the file is read in this page. */
export function Drift() {
  const [state, setState] = useState<{ name: string; result: Awaited<ReturnType<typeof driftFromZip>> } | { busy: true } | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_PICKED) { setState({ name: file.name, result: { ok: false, error: "the file is larger than 64 MiB" } }); return; }
    setState({ busy: true });
    setState({ name: file.name, result: await driftFromZip(new Uint8Array(await file.arrayBuffer())) });
  };
  return (
    <section aria-labelledby="drift-h" data-testid="drift">
      <header className="section-head">
        <h2 id="drift-h">Drift</h2>
        <p>Re-import an exported project ZIP to see which Studio-written files were edited, are missing or are not listed.</p>
      </header>
      <label>Exported project (ZIP) <input type="file" accept=".zip,application/zip" data-testid="drift-file" onChange={(e) => void pick(e.target.files?.[0])} /></label>
      <p className="muted small">The same classification as <code>tools/check-drift.sh</code> inside the export. The file is read in this page and not sent anywhere.</p>
      {state !== null && "busy" in state && <p>Reading…</p>}
      {state !== null && "result" in state && (state.result.ok
        ? <DriftTable report={state.result.report} />
        : <p role="alert" data-testid="drift-error">Not imported: {state.result.error}</p>)}
    </section>
  );
}
const SHOWN = 400;
const clip = (s: string) => (s.length > SHOWN ? `${s.slice(0, SHOWN)}… (${s.length} characters)` : s);
export function ProposalDiff({ rows }: { rows: ProposalDiffRow[] }) {
  return (
    <table className="inv-table" data-testid="proposal-diff">
      <thead><tr><th scope="col">Operation</th><th scope="col">Path</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}><td>{r.op}</td><th scope="row"><code>{r.path}</code></th><td><code>{r.before === "" ? "(absent)" : clip(r.before)}</code></td><td><code>{r.after === "" ? "(removed)" : clip(r.after)}</code></td></tr>
        ))}
      </tbody>
    </table>
  );
}
type Review = Extract<Awaited<ReturnType<ReturnType<typeof useSession>["reviewProposal"]>>, { ok: true }>;
const MAX_PROPOSAL_BYTES = 256 * 1024;
/**
 * Proposal inbox. Step 1 reads a file and checks it (schema, then the engine or the manifest rules) without writing anything.
 * Step 2 shows the difference. Accept commits it as one undo step; Reject discards it and changes nothing.
 */
export function ProposalInbox() {
  const session = useSession();
  const project = useProject();
  const draft = useDraft();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stale = review !== null && (review.expected.doc !== draft.doc || review.expected.manifests !== project.manifests);
  useEffect(() => { if (stale) { setReview(null); setMessage("The project changed after the proposal was checked. Check it again."); } }, [stale]);
  const clear = () => { setProposal(null); setReview(null); };
  const load = async (file: File | undefined) => {
    if (!file) return;
    clear(); setMessage(null);
    if (file.size > MAX_PROPOSAL_BYTES) { setMessage("Not read: the file is larger than 256 KiB."); return; }
    const parsed = parseProposal(await file.text());
    if (!parsed.ok) { setMessage(`Not a valid proposal: ${parsed.message}`); return; }
    setProposal(parsed.proposal);
    setBusy(true);
    try {
      const r = await session.reviewProposal(parsed.proposal);
      if (r.ok) setReview(r); else setMessage(`Refused (${r.stage}): ${r.message}. Nothing was changed.`);
    } finally { setBusy(false); }
  };
  const accept = () => {
    if (review === null || stale) return;
    const r = session.applyReviewedProposal(review);
    clear();
    setMessage(r.ok ? "Applied as one undo step." : `Not applied: ${r.message}. Nothing was changed.`);
  };
  const reject = () => { clear(); setMessage("Rejected. Nothing was changed."); };
  if (project.manifests === null || draft.doc === null) return <p className="muted">Open a project to review a proposal.</p>;
  const plan: ProposalPlan | null = review?.plan ?? null;
  return (
    <section aria-labelledby="proposals-h" data-testid="proposals">
      <header className="section-head">
        <h2 id="proposals-h">Proposal inbox</h2>
        <p>Review a change someone else prepared, for example Kiro. A proposal is data: Studio checks it, shows the difference and applies it only when you accept.</p>
      </header>
      <label>Proposal file (JSON) <input type="file" accept=".json,application/json" data-testid="proposal-file" onChange={(e) => void load(e.target.files?.[0])} /></label>
      <p className="muted small">
        Studio cannot tell who or what wrote a proposal, and it makes no model call. Binary assets cannot arrive this way; import an image or sound
        in the Asset library and declare its origin there.
      </p>
      {busy && <p>Checking…</p>}
      {message !== null && <p role="status" data-testid="proposal-message">{message}</p>}
      {proposal !== null && plan !== null && (
        <div className="card" data-testid="proposal-review">
          <h3>{proposal.summary}</h3>
          <p className="small">Target: <code>{proposal.target}</code>. The engine or manifest checks passed on the result; nothing is written until you accept.</p>
          <ProposalDiff rows={plan.diff} />
          <p>
            <button type="button" data-testid="proposal-accept" disabled={stale} onClick={accept}>Accept and apply</button>{" "}
            <button type="button" data-testid="proposal-reject" onClick={reject}>Reject</button>
          </p>
        </div>
      )}
    </section>
  );
}
