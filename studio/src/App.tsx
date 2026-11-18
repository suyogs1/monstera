import type { ReactElement } from "react";
import { useRef, useState, type KeyboardEvent } from "react";
import { openSection, useDraft, useRoute } from "./app/hooks";
import { isEditable } from "./app/router";
import { navItems } from "./app/shell";
import { usePrefs } from "./app/prefs";
import type { SectionId } from "./app/sections";
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
import { Integration } from "./ui/sections/Integration";
import { Overview } from "./ui/sections/Overview";
import { Platforms } from "./ui/sections/Platforms";
import { Presentation } from "./ui/sections/Presentation";
import { Rules } from "./ui/sections/Rules";
import { Spawns } from "./ui/sections/Spawns";
import { StatusBadge } from "./ui/ModuleCard";
import { ModulePage } from "./ui/ModulePage";
import { SpecView } from "./ui/SpecView";
import { Guards } from "./ui/Guards";
import { PersistenceBanner } from "./ui/PersistenceStatus";
import { TopBar } from "./ui/TopBar";
import { ValidationPanel } from "./ui/ValidationPanel";

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
  levels: () => <LevelStudio />,
  "gameplay-modules": () => <GameplayModules />,
  "gameplay-planned": () => <GameplayPlanned />,
  assets: () => <AssetLibrary />,
  sprites: () => <SpriteStudio />,
  completeness: () => <Completeness />,
  readiness: () => <Readiness />,
};

function NumberModeToggle() {
  const { mode, setMode } = usePrefs();
  return (
    <fieldset className="mode">
      <legend>Quantities</legend>
      <label><input type="radio" name="number-mode" checked={mode === "units"} onChange={() => setMode("units")} /> Game units</label>
      <label><input type="radio" name="number-mode" checked={mode === "raw"} onChange={() => setMode("raw")} /> Raw (Q16.16)</label>
      <small className="muted">Display only. The spec always stores raw integers; 1 unit = 65536.</small>
    </fieldset>
  );
}

const NAV = navItems();

export function App() {
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const { doc } = useDraft();
  const editors = route.kind === "section" && isEditable(route.module);

  const onNavKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape" && menuOpen) { setMenuOpen(false); toggle.current?.focus(); }
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      <Guards />
      <TopBar />
      <PersistenceBanner />
      <div className="body">
        <nav className={`nav${menuOpen ? " open" : ""}`} aria-label="Studio modules" onKeyDown={onNavKey}>
          <button ref={toggle} type="button" className="nav-toggle" aria-expanded={menuOpen} aria-controls="module-list" data-testid="nav-toggle" onClick={() => setMenuOpen(!menuOpen)}>
            Modules
          </button>
          <ul id="module-list" data-testid="module-list">
            {NAV.map((m) => {
              const current = route.module === m.id;
              return (
                <li key={m.id}>
                  <a href={m.href} aria-current={current ? "page" : undefined} data-testid={`module-${m.id}`} data-status={m.status} onClick={() => setMenuOpen(false)}>
                    <span className={`dot dot-${m.status}`} data-testid={`dot-${m.id}`} aria-hidden="true" />
                    <span className="nav-title">{m.title}</span>
                    <StatusBadge status={m.status} />
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
              );
            })}
          </ul>
          <NumberModeToggle />
        </nav>
        <main id="main" className="main" tabIndex={-1}>
          <ModulePage route={route} loading={doc === null} renderSection={(id) => { const View = VIEWS[id]; return View ? <View /> : null; }} />
        </main>
        <div className="side">
          {doc !== null && editors && <Preview />}
          <ValidationPanel setSection={openSection} />
        </div>
      </div>
      <footer className="footer">
        Static web app. The MONSTERA engine runs in this page; nothing is sent to a server. Studio and Kiro share only the
        <code> monstera.spec.json </code> file.
      </footer>
    </div>
  );
}