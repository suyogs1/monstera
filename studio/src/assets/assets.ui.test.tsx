// Static-markup checks of the asset library list, its filters and routing. Import, preview and delete flows are tested against the
// real controller in project/assets.controller.test.ts.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isEditable, resolveHash } from "../app/router";
import { xrefManifests } from "../project/xref.testkit";
import { AssetList } from "./AssetList";
import { filterAssets } from "./library";
const noop = () => undefined;
const assets = xrefManifests().assets.assets; // asset-0001 image/sprite, asset-0002 audio/sfx linked to bat and bullet
describe("library filters", () => {
  it("filter by category, kind and linked entity, alone and together", () => {
    expect(filterAssets(assets, {}).map((a) => a.id)).toEqual(["asset-0001", "asset-0002"]);
    expect(filterAssets(assets, { category: "sfx" }).map((a) => a.id)).toEqual(["asset-0002"]);
    expect(filterAssets(assets, { kind: "image" }).map((a) => a.id)).toEqual(["asset-0001"]);
    expect(filterAssets(assets, { kindRef: "bat" }).map((a) => a.id)).toEqual(["asset-0002"]);
    expect(filterAssets(assets, { kindRef: "player" })).toEqual([]);
    expect(filterAssets(assets, { category: "sfx", kind: "image" })).toEqual([]);
    expect(filterAssets(assets, { category: "all", kind: "all", kindRef: "all" })).toHaveLength(2);
  });
});
describe("asset list", () => {
  const render = (over: Partial<Parameters<typeof AssetList>[0]> = {}) =>
    renderToStaticMarkup(<AssetList assets={assets} filter={{}} kindIds={["bat", "bullet"]} previewId={null} preview={null} onFilter={noop} onPreview={noop} onDelete={noop} {...over} />);
  it("shows a row with provenance and preview and delete actions per asset", () => {
    const html = render();
    for (const a of assets) for (const t of ["row", "preview", "delete"]) expect(html).toContain(`data-testid="asset-${t}-${a.id}"`);
    expect(html).toContain("proprietary-owned");
    expect(html).toContain('data-testid="asset-count"');
  });
  it("lists only the matching rows and says when nothing matches", () => {
    const html = render({ filter: { category: "sfx" } });
    expect(html).toContain('data-testid="asset-row-asset-0002"');
    expect(html).not.toContain('data-testid="asset-row-asset-0001"');
    expect(render({ filter: { kindRef: "player" } })).toContain('data-testid="asset-empty"');
    expect(render({ assets: [] })).toContain("No assets yet");
  });
  it("renders the preview only inside the chosen row", () => {
    const html = render({ previewId: "asset-0001", preview: <img alt="p" /> });
    expect(html).toContain('data-testid="asset-preview-pane-asset-0001"');
    expect(html).not.toContain('data-testid="asset-preview-pane-asset-0002"');
    expect(html).toContain("Hide preview");
  });
});
describe("routing", () => {
  it("the assets module is editable and #/assets opens the library", () => {
    expect(isEditable("assets")).toBe(true);
    expect(resolveHash("#/assets").route).toMatchObject({ kind: "section", module: "assets", sectionId: "assets" });
    expect(resolveHash("#/assets").canonical).toBe("#/assets/library");
  });
});
