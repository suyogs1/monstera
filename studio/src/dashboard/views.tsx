// Presentational Dashboard views. Props in, markup out: no hooks, no storage, no engine. Dashboard.tsx owns the state and the
// actions. Keeping these pure lets the component tests render them with renderToStaticMarkup and read every word.
import type { ReactNode } from "react";
import { StatusBadge } from "../ui/ModuleCard";
import { MAX_PROJECT_NAME } from "../project/catalog";
import { IconClock, IconDesigner, IconFolderOpen, IconPlus } from "../ui/icons";
import { MODULE_LABEL, type Line, type ProjectRow } from "./model";

export interface TemplateOption { id: string; label: string; group: string }
export interface Notice { kind: "ok" | "error"; text: string }

const toneClass = (l: Line): string => `status-pill ${l.tone}`;

export function evidenceBadgeLabel(text: string): { label: string; full: string } {
  if (text.startsWith("SIMULATOR-TESTED")) {
    return { label: "SIMULATOR-TESTED", full: text };
  }
  if (text.startsWith("GENERATED")) {
    return { label: "GENERATED", full: text };
  }
  if (text.includes("different specification")) {
    return { label: "Spec Mismatch", full: text };
  }
  if (text.startsWith("None")) {
    return { label: "None", full: text };
  }
  return { label: text.length > 20 ? `${text.slice(0, 18)}…` : text, full: text };
}

export function validationBadgeLabel(text: string): { label: string; full: string } {
  if (text.startsWith("Valid when saved")) {
    return { label: "Valid when saved", full: text };
  }
  if (text.startsWith("Valid.")) {
    return { label: "Valid", full: text };
  }
  return { label: text, full: text };
}

export function Facts({ row }: { row: ProjectRow }) {
  return (
    <details className="project-technical-disclosure" data-testid={`project-facts-${row.projectKey}`}>
      <summary className="technical-summary-toggle">
        Technical Details &amp; Manifest Facts
      </summary>
      <div className="technical-facts-panel">
        <div className="tech-fact-row">
          <span className="tech-fact-label">Project ID:</span>
          <code className="tech-fact-value">{row.projectId ?? "unknown"}</code>
        </div>
        <div className="tech-fact-row">
          <span className="tech-fact-label">Bundle ID:</span>
          <code className="tech-fact-value">{row.projectId ? `app.monstera.${row.projectId}` : "unknown"}</code>
        </div>
        <div className="tech-fact-row">
          <span className="tech-fact-label">Targets:</span>
          <span className="tech-fact-value">{row.targets.length > 0 ? row.targets.join(", ") : "none listed"}</span>
        </div>
        <div className="tech-fact-row">
          <span className="tech-fact-label">Spec SHA-256:</span>
          <code className="tech-fact-value font-mono" title={row.sha256 ?? undefined}>{row.sha256 ?? "none"}</code>
        </div>
        <div className="tech-fact-row">
          <span className="tech-fact-label">Engine Check:</span>
          <span className={`tech-fact-value ${toneClass(row.validation)}`}>{row.validation.text}</span>
        </div>
        <div className="tech-fact-row">
          <span className="tech-fact-label">Native Evidence:</span>
          <span className={`tech-fact-value ${toneClass(row.evidence)}`}>{row.evidence.text}</span>
        </div>
        <div className="tech-fact-row tech-fact-full">
          <span className="tech-fact-label">Studio Data:</span>
          <span className="tech-fact-value" data-testid={`project-populated-${row.projectKey}`}>
            {row.populated.length === 0 ? "Empty: no assets, sprites, levels, gameplay or services yet." : row.populated.map((p) => `${MODULE_LABEL[p.module]} (${p.detail})`).join(", ")}
          </span>
        </div>
      </div>
    </details>
  );
}

export interface ProjectListProps {
  rows: readonly ProjectRow[];
  listError: string | null;
  busyKey: string | null;
  notice: Notice | null;
  onOpen(key: string): void;
  onRename(key: string, name: string): void;
  onDuplicate(key: string): void;
  onDelete(key: string): void;
}

function Row({ row, busy, p }: { row: ProjectRow; busy: boolean; p: ProjectListProps }) {
  const key = row.projectKey;
  const ev = evidenceBadgeLabel(row.evidence.text);
  const val = validationBadgeLabel(row.validation.text);

  return (
    <li
      className={`game-card ${row.isOpen ? "is-active-card" : ""}`}
      data-testid={`project-${key}`}
      data-open={row.isOpen ? "true" : "false"}
      data-unreadable={row.unreadable !== null ? "true" : undefined}
      aria-busy={busy}
    >
      <div className="game-card-media-wrapper">
        {row.previewUrl ? (
          <img
            src={row.previewUrl}
            alt={`${row.name} native preview`}
            className="game-card-screenshot"
            loading="lazy"
          />
        ) : (
          <div className="game-card-fallback-art">
            <span className="game-art-glyph" aria-hidden="true"><IconDesigner size={40} /></span>
          </div>
        )}
        <div className="game-card-media-gradient" />
        <div className="game-card-media-pills">
          {row.isOpen && <span className="open-badge"><StatusBadge status="open" label="open" /></span>}
          {row.targets.map((t) => (
            <span key={t} className="platform-badge">{t}</span>
          ))}
        </div>
      </div>

      <div className="game-card-content">
        <div className="game-card-header-bar">
          <div className="game-card-identity">
            <h3 className="game-card-heading">{row.name}</h3>
            <span className="game-card-modified">
              <IconClock size={13} />
              <span>{row.lastModified ?? "Saved in browser"}</span>
            </span>
          </div>

          <div className="game-card-primary-cta">
            {row.unreadable === null && !row.isOpen && (
              <button
                type="button"
                className="btn-open-workspace"
                data-testid={`project-open-${key}`}
                disabled={busy}
                onClick={() => p.onOpen(key)}
              >
                Open Project
              </button>
            )}
            {row.unreadable === null && row.isOpen && (
              <span className="active-workspace-pill">Active Project</span>
            )}
          </div>
        </div>

        <div className="game-card-metadata-chips">
          <div className="meta-chip" title={val.full}>
            <span className="meta-chip-label">Spec</span>
            <span className={`meta-chip-value ${toneClass(row.validation)}`}>{val.label}</span>
          </div>
          <div className="meta-chip" title={ev.full}>
            <span className="meta-chip-label">Evidence</span>
            <span className={`meta-chip-value ${toneClass(row.evidence)}`}>{ev.label}</span>
          </div>
        </div>

        <div className="game-card-secondary-row">
          <div className="game-card-actions-shelf">
            {row.unreadable === null && (
              <button
                type="button"
                className="btn-card-subtle"
                data-testid={`project-duplicate-${key}`}
                disabled={busy}
                onClick={() => p.onDuplicate(key)}
              >
                Duplicate
              </button>
            )}
            {row.unreadable === null && (
              <details className="card-rename-disclosure">
                <summary className="btn-card-subtle rename-toggle" title="Rename project">Rename…</summary>
                <form
                  className="card-rename-form"
                  data-testid={`project-rename-form-${key}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = new FormData(e.currentTarget).get("name");
                    p.onRename(key, typeof v === "string" ? v : "");
                  }}
                >
                  <label className="rename-label">
                    <span className="sr-only">Project Name</span>
                    <input
                      name="name"
                      defaultValue={row.name}
                      maxLength={MAX_PROJECT_NAME}
                      className="rename-input"
                      data-testid={`project-name-${key}`}
                    />
                  </label>
                  <button type="submit" className="btn-primary-xs" disabled={busy} data-testid={`project-rename-${key}`}>Save</button>
                </form>
              </details>
            )}
            <button
              type="button"
              className="btn-card-danger"
              data-testid={`project-delete-${key}`}
              disabled={busy}
              onClick={() => p.onDelete(key)}
            >
              Delete…
            </button>
          </div>
        </div>

        {row.unreadable !== null ? (
          <p className="notice error-notice" role="note">This project cannot be read: {row.unreadable} It is kept unchanged. You can delete it.</p>
        ) : (
          <Facts row={row} />
        )}
      </div>
    </li>
  );
}

export function ProjectListView(p: ProjectListProps) {
  return (
    <section aria-label="Recent Projects" data-testid="project-list" className="recent-projects-section">
      <div className="recent-projects-header">
        <h2 className="recent-projects-title">Recent Projects</h2>
        <span className="recent-projects-storage-note" data-testid="browser-only">
          Local IndexedDB storage (only in this browser). No cloud upload.
        </span>
      </div>

      {p.listError !== null && <p className="notice error-notice" role="alert" data-testid="project-list-error">{p.listError}</p>}
      {p.notice !== null && <p className={p.notice.kind === "error" ? "notice error-notice" : "status-banner ok"} role={p.notice.kind === "error" ? "alert" : "status"} data-testid="project-notice">{p.notice.text}</p>}
      {p.rows.length === 0 && p.listError === null && <p className="muted empty-state" data-testid="project-empty">No project is stored yet.</p>}

      <ul className="game-cards-grid">
        {p.rows.map((r) => <Row key={r.projectKey} row={r} busy={p.busyKey === r.projectKey} p={p} />)}
      </ul>
    </section>
  );
}

export function CreateView({ templates, busy, onCreate, onImportFile }: {
  templates: readonly TemplateOption[]; busy: boolean; onCreate(templateId: string): void; onImportFile(file: File): void;
}) {
  return (
    <section aria-label="Create or import project" data-testid="project-create" className="dashboard-hero-actions">
      <form className="hero-create-form" onSubmit={(e) => {
        e.preventDefault();
        const id = new FormData(e.currentTarget).get("template");
        if (typeof id === "string" && id !== "") onCreate(id);
      }}>
        <label className="hero-template-select-label">
          <span className="sr-only">Choose Project Template</span>
          <select name="template" className="select-template-hero" data-testid="create-template" defaultValue={templates[0]?.id ?? ""}>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.label}{t.group === "official" ? "" : ` (${t.group})`}</option>)}
          </select>
        </label>
        <button type="submit" className="btn-hero-primary" disabled={busy || templates.length === 0} data-testid="create-from-template">
          <span className="btn-icon" aria-hidden="true"><IconPlus size={16} /></span> New Project
        </button>
      </form>

      <div className="hero-actions-divider" aria-hidden="true" />

      <div className="hero-import-wrap">
        <label className="btn-hero-secondary file-drop-label">
          <span className="btn-icon" aria-hidden="true"><IconFolderOpen size={17} /></span>
          <span>Import Project (<code>monstera.spec.json</code>)</span>
          <input type="file" accept=".json,application/json" disabled={busy} data-testid="create-import-file" className="sr-only" onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) onImportFile(f);
            e.currentTarget.value = "";
          }} />
        </label>
      </div>
    </section>
  );
}

export function BundleView({ busy, canExport, onExport, onImportFile }: {
  busy: boolean; canExport: boolean; onExport(): void; onImportFile(file: File): void;
}) {
  return (
    <details className="technical-details bundle-disclosure" data-testid="project-bundle">
      <summary className="bundle-summary">
        <span className="bundle-summary-title">Project Bundle &amp; Storage Backup</span>
      </summary>
      <div className="bundle-drawer-body">
        <p className="muted small">
          A bundle is one ZIP with the open project&apos;s specification, its Studio data and its asset files. Importing one adds a new
          project; a bundle that fails any check is refused and nothing is changed. Clearing your browser site data deletes local records.
        </p>
        <div className="actions-row">
          <button type="button" className="btn-secondary-sm" disabled={busy || !canExport} data-testid="bundle-export" onClick={onExport}>
            Export bundle
          </button>
          <label className="btn-secondary-sm file-drop-label">
            <span>Import bundle (<code>.zip</code>)</span>
            <input type="file" accept=".zip,application/zip" disabled={busy} data-testid="bundle-import-file" className="sr-only" onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) onImportFile(f);
              e.currentTarget.value = "";
            }} />
          </label>
        </div>
      </div>
    </details>
  );
}

export interface StatusCardsProps {
  name: string; projectKey: string; projectId: string | null; sha256: string | null; storageStatus: string; persistence: string;
  validation: Line; determinism: Line; evidence: Line; populated: ProjectRow["populated"];
  links: { determinism: ReactNode; evidence: ReactNode; validation: ReactNode };
}

export function StatusCards(s: StatusCardsProps) {
  return (
    <section aria-labelledby="status-h" data-testid="status-cards" className="project-status-view">
      <div className="status-hero-card">
        <span className="status-hero-tag">Current Workspace</span>
        <h3 id="status-h" className="status-hero-title">{s.name}</h3>
        <p className="muted small">Every card reads the same state the editors write. Nothing here is cached or typed in.</p>
      </div>

      <div className="pipeline-flow" data-testid="pipeline-flow" aria-label="Specification and Native Evidence Pipeline">
        <div className="pipeline-step">
          <span className="pipeline-step-badge">1. Active Project</span>
          <strong>{s.name}</strong>
          <span className="small muted">In workspace</span>
        </div>
        <div className="pipeline-step">
          <span className="pipeline-step-badge">2. Engine Validation</span>
          <span className={toneClass(s.validation)}>{s.validation.text}</span>
          <span className="small pipeline-link">{s.links.validation}</span>
        </div>
        <div className="pipeline-step">
          <span className="pipeline-step-badge">3. Spec SHA-256</span>
          <code className="font-mono" title={s.sha256 ?? undefined}>{s.sha256 ? `${s.sha256.slice(0, 12)}…` : "Pending"}</code>
          <span className="small muted">Canonical anchor</span>
        </div>
        <div className="pipeline-step">
          <span className="pipeline-step-badge">4. Native Evidence</span>
          <span className={toneClass(s.evidence)}>{s.evidence.text}</span>
          <span className="small pipeline-link">{s.links.evidence}</span>
        </div>
      </div>

      <details className="technical-details">
        <summary>Cryptographic hash binding details</summary>
        <p className="small muted">
          Native evidence is strictly cryptographic: committed simulator reports apply only when the active specification&apos;s canonical SHA-256
          matches the verified test run byte-for-byte. When you modify game settings, a fresh hash is generated and status transitions to &quot;GENERATED&quot;,
          guaranteeing MONSTERA never displays unverified claims for altered drafts.
        </p>
      </details>

      <div className="status-grid">
        <section className="status-card" data-testid="status-validation">
          <header className="status-card-header"><h4>Validation</h4></header>
          <p className={toneClass(s.validation)}>{s.validation.text}</p>
          <p className="small status-card-link">{s.links.validation}</p>
        </section>

        <section className="status-card" data-testid="status-hash">
          <header className="status-card-header"><h4>Specification hash</h4></header>
          <p><code className="font-mono" data-testid="status-hash-value">{s.sha256 ?? "not available while the engine has not accepted the specification"}</code></p>
          <p className="muted small">SHA-256 of the engine&apos;s canonical text. Project id: <code>{s.projectId ?? "unknown"}</code>.</p>
        </section>

        <section className="status-card" data-testid="status-determinism">
          <header className="status-card-header"><h4>Determinism</h4></header>
          <p className={toneClass(s.determinism)}>{s.determinism.text}</p>
          <p className="small status-card-link">{s.links.determinism}</p>
        </section>

        <section className="status-card" data-testid="status-evidence">
          <header className="status-card-header"><h4>Native evidence</h4></header>
          <p className={toneClass(s.evidence)}>{s.evidence.text}</p>
          <p className="muted small">Evidence belongs to one exact specification hash. Studio cannot build or launch apps.</p>
          <p className="small status-card-link">{s.links.evidence}</p>
        </section>

        <section className="status-card" data-testid="status-modules">
          <header className="status-card-header"><h4>Studio data</h4></header>
          {s.populated.length === 0 ? (
            <p className="muted">No module has data yet.</p>
          ) : (
            <ul className="populated-list">
              {s.populated.map((p) => (
                <li key={p.module} data-testid={`status-module-${p.module}`}>{MODULE_LABEL[p.module]}: {p.detail}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="status-card" data-testid="status-storage">
          <header className="status-card-header"><h4>Storage</h4></header>
          <p className="status-storage-val" data-testid="status-storage-text">{s.storageStatus}</p>
          <p className="muted small">{s.persistence}</p>
        </section>
      </div>
    </section>
  );
}
