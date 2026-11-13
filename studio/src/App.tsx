import type { ReactElement } from "react";
import { useDraft, useSection } from "./app/hooks";
import { usePrefs } from "./app/prefs";
import { SECTIONS, type SectionId } from "./app/sections";
import { Preview } from "./preview/Preview";
import { Determinism } from "./ui/sections/Determinism";
import { Entities } from "./ui/sections/Entities";
import { Export } from "./ui/sections/Export";
import { Gameplay } from "./ui/sections/Gameplay";
import { Integration } from "./ui/sections/Integration";
import { Overview } from "./ui/sections/Overview";
import { Platforms } from "./ui/sections/Platforms";
import { Presentation } from "./ui/sections/Presentation";
import { Rules } from "./ui/sections/Rules";
import { Spawns } from "./ui/sections/Spawns";
import { SpecView } from "./ui/SpecView";
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

export function App() {
  const [section, setSection] = useSection();
  const { doc } = useDraft();
  const View = VIEWS[section];

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      <TopBar />
      <div className="body">
        <nav className="nav" aria-label="Project Brain sections">
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#/${s.id}`} aria-current={s.id === section ? "page" : undefined} data-testid={`nav-${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ul>
          <NumberModeToggle />
        </nav>
        <main id="main" className="main" tabIndex={-1}>
          {doc === null ? <p>Loading…</p> : View ? <View /> : <p className="muted">This section is not available yet.</p>}
        </main>
        <div className="side">
          {doc !== null && <Preview />}
          <ValidationPanel setSection={setSection} />
        </div>
      </div>
      <footer className="footer">
        Static web app. The MONSTERA engine runs in this page; nothing is sent to a server. Studio and Kiro share only the
        <code> monstera.spec.json </code> file.
      </footer>
    </div>
  );
}
