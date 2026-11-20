import { useEffect, useMemo, useState } from "react";
import { useDraft, useSession } from "../../app/hooks";
import type { ExportFile, ExportPlan } from "../../engine/protocol";
import { buildZip } from "../../export/zip";
import { blocking, verifyPlan, type CheckItem } from "../../release/completeness";
import driftScript from "../../../../tools/check-drift.sh?raw";
import { releaseExport } from "../../release/exportPack";
import { useCompleteness } from "../../release/useCompleteness";
import { useProject } from "../../project/context";
import { setVerifiedPlan } from "../../release/verified";

type Ready = Extract<ExportPlan, { ok: true }>;
interface Node { name: string; dirs: Map<string, Node>; files: ExportFile[] }

function tree(files: ExportFile[]): Node {
  const root: Node = { name: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let n = root;
    for (const p of parts.slice(0, -1)) {
      if (!n.dirs.has(p)) n.dirs.set(p, { name: p, dirs: new Map(), files: [] });
      n = n.dirs.get(p)!;
    }
    n.files.push(f);
  }
  return root;
}

const size = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);

function Tree({ node, depth }: { node: Node; depth: number }) {
  return (
    <ul className="tree">
      {[...node.dirs.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((d) => (
        <li key={d.name}><details open={depth < 1}><summary><code>{d.name}/</code></summary><Tree node={d} depth={depth + 1} /></details></li>
      ))}
      {[...node.files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => (
        <li key={f.path} data-path-file={f.path}>
          <code>{f.path.split("/").pop()}</code> <span className="muted small">{size(f.size)}{f.mode === 0o755 ? " · executable (755)" : ""}{f.path.endsWith(".jar") ? " · binary" : ""}</span>
        </li>
      ))}
    </ul>
  );
}

function decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The archive: every planned file under one top-level folder named after the project, nothing else. */
export function zipFor(plan: Ready): Uint8Array<ArrayBuffer> {
  return buildZip(plan.files.map((f) => ({ path: `${plan.projectId}/${f.path}`, data: decode(f.data), mode: f.mode })));
}

export function Export() {
  const session = useSession();
  const draft = useDraft();
  const v = draft.validation;
  const pending = draft.validatedRevision !== draft.revision;
  const [plan, setPlan] = useState<(Ready & { originPath: string | null; checks: CheckItem[] }) | null>(null);
  const completeness = useCompleteness();
  const project = useProject();
  const blockedBy = blocking(completeness.items);
  const originPath = draft.baseline?.origin?.path ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A plan is bound to the draft SHA-256 and the origin it was made with (the origin can choose the label).
  const stale = plan !== null && (pending || !v?.ok || v.sha256 !== plan.specSha256 || originPath !== plan.originPath);
  const canRun = !pending && v?.ok === true && v.canonicalText !== null && !busy && blockedBy.length === 0;
  const root = useMemo(() => (plan ? tree(plan.files) : null), [plan]);
  const total = plan ? plan.files.reduce((a, f) => a + f.size, 0) : 0;

  const generate = async () => {
    if (!v?.canonicalText) return;
    setBusy(true); setError(null);
    try {
      const r = await session.engine.exportPlan(v.canonicalText, originPath);
      if (r.ok) setPlan({ ...r, originPath, checks: await verifyPlan(r, v.sha256) }); else { setPlan(null); setError(r.message); }
    } catch (e) { setPlan(null); setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const planErrors = plan ? blocking(plan.checks) : [];
  const verified = plan !== null && !stale && planErrors.length === 0;
  useEffect(() => { setVerifiedPlan(verified && plan ? plan.specSha256 : null); }, [verified, plan]);
  const download = () => {
    if (!plan || stale || planErrors.length > 0) return;
    let zip: Uint8Array<ArrayBuffer>;
    try { zip = zipFor(plan); } catch (e) { setError(`the archive could not be built: ${(e as Error).message}`); return; }
    const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${plan.projectId}-native-source.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const downloadPack = async () => {
    if (!plan || stale || !v?.ok) return;
    setError(null);
    try {
      const assets = new Map<string, Uint8Array>();
      for (const a of project.manifests?.assets.assets ?? []) { const b = await project.assetBytes(a.id); if (b) assets.set(a.id, b); }
      const r = await releaseExport({ items: completeness.items, plan, planChecks: plan.checks, specText: v.canonicalText, manifests: project.manifests, assets, driftScript });
      if (!r.ok) { setError(r.reason === "blocked" ? r.blockers.map((i) => i.message).join(" ") : r.message); return; }
      const url = URL.createObjectURL(new Blob([r.zip], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url; a.download = `${plan.projectId}-pack.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(`the pack could not be built: ${(e as Error).message}`); }
  };
  return (
    <section aria-labelledby="export-h" data-testid="export">
      <header className="section-head">
        <h2 id="export-h">Native source</h2>
        <p>
          The Android (Kotlin, Compose) and iOS (Swift, SwiftUI, SpriteKit) projects for this draft, produced in this page by the
          MONSTERA generator with the same call as <code>monstera generate</code>. Studio does not build them.
        </p>
      </header>
      <p className="notice" data-testid="export-label">
        <strong>GENERATED</strong>: source files only. Studio has not compiled them, run them on a simulator or tested them on a
        device. COMPILED and SIMULATOR-TESTED results exist only as committed evidence for committed specifications; Studio shows none here.
      </p>

      <div className="actions">
        <button type="button" data-testid="export-generate" disabled={!canRun} onClick={() => void generate()}>{busy ? "Generating…" : "Generate source files"}</button>
        <button type="button" data-testid="export-download" disabled={!plan || stale || planErrors.length > 0} onClick={download}>Download ZIP</button>
        <button type="button" data-testid="export-download-pack" disabled={!plan || stale || planErrors.length > 0 || blockedBy.length > 0} onClick={() => void downloadPack()}>Download pack ZIP</button>
        {!canRun && !busy && <span className="muted small" data-testid="export-blocked">{pending ? "Waiting for validation." : !v?.ok ? "Only a valid draft can be exported." : `Export is blocked by ${blockedBy.length} problem${blockedBy.length === 1 ? "" : "s"} in the completeness check.`}</span>}
      </div>
      {blockedBy.length > 0 && v?.ok === true && !pending && (
        <p className="status bad" role="alert" data-testid="export-completeness">
          Export is blocked: {blockedBy.slice(0, 3).map((i) => i.message).join(" ")}{blockedBy.length > 3 ? ` (and ${blockedBy.length - 3} more)` : ""} See the completeness check.
        </p>
      )}
      {planErrors.length > 0 && (
        <p className="status bad" role="alert" data-testid="export-plan-mismatch">The generated files do not equal the engine plan, so the download is blocked: {planErrors.map((i) => i.message).join(" ")}</p>
      )}
      {error && <p className="status bad" role="alert" data-testid="export-error">The export was refused: {error}</p>}
      {stale && <p className="status pending" role="status" data-testid="export-stale">Stale: these files were generated for draft {plan.specSha256.slice(0, 12)}; the draft has changed. Generate again.</p>}

      {plan && (
        <>
          {plan.scenariosOmitted ? (
            <p className="notice why-unexpected" role="alert" data-testid="export-goldens" data-included="0" data-omitted={plan.scenariosOmitted.count}>
              <strong>Recorded goldens omitted.</strong> This draft is not the specification its {plan.scenariosOmitted.count} recorded golden
              scenario{plan.scenariosOmitted.count === 1 ? "" : "s"} were recorded for, so the export embeds none (the generated
              conformance tests have no scenarios). <code>monstera generate</code> refuses this spec until the goldens are re-recorded
              with <code>monstera scenarios record</code>.
            </p>
          ) : (
            <p className="notice" data-testid="export-goldens" data-included={plan.scenariosIncluded} data-omitted="0">
              {plan.scenariosIncluded > 0 ? <>Includes the {plan.scenariosIncluded} recorded golden scenarios of <code>{plan.label}</code> in the native conformance tests.</>
                : <>No golden scenarios are recorded for project <code>{plan.projectId}</code>, so none are embedded.</>}
            </p>
          )}
          <dl className="kv small" data-testid="export-summary">
            <dt>Spec</dt><dd><code>{plan.label}</code> (layout <code>{plan.layout}</code>)</dd>
            <dt>Spec SHA-256</dt><dd><code>{plan.specSha256}</code></dd>
            <dt>Manifest SHA-256</dt><dd><code>{plan.manifestSha256}</code></dd>
            <dt>Files</dt><dd>{plan.files.length} files, {size(total)}, in <code>{plan.projectId}/</code></dd>
            <dt>Where</dt><dd>{plan.layout === "app"
              ? <>The generator owns <code>android/</code>, <code>ios/</code>, <code>.kiro/steering/monstera-generated.md</code> and the manifest; put them in <code>apps/{plan.projectId}/</code> next to the spec.</>
              : <>A fixture tree (<code>generated/{plan.projectId}/</code>); every file is generator-owned.</>}</dd>
          </dl>
          {root && <div data-testid="export-tree" data-sha={plan.specSha256}><Tree node={root} depth={0} /></div>}
        </>
      )}
    </section>
  );
}
