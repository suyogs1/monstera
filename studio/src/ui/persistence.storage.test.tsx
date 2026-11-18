// Storage protection (user-initiated persist request) and the site storage estimate: pure wording and formatting helpers,
// and the view they feed. The controller's persist/estimate semantics are tested in project/store tests.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StorageProtectionView } from "./PersistenceStatus";
import { estimateView, formatBytes, PROTECT_EXPLANATION, PROTECT_LABEL, PROTECT_RETRY_LABEL, protectionView } from "./persistence";

describe("formatBytes (decimal units, one decimal below 10, half-up)", () => {
  it.each([
    [0, "0 B"], [1, "1 B"], [999, "999 B"], [999.4, "999 B"],
    [999.6, "1 KB"], [1000, "1 KB"], [1500, "1.5 KB"], [9949, "9.9 KB"], [9950, "10 KB"], [12_345, "12 KB"], [999_499, "999 KB"],
    [999_500, "1 MB"], [18_000_000, "18 MB"], [18_499_999, "18 MB"], [18_500_000, "19 MB"], [1_234_567, "1.2 MB"],
    [500_000_000, "500 MB"], [2_500_000_000, "2.5 GB"], [999_999_999_999, "1 TB"], [7e12, "7 TB"], [2e15, "2000 TB"],
  ])("%s -> %s", (n, s) => expect(formatBytes(n)).toBe(s));
  it("refuses invalid input", () => {
    for (const n of [-1, NaN, Infinity]) expect(formatBytes(n)).toBe("unknown");
  });
});

describe("estimateView", () => {
  it("words a known estimate as site-wide and approximate, never as a project size", () => {
    const e = estimateView({ usage: 18_000_000, quota: 500_000_000 });
    expect(e.kind).toBe("known");
    expect(e.text).toBe("Site storage: about 18 MB of 500 MB (browser estimate for this whole site, not just this project)");
    expect(e.text).not.toMatch(/project (size|uses)/i);
  });
  it("shows a calm message for unknown, incomplete and impossible estimates", () => {
    for (const x of ["unknown", { usage: -1, quota: 5 }, { usage: 1, quota: 0 }, { usage: NaN, quota: 5 }, { usage: 1, quota: Infinity }] as const) {
      expect(estimateView(x as never)).toEqual({ kind: "unknown", text: "Site storage: estimate unavailable" });
    }
  });
  it("says it is checking until the first answer", () => {
    expect(estimateView(null).text).toBe("Site storage: checking…");
  });
});

describe("protectionView", () => {
  it("starts with the plain label and no result", () => {
    expect(protectionView(null)).toEqual({ buttonLabel: "Protect browser storage", result: null });
    expect(PROTECT_LABEL).toBe("Protect browser storage");
  });
  it("has an honest, distinct sentence for every outcome and offers a retry after a non-granted one", () => {
    const outs = (["granted", "not-granted", "unavailable", "rejected"] as const).map((o) => protectionView(o));
    expect(new Set(outs.map((o) => o.result?.text)).size).toBe(4);
    expect(outs.map((o) => o.buttonLabel)).toEqual([PROTECT_LABEL, PROTECT_RETRY_LABEL, PROTECT_RETRY_LABEL, PROTECT_RETRY_LABEL]);
    expect(outs.map((o) => o.result?.ok)).toEqual([true, false, false, false]);
    expect(outs[0]?.result?.text).toContain("can still be cleared");
    expect(outs[1]?.result?.text).toContain("browser decides");
    expect(outs[2]?.result?.text).toContain("does not offer");
    expect(outs[3]?.result?.text).toContain("Nothing changed");
    for (const o of outs) expect(o.result?.text).not.toMatch(/guarantee|cannot be cleared|your project is saved/i);
  });
  it("the explanation says the browser decides, that it is not a guarantee and that it is not saving", () => {
    expect(PROTECT_EXPLANATION).toContain("browser decides");
    expect(PROTECT_EXPLANATION).toContain("does not stop you or your browser settings from clearing site data");
    expect(PROTECT_EXPLANATION).toContain("not the same as the project being saved");
  });
});

describe("StorageProtectionView", () => {
  const props = { busy: false, onRequest: () => undefined, onRefresh: () => undefined };
  it("renders the action, the explanation and the estimate, labelled as storage protection (not saving)", () => {
    const html = renderToStaticMarkup(<StorageProtectionView {...props} last={null} estimate={{ usage: 18e6, quota: 500e6 }} />);
    expect(html).toContain("Protect browser storage");
    expect(html).toContain('aria-label="Browser storage protection"');
    expect(html).toContain("Site storage: about 18 MB of 500 MB");
    expect(html).not.toContain("protect-storage-result");
    expect(html).not.toContain("Project: saved");
  });
  it("shows the outcome as a status and relabels the button after a non-granted result", () => {
    const html = renderToStaticMarkup(<StorageProtectionView {...props} last="not-granted" estimate="unknown" />);
    expect(html).toContain("Request again");
    expect(html).toContain('data-outcome="not-granted"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Site storage: estimate unavailable");
  });
  it("disables both buttons only while a request is in flight", () => {
    expect(renderToStaticMarkup(<StorageProtectionView {...props} busy last={null} estimate={null} />).match(/disabled=""/g)).toHaveLength(2);
    expect(renderToStaticMarkup(<StorageProtectionView {...props} last={null} estimate={null} />)).not.toContain("disabled");
  });
});
