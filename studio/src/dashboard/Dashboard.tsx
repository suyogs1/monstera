// The Dashboard module: Projects (list, create, open, rename, duplicate, delete) and Status (cards for the open project).
// State and actions live here; the markup is in views.tsx and the wording in model.ts.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useDraft, useSession } from "../app/hooks";
import { hashForSection } from "../app/router";
import { moduleOf } from "../app/shell";
import { verdict } from "../badge/badge";
import type { NativeIndex } from "../badge/nativeApps";
import raw from "../generated/native-apps.json";
import { useProject } from "../project/context";
import type { ProjectListOutcome } from "../project/controller";
import { populatedModules } from "../project/catalog";
import { indicatorOf } from "../ui/persistence";
import { copyName, deleteWarning, determinismLine, evidenceLine, projectRows, validationLine, type LiveProject } from "./model";
import { replaceWithConfirm } from "../ui/replaceConfirm";
import { IconArrowRight } from "../ui/icons";
import { BundleView, CreateView, ProjectListView, StatusCards, type Notice } from "./views";

const INDEX = raw as unknown as NativeIndex;

/** Strict UTF-8 like the CLI; a byte order mark is kept so the engine can refuse it. */
async function readSpecFile(file: File): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()) };
  } catch {
    return { ok: false, message: `${file.name} is not valid UTF-8.` };
  }
}

function targetsOfDoc(doc: unknown): string[] {
  const t = (doc as { project?: { targets?: unknown } } | null)?.project?.targets;
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
}

/** The open project, from the state every editor reads and writes. */
function useLive(): LiveProject | null {
  const project = useProject();
  const draft = useDraft();
  return useMemo(() => {
    if (project.projectKey === null || project.name === null || draft.doc === null) return null;
    const settled = draft.validation !== null && draft.validatedRevision === draft.revision && draft.validation.ok;
    return {
      projectKey: project.projectKey, name: project.name, projectId: project.manifests?.project.projectId ?? null,
      sha256: settled ? draft.validation?.sha256 ?? null : null, targets: targetsOfDoc(draft.doc), manifests: project.manifests,
      validation: validationLine(draft),
    };
  }, [project.projectKey, project.name, project.manifests, draft]);
}

export function Projects() {
  const session = useSession();
  const project = useProject();
  const live = useLive();
  const [listing, setListing] = useState<ProjectListOutcome | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tick, setTick] = useState(0);
  const { listProjects } = project;
  useEffect(() => {
    let current = true;
    void listProjects().then((r) => { if (current) setListing(r); });
    return () => { current = false; };
  }, [listProjects, project.projectKey, project.storeStatus, project.name, tick]);
  const rows = useMemo(() => projectRows(listing?.ok ? listing.entries : [], live, INDEX, project.detail.lastSavedAt), [listing, live, project.detail.lastSavedAt]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const done = (r: { ok: true } | { ok: false; reason: string }, ok: string): void => {
    setNotice(r.ok ? { kind: "ok", text: ok } : { kind: "error", text: r.reason });
    refresh();
  };
  const templates = session.templates.map((t) => ({ id: t.id, label: t.id, group: t.group }));
  const withBusy = async (key: string | null, work: () => Promise<void>): Promise<void> => {
    setBusyKey(key);
    try { await work(); } finally { setBusyKey(null); }
  };
  return (
    <section aria-label="Projects" className="dashboard-projects-shell">
      <header className="dashboard-header-hero">
        <div className="dashboard-title-row">
          <h1 className="dashboard-main-heading">Projects</h1>
          <span className="projects-count-badge">{rows.length} {rows.length === 1 ? "project" : "projects"}</span>
        </div>
        <nav className="workflow-strip" aria-label="Studio workflow">
          <span className="workflow-label">Workflow</span>
          <span className="workflow-steps">
            <a href={hashForSection("dashboard-projects")} className="workflow-step is-current">Create</a>
            <IconArrowRight size={13} className="workflow-arrow" />
            <a href={hashForSection("overview")} className="workflow-step">Design</a>
            <IconArrowRight size={13} className="workflow-arrow" />
            <a href={hashForSection("assets")} className="workflow-step">Author Assets</a>
            <IconArrowRight size={13} className="workflow-arrow" />
            <a href={hashForSection("determinism")} className="workflow-step">Preview</a>
            <IconArrowRight size={13} className="workflow-arrow" />
            <a href={hashForSection("export")} className="workflow-step">Generate</a>
          </span>
        </nav>
      </header>

      <div className="dashboard-hero-actions-container">
        <CreateView
          templates={templates} busy={creating}
          onCreate={(id) => {
            setCreating(true); setNotice(null);
            void (async () => {
              try {
                const r = await replaceWithConfirm((o) => session.loadTemplate(id, o));
                setNotice(r.ok ? { kind: "ok", text: `Created a new project from ${id}. It is now the open project.` } : { kind: "error", text: r.message });
              } catch (e) {
                setNotice({ kind: "error", text: `The project could not be created: ${e instanceof Error ? e.message : "unknown error"}.` });
              } finally { setCreating(false); refresh(); }
            })();
          }}
          onImportFile={(file) => {
            setCreating(true); setNotice(null);
            void (async () => {
              try {
                const read = await readSpecFile(file);
                if (!read.ok) { setNotice({ kind: "error", text: `Could not import ${file.name}: ${read.message} Nothing was changed.` }); return; }
                const r = await replaceWithConfirm((o) => session.importText(read.text, file.name, o));
                setNotice(r.ok ? { kind: "ok", text: `Imported ${file.name} as a new project. It is now the open project.` } : { kind: "error", text: `Could not import ${file.name}: ${r.message}` });
              } finally { setCreating(false); refresh(); }
            })();
          }}
        />
      </div>

      <ProjectListView
        rows={rows} listError={listing !== null && !listing.ok ? listing.message : null} busyKey={busyKey} notice={notice}
        onOpen={(key) => void withBusy(key, async () => {
          let r = await project.openProject(key);
          if (!r.ok && live !== null && project.dirty && window.confirm(`${r.reason}\n\nOpen the other project and discard the unsaved changes?`)) r = await project.openProject(key, { discardMemory: true });
          done(r, "Opened.");
        })}
        onRename={(key, name) => void withBusy(key, async () => done(await project.renameProject(key, name), "Renamed."))}
        onDuplicate={(key) => void withBusy(key, async () => {
          const source = rows.find((r) => r.projectKey === key);
          const r = await project.duplicateProject(key, copyName(source?.name ?? "project"));
          done(r.ok ? { ok: true } : r, r.ok ? `Created "${r.name}". It keeps the same project id as the original, because the specification is copied unchanged.` : "");
        })}
        onDelete={(key) => {
          const row = rows.find((r) => r.projectKey === key);
          if (!row || !window.confirm(deleteWarning(row))) return;
          void withBusy(key, async () => done(await session.deleteProject(key), `Deleted "${row.name}".`));
        }}
      />

      <div className="dashboard-secondary-shelf">
        <BundleView
          busy={creating} canExport={live !== null}
          onExport={() => {
            setCreating(true); setNotice(null);
            void (async () => {
              try {
                const r = await session.exportBundleBytes();
                if (!r.ok) { setNotice({ kind: "error", text: `The bundle could not be exported: ${r.message}.` }); return; }
                const url = URL.createObjectURL(new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" }));
                const a = document.createElement("a");
                a.href = url; a.download = `${live?.projectId ?? "project"}-bundle.zip`;
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setNotice({ kind: "ok", text: "Exported the project bundle." });
              } finally { setCreating(false); }
            })();
          }}
          onImportFile={(file) => {
            setCreating(true); setNotice(null);
            void (async () => {
              try {
                const data = new Uint8Array(await file.arrayBuffer());
                const r = await replaceWithConfirm((o) => session.importBundleBytes(data, file.name, o));
                setNotice(r.ok ? { kind: "ok", text: `Imported ${file.name} as a new project. It is now the open project.` } : { kind: "error", text: `Could not import ${file.name}: ${r.message}` });
              } finally { setCreating(false); refresh(); }
            })();
          }}
        />
      </div>
    </section>
  );
}

export function Status() {
  const session = useSession();
  const project = useProject();
  const draft = useDraft();
  const live = useLive();
  const run = useSyncExternalStore(session.badge.subscribe, session.badge.getState);
  if (live === null) return <p className="muted">No project is open.</p>;
  const v = draft.validation;
  const view = { revision: draft.revision, validatedRevision: draft.validatedRevision, ok: v?.ok === true, sha256: v?.sha256 ?? null, originPath: draft.baseline?.origin?.path ?? null };
  const indicator = indicatorOf(project);
  return (
    <section aria-labelledby="dashboard-status-h">
      <header className="section-head">
        <h2 id="dashboard-status-h">Status</h2>
        <p>The state of the open project at a glance. Open the module named on a card for the detail.</p>
      </header>
      <StatusCards
        name={live.name} projectKey={live.projectKey} projectId={live.projectId} sha256={live.sha256}
        storageStatus={`${indicator.label}${indicator.reason ? `. ${indicator.reason}` : ""}`}
        persistence="Saved in this browser only."
        validation={live.validation} determinism={determinismLine(verdict(run, view))} evidence={evidenceLine(INDEX, live.sha256, live.projectId)}
        populated={live.manifests ? populatedModules(live.manifests) : []}
        links={{
          validation: <a href={hashForSection("overview")}>{moduleOf("designer").title}</a>,
          determinism: <a href={hashForSection("determinism")}>{moduleOf("preview").title}</a>,
          evidence: <a href={hashForSection("export")}>{moduleOf("release").title}</a>,
        }}
      />
    </section>
  );
}
