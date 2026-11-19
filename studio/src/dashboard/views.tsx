// Presentational Dashboard views. Props in, markup out: no hooks, no storage, no engine. Dashboard.tsx owns the state and the
// actions. Keeping these pure lets the component tests render them with renderToStaticMarkup and read every word.
import type { ReactNode } from "react";
import { StatusBadge } from "../ui/ModuleCard";
import { MAX_PROJECT_NAME } from "../project/catalog";
import { MODULE_LABEL, type Line, type ProjectRow } from "./model";

export interface TemplateOption { id: string; label: string; group: string }
export interface Notice { kind: "ok" | "error"; text: string }

const short = (sha: string | null): string => (sha ? `${sha.slice(0, 12)}…` : "none");
const toneClass = (l: Line): string => `status ${l.tone}`;

export function Facts({ row }: { row: ProjectRow }) {
  return (
    <dl className="facts" data-testid={`project-facts-${row.projectKey}`}>
      <div><dt>Project id</dt><dd><code>{row.projectId ?? "unknown"}</code></dd></div>
      <div><dt>Targets</dt><dd>{row.targets.length > 0 ? row.targets.join(", ") : "none listed"}</dd></div>
      <div><dt>Spec SHA-256</dt><dd><code title={row.sha256 ?? undefined}>{short(row.sha256)}</code></dd></div>
      <div><dt>Engine check</dt><dd className={toneClass(row.validation)}>{row.validation.text}</dd></div>
      <div><dt>Native evidence</dt><dd className={toneClass(row.evidence)}>{row.evidence.text}</dd></div>
      <div>
        <dt>Studio data</dt>
        <dd data-testid={`project-populated-${row.projectKey}`}>
          {row.populated.length === 0 ? "Empty: no assets, sprites, levels, gameplay or services yet." : row.populated.map((p) => `${MODULE_LABEL[p.module]} (${p.detail})`).join(", ")}
        </dd>
      </div>
    </dl>
  );
}

export interface ProjectListProps {
  rows: readonly ProjectRow[];
  /** Why the stored list could not be read, or null. */
  listError: string | null;
  /** Key of the project an action is running on. */
  busyKey: string | null;
  notice: Notice | null;
  onOpen(key: string): void;
  onRename(key: string, name: string): void;
  onDuplicate(key: string): void;
  onDelete(key: string): void;
}

function Row({ row, busy, p }: { row: ProjectRow; busy: boolean; p: ProjectListProps }) {
  const key = row.projectKey;
  return (
    <li className="card" data-testid={`project-${key}`} data-open={row.isOpen ? "true" : "false"} data-unreadable={row.unreadable !== null ? "true" : undefined} aria-busy={busy}>
      <header>
        <h3>{row.name}{row.isOpen && <> <StatusBadge status="open" label="open" /></>}</h3>
      </header>
      {row.unreadable !== null ? (
        <p className="notice" role="note">This project cannot be read: {row.unreadable} It is kept unchanged. You can delete it.</p>
      ) : <Facts row={row} />}
      <div className="actions small">
        {row.unreadable === null && !row.isOpen && <button type="button" data-testid={`project-open-${key}`} disabled={busy} onClick={() => p.onOpen(key)}>Open</button>}
        {row.unreadable === null && <button type="button" data-testid={`project-duplicate-${key}`} disabled={busy} onClick={() => p.onDuplicate(key)}>Duplicate</button>}
        <button type="button" data-testid={`project-delete-${key}`} disabled={busy} onClick={() => p.onDelete(key)}>Delete…</button>
      </div>
      {row.unreadable === null && (
        <form className="actions small" data-testid={`project-rename-form-${key}`} onSubmit={(e) => {
          e.preventDefault();
          const v = new FormData(e.currentTarget).get("name");
          p.onRename(key, typeof v === "string" ? v : "");
        }}>
          <label>Name{" "}
            <input name="name" defaultValue={row.name} maxLength={MAX_PROJECT_NAME} data-testid={`project-name-${key}`} />
          </label>
          <button type="submit" disabled={busy} data-testid={`project-rename-${key}`}>Rename</button>
        </form>
      )}
    </li>
  );
}

export function ProjectListView(p: ProjectListProps) {
  return (
    <section aria-labelledby="projects-h" data-testid="project-list">
      <h3 id="projects-h">Projects in this browser</h3>
      <p className="muted small" data-testid="browser-only">
        These projects exist only in this browser (IndexedDB on this device). Nothing is uploaded, and clearing the site data deletes them.
        Use Export spec in the top bar to keep a copy of the open project&apos;s specification, or export a project bundle below
        (specification, Studio data and assets in one file) to move it to another browser.
      </p>
      {p.listError !== null && <p className="notice" role="alert" data-testid="project-list-error">{p.listError}</p>}
      {p.notice !== null && <p className={p.notice.kind === "error" ? "notice" : "status ok"} role={p.notice.kind === "error" ? "alert" : "status"} data-testid="project-notice">{p.notice.text}</p>}
      {p.rows.length === 0 && p.listError === null && <p className="muted" data-testid="project-empty">No project is stored yet.</p>}
      <ul className="project-list">
        {p.rows.map((r) => <Row key={r.projectKey} row={r} busy={p.busyKey === r.projectKey} p={p} />)}
      </ul>
    </section>
  );
}

export function CreateView({ templates, busy, onCreate, onImportFile }: {
  templates: readonly TemplateOption[]; busy: boolean; onCreate(templateId: string): void; onImportFile(file: File): void;
}) {
  return (
    <section aria-labelledby="create-h" data-testid="project-create">
      <h3 id="create-h">New project</h3>
      <p className="muted small">A new project is added to the list. Your other projects stay as they are.</p>
      <form className="actions" onSubmit={(e) => {
        e.preventDefault();
        const id = new FormData(e.currentTarget).get("template");
        if (typeof id === "string" && id !== "") onCreate(id);
      }}>
        <label>From a template{" "}
          <select name="template" data-testid="create-template" defaultValue={templates[0]?.id ?? ""}>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.label}{t.group === "official" ? "" : ` (${t.group})`}</option>)}
          </select>
        </label>
        <button type="submit" disabled={busy || templates.length === 0} data-testid="create-from-template">Create project</button>
      </form>
      <p className="actions">
        <label>From a specification file (<code>monstera.spec.json</code>){" "}
          <input type="file" accept=".json,application/json" disabled={busy} data-testid="create-import-file" onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) onImportFile(f);
            e.currentTarget.value = "";
          }} />
        </label>
      </p>
    </section>
  );
}

export function BundleView({ busy, canExport, onExport, onImportFile }: {
  busy: boolean; canExport: boolean; onExport(): void; onImportFile(file: File): void;
}) {
  return (
    <section aria-labelledby="bundle-h" data-testid="project-bundle">
      <h3 id="bundle-h">Project bundle</h3>
      <p className="muted small">
        A bundle is one ZIP with the open project&apos;s specification, its Studio data and its asset files. Importing one adds a new
        project; a bundle that fails any check is refused and nothing is changed.
      </p>
      <p className="actions">
        <button type="button" disabled={busy || !canExport} data-testid="bundle-export" onClick={onExport}>Export bundle</button>
        <label>Import bundle (<code>.zip</code>){" "}
          <input type="file" accept=".zip,application/zip" disabled={busy} data-testid="bundle-import-file" onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) onImportFile(f);
            e.currentTarget.value = "";
          }} />
        </label>
      </p>
    </section>
  );
}

export interface StatusCardsProps {
  name: string; projectKey: string; projectId: string | null; sha256: string | null; storageStatus: string; persistence: string;
  validation: Line; determinism: Line; evidence: Line; populated: ProjectRow["populated"];
  /** Links to the module that shows the full detail for a card. */
  links: { determinism: ReactNode; evidence: ReactNode; validation: ReactNode };
}

export function StatusCards(s: StatusCardsProps) {
  return (
    <section aria-labelledby="status-h" data-testid="status-cards">
      <h3 id="status-h">Open project: {s.name}</h3>
      <p className="muted small">Every card reads the same state the editors write. Nothing here is cached or typed in.</p>
      <div className="cards">
        <section className="card" data-testid="status-validation"><header><h4>Validation</h4></header>
          <p className={toneClass(s.validation)}>{s.validation.text}</p><p className="small">{s.links.validation}</p></section>
        <section className="card" data-testid="status-hash"><header><h4>Specification hash</h4></header>
          <p><code data-testid="status-hash-value">{s.sha256 ?? "not available while the engine has not accepted the specification"}</code></p>
          <p className="muted small">SHA-256 of the engine&apos;s canonical text. Project id: <code>{s.projectId ?? "unknown"}</code>.</p></section>
        <section className="card" data-testid="status-determinism"><header><h4>Determinism</h4></header>
          <p className={toneClass(s.determinism)}>{s.determinism.text}</p><p className="small">{s.links.determinism}</p></section>
        <section className="card" data-testid="status-evidence"><header><h4>Native evidence</h4></header>
          <p className={toneClass(s.evidence)}>{s.evidence.text}</p>
          <p className="muted small">Evidence belongs to one exact specification hash. Studio cannot build or launch apps.</p><p className="small">{s.links.evidence}</p></section>
        <section className="card" data-testid="status-modules"><header><h4>Studio data</h4></header>
          {s.populated.length === 0 ? <p className="muted">No module has data yet.</p> : (
            <ul>{s.populated.map((p) => <li key={p.module} data-testid={`status-module-${p.module}`}>{MODULE_LABEL[p.module]}: {p.detail}</li>)}</ul>
          )}</section>
        <section className="card" data-testid="status-storage"><header><h4>Storage</h4></header>
          <p data-testid="status-storage-text">{s.storageStatus}</p><p className="muted small">{s.persistence}</p></section>
      </div>
    </section>
  );
}
