import { matchNativeApps, type Check, type EvidenceFile, type NativeIndex, type PlatformEvidence } from "../../badge/nativeApps";
import raw from "../../generated/native-apps.json";
const INDEX = raw as unknown as NativeIndex;
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : "none");
const url = (f: EvidenceFile) => `${import.meta.env.BASE_URL}${f.url}`;
const WORD: Record<Check["state"], string> = { pass: "Verified", fail: "Failed", missing: "No evidence", stale: "Different specification" };
const ROWS: { key: keyof PlatformEvidence["checks"]; title: string }[] = [
  { key: "compile", title: "Native compilation" },
  { key: "launch", title: "Installation and launch" },
  { key: "specHash", title: "Exact specification hash" },
  { key: "integrity", title: "Bundled specification integrity" },
  { key: "runtime", title: "Fixed-tick runtime observed" },
  { key: "screenshot", title: "Screenshot captured" },
  { key: "logs", title: "Logs captured" },
];
function Links({ p }: { p: PlatformEvidence }) {
  const items: [string, EvidenceFile | null][] = [["report.json", p.files.report], ["results.jsonl", p.files.results], ["logs.txt", p.files.logs], ["screenshot", p.files.screenshot]];
  return (
    <p className="small" data-testid={`native-app-links-${p.platform}`}>
      Supporting evidence:{" "}
      {items.map(([name, f]) => f ? (
        <span key={name}><a href={url(f)} target="_blank" rel="noreferrer" title={`${f.repoPath}, SHA-256 ${f.sha256}`}>{name}</a>{" "}</span>
      ) : <span key={name} className="muted">{name} (missing) </span>)}
    </p>
  );
}
function Platform({ p }: { p: PlatformEvidence }) {
  const shot = p.files.screenshot;
  return (
    <div className="card" data-testid={`native-app-${p.platform}`} data-label={p.label}>
      <header><h4>{p.platform === "android" ? "Android" : "iOS"} ({p.device})</h4></header>
      <p><strong data-testid={`native-app-label-${p.platform}`}>{p.label}</strong>{p.runId && <span className="muted small"> · run <code>{p.runId}</code></span>}</p>
      {p.problem && <p className="notice" data-testid={`native-app-problem-${p.platform}`}>Evidence rejected: {p.problem}.</p>}
      <table className="inv-table">
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.key} data-check={r.key} data-state={p.checks[r.key].state}>
              <th scope="row">{r.title}</th><td>{WORD[p.checks[r.key].state]}</td><td className="muted small">{p.checks[r.key].detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {shot && p.checks.screenshot.state === "pass" && (
        <a href={url(shot)} target="_blank" rel="noreferrer">
          <img src={url(shot)} alt={`${p.device} screenshot after launch`} data-testid={`native-app-shot-${p.platform}`} style={{ maxWidth: "100%", maxHeight: 240 }} />
        </a>
      )}
      <Links p={p} />
    </div>
  );
}
/** Committed Phase 1 evidence for the exact specification of the draft. Read-only: Studio never builds or launches anything. */
export function NativeApps({ sha, projectId }: { sha: string | null; projectId: string | null }) {
  const { exact, otherSpec } = matchNativeApps(INDEX, sha, projectId);
  return (
    <section className="card" aria-labelledby="native-apps-h" data-testid="native-apps" data-matched={exact ? "yes" : "no"} data-label={exact?.label ?? "GENERATED"}>
      <header><h3 id="native-apps-h">Native app build and simulator launch (committed evidence)</h3></header>
      <p className="muted small">
        Separate from simulation conformance above. This is what happened when the generated Android and iOS apps were built and launched on an
        emulator and a simulator, read from <code>{INDEX.evidenceDir}/</code> at build time. Studio cannot build or launch apps. Evidence applies
        only to the exact specification SHA-256 it was recorded for. {INDEX.scope} No physical device was used, and none is claimed.
      </p>
      {exact ? (
        <>
          <p data-testid="native-apps-headline">
            <strong>{exact.label}</strong> for this exact specification ({short(exact.specSha256)}), <code>{exact.specPath}</code>.
            {exact.label !== "SIMULATOR-TESTED" && <> The evidence is incomplete or inconsistent, so the stronger label is not given.</>}
          </p>
          <div>{exact.platforms.map((p) => <Platform key={p.platform} p={p} />)}</div>
        </>
      ) : (
        <p data-testid="native-apps-none">
          <strong>GENERATED</strong>: {sha ? <>no committed native build or launch evidence matches this specification ({short(sha)}).</> : <>waiting for a valid, validated draft.</>}
          {otherSpec && <> Evidence exists for <code>{otherSpec.id}</code>, but it was recorded for specification {short(otherSpec.specSha256)}, an earlier or different one. It does not apply to this draft.</>}
        </p>
      )}
    </section>
  );
}
