import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SessionContext } from "./app/hooks";
import { PrefsProvider } from "./app/prefs";
import { Session } from "./app/session";
import { COVERAGE } from "./schema/coverage";
import "./styles.css";

const session = new Session(window.localStorage);
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
  return <SessionContext.Provider value={session}><PrefsProvider><App /></PrefsProvider></SessionContext.Provider>;
}

createRoot(document.getElementById("root") as HTMLElement).render(<StrictMode><Root /></StrictMode>);
