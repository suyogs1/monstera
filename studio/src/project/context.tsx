// React access to the project (persistence status, manifests, undo/redo, storage actions). Plumbing only: no component
// here renders anything. Same pattern as useDraft: a plain external store read through useSyncExternalStore.
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { ProjectManifest } from "./manifests";
import type { ProjectActions, ProjectController, ProjectViewState } from "./controller";

const ProjectContext = createContext<ProjectController | null>(null);

export function ProjectProvider({ controller, children }: { controller: ProjectController; children: ReactNode }) {
  return <ProjectContext.Provider value={controller}>{children}</ProjectContext.Provider>;
}

/** The view state (see ProjectViewState) plus the stable action functions. */
export type ProjectApi = ProjectViewState & ProjectActions;

export function useProject(): ProjectApi {
  const c = useContext(ProjectContext);
  if (!c) throw new Error("ProjectProvider is missing");
  const state = useSyncExternalStore(c.subscribe, c.getState);
  return useMemo(() => ({ ...state, ...c.actions }), [state, c]);
}

/** The project's derivation switches, or null without a provider or an open project. Never throws: Designer controls render in tests without a project. */
export function useDerivation(): ProjectManifest["derivation"] | null {
  const c = useContext(ProjectContext);
  const state = useSyncExternalStore(c ? c.subscribe : noSubscribe, c ? c.getState : noState);
  return (state as ProjectViewState | null)?.manifests?.project.derivation ?? null;
}
const noSubscribe = (): (() => void) => () => undefined;
const noState = (): null => null;
