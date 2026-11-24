// The Atlas section of the Sprite editor, rendered against the real Session and ProjectController. The two store hooks are
// replaced by plain reads of the same stores (server rendering has no subscription), everything else is the shipped component.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { drain, harness, type Harness } from "../../app/session.testkit";
import { memoryMarker, newFactory } from "../../project/testkit";
import { xrefManifests } from "../../project/xref.testkit";

let current: Harness;
vi.mock("../../app/hooks", () => ({ useSession: () => current.session, useDraft: () => current.session.store.getState() }));
vi.mock("../../project/context", () => ({ useProject: () => ({ ...current.session.project.getState(), ...current.session.project.actions }) }));
const { AtlasAuthoring } = await import("./AtlasAuthoring");

describe("AtlasAuthoring", () => {
  it("offers the sheets of the project, every kind with frames and timing, and apply and remove", async () => {
    current = harness({ marker: memoryMarker(), factory: newFactory() });
    await current.session.start();
    await drain(current);
    const m = xrefManifests();
    for (const n of ["assets", "animations", "levels", "gameplay"] as const) expect(current.session.project.actions.commitManifest(n, m[n] as never)).toMatchObject({ ok: true });
    await drain(current);
    const html = renderToStaticMarkup(<AtlasAuthoring />);
    expect(html).toContain('data-testid="atlas-authoring"');
    expect(html).toContain("sheet-lantern");
    for (const id of ["player", "bullet", "pumpkin", "bat", "ember", "star"]) {
      expect(html).toContain(`data-testid="atlas-frames-${id}"`);
      expect(html).toContain(`data-testid="atlas-tpf-${id}"`);
    }
    for (const t of ["atlas-build", "atlas-apply", "atlas-remove"]) expect(html).toContain(`data-testid="${t}"`);
    expect(html).toContain("Applied atlas: 8 x 1 frames of 16x16");
    expect(html).toContain('data-testid="sprite-preview-bat"');
  });
});
