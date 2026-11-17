// Project persistence UI: the indicator (TopBar) and the banners. They read useProject() only; the wording and the
// choice of buttons live in persistence.ts (pure, tested). "Project: ..." is about storage, "Spec: ..." about validity.
import { useState } from "react";
import { useProject } from "../project/context";
import {
  bannersOf, exportRecoveryFile, indicatorOf, newProjectStep, reloadConfirmed, reloadStep, retryOpenStep, retrySaveStep,
  type ActionNotice, type BannerAction, type Download, type PersistenceView,
} from "./persistence";

export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function PersistenceIndicatorView({ view }: { view: PersistenceView }) {
  const i = indicatorOf(view);
  return (
    <p className="persist-state small" data-testid="persistence-status" data-kind={i.kind} role="status" aria-live="polite">
      <span className={`status ${i.kind === "saved" ? "ok" : i.kind === "saving" || i.kind === "loading" || i.kind === "unsaved" ? "pending" : "bad"}`}>{i.label}</span>
      {i.reason !== null && <span className="muted" data-testid="persistence-reason">{i.reason}</span>}
    </p>
  );
}

export function PersistenceIndicator() {
  return <PersistenceIndicatorView view={useProject()} />;
}

const BUTTON: Record<BannerAction, { label: string; testid: string }> = {
  retrySave: { label: "Retry saving", testid: "persist-retry-save" },
  retryOpen: { label: "Retry opening storage", testid: "persist-retry-open" },
  exportRecovery: { label: "Export recovery data", testid: "persist-export" },
  exportStored: { label: "Export the preserved stored record", testid: "persist-export-stored" },
  exportLegacy: { label: "Export the earlier draft", testid: "persist-export-legacy" },
  reloadFromStorage: { label: "Reload stored version", testid: "persist-reload" },
  startNewProject: { label: "Save as a new project", testid: "persist-new-project" },
};

export interface BannerViewProps {
  view: PersistenceView;
  notice: ActionNotice | null;
  /** The explicit second confirmation of a destructive reload is showing. */
  confirm: string | null;
  busy: boolean;
  onAction: (a: BannerAction) => void;
  onConfirmDiscard: () => void;
  onCancelDiscard: () => void;
}

export function PersistenceBannerView({ view, notice, confirm, busy, onAction, onConfirmDiscard, onCancelDiscard }: BannerViewProps) {
  const banners = bannersOf(view);
  if (banners.length === 0 && notice === null) return null;
  return (
    <section className="persist-banners" aria-label="Storage and recovery" data-testid="persistence-banners">
      {banners.map((b) => (
        <div key={b.id} className={`persist-banner ${b.role === "alert" ? "bad" : "warn"}`} role={b.role} data-testid={`banner-${b.id}`}>
          <strong>{b.title}</strong>
          <p>{b.message}</p>
          {b.notes.map((n) => <p key={n} className="muted small">{n}</p>)}
          {b.actions.length > 0 && (
            <div className="actions">
              {b.actions.map((a) => (
                <button key={a} type="button" disabled={busy} data-testid={BUTTON[a].testid} onClick={() => onAction(a)}>{BUTTON[a].label}</button>
              ))}
            </div>
          )}
        </div>
      ))}
      {confirm !== null && (
        <div className="persist-banner bad" role="alertdialog" aria-label="Confirm discarding in-memory changes" data-testid="banner-confirm-discard">
          <p>{confirm}</p>
          <div className="actions">
            <button type="button" className="danger" disabled={busy} data-testid="persist-discard-confirm" onClick={onConfirmDiscard}>Discard my in-memory changes and reload</button>
            <button type="button" disabled={busy} data-testid="persist-discard-cancel" onClick={onCancelDiscard}>Keep my changes</button>
          </div>
        </div>
      )}
      {notice !== null && <p className={`persist-notice${notice.kind === "error" ? " bad" : ""}`} role="status" data-testid="persistence-notice">{notice.text}</p>}
    </section>
  );
}

export function PersistenceBanner({ download = downloadText }: { download?: Download }) {
  const api = useProject();
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (f: () => Promise<ActionNotice | null>) => {
    setBusy(true);
    try { setNotice(await f()); } finally { setBusy(false); }
  };
  const onAction = (a: BannerAction) => {
    setConfirm(null);
    switch (a) {
      case "retrySave": return void run(() => retrySaveStep(api));
      case "retryOpen": return void run(() => retryOpenStep(api));
      case "exportRecovery": return setNotice(exportRecoveryFile(api, "live", download));
      case "exportStored": return setNotice(exportRecoveryFile(api, "stored", download));
      case "exportLegacy": return setNotice(exportRecoveryFile(api, "legacy", download));
      case "startNewProject": return void run(() => newProjectStep(api));
      case "reloadFromStorage":
        return void run(async () => {
          const s = await reloadStep(api);
          if (s.done) return s.notice;
          setConfirm(s.confirm);
          return null;
        });
    }
  };
  return (
    <PersistenceBannerView
      view={api} notice={notice} confirm={confirm} busy={busy} onAction={onAction}
      onConfirmDiscard={() => void run(async () => { setConfirm(null); return reloadConfirmed(api); })}
      onCancelDiscard={() => setConfirm(null)}
    />
  );
}
