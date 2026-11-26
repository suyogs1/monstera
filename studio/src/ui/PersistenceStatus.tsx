// Project persistence UI: the indicator (TopBar) and the banners. They read useProject() only; the wording and the
// choice of buttons live in persistence.ts (pure, tested). "Project: ..." is about storage, "Spec: ..." about validity.
import { useEffect, useRef, useState } from "react";
import { useProject } from "../project/context";
import type { EstimateResult, PersistenceResult } from "../project/store";
import {
  bannersOf, estimateView, exportRecoveryFile, indicatorOf, PROTECT_EXPLANATION, protectionView, newProjectStep, reloadConfirmed, reloadStep, retryOpenStep, retrySaveStep,
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
      <span className={`status-pill ${i.kind === "saved" ? "ok" : i.kind === "saving" || i.kind === "loading" || i.kind === "unsaved" ? "pending" : "bad"}`}>
        <span className={`dot dot-${i.kind === "saved" ? "ok" : i.kind === "saving" || i.kind === "loading" || i.kind === "unsaved" ? "pending" : "bad"}`} aria-hidden="true" />
        {i.label}
      </span>
      {i.reason !== null && <span className="muted persist-reason-hint" data-testid="persistence-reason">{i.reason}</span>}
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
  if (banners.length === 0 && notice === null && confirm === null) return null;
  return (
    <section className="persist-banners-dock" aria-label="Storage and recovery" data-testid="persistence-banners">
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
            <button type="button" className="btn-danger-sm" disabled={busy} data-testid="persist-discard-confirm" onClick={onConfirmDiscard}>Discard my in-memory changes and reload</button>
            <button type="button" className="btn-secondary-sm" disabled={busy} data-testid="persist-discard-cancel" onClick={onCancelDiscard}>Keep my changes</button>
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

// ------------------------------------------------------------------ storage protection and site storage estimate

export interface StorageViewProps {
  last: PersistenceResult | null;
  estimate: EstimateResult | null;
  busy: boolean;
  onRequest: () => void;
  onRefresh: () => void;
}

/** Storage protection is a browser request, not saving; it has its own region so it cannot be mistaken for the save indicator. */
export function StorageProtectionView({ last, estimate, busy, onRequest, onRefresh }: StorageViewProps) {
  const p = protectionView(last);
  const e = estimateView(estimate);
  return (
    <section className="storage-protect-compact" aria-label="Browser storage protection" data-testid="storage-protection">
      <div className="storage-protect-row">
        <button type="button" className="btn-secondary-sm" disabled={busy} onClick={onRequest} title={PROTECT_EXPLANATION} data-testid="protect-storage-button">
          {p.buttonLabel}
        </button>
        <button type="button" className="btn-ghost-sm" disabled={busy} onClick={onRefresh} title="Refresh estimate" data-testid="storage-refresh">
          ↻
        </button>
      </div>
      <div className="storage-estimate-meta muted small" data-testid="storage-estimate" data-kind={e.kind}>
        {e.text}
      </div>
      <p className="sr-only" data-testid="protect-storage-help">{PROTECT_EXPLANATION}</p>
      {p.result !== null && (
        <p className={`storage-result-msg small ${p.result.ok ? "ok" : "bad"}`} role="status" data-testid="protect-storage-result" data-outcome={p.result.outcome}>
          {p.result.text}
        </p>
      )}
    </section>
  );
}

/** Reads the controller only. The browser is asked to persist only when the user presses the button; the estimate is read
 *  once when the project is ready, after each committed save and after a request, never on a timer. */
export function StorageProtection() {
  const api = useProject();
  const [last, setLast] = useState<PersistenceResult | null>(null);
  const [estimate, setEstimate] = useState<EstimateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const booted = useRef(false);
  const { estimate: read, requestPersistence } = api;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = async () => {
    const e = await read();
    if (alive.current) setEstimate(e);
  };
  const onRequest = async () => {
    setBusy(true);
    try {
      const r = await requestPersistence();
      if (alive.current) setLast(r);
      await refresh();
    } finally { if (alive.current) setBusy(false); }
  };

  const key = api.status === "loading" ? null : api.status === "saved" ? `saved:${api.detail.lastSavedAt ?? 0}` : "other";
  useEffect(() => {
    if (key === null || (key === "other" && booted.current)) return;
    booted.current = true;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return <StorageProtectionView last={last} estimate={estimate} busy={busy} onRequest={() => void onRequest()} onRefresh={() => void refresh()} />;
}
