import { useState } from "react";
import { useProject } from "../project/context";
import type { IntegrationsManifest } from "../project/manifests";
import { ScaffoldBanner } from "./Banner";
import { BACKEND_INTRO, BACKEND_TITLE, CONFIG_HELP, CONFIG_TITLE, NOT_APPLIED, SCAFFOLD_PREVIEW_HELP, SCAFFOLD_PREVIEW_TITLE, SERVICES_TITLE } from "./labels";
import { setService } from "./ops";
import { emitScaffold, SERVICES, type ScaffoldFile } from "./scaffold";
/** The Firebase scaffold files and the setup note; the AdMob files belong to the Monetization views. */
export function previewFiles(m: IntegrationsManifest, only: (path: string) => boolean): ScaffoldFile[] {
  try { return emitScaffold(m, "studio").filter((f) => only(f.path)); } catch { return []; }
}
const isFirebase = (p: string) => /^scaffold\/(android|ios)\/Firebase/.test(p);
export interface BackendViewProps { integrations: IntegrationsManifest; notice: string | null; onToggle(service: string, on: boolean): void }
/** Pure view. It has no text input at all: services are checkboxes, everything else is read-only. */
export function BackendView({ integrations, notice, onToggle }: BackendViewProps) {
  const files = previewFiles(integrations, isFirebase);
  return (
    <section className="module-body" data-testid="backend-firebase">
      <h2>{BACKEND_TITLE}</h2>
      <ScaffoldBanner kind="backend" />
      <p className="muted">{BACKEND_INTRO}</p>
      {notice !== null && <p className="notice" role="alert" data-testid="integrations-notice">{notice}</p>}
      <fieldset>
        <legend>{SERVICES_TITLE}</legend>
        {SERVICES.map((s) => (
          <label key={s}>
            <input type="checkbox" checked={integrations.backend.services[s] === true} onChange={(e) => onToggle(s, e.target.checked)} /> {s}
          </label>
        ))}
      </fieldset>
      <h3>{CONFIG_TITLE}</h3>
      <p className="muted">{CONFIG_HELP}</p>
      <ul data-testid="config-files">{integrations.backend.configFiles.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
      <h3>{SCAFFOLD_PREVIEW_TITLE}</h3>
      <p className="muted">{SCAFFOLD_PREVIEW_HELP}</p>
      {files.map((f) => (
        <details key={f.path}>
          <summary><code>{f.path}</code></summary>
          <pre className="mono" data-testid="scaffold-preview">{f.text}</pre>
        </details>
      ))}
    </section>
  );
}
export function Backend() {
  const project = useProject();
  const [notice, setNotice] = useState<string | null>(null);
  const integrations = project.manifests?.integrations ?? null;
  if (integrations === null) return <p className="muted">Open a project to edit its backend scaffold.</p>;
  const onToggle = (service: string, on: boolean) => {
    const r = setService(integrations, service, on);
    if (!r.ok) { setNotice(`${NOT_APPLIED}${r.reason}`); return; }
    const out = project.commitManifest("integrations", r.integrations, service);
    setNotice(out.ok ? null : `${NOT_APPLIED}${out.message}`);
  };
  return <BackendView integrations={integrations} notice={notice} onToggle={onToggle} />;
}
