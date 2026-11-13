import { useMemo, useSyncExternalStore } from "react";
import { useDraft, useSession } from "../../app/hooks";
import { verdict, type Verdict } from "../../badge/badge";
import { summarizeChanges, type ChangeSummary } from "../../badge/classify";
import { nativeEvidence, type ConformanceReport } from "../../badge/native";
import { toIssuePath, type Path } from "../../draft/path";
import raw from "../../generated/conformance.json";
import type { Json } from "../../schema/schema";

const REPORTS = (raw as { reports: ConformanceReport[] }).reports;

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : "none");
/** Checkpoint position: frame-driven scenarios count frames (RUNTIME-CONTRACT section 7), the others ticks. */
const at = (frameDriven: boolean, n: number | null) => (n === null ? "the end" : frameDriven ? `frame ${n}` : `tick ${n}`);
const list = (paths: Path[]) => paths.map((p) => toIssuePath(p)).join(", ");

function headline(v: Verdict): { text: string; tone: "ok" | "bad" | "pending" } {
  switch (v.kind) {
    case "not-run": return { text: "Not run for this draft.", tone: "pending" };
    case "running": return { text: `Running: ${v.done} of ${v.total} recorded goldens checked…`, tone: "pending" };
    case "stale": return { text: `Stale: the last result was for draft ${short(v.run.sha256)}; the draft has changed since. Run the check again.`, tone: "pending" };
    case "no-goldens": return { text: v.run.origin ? `No result: no golden scenario is recorded for ${v.run.origin.path}.` : "No result: this draft has no known originating template, so no recorded goldens apply. Declare one below to compare against its goldens.", tone: "pending" };
    case "invalid": return { text: `No result: the engine refuses this draft (${v.message}). Fix the validation issues first.`, tone: "bad" };
    case "error": return { text: `No result: the engine reported an error (${v.message}).`, tone: "bad" };
    case "match": {
      const cps = v.run.results.reduce((a, r) => a + ("checkpoints" in r ? r.checkpoints : 0), 0);
      return { text: `MATCH: all ${v.run.scenarios.length} recorded goldens reproduce every checkpoint (${cps} checkpoints).`, tone: "ok" };
    }
    case "diverged": {
      return { text: `DIVERGED: ${v.divergedScenarios} of ${v.run.scenarios.length} recorded goldens differ. First: ${v.scenario.name} at ${at(v.scenario.frameDriven, v.first.firstDivergentTick)}.`, tone: "bad" };
    }
  }
}

function explanation(v: Verdict, c: ChangeSummary): { text: string; kind: "expected" | "unexpected" | "note" } | null {
  const behaviour = c.behaviour.length > 0;
  const unread = [...c.display, ...c.other];
  if (v.kind === "diverged") {
    if (behaviour) return { kind: "expected", text: `Expected: the draft changes fields the simulation reads (${list(c.behaviour)}), so the recorded runs are supposed to change.` };
    return { kind: "unexpected", text: `Unexpected: none of the changed fields is read by the simulation${unread.length ? ` (${list(unread)})` : " (the draft is unedited)"}. Display-only edits must never diverge (R5.3, contract section 9). Treat this as an engine fault and report it.` };
  }
  if (v.kind === "match") {
    if (behaviour) return { kind: "note", text: `The draft changes fields the simulation reads (${list(c.behaviour)}), but no recorded scenario runs differently. MATCH means the recorded runs are unchanged, not that the edit has no effect.` };
    if (unread.length) return { kind: "note", text: `Only fields the simulation does not read changed (${list(unread)}); as required, nothing diverged.` };
    return { kind: "note", text: "Unedited starting point: the recorded goldens reproduce in this browser." };
  }
  return null;
}

function NativeEvidence({ sha, projectId }: { sha: string | null; projectId: string | null }) {
  const { exact, otherSpecsOfProject: sameProject } = nativeEvidence(REPORTS, sha, projectId);
  return (
    <section className="card" aria-labelledby="native-h" data-testid="native-conformance" data-matched={exact.length > 0 ? "yes" : "no"}>
      <header><h3 id="native-h">Native conformance (committed evidence)</h3></header>
      <p className="muted small">
        Separate from the badge. Native conformance is measured by <code>monstera conformance</code>, which builds and runs the Kotlin and
        Swift cores with Gradle and Swift. The browser cannot run them, and Studio never infers native results from what runs here.
        A report is shown only when it was recorded for exactly this specification&apos;s SHA-256.
      </p>
      {exact.length > 0 ? exact.map((r) => (
        <p key={r.file}>
          <strong>{r.verdict.toUpperCase()}</strong> for this exact specification: {r.platforms.map((p) => `${p.platform} ${p.status}`).join(", ")};{" "}
          {r.scenarios.length} scenarios. Evidence: <code>{r.file}</code>
        </p>
      )) : (
        <p data-testid="native-none">
          {sha ? <>No committed native conformance report matches this specification ({short(sha)}).</> : <>Waiting for a valid, validated draft.</>}
          {sameProject.length > 0 && <> {sameProject.map((r) => <span key={r.file}><code>{r.file}</code> was recorded for spec {short(r.specSha256)}, a different specification. </span>)}</>}
        </p>
      )}
    </section>
  );
}

/** Which template's recorded goldens apply, and why. Imports get one only when they are exactly a template or the user declares it. */
function OriginLine() {
  const session = useSession();
  const { baseline } = useDraft();
  const origin = baseline?.origin ?? null;
  const isImport = baseline?.group === "import";
  const how = origin?.basis === "template" ? "the draft was started from this template"
    : origin?.basis === "identical" ? "the imported file is exactly this template (same canonical SHA-256)"
    : origin?.basis === "declared" ? "declared by you for this imported file" : "";
  return (
    <div className="origin" data-testid="badge-origin" data-basis={origin?.basis ?? "none"}>
      <p className="small">
        {origin ? <>Goldens of <code>{origin.path}</code>: {how}.</> : <>No originating template is known for this draft.</>}
      </p>
      {isImport && origin?.basis !== "identical" && (
        <label className="small">
          Compare this imported file against the recorded goldens of{" "}
          <select data-testid="origin-select" value={origin?.templateId ?? ""} onChange={(e) => void session.declareOrigin(e.target.value || null)}>
            <option value="">no template (no goldens)</option>
            {session.templates.map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
          </select>
          <span className="muted"> The project id inside the file is not used to choose.</span>
        </label>
      )}
    </div>
  );
}

export function Determinism() {
  const session = useSession();
  const draft = useDraft();
  const run = useSyncExternalStore(session.badge.subscribe, session.badge.getState);
  const v = draft.validation;
  const origin = draft.baseline?.origin ?? null;
  const view = { revision: draft.revision, validatedRevision: draft.validatedRevision, ok: v?.ok === true, sha256: v?.sha256 ?? null, originPath: origin?.path ?? null };
  const result = verdict(run, view);
  const head = headline(result);
  // Changes are explained against the origin template (the spec the goldens were recorded for), not the imported file.
  const baselineDoc = useMemo(() => (origin ? (JSON.parse(origin.canonicalText) as Json) : undefined), [origin]);
  const changes = useMemo(() => summarizeChanges(baselineDoc, draft.doc ?? undefined), [baselineDoc, draft.doc]);
  const why = explanation(result, changes);
  const pending = draft.validatedRevision !== draft.revision;
  const canRun = !pending && v?.ok === true && result.kind !== "running";
  const shown = result.kind === "not-run" || result.kind === "running" ? run : result.run;

  return (
    <section aria-labelledby="det-h" data-testid="determinism">
      <header className="section-head">
        <h2 id="det-h">Determinism: oracle vs recorded goldens</h2>
        <p>
          Runs every recorded golden scenario of the originating template against this draft with the engine&apos;s reference simulation (the
          oracle) in this page, and compares every checkpoint with the committed one. The comparison is the engine&apos;s own equality; the
          result is bound to the draft&apos;s exact SHA-256. Scenarios replay recorded input, so the preview&apos;s touch mapping is not assessed.
        </p>
      </header>

      <OriginLine />

      <div className="actions">
        <button type="button" data-testid="badge-run" disabled={!canRun} onClick={() => void session.badge.start()}>
          {result.kind === "running" ? "Checking…" : "Check this draft against the recorded goldens"}
        </button>
        {!canRun && result.kind !== "running" && <span className="muted small">{pending ? "Waiting for validation." : v?.ok ? "" : "Only a valid draft can be checked."}</span>}
      </div>

      <p className={`status ${head.tone}`} role="status" aria-live="polite" data-testid="badge-verdict" data-verdict={result.kind}>{head.text}</p>
      {result.kind === "running" && <progress max={result.total || 1} value={result.done} aria-label="Scenarios checked" />}
      {shown && <p className="muted small" data-testid="badge-sha">Result for draft SHA-256 <code>{shown.sha256}</code>{shown.phase === "done" ? ` · ${Math.round(shown.ms)} ms` : ""}</p>}
      {why && <p className={`notice why-${why.kind}`} data-testid="badge-explanation" data-explanation={why.kind}>{why.text} <span className="muted small">The classification explains the result; it does not decide it.</span></p>}

      {result.kind === "diverged" && (
        <table className="inv-table badge-table" data-testid="badge-first-divergence">
          <caption>First divergence: {result.scenario.name}, {at(result.scenario.frameDriven, result.first.firstDivergentTick)}{result.scenario.frameDriven ? " (a frame-driven scenario counts frames; the observed tick is the world tick)" : ""}</caption>
          <thead><tr><th scope="col"></th><th scope="col">Recorded</th><th scope="col">This draft</th></tr></thead>
          <tbody>
            <tr><th scope="row">hash</th><td><code>{result.first.expected?.hash ?? "missing"}</code></td><td><code>{result.first.actual?.hash ?? "missing"}</code></td></tr>
            {Object.keys(result.first.expected?.observe ?? result.first.actual?.observe ?? {}).sort().map((k) => (
              <tr key={k}><th scope="row">{k}</th><td>{result.first.expected?.observe[k] ?? "–"}</td><td>{result.first.actual?.observe[k] ?? "–"}</td></tr>
            ))}
          </tbody>
        </table>
      )}

      {shown && shown.scenarios.length > 0 && (
        <table className={`inv-table badge-table${result.kind === "stale" ? " is-stale" : ""}`} data-testid="badge-rows">
          <caption>{result.kind === "stale" ? "Stale result (for an earlier draft): " : ""}Recorded goldens of <code>{shown.origin?.path}</code></caption>
          <thead><tr><th scope="col">Scenario</th><th scope="col">Driven by</th><th scope="col">Ticks</th><th scope="col">Checkpoints</th><th scope="col">Result</th><th scope="col">ms</th></tr></thead>
          <tbody>
            {shown.scenarios.map((s, i) => {
              const r = shown.results[i];
              const cell = !r ? (shown.phase === "running" ? "waiting" : "not run")
                : r.status === "diverged" ? `diverged at ${at(s.frameDriven, r.firstDivergentTick)} (${r.divergentCheckpoints}/${r.checkpoints})`
                : r.status === "match" ? "match" : `${r.status}: ${r.message}`;
              return (
                <tr key={s.file} data-status={r?.status ?? "none"}>
                  <td><code>{s.name}</code></td><td>{s.frameDriven ? "frames" : "ticks"}</td><td>{s.ticks}</td><td>{s.checkpoints}</td>
                  <td>{cell}</td><td>{r && "ms" in r ? Math.round(r.ms) : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <NativeEvidence sha={view.ok && !pending ? view.sha256 : null} projectId={origin?.templateId ?? null} />
    </section>
  );
}
