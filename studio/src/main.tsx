import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SessionContext } from "./app/hooks";
import { ProjectProvider } from "./project/context";
import { PrefsProvider } from "./app/prefs";
import { Session } from "./app/session";
import { COVERAGE } from "./schema/coverage";
import "./styles.css";

/** localStorage can throw (privacy modes). Studio only READS the legacy draft from it and keeps one hint marker. */
const local = ((): Storage | undefined => { try { return window.localStorage; } catch { return undefined; } })();
const session = new Session({
  legacy: local, marker: local, factory: window.indexedDB ?? null,
  storage: typeof navigator === "undefined" ? null : navigator.storage ?? null,
});
// Best-effort flush of a pending save when the page is hidden or closed. Never reported as saved by itself.
session.project.attachLifecycle(window, document);
// Handles for the acceptance run and for debugging in the console. They expose the page's own objects only.
Object.assign(window, { engine: session.engine, session, coverage: COVERAGE, ready: false });

function Root() {
  const [state, setState] = useState<"starting" | "ready" | { failed: string }>("starting");
  useEffect(() => {
    session.start().then(
      () => { (window as unknown as { ready: boolean }).ready = true; setState("ready"); },
      (e: Error) => setState({ failed: e.message }),
    );
  }, []);
  if (state === "starting") return <p className="boot" role="status">Starting the MONSTERA engine…</p>;
  if (typeof state === "object") return <p className="boot bad" role="alert">The engine could not start: {state.failed}</p>;
  return <SessionContext.Provider value={session}><ProjectProvider controller={session.project}><PrefsProvider><App /></PrefsProvider></ProjectProvider></SessionContext.Provider>;
}

createRoot(document.getElementById("root") as HTMLElement).render(<StrictMode><Root /></StrictMode>);
