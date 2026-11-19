// Increment E: persistence indicator, banners, recovery export, undo/redo shortcuts and the beforeunload decision.
// Pure helpers are tested directly; the views through renderToStaticMarkup with a fake controller view; the flows
// (quota, invalid spec, conflict, quarantine, older write) through the REAL controller with fake-indexeddb.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { drain, FakeEngine, harness, until, type Harness } from "../app/session.testkit";
import type { SessionDeps } from "../app/session";
import type { ProjectViewState } from "../project/controller";
import { STORE_PROJECTS } from "../project/idb";
import { ProjectStore, EVICTION_HINT, type ProjectStoreStatus, type StoreAction, type StoreReason } from "../project/store";
import { baseline, instrumentedOpen, memoryMarker, newFactory, pumpkinText, rawAll, rawPut } from "../project/testkit";
import { PersistenceBannerView, PersistenceIndicatorView } from "./PersistenceStatus";
import {
  bannersOf, exportRecoveryFile, indicatorOf, isEditableTarget, isMacPlatform, newProjectStep, recoveryFileName, reloadConfirmed, reloadStep,
  retryOpenStep, retrySaveStep, runShortcut, shortcutHint, shortcutOf, shouldWarnBeforeUnload, type KeyLike, type PersistenceView,
} from "./persistence";

// ---------------------------------------------------------------- fake views

const STATUSES: ProjectStoreStatus[] = ["loading", "saved", "saving", "unsaved", "failed", "memory-only", "conflict", "read-only", "quarantined", "closed"];
function view(o: Partial<ProjectViewState> & { actions?: StoreAction[]; reason?: StoreReason | null; message?: string } = {}): ProjectViewState {
  const status = o.status ?? "saved";
  return {
    status, storeStatus: o.storeStatus ?? status,
    detail: { message: o.message ?? "msg", error: null, lastSavedAt: null, reason: o.reason ?? null, issues: [], actions: o.actions ?? [], ...o.detail },
    hint: null, migration: null, legacy: null, projectKey: "k1", name: "n", manifests: null,
    canUndo: false, canRedo: false, gate: "idle", dirty: false, gameplayProvisional: false,
    ...(({ actions: _a, reason: _r, message: _m, detail: _d, ...rest }) => rest)(o),
  };
}

// ---------------------------------------------------------------- A. indicator

describe("indicatorOf", () => {
  it("has a distinct label for every status", () => {
    const labels = STATUSES.map((s) => indicatorOf(view({ status: s })).label);
    expect(new Set(labels).size).toBe(STATUSES.length);
    for (const l of labels) expect(l.startsWith("Project:")).toBe(true);
    expect(labels[STATUSES.indexOf("saved")]).toBe("Project: saved");
  });
  it("says Saved only for a committed, clean project the gate is not holding back", () => {
    expect(indicatorOf(view({ status: "saved" })).kind).toBe("saved");
    expect(indicatorOf(view({ status: "saved", dirty: true })).kind).toBe("unsaved");
    for (const gate of ["waiting-for-validation", "waiting-for-valid-spec", "hash-mismatch", "scheduled"] as const) {
      expect(indicatorOf(view({ status: "saved", gate })).kind, gate).toBe("unsaved");
      expect(indicatorOf(view({ status: "unsaved", gate })).kind, gate).toBe("unsaved");
    }
    for (const s of STATUSES.filter((x) => x !== "saved")) expect(indicatorOf(view({ status: s })).kind).not.toBe("saved");
  });
  it("gives the gate reason for unsaved and shows lastSavedAt only for saved", () => {
    expect(indicatorOf(view({ status: "unsaved", gate: "waiting-for-valid-spec" })).reason).toBe("Unsaved: the specification has validation errors");
    expect(indicatorOf(view({ status: "unsaved", gate: "waiting-for-validation" })).reason).toContain("engine");
    expect(indicatorOf(view({ status: "saved", detail: { lastSavedAt: Date.UTC(2026, 0, 2, 3, 4, 5) } as never })).reason).toBe("Last saved 03:04:05 UTC");
    expect(indicatorOf(view({ status: "failed", detail: { lastSavedAt: 1 } as never })).reason).toBeNull();
    expect(indicatorOf(view({ status: "unsaved", detail: { lastSavedAt: 1 } as never })).reason).not.toContain("Last saved");
  });
  it("renders as a polite status region, separate from the spec verdict", () => {
    const html = renderToStaticMarkup(<PersistenceIndicatorView view={view({ status: "unsaved", gate: "waiting-for-valid-spec" })} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Project: unsaved");
    expect(html).not.toContain("Spec:");
    expect(html).not.toContain("Project: saved");
  });
});

// ---------------------------------------------------------------- B. banners

const labelsOf = (v: PersistenceView) => bannersOf(v).flatMap((b) => b.actions);
describe("bannersOf", () => {
  it("quota: alert with exactly the store's actions", () => {
    const [b, ...rest] = bannersOf(view({ status: "failed", reason: "quota", actions: ["retrySave", "exportRecovery"], message: "Browser storage is full. Your work is kept in memory and is NOT saved." }));
    expect(rest).toEqual([]);
    expect(b).toMatchObject({ id: "quota", role: "alert", actions: ["retrySave", "exportRecovery"] });
    expect(b?.message).toContain("NOT saved");
  });
  it("memory-only offers export and nothing that writes", () => {
    const [b] = bannersOf(view({ status: "memory-only", reason: "unavailable", actions: ["exportRecovery"] }));
    expect(b?.id).toBe("memory-only");
    expect(b?.actions).toEqual(["exportRecovery"]);
  });
  it("conflict offers reload (with the discard explanation), retry opening and export", () => {
    const [b] = bannersOf(view({ status: "conflict", reason: "conflict", actions: ["reloadFromStorage", "retryOpen", "exportRecovery"] }));
    expect(b?.actions).toEqual(["retryOpen", "exportRecovery", "reloadFromStorage"]);
    expect(b?.notes.join(" ")).toContain("discards changes that are only in memory");
  });
  it("closed offers retry opening", () => {
    expect(labelsOf(view({ status: "closed", reason: "abnormal-close", actions: ["retryOpen", "exportRecovery"] }))).toEqual(["retryOpen", "exportRecovery"]);
  });
  it("quarantined and format-newer read-only offer exports and a new project, never a save", () => {
    for (const v of [view({ status: "quarantined", reason: "corrupt", actions: ["exportRecovery"] }), view({ status: "read-only", reason: "format-newer", actions: ["exportRecovery"] })]) {
      const a = labelsOf(v);
      expect(a).toEqual(["exportRecovery", "exportStored", "startNewProject"]);
      expect(a).not.toContain("retrySave");
      expect(bannersOf(v)[0]?.notes.join(" ")).toContain("exactly as it is");
    }
  });
  it("a database-newer read-only store allows export only (the store refuses a new project there)", () => {
    expect(labelsOf(view({ status: "read-only", reason: "database-newer", actions: ["exportRecovery"] }))).toEqual(["exportRecovery"]);
  });
  it("migration failure and a refused or unreadable earlier draft", () => {
    const failed = view({ status: "failed", reason: "migration", actions: ["retryOpen", "exportRecovery"], migration: { status: "failed", reason: "storage", message: "storage broke", error: null, legacy: {} as never } });
    expect(bannersOf(failed).map((b) => b.id)).toEqual(["migration"]);
    expect(labelsOf(failed)).toEqual(["retryOpen", "exportRecovery"]);
    const refused = view({ status: "unsaved", migration: { status: "refused", reason: "canonicalization-failed", message: "not valid" } as never, legacy: { status: "refused", message: "not valid" } });
    expect(labelsOf(refused)).toEqual(["exportLegacy"]);
    expect(bannersOf(refused)[0]?.message).toBe("not valid");
    const unreadable = view({ status: "memory-only", actions: ["exportRecovery"], migration: { status: "unreadable", message: "denied" }, legacy: { status: "unreadable", message: "denied" } });
    expect(bannersOf(unreadable).map((b) => b.id)).toEqual(["memory-only", "migration"]);
  });
  it("a healthy project shows no banner", () => {
    expect(bannersOf(view({ status: "saved" }))).toEqual([]);
    expect(bannersOf(view({ status: "unsaved", gate: "waiting-for-valid-spec" }))).toEqual([]);
  });
  it("the eviction hint keeps its honest wording and is a status, not an alert", () => {
    const [b] = bannersOf(view({ status: "unsaved", hint: EVICTION_HINT }));
    expect(b).toMatchObject({ id: "eviction", role: "status", actions: [] });
    expect(b?.message).toContain("may");
    expect(b?.message).toContain("not a reliable check");
    expect(b?.message).not.toMatch(/\b(was|were) (deleted|cleared)\b/);
  });
});

describe("PersistenceBannerView", () => {
  const props = { notice: null, confirm: null, busy: false, onAction: () => undefined, onConfirmDiscard: () => undefined, onCancelDiscard: () => undefined };
  it("renders failures as alerts with only the available buttons", () => {
    const html = renderToStaticMarkup(<PersistenceBannerView {...props} view={view({ status: "failed", reason: "quota", actions: ["retrySave", "exportRecovery"] })} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Retry saving");
    expect(html).toContain("Export recovery data");
    expect(html).not.toContain("Reload stored version");
    expect(html).not.toContain("Retry opening storage");
  });
  it("shows the explicit discard confirmation only when asked, with a way to keep the changes", () => {
    const base = view({ status: "conflict", reason: "conflict", actions: ["reloadFromStorage", "retryOpen", "exportRecovery"] });
    expect(renderToStaticMarkup(<PersistenceBannerView {...props} view={base} />)).not.toContain("persist-discard-confirm");
    const html = renderToStaticMarkup(<PersistenceBannerView {...props} view={base} confirm="Reloading discards them." />);
    expect(html).toContain("persist-discard-confirm");
    expect(html).toContain("Keep my changes");
    expect(html).toContain("Reloading discards them.");
  });
  it("shows the result of an action as a visible message", () => {
    const html = renderToStaticMarkup(<PersistenceBannerView {...props} view={view({ status: "saved" })} notice={{ kind: "error", text: "Unsaved changes cannot be handed to storage yet" }} />);
    expect(html).toContain("Unsaved changes cannot be handed to storage yet");
  });
  it("the eviction hint renders as a status region", () => {
    const html = renderToStaticMarkup(<PersistenceBannerView {...props} view={view({ status: "unsaved", hint: EVICTION_HINT })} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("may have cleared");
  });
});

// ---------------------------------------------------------------- action flows (fake api)

describe("action flows", () => {
  const ok = { ok: true } as const;
  it("reload never discards first; only an unsaved-changes refusal opens the explicit second step", async () => {
    const reload = vi.fn(async (o?: { discardMemory?: boolean }) => (o?.discardMemory ? ok : ({ ok: false, reason: "unsaved-changes", message: "unsaved" } as const)));
    const step = await reloadStep({ reloadFromStorage: reload });
    expect(step.done).toBe(false);
    expect(reload.mock.calls).toEqual([[]]); // no discardMemory yet
    const n = await reloadConfirmed({ reloadFromStorage: reload });
    expect(n.kind).toBe("info");
    expect(reload.mock.calls[1]).toEqual([{ discardMemory: true }]);
  });
  it("a clean reload and other refusals never ask for confirmation", async () => {
    expect(await reloadStep({ reloadFromStorage: async () => ok })).toMatchObject({ done: true, notice: { kind: "info" } });
    expect(await reloadStep({ reloadFromStorage: async () => ({ ok: false, reason: "no-project", message: "Nothing is stored" }) })).toMatchObject({ done: true, notice: { kind: "error", text: "Nothing is stored" } });
  });
  it("retry results are visible messages", async () => {
    expect(await retryOpenStep({ retryOpen: async () => ({ ok: false, reason: "unsaved-invalid-edits", message: "cannot hand over" }) })).toEqual({ kind: "error", text: "cannot hand over" });
    expect(await retrySaveStep({ retrySave: async () => "failed" })).toMatchObject({ kind: "error" });
    expect(await retrySaveStep({ retrySave: async () => "saved" })).toEqual({ kind: "info", text: "Saved." });
    expect(await newProjectStep({ startNewProject: async () => ({ ok: false, reason: "invalid-snapshot", message: "no canonical text" }) })).toEqual({ kind: "error", text: "no canonical text" });
  });
  it("export downloads under a deterministic name and reports when there is nothing to export", () => {
    const downloads: [string, string][] = [];
    const api = { ...view(), exportRecovery: (o?: { stored?: boolean; legacy?: boolean }) => (o?.legacy ? null : "{}") };
    expect(exportRecoveryFile(api, "live", (n, t) => downloads.push([n, t]))).toMatchObject({ kind: "info" });
    expect(downloads).toEqual([["monstera-recovery-k1.json", "{}"]]);
    expect(exportRecoveryFile(api, "legacy", (n, t) => downloads.push([n, t]))).toMatchObject({ kind: "error" });
    expect(downloads).toHaveLength(1);
    expect(recoveryFileName(view(), "legacy")).toBe("monstera-recovery-legacy.json");
    expect(recoveryFileName({ projectKey: "My Proj/1", manifests: null }, "stored")).toBe("monstera-recovery-my-proj-1-stored.json");
  });
});

// ---------------------------------------------------------------- D. undo/redo

const key = (o: Partial<KeyLike>): KeyLike => ({ key: "z", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
describe("undo and redo shortcuts", () => {
  it("Windows and Linux use Ctrl", () => {
    expect(shortcutOf(key({ ctrlKey: true }), false)).toBe("undo");
    expect(shortcutOf(key({ ctrlKey: true, shiftKey: true, key: "Z" }), false)).toBe("redo");
    expect(shortcutOf(key({ ctrlKey: true, key: "y" }), false)).toBe("redo");
    expect(shortcutOf(key({ metaKey: true }), false)).toBeNull();
    expect(shortcutOf(key({ ctrlKey: true, shiftKey: true, key: "y" }), false)).toBeNull();
    expect(shortcutOf(key({ key: "z" }), false)).toBeNull();
  });
  it("macOS uses Cmd and has no Ctrl+Y", () => {
    expect(shortcutOf(key({ metaKey: true }), true)).toBe("undo");
    expect(shortcutOf(key({ metaKey: true, shiftKey: true }), true)).toBe("redo");
    expect(shortcutOf(key({ metaKey: true, key: "y" }), true)).toBeNull();
    expect(shortcutOf(key({ ctrlKey: true }), true)).toBeNull();
  });
  it("is ignored in text fields, selects, contenteditable, while composing and with Alt", () => {
    for (const tagName of ["INPUT", "textarea", "SELECT"]) expect(shortcutOf(key({ ctrlKey: true, target: { tagName } }), false), tagName).toBeNull();
    expect(shortcutOf(key({ ctrlKey: true, target: { tagName: "DIV", isContentEditable: true } }), false)).toBeNull();
    expect(shortcutOf(key({ ctrlKey: true, target: { tagName: "SPAN", closest: () => ({}) } }), false)).toBeNull();
    expect(shortcutOf(key({ ctrlKey: true, isComposing: true }), false)).toBeNull();
    expect(shortcutOf(key({ ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(shortcutOf(key({ ctrlKey: true, target: { tagName: "BUTTON", closest: () => null } }), false)).toBe("undo");
    expect(isEditableTarget(null)).toBe(false);
  });
  it("detects the platform", () => {
    expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
    expect(isMacPlatform({ platform: "Win32", userAgentData: { platform: "macOS" } })).toBe(true);
    expect(isMacPlatform({ platform: "Win32" })).toBe(false);
    expect(isMacPlatform(undefined)).toBe(false);
    expect(shortcutHint("undo", true)).toBe("⌘Z");
    expect(shortcutHint("redo", false)).toBe("Ctrl+Shift+Z");
  });
  it("only handles an available action", () => {
    const a = { undo: vi.fn(() => true), redo: vi.fn(() => true) };
    expect(runShortcut("undo", { canUndo: false, canRedo: true }, a)).toBe(false);
    expect(a.undo).not.toHaveBeenCalled();
    expect(runShortcut("undo", { canUndo: true, canRedo: false }, a)).toBe(true);
    expect(runShortcut("redo", { canUndo: true, canRedo: false }, a)).toBe(false);
    expect(runShortcut(null, { canUndo: true, canRedo: true }, a)).toBe(false);
    expect(a.redo).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- E. beforeunload

describe("shouldWarnBeforeUnload", () => {
  const w = (status: ProjectStoreStatus, o: Partial<ProjectViewState> = {}) => shouldWarnBeforeUnload({ status, gate: "idle", dirty: false, projectKey: "k", ...o });
  it("does not warn for a clean, saved project, nor before a project exists", () => {
    expect(w("saved")).toBe(false);
    expect(w("loading", { projectKey: null })).toBe(false);
  });
  it("warns for every status in which memory may hold work the store lacks", () => {
    for (const s of ["saving", "unsaved", "failed", "memory-only", "conflict", "closed"] as const) expect(w(s), s).toBe(true);
  });
  it("warns for any dirty project and for every gate that holds an edit back", () => {
    for (const s of STATUSES) expect(w(s, { dirty: true }), s).toBe(true);
    for (const gate of ["waiting-for-validation", "waiting-for-valid-spec", "hash-mismatch"] as const) expect(w("saved", { gate }), gate).toBe(true);
  });
  it("read-only and quarantined without edits have nothing to lose", () => {
    expect(w("read-only")).toBe(false);
    expect(w("quarantined")).toBe(false);
    expect(w("quarantined", { dirty: true })).toBe(true);
  });
});

// ---------------------------------------------------------------- flows through the real controller

type Gameish = { game: { runtime: { lives: number } } };
const setLives = (h: Harness, n: number): void => h.session.store.set(["game", "runtime", "lives"], n);
const lives = (h: Harness): number => (h.session.store.getState().doc as unknown as Gameish).game.runtime.lives;
const records = async (f: IDBFactory) => (await rawAll(f, STORE_PROJECTS)) as { specText: string; name: string }[];
const storedLives = (r: { specText: string } | undefined): number => (JSON.parse(r?.specText ?? "{}") as Gameish).game.runtime.lives;
const v = (h: Harness): ProjectViewState => h.session.project.getState();
const api = (h: Harness) => ({ ...v(h), ...h.session.project.actions });
async function boot(deps: Omit<SessionDeps, "engine" | "schedule"> = {}, engine?: FakeEngine): Promise<Harness> {
  const h = harness({ marker: memoryMarker(), ...deps }, engine);
  await h.session.start();
  await drain(h);
  return h;
}

describe("save status through the real controller", () => {
  it("a saved project says Saved with its time; a fresh edit does not, until it is committed", async () => {
    const h = await boot({ factory: newFactory() });
    expect(indicatorOf(v(h)).kind).toBe("saved");
    setLives(h, 7);
    expect(indicatorOf(v(h)).kind).toBe("unsaved");
    await drain(h);
    expect(indicatorOf(v(h))).toMatchObject({ kind: "saved" });
  });

  it("an older write that completes does not mark a newer edit saved", async () => {
    const factory = newFactory();
    let h!: Harness;
    let once = true;
    h = await boot({ factory, projectDeps: { openConnection: instrumentedOpen({
      onCall: (store, method, mode) => { if (once && store === STORE_PROJECTS && method === "put" && mode === "readwrite") { once = false; setLives(h, 8); } },
    }) } });
    once = true; // armed only after boot
    const seen: string[] = [];
    h.session.project.subscribe(() => seen.push(indicatorOf(v(h)).kind));
    setLives(h, 7);
    h.clock.runDue(); // the engine check
    await until(h, () => v(h).gate === "scheduled");
    h.clock.runDue(); // write for lives=7 starts; its put edits lives=8 while it is in flight
    await until(h, () => v(h).storeStatus === "saved" && v(h).dirty);
    expect(v(h).status).toBe("unsaved");
    expect(indicatorOf(v(h)).kind).toBe("unsaved");
    expect(seen).not.toContain("saved");
    await drain(h);
    expect(indicatorOf(v(h)).kind).toBe("saved");
    expect(storedLives((await records(factory))[0])).toBe(8);
  });

  it("an invalid specification is never Saved, and the draft stays recoverable and marked non-canonical", async () => {
    const factory = newFactory();
    const engine = new FakeEngine();
    const h = await boot({ factory }, engine);
    engine.reject = (t) => t.includes('"lives":99');
    setLives(h, 99);
    await drain(h);
    expect(indicatorOf(v(h))).toMatchObject({ kind: "unsaved", reason: "Unsaved: the specification has validation errors" });
    expect(storedLives((await records(factory))[0])).toBe(5);
    const out = JSON.parse(h.session.project.actions.exportRecovery() ?? "null") as {
      format: number; specText: string; specTextCanonical: boolean; manifests: Record<string, string>; baseline: unknown;
      specValidation: { checked: boolean; ok: boolean; parsed: boolean; issueCount: number; issues: { code: string }[] };
    };
    expect(out.format).toBe(3);
    expect(out.specTextCanonical).toBe(false);
    expect(out.specValidation).toMatchObject({ checked: true, ok: false, parsed: false, issueCount: 1 });
    expect(out.specValidation.issues[0]?.code).toBe("json.syntax");
    expect(storedLives(out)).toBe(99); // the invalid text is preserved
    expect(Object.keys(out.manifests)).toHaveLength(7);
    expect(out.baseline).not.toBeNull();
    expect(h.session.project.actions.exportRecovery()).toBe(h.session.project.actions.exportRecovery()); // deterministic
  });

  it("a parseable but invalid spec is exported with the engine's issues and never claimed valid", async () => {
    const engine = new FakeEngine();
    engine.invalid = (t) => { try { return ((JSON.parse(t) as { game: { runtime: { maxEntities: number } } }).game.runtime.maxEntities) > 1024; } catch { return false; } };
    const h = await boot({ factory: newFactory() }, engine);
    h.session.store.set(["game", "runtime", "maxEntities"], 5000);
    await drain(h);
    expect(v(h)).toMatchObject({ status: "unsaved", gate: "waiting-for-valid-spec" });
    const out = JSON.parse(h.session.project.actions.exportRecovery() ?? "null") as { specTextCanonical: boolean; specValidation: { ok: boolean; parsed: boolean } };
    expect(out.specTextCanonical).toBe(false);
    expect(out.specValidation).toMatchObject({ ok: false, parsed: true });
  });

  it("a clean project keeps the store's format-1 recovery without the live-only fields", async () => {
    const h = await boot({ factory: newFactory() });
    const out = JSON.parse(h.session.project.actions.exportRecovery() ?? "null") as Record<string, unknown>;
    expect(out["format"]).toBe(1);
    expect(out).not.toHaveProperty("specTextCanonical");
  });

  it("a valid unsaved edit is exported as canonical text (format 3) before it is stored", async () => {
    const h = await boot({ factory: newFactory() });
    setLives(h, 6);
    h.clock.runDue(); // the engine check
    await until(h, () => v(h).gate === "scheduled");
    const out = JSON.parse(h.session.project.actions.exportRecovery() ?? "null") as { format: number; specText: string; specTextCanonical: boolean; specValidation: { ok: boolean } };
    expect(out).toMatchObject({ format: 3, specTextCanonical: true, specValidation: { ok: true } });
    expect(storedLives(out)).toBe(6);
    expect(out.specText).toBe(h.session.store.getState().validation?.canonicalText);
  });
});

describe("failure and recovery flows", () => {
  it("quota: banner with retry and export, no Saved, retrySave stores the edit once space is back", async () => {
    const factory = newFactory();
    let full = false;
    const h = await boot({ factory, projectDeps: { openConnection: instrumentedOpen({
      onCall: (store, method, mode) => { if (full && store === STORE_PROJECTS && method === "get" && mode === "readwrite") throw new DOMException("full", "QuotaExceededError"); },
    }) } });
    full = true;
    setLives(h, 7);
    await drain(h);
    expect(v(h)).toMatchObject({ status: "failed" });
    expect(v(h).detail.reason).toBe("quota");
    expect(indicatorOf(v(h)).kind).toBe("failed");
    const [b] = bannersOf(v(h));
    expect(b).toMatchObject({ id: "quota", role: "alert", actions: ["retrySave", "exportRecovery"] });
    expect(storedLives((await records(factory))[0])).toBe(5);
    const html = renderToStaticMarkup(<PersistenceBannerView view={v(h)} notice={null} confirm={null} busy={false} onAction={() => undefined} onConfirmDiscard={() => undefined} onCancelDiscard={() => undefined} />);
    expect(html).toContain("Browser storage is full");
    expect(html).not.toContain("Project: saved");
    const files: string[] = [];
    expect(exportRecoveryFile(api(h), "live", (_n, t) => files.push(t)).kind).toBe("info");
    expect(storedLives(JSON.parse(files[0] ?? "{}") as { specText: string })).toBe(7);
    expect(await retrySaveStep(api(h))).toMatchObject({ kind: "error" }); // still full
    full = false;
    expect(await retrySaveStep(api(h))).toEqual({ kind: "info", text: "Saved." });
    expect(indicatorOf(v(h)).kind).toBe("saved");
    expect(storedLives((await records(factory))[0])).toBe(7);
  });

  it("memory-only: banner offers export, nothing is ever saved", async () => {
    const h = await boot({ factory: null });
    expect(v(h).status).toBe("memory-only");
    setLives(h, 7);
    await drain(h);
    expect(indicatorOf(v(h)).kind).toBe("memory-only");
    expect(bannersOf(v(h))[0]).toMatchObject({ id: "memory-only", actions: ["exportRecovery"] });
    const files: string[] = [];
    exportRecoveryFile(api(h), "live", (_n, t) => files.push(t));
    expect(storedLives(JSON.parse(files[0] ?? "{}") as { specText: string })).toBe(7);
  });

  async function conflicted() {
    const factory = newFactory();
    const a = await boot({ factory });
    const other = new ProjectStore({ factory }); // another tab
    await other.open();
    const p = other.getState().project;
    if (!p) throw new Error("no project");
    expect(await other.save({ ...p, name: "other tab" })).toBe("saved");
    setLives(a, 7);
    await drain(a);
    return { factory, a };
  }

  it("conflict: reload asks first, keeps the edit, and discards only after the explicit second step", async () => {
    const { a } = await conflicted();
    expect(indicatorOf(v(a)).kind).toBe("conflict");
    expect(bannersOf(v(a))[0]?.actions).toContain("reloadFromStorage");
    const step = await reloadStep(api(a));
    expect(step).toMatchObject({ done: false });
    expect(lives(a)).toBe(7);
    expect(v(a).status).toBe("conflict");
    const retry = await retryOpenStep(api(a));
    expect(retry.kind).toBe("info");
    expect(lives(a)).toBe(7);
    expect(await reloadConfirmed(api(a))).toMatchObject({ kind: "info" });
    expect(lives(a)).toBe(5);
    expect(v(a)).toMatchObject({ status: "saved", name: "other tab", dirty: false });
  });

  it("closed storage: the edit survives retry opening and is then stored", async () => {
    const factory = newFactory();
    let failing = false;
    const h = await boot({ factory, projectDeps: { openConnection: instrumentedOpen({
      onCall: (store, method, mode) => { if (failing && store === STORE_PROJECTS && method === "get" && mode === "readwrite") throw new Error("disk"); },
    }) } });
    failing = true;
    setLives(h, 7);
    await drain(h);
    expect(indicatorOf(v(h)).kind).toBe("failed");
    failing = false;
    expect(await retryOpenStep(api(h))).toMatchObject({ kind: "info" });
    await drain(h);
    expect(indicatorOf(v(h)).kind).toBe("saved");
    expect(storedLives((await records(factory))[0])).toBe(7);
  });

  it("retry opening is refused with a visible message while the unsaved edit has no canonical text", async () => {
    const engine = new FakeEngine();
    const h = await boot({ factory: newFactory() }, engine);
    engine.reject = (t) => t.includes('"lives":99');
    setLives(h, 99);
    await drain(h);
    expect(await retryOpenStep(api(h))).toMatchObject({ kind: "error", text: expect.stringContaining("Export a recovery file") });
    expect(lives(h)).toBe(99);
  });

  it("quarantined: export and a new project are offered, never a save; the preserved record stays untouched", async () => {
    const factory = newFactory();
    const junk = { projectKey: "junk", format: 1, junk: true };
    await rawPut(factory, STORE_PROJECTS, junk);
    const h = await boot({ factory });
    expect(indicatorOf(v(h)).kind).toBe("quarantined");
    const acts = bannersOf(v(h)).flatMap((b) => b.actions);
    expect(acts).toEqual(["exportRecovery", "exportStored", "startNewProject"]);
    const files: [string, string][] = [];
    expect(exportRecoveryFile(api(h), "stored", (n, t) => files.push([n, t])).kind).toBe("info");
    expect(JSON.parse(files[0]?.[1] ?? "{}")).toMatchObject({ kind: "monstera.studio.recovery" });
    expect(files[0]?.[0]).toMatch(/-stored\.json$/);
    expect(await records(factory)).toEqual([junk]);
    expect(await newProjectStep(api(h))).toMatchObject({ kind: "info" });
    expect((await rawAll(factory, STORE_PROJECTS)).some((r) => JSON.stringify(r) === JSON.stringify(junk))).toBe(true);
  });

  it("read-only (newer record format): export and a new project, nothing written over the newer record", async () => {
    const factory = newFactory();
    const future = { format: 2, projectKey: "q1", specText: "future" };
    await rawPut(factory, STORE_PROJECTS, future);
    const h = await boot({ factory });
    expect(indicatorOf(v(h)).kind).toBe("read-only");
    expect(bannersOf(v(h)).flatMap((b) => b.actions)).toEqual(["exportRecovery", "exportStored", "startNewProject"]);
    setLives(h, 7);
    await drain(h);
    expect(indicatorOf(v(h)).kind).not.toBe("saved");
    expect((await rawAll(factory, STORE_PROJECTS)).find((r) => (r as { projectKey: string }).projectKey === "q1")).toEqual(future);
  });

  it("legacy recovery is offered and exported for a refused earlier draft", async () => {
    const bad = JSON.stringify(JSON.parse(pumpkinText)).replace('"lives":5', '"lives":5,"junk":1');
    const legacyText = JSON.stringify({ version: 1, docText: bad, baseline });
    const engine = new FakeEngine();
    engine.invalid = (t) => t.includes('"junk"');
    const h = harness({ factory: newFactory(), marker: memoryMarker(), legacy: { getItem: () => legacyText } }, engine);
    await h.session.start();
    await drain(h);
    expect(v(h).migration?.status).toBe("refused");
    const legacyBanner = bannersOf(v(h)).find((b) => b.id === "migration");
    expect(legacyBanner?.actions).toContain("exportLegacy");
    const files: [string, string][] = [];
    expect(exportRecoveryFile(api(h), "legacy", (n, t) => files.push([n, t])).kind).toBe("info");
    expect(files[0]?.[0]).toBe("monstera-recovery-legacy.json");
    expect(files[0]?.[1]).toContain("junk");
  });
});

describe("reload from IndexedDB", () => {
  it("a saved project is restored by a new session on the same database; unsaved edits were not stored", async () => {
    const factory = newFactory();
    const a = await boot({ factory });
    setLives(a, 7);
    await drain(a);
    expect(indicatorOf(v(a)).kind).toBe("saved");
    const engine = new FakeEngine();
    engine.reject = (t) => t.includes('"lives":99');
    const b = await boot({ factory }, engine);
    expect(lives(b)).toBe(7);
    expect(indicatorOf(v(b)).kind).toBe("saved");
    setLives(b, 99); // never reaches storage
    await drain(b);
    const c = await boot({ factory });
    expect(lives(c)).toBe(7);
  });
});
