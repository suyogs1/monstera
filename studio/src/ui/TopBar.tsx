import { useRef, useState, useSyncExternalStore } from "react";
import { useDraft, useSession } from "../app/hooks";
import { useProject } from "../project/context";
import { PersistenceIndicator, StorageProtection, downloadText } from "./PersistenceStatus";
import { exportRecoveryFile, type ActionNotice } from "./persistence";
import { replaceWithConfirm } from "./replaceConfirm";

export function TopBar() {
  const session = useSession();
  const { doc, baseline, validation, revision, validatedRevision } = useDraft();
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const project = useProject();
  const migrated = useSyncExternalStore(session.onMigrationNotice, () => session.migrationNotice);
  const onRecovery = () => { const n: ActionNotice = exportRecoveryFile(project, "live", downloadText); setMessage(n.text); };

  const name = doc && typeof doc === "object" && !Array.isArray(doc) ? String((doc["project"] as Record<string, unknown> | undefined)?.["displayName"] ?? "") : "";
  const edited = validation?.canonicalText != null && baseline?.canonicalText != null && validation.canonicalText !== baseline.canonicalText;
  const canExport = validation?.ok === true && validatedRevision === revision && validation.canonicalText !== null;
  const official = session.templates.filter((t) => t.group === "official");
  const samples = session.templates.filter((t) => t.group === "kiro-sample");

  const confirmDiscard = () => !edited || window.confirm("Discard your edits to this draft?");

  const onTemplate = (id: string) => {
    if (!confirmDiscard()) return;
    setMessage(null);
    void replaceWithConfirm((o) => session.loadTemplate(id, o)).then((r) => { if (!r.ok) setMessage(r.message); });
  };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    if (!confirmDiscard()) { if (fileInput.current) fileInput.current.value = ""; return; }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
    } catch {
      setMessage(`Could not import ${file.name}: the file is not valid UTF-8. Your draft was not changed.`);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    const r = await replaceWithConfirm((o) => session.importText(text, file.name, o));
    setMessage(r.ok ? `Imported ${file.name}.` : `Could not import ${file.name}: ${r.message}`);
    if (fileInput.current) fileInput.current.value = "";
  };

  const onExport = () => {
    if (!validation?.canonicalText) return;
    const url = URL.createObjectURL(new Blob([validation.canonicalText], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "monstera.spec.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const pending = !validation || validatedRevision !== revision;
  const verdict = pending ? "checking" : validation.ok ? "valid" : "invalid";
  const hash = !pending && validation.sha256 ? validation.sha256.slice(0, 12) : null;
  const current = baseline?.templateId ?? "";

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand">
          <span className="logo" aria-hidden="true">M</span>
          <div className="brand-titles">
            <strong className="brand-name">MONSTERA</strong>
            <span className="brand-separator" aria-hidden="true">/</span>
            <span className="project-badge" data-testid="project-name">
              {name ? `· ${name}` : ""} {edited ? "· edited" : ""}
            </span>
          </div>
        </div>
      </div>

      <div className="topbar-center">
        <PersistenceIndicator />
        <p className="topbar-state small" data-testid="topbar-state" data-verdict={verdict}>
          <span className={`status-pill ${verdict === "valid" ? "ok" : verdict === "invalid" ? "bad" : "pending"}`}>
            <span className={`dot dot-${verdict === "valid" ? "ok" : verdict === "invalid" ? "bad" : "pending"}`} aria-hidden="true" />
            Spec: {verdict}
          </span>
          <span className="muted topbar-hash-wrapper font-mono">
            SHA-256 <code data-testid="topbar-hash" title="Canonical SHA-256 computed by the engine">{hash ?? "…"}</code>
          </span>
        </p>
      </div>

      <div className="topbar-right">
        <details className="project-actions-dropdown">
          <summary className="btn-secondary-sm actions-dropdown-trigger">
            <span>Project Actions</span>
            <span className="caret-icon" aria-hidden="true">▾</span>
          </summary>
          <div className="actions-popover-menu">
            <div className="popover-group">
              <span className="popover-heading">Specification</span>
              <div className="popover-btn-stack">
                <button
                  type="button"
                  className="btn-menu-action primary"
                  onClick={onExport}
                  disabled={!canExport}
                  title={canExport ? "Download monstera.spec.json" : "Export is available when the draft is valid"}
                  data-testid="export-button"
                >
                  Export specification
                </button>
                <button
                  type="button"
                  className="btn-menu-action"
                  onClick={() => fileInput.current?.click()}
                  title="Import an existing specification JSON file"
                >
                  Import specification…
                </button>
                <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void onImport(e.target.files?.[0])} data-testid="import-input" />
              </div>
            </div>

            <div className="popover-group">
              <span className="popover-heading">Template</span>
              <label className="popover-label-select">
                <span>Start from:</span>
                <select value={current} onChange={(e) => onTemplate(e.target.value)} data-testid="template-select" aria-label="Start from a template" className="menu-select-input">
                  {baseline && !baseline.templateId && <option value="">{baseline.label} (imported)</option>}
                  <optgroup label="Official games">
                    {official.map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
                  </optgroup>
                  <optgroup label="Kiro-authored sample (not an official game)">
                    {samples.map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
                  </optgroup>
                </select>
              </label>
            </div>

            <div className="popover-group">
              <span className="popover-heading">Recovery & Baseline</span>
              <div className="popover-btn-stack">
                <button
                  type="button"
                  className="btn-menu-action"
                  onClick={onRecovery}
                  title="Download in-memory project recovery file"
                  data-testid="recovery-export-button"
                >
                  Export recovery data
                </button>
                <button
                  type="button"
                  className="btn-menu-action danger"
                  onClick={() => { if (confirmDiscard()) void session.reset(); }}
                  disabled={!edited}
                  data-testid="reset-button"
                  title="Discard changes and revert to project baseline"
                >
                  Reset to baseline
                </button>
              </div>
            </div>

            <div className="popover-group">
              <span className="popover-heading">Browser Storage</span>
              <StorageProtection />
            </div>
          </div>
        </details>
      </div>

      {message && <p className="notice topbar-toast" role="status">{message}</p>}
      {migrated && (
        <p className="notice topbar-toast" role="status" data-testid="spec-migration-notice">
          {migrated} Sprite atlases cannot be authored in Studio yet; those fields stay read-only.{" "}
          <button type="button" onClick={() => session.dismissMigrationNotice()} data-testid="spec-migration-dismiss">Dismiss</button>
        </p>
      )}
    </header>
  );
}
