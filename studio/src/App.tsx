import type { ReactElement } from "react";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { openSection, useDraft, useRoute } from "./app/hooks";
import { isEditable } from "./app/router";
import { navItems } from "./app/shell";
import { usePrefs } from "./app/prefs";
import type { SectionId } from "./app/sections";
import { useProject } from "./project/context";
import { isMac } from "./ui/Guards";
import { shortcutHint } from "./ui/persistence";
import { Preview } from "./preview/Preview";
import { Determinism } from "./ui/sections/Determinism";
import { Entities } from "./ui/sections/Entities";
import { Export } from "./ui/sections/Export";
import { Gameplay } from "./ui/sections/Gameplay";
import { AssetLibrary } from "./assets/AssetLibrary";
import { SpriteStudio } from "./sprites/SpriteStudio";
import { Completeness, Readiness } from "./release/Release";
import { LevelStudio } from "./levels/LevelStudio";
import { GameplayModules } from "./gameplay/Modules";
import { GameplayPlanned } from "./gameplay/Planned";
import { Backend } from "./integrations/Backend";
import { MockBehaviour, Placements } from "./integrations/Ads";
import { Projects, Status } from "./dashboard/Dashboard";
import { Drift, ProposalInbox } from "./kiro/KiroViews";
import { Integration } from "./ui/sections/Integration";
import { Overview } from "./ui/sections/Overview";
import { Platforms } from "./ui/sections/Platforms";
import { Presentation } from "./ui/sections/Presentation";
import { Rules } from "./ui/sections/Rules";
import { Spawns } from "./ui/sections/Spawns";
import { ModulePage } from "./ui/ModulePage";
import { SpecView } from "./ui/SpecView";
import { Guards } from "./ui/Guards";
import { PersistenceBanner } from "./ui/PersistenceStatus";
import { TopBar } from "./ui/TopBar";
import { ValidationPanel } from "./ui/ValidationPanel";
import {
  IconAssets,
  IconBackend,
  IconDashboard,
  IconDesigner,
  IconGameplay,
  IconKiro,
  IconLevels,
  IconCoins,
  IconPreview,
  IconRelease,
  IconSprites,
} from "./ui/icons";

const VIEWS: Partial<Record<SectionId, () => ReactElement>> = {
  overview: () => <Overview />,
  platforms: () => <Platforms />,
  gameplay: () => <Gameplay />,
  entities: () => <Entities />,
  rules: () => <Rules />,
  spawns: () => <Spawns />,
  presentation: () => <Presentation />,
  spec: () => <SpecView />,
  determinism: () => <Determinism />,
  export: () => <Export />,
  integration: () => <Integration />,
  "kiro-drift": () => <Drift />,
  "kiro-proposals": () => <ProposalInbox />,
  levels: () => <LevelStudio />,
  "gameplay-modules": () => <GameplayModules />,
  "gameplay-planned": () => <GameplayPlanned />,
  assets: () => <AssetLibrary />,
  sprites: () => <SpriteStudio />,
  completeness: () => <Completeness />,
  readiness: () => <Readiness />,
  "backend-firebase": () => <Backend />,
  "monetization-placements": () => <Placements />,
  "monetization-mock": () => <MockBehaviour />,
  "dashboard-projects": () => <Projects />,
  "dashboard-status": () => <Status />,
};

function NumberModeToggle() {
  const { mode, setMode } = usePrefs();
  return (
    <fieldset className="mode">
      <legend>Display Quantities</legend>
      <label><input type="radio" name="number-mode" checked={mode === "units"} onChange={() => setMode("units")} /> Game units</label>
      <label><input type="radio" name="number-mode" checked={mode === "raw"} onChange={() => setMode("raw")} /> Raw (Q16.16)</label>
      <small className="muted">Spec stores raw integers (1 unit = 65,536).</small>
    </fieldset>
  );
}

const NAV = navItems();

const MODULE_ICONS: Record<string, ReactElement> = {
  dashboard: <IconDashboard size={18} />,
  designer: <IconDesigner size={18} />,
  assets: <IconAssets size={18} />,
  sprites: <IconSprites size={18} />,
  levels: <IconLevels size={18} />,
  gameplay: <IconGameplay size={18} />,
  backend: <IconBackend size={18} />,
  monetization: <IconCoins size={18} />,
  kiro: <IconKiro size={18} />,
  preview: <IconPreview size={18} />,
  release: <IconRelease size={18} />,
};

function navGroup(id: string): { title: string; key: string } | null {
  if (id === "dashboard") return { title: "Workspace", key: "workspace" };
  if (id === "designer") return { title: "Create", key: "create" };
  if (id === "preview") return { title: "Test & Build", key: "test" };
  if (id === "backend") return { title: "More Tools", key: "more" };
  return null;
}

export function App() {
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const { doc } = useDraft();
  const project = useProject();
  const mac = isMac();

  const isDashboard = route.module === "dashboard";
  const editors = route.kind === "section" && isEditable(route.module);
  const isPreviewProminent = route.module === "designer" || route.module === "sprites" || route.module === "preview";
  const showPreviewInWorkspace = doc !== null && editors && !isDashboard && isPreviewProminent;

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    const mainEl = document.getElementById("main");
    if (mainEl) mainEl.scrollTop = 0;
  }, [route]);

  const onNavKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape" && menuOpen) { setMenuOpen(false); toggle.current?.focus(); }
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      <Guards />
      <TopBar />
      <PersistenceBanner />
      <div className={`body ${isDashboard ? "dashboard-layout" : showPreviewInWorkspace && !previewCollapsed ? "with-preview" : "without-preview"}`}>
        <nav className={`nav${menuOpen ? " open" : ""}`} aria-label="Studio modules" onKeyDown={onNavKey}>
          <button ref={toggle} type="button" className="nav-toggle" aria-expanded={menuOpen} aria-controls="module-list" data-testid="nav-toggle" onClick={() => setMenuOpen(!menuOpen)}>
            Modules
          </button>
          <ul id="module-list" data-testid="module-list">
            {NAV.map((m) => {
              const current = route.module === m.id;
              const group = navGroup(m.id);
              return (
                <Fragment key={m.id}>
                  {group && (
                    <li className={`nav-group-header nav-group-header-${group.key}`} aria-hidden="true">
                      {group.title}
                    </li>
                  )}
                  <li className={`nav-item nav-item-${m.id}`}>
                    <a
                      href={m.href}
                      aria-current={current ? "page" : undefined}
                      data-testid={`module-${m.id}`}
                      data-status={m.status}
                      title={`${m.title} (${m.status})`}
                      onClick={() => setMenuOpen(false)}
                    >
                      <span className={`dot dot-${m.status}`} data-testid={`dot-${m.id}`} aria-hidden="true" title={`Status: ${m.status}`} />
                      <span className="nav-icon" aria-hidden="true">{MODULE_ICONS[m.id] ?? <IconDashboard size={18} />}</span>
                      <span className="nav-title">{m.title}</span>
                      <span className="sr-only">{m.status}</span>
                    </a>
                    {current && m.sections.length > 0 && (
                      <ul className="subnav" aria-label={`${m.title} sections`}>
                        {m.sections.map((s) => (
                          <li key={s.id}>
                            <a href={s.href} aria-current={route.kind === "section" && route.sectionId === s.id ? "page" : undefined} data-testid={`nav-${s.id}`} onClick={() => setMenuOpen(false)}>{s.title}</a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                </Fragment>
              );
            })}
          </ul>
          <NumberModeToggle />
        </nav>

        <main id="main" className="main" tabIndex={-1}>
          {editors && !isDashboard && (
            <div className="workspace-context-bar">
              <div className="workspace-history-tools">
                <button
                  type="button"
                  className="btn-history-tool"
                  onClick={() => project.undo()}
                  disabled={!project.canUndo}
                  aria-label="Undo"
                  aria-keyshortcuts={mac ? "Meta+Z" : "Control+Z"}
                  title={`Undo (${shortcutHint("undo", mac)})`}
                  data-testid="undo-button"
                >
                  Undo <kbd className="muted small">{shortcutHint("undo", mac)}</kbd>
                </button>
                <button
                  type="button"
                  className="btn-history-tool"
                  onClick={() => project.redo()}
                  disabled={!project.canRedo}
                  aria-label="Redo"
                  aria-keyshortcuts={mac ? "Meta+Shift+Z" : "Control+Shift+Z Control+Y"}
                  title={`Redo (${shortcutHint("redo", mac)})`}
                  data-testid="redo-button"
                >
                  Redo <kbd className="muted small">{shortcutHint("redo", mac)}</kbd>
                </button>
              </div>
            </div>
          )}
          <ModulePage route={route} loading={doc === null} renderSection={(id) => { const View = VIEWS[id]; return View ? <View /> : null; }} />
        </main>

        <div className={`side ${previewCollapsed ? "collapsed" : ""} ${!showPreviewInWorkspace ? "no-preview" : ""} ${isDashboard ? "dashboard-side" : ""}`}>
          {showPreviewInWorkspace && (
            <div className="preview-dock">
              <div className="preview-dock-header">
                <span className="preview-dock-title">Live Preview</span>
                <button
                  type="button"
                  className="preview-dock-toggle"
                  onClick={() => setPreviewCollapsed(!previewCollapsed)}
                  title={previewCollapsed ? "Expand live game preview" : "Collapse live game preview"}
                >
                  {previewCollapsed ? "Show" : "Hide"}
                </button>
              </div>
              {!previewCollapsed && <Preview />}
            </div>
          )}
          <ValidationPanel setSection={openSection} />
        </div>
      </div>

      <footer className="footer">
        <span className="footer-pill">Local Engine</span>
        MONSTERA runs in-browser via WebAssembly. Unmodified specification-driven native foundry.
      </footer>
    </div>
  );
}
