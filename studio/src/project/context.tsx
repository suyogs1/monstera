// React access to the project (persistence status, manifests, undo/redo, storage actions). Plumbing only: no component
// here renders anything. Same pattern as useDraft: a plain external store read through useSyncExternalStore.
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
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
