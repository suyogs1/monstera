import { describe, expect, it } from "vitest";
import { diffLines, hunks } from "./diff";

describe("diffLines", () => {
  it("reports identical texts as unchanged", () => {
    expect(diffLines("a\nb\n", "a\nb\n").every((l) => l.kind === "same")).toBe(true);
  });
  it("finds a changed line with old and new numbers", () => {
    const d = diffLines('{\n  "lives": 5,\n  "x": 1\n}\n', '{\n  "lives": 6,\n  "x": 1\n}\n');
    expect(d.filter((l) => l.kind !== "same")).toEqual([
      { kind: "del", text: '  "lives": 5,', oldNo: 2 },
      { kind: "add", text: '  "lives": 6,', newNo: 2 },
    ]);
  });
  it("handles inserted and removed lines", () => {
    const d = diffLines("a\nb\nc", "a\nx\ny\nb\nc");
    expect(d.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["x", "y"]);
    expect(d.filter((l) => l.kind === "del")).toEqual([]);
  });
  it("collapses unchanged stretches into skip markers", () => {
    const base = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const edited = base.slice(); edited[10] = "changed";
    const h = hunks(diffLines(base.join("\n"), edited.join("\n")), 1);
    expect(h[0]).toEqual({ kind: "skip", count: 9 });
    expect(h.filter((l) => l.kind === "del" || l.kind === "add")).toHaveLength(2);
    expect(h[h.length - 1]).toEqual({ kind: "skip", count: 8 });
  });
});
