import { useRef, useState } from "react";
import { useDraft, useSession } from "../app/hooks";

export function TopBar() {
  const session = useSession();
  const { doc, baseline, validation, revision, validatedRevision } = useDraft();
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  const name = doc && typeof doc === "object" && !Array.isArray(doc) ? String((doc["project"] as Record<string, unknown> | undefined)?.["displayName"] ?? "") : "";
  const edited = validation?.canonicalText != null && baseline?.canonicalText != null && validation.canonicalText !== baseline.canonicalText;
  const canExport = validation?.ok === true && validatedRevision === revision && validation.canonicalText !== null;
  const official = session.templates.filter((t) => t.group === "official");
  const samples = session.templates.filter((t) => t.group === "kiro-sample");

  const confirmDiscard = () => !edited || window.confirm("Discard your edits to this draft?");

  const onTemplate = (id: string) => {
    if (!confirmDiscard()) return;
    setMessage(null);
    void session.loadTemplate(id);
  };

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    if (!confirmDiscard()) { if (fileInput.current) fileInput.current.value = ""; return; }
    // Decode like the CLI does: UTF-8 only, and keep a byte order mark so the engine can refuse it (file.text() would strip it).
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
    } catch {
      setMessage(`Could not import ${file.name}: the file is not valid UTF-8. Your draft was not changed.`);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    const r = await session.importText(text, file.name);
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

  const current = baseline?.templateId ?? "";
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden="true">M</span>
        <div>
          <strong>MONSTERA Studio</strong>
          <span className="muted small" data-testid="project-name"> {name ? `· ${name}` : ""} {edited ? "· edited" : ""}</span>
        </div>
      </div>
      <div className="actions">
        <label className="inline">
          <span>Start from</span>
          <select value={current} onChange={(e) => onTemplate(e.target.value)} data-testid="template-select" aria-label="Start from a template">
            {baseline && !baseline.templateId && <option value="">{baseline.label} (imported)</option>}
            <optgroup label="Official games">
              {official.map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
            </optgroup>
            <optgroup label="Kiro-authored sample (not an official game)">
              {samples.map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
            </optgroup>
          </select>
        </label>
        <button type="button" onClick={() => fileInput.current?.click()}>Import spec…</button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void onImport(e.target.files?.[0])} data-testid="import-input" />
        <button type="button" onClick={onExport} disabled={!canExport} title={canExport ? "Download monstera.spec.json" : "Export is available when the draft is valid"} data-testid="export-button">
          Export spec
        </button>
        <button type="button" onClick={() => { if (confirmDiscard()) void session.reset(); }} disabled={!edited} data-testid="reset-button">Reset</button>
      </div>
      {message && <p className="notice" role="status">{message}</p>}
    </header>
  );
}
