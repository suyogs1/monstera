// React access to the completeness check: gathers the inputs the pure check needs (engine verdict, project validation,
// derivation freshness, stored asset files) and returns its items. Plumbing only; the rules live in completeness.ts.
import { useEffect, useMemo, useState } from "react";
import { useDraft } from "../app/hooks";
import { derivationState } from "../derive/apply";
import { useProject } from "../project/context";
import { checkCompleteness, type CheckItem, type DerivationCheck } from "./completeness";

export interface CompletenessState {
  items: CheckItem[];
  /** False while the async inputs (derivation freshness, stored asset files) have not been read for the current project. */
  settled: boolean;
}

export function useCompleteness(): CompletenessState {
  const draft = useDraft();
  const project = useProject();
  const { manifests, assetBytes, validateProject } = project;
  const pending = draft.validatedRevision !== draft.revision;
  const [derivation, setDerivation] = useState<{ key: unknown; value: DerivationCheck } | null>(null);
  const [blobs, setBlobs] = useState<{ key: unknown; missing: string[] } | null>(null);
  const derivationOn = manifests !== null && (manifests.project.derivation.levels || manifests.project.derivation.gameplay);

  useEffect(() => {
    let live = true;
    if (manifests === null || !derivationOn) return;
    void derivationState(draft.doc, manifests).then((value) => { if (live) setDerivation({ key: manifests, value }); });
    return () => { live = false; };
  }, [draft.doc, manifests, derivationOn]);

  useEffect(() => {
    let live = true;
    if (manifests === null) return;
    const ids = manifests.assets.assets.map((a) => a.id);
    void Promise.all(ids.map(async (id) => ((await assetBytes(id)) === null ? id : null))).then((r) => {
      if (live) setBlobs({ key: manifests, missing: r.filter((x): x is string => x !== null) });
    });
    return () => { live = false; };
  }, [manifests, assetBytes]);

  const aggregate = useMemo(() => (manifests === null ? null : validateProject()), [manifests, validateProject, draft.revision, draft.validatedRevision, draft.validation]);
  return useMemo(() => {
    if (manifests === null || aggregate === null) {
      return { settled: true, items: [{ class: "unverified", severity: "error", message: "No project is open, so nothing can be checked.", module: null, pathText: null }] };
    }
    const d = derivationOn ? (derivation?.key === manifests ? derivation.value : null) : "none";
    const b = blobs?.key === manifests ? blobs.missing : null;
    const items = checkCompleteness({ pending, aggregate, manifests, derivation: d, derivationOn, missingBlobs: b });
    return { items, settled: d !== null && b !== null };
  }, [manifests, aggregate, pending, derivation, blobs, derivationOn]);
}
