import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Json } from "../schema/schema";
import { setAt } from "../draft/path";
import type { ManifestMap } from "./manifests";
import { COALESCE_WINDOW_MS, HISTORY_LIMIT, History } from "./history";

const repo = join(__dirname, "..", "..", "..");
const pumpkin = JSON.parse(readFileSync(join(repo, "apps/pumpkin-blaster/monstera.spec.json"), "utf8")) as Json;

/** Fake clock: tests move time explicitly. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, set: (v: number) => { t = v; }, advance: (d: number) => { t += d; } };
}
const make = () => { const c = clock(); return { c, h: new History<number>(c.now) }; };

describe("History order", () => {
  it("undoes and redoes in LIFO order", () => {
    const { h } = make();
    // states 1 -> 2 -> 3 -> 4; each push records the state before the change
    h.push(1); h.push(2); h.push(3);
    expect(h.undo(4)).toBe(3);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(true);
    expect(h.redo(1)).toBe(2);
    expect(h.redo(2)).toBe(3);
    expect(h.redo(3)).toBe(4);
    expect(h.canRedo).toBe(false);
    expect(h.canUndo).toBe(true);
  });

  it("clears redo on a new push after undo", () => {
    const { h } = make();
    h.push(1); h.push(2);
    expect(h.undo(3)).toBe(2);
    expect(h.canRedo).toBe(true);
    h.push(2);
    expect(h.canRedo).toBe(false);
    expect(h.redo(9)).toBeUndefined();
  });

  it("does nothing on an empty stack", () => {
    const { h } = make();
    expect(h.undo(1)).toBeUndefined();
    expect(h.redo(1)).toBeUndefined();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });

  it("undefined results leave the other stack untouched", () => {
    const { h } = make();
    h.push(1);
    expect(h.redo(5)).toBeUndefined();
    expect(h.canUndo).toBe(true);
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBeUndefined();
    expect(h.canRedo).toBe(true);
  });
});

describe("History cap", () => {
  it("keeps 100 entries and drops the oldest", () => {
    expect(HISTORY_LIMIT).toBe(100);
    const { h } = make();
    for (let i = 0; i < 105; i++) h.push(i); // entries 0..104; 0..4 dropped
    const seen: number[] = [];
    let cur = 105;
    for (let p = h.undo(cur); p !== undefined; p = h.undo(cur)) { seen.push(p); cur = p; }
    expect(seen.length).toBe(100);
    expect(seen[0]).toBe(104);
    expect(seen[99]).toBe(5);
  });

  it("caps the undo stack when redo refills it", () => {
    const { h } = make();
    for (let i = 0; i < 100; i++) h.push(i);
    expect(h.undo(100)).toBe(99);
    h.push(99); // back to 100 entries
    expect(h.undo(100)).toBe(99);
    expect(h.redo(99)).toBe(100);
    let n = 0;
    for (let cur = 100, p = h.undo(cur); p !== undefined; p = h.undo(cur)) { n++; cur = p; }
    expect(n).toBe(100);
  });
});

describe("History coalescing", () => {
  it("collapses same-key pushes inside the window into one entry keeping the first snapshot", () => {
    const { c, h } = make();
    h.push(10, "a.b"); c.advance(300);
    h.push(11, "a.b"); c.advance(300);
    h.push(12, "a.b");
    expect(h.undo(13)).toBe(10);
    expect(h.canUndo).toBe(false);
  });

  it("measures the window from the last push of the burst", () => {
    const { c, h } = make();
    h.push(1, "k"); c.advance(800); // t=800
    h.push(2, "k"); c.advance(800); // t=1600: 1600 from first, 800 from last -> still joins
    h.push(3, "k");
    expect(h.undo(4)).toBe(1);
    expect(h.canUndo).toBe(false);
  });

  it("includes exactly the window length and excludes one more millisecond", () => {
    const a = make();
    a.h.push(1, "k"); a.c.advance(COALESCE_WINDOW_MS); a.h.push(2, "k");
    expect(a.h.undo(3)).toBe(1);
    expect(a.h.canUndo).toBe(false);
    const b = make();
    b.h.push(1, "k"); b.c.advance(COALESCE_WINDOW_MS + 1); b.h.push(2, "k");
    expect(b.h.undo(3)).toBe(2);
    expect(b.h.undo(2)).toBe(1);
  });

  it("does not coalesce across different keys", () => {
    const { h } = make();
    h.push(1, "a"); h.push(2, "b");
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
  });

  it("does not coalesce when the key is absent", () => {
    const { h } = make();
    h.push(1); h.push(2);
    h.push(3, "a"); h.push(4);
    expect(h.undo(5)).toBe(4);
    expect(h.undo(4)).toBe(3);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
  });

  it("breaks the burst after undo", () => {
    const { h } = make();
    h.push(1, "k"); h.push(2, "k"); // one entry: 1
    expect(h.undo(3)).toBe(1);
    h.push(1, "k"); // new entry, not joined to the undone one
    h.push(5, "k"); // joins the entry just made
    expect(h.undo(6)).toBe(1);
    expect(h.canUndo).toBe(false);
  });

  it("breaks the burst after redo", () => {
    const { h } = make();
    h.push(1, "k"); h.push(2, "x");
    expect(h.undo(3)).toBe(2);
    expect(h.redo(2)).toBe(3); // entries: [1, 2]
    h.push(3, "x"); // lastKey was reset by redo, so this is a new entry
    expect(h.undo(4)).toBe(3);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
  });

  it("breaks the burst after clear", () => {
    const { h } = make();
    h.push(1, "k");
    h.clear();
    h.push(2, "k");
    expect(h.undo(3)).toBe(2);
    expect(h.canUndo).toBe(false);
  });

  it("a push with a repeated key after undo still clears redo", () => {
    const { h } = make();
    h.push(1, "k");
    expect(h.undo(2)).toBe(1);
    expect(h.canRedo).toBe(true);
    h.push(1, "k");
    expect(h.canRedo).toBe(false);
  });
});

describe("History clear", () => {
  it("empties both stacks", () => {
    const { h } = make();
    h.push(1); h.push(2);
    expect(h.undo(3)).toBe(2);
    expect(h.canUndo && h.canRedo).toBe(true);
    h.clear();
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    expect(h.undo(9)).toBeUndefined();
    expect(h.redo(9)).toBeUndefined();
  });
});

type Snapshot = { doc: Json; manifests: ManifestMap };
// Blobs are not part of a snapshot: the key must not exist on the type.
const noBlobs: "blobs" extends keyof Snapshot ? never : true = true;

describe("History snapshots", () => {
  const manifests = {} as ManifestMap;

  it("restores a combined snapshot by reference and keeps manifests identical on doc-only edits", () => {
    expect(noBlobs).toBe(true);
    const h = new History<Snapshot>(clock().now);
    const s0: Snapshot = { doc: pumpkin, manifests };
    const s1: Snapshot = { doc: setAt(s0.doc, ["game", "runtime", "lives"], 9), manifests: s0.manifests };
    h.push(s0);
    expect(s1.manifests).toBe(s0.manifests);
    const back = h.undo(s1);
    expect(back).toBe(s0);
    expect(back?.doc).toBe(pumpkin);
    expect(h.redo(s0)).toBe(s1);
  });

  it("restores doc and manifests together when both changed", () => {
    const h = new History<Snapshot>(clock().now);
    const m2 = {} as ManifestMap;
    const s0: Snapshot = { doc: pumpkin, manifests };
    const s1: Snapshot = { doc: setAt(pumpkin, ["game", "runtime", "lives"], 9), manifests: m2 };
    h.push(s0);
    const back = h.undo(s1);
    expect(back?.doc).toBe(s0.doc);
    expect(back?.manifests).toBe(manifests);
    expect(back?.manifests).not.toBe(m2);
  });

  it("is not affected by later structural-sharing edits", () => {
    const before = JSON.stringify(pumpkin);
    const h = new History<Json>(clock().now);
    const s0 = pumpkin;
    h.push(s0);
    const s1 = setAt(s0, ["game", "runtime", "lives"], 9);
    h.push(s1, "x");
    const s2 = setAt(s1, ["game", "runtime", "lives"], 7);
    expect(JSON.stringify(s0)).toBe(before);
    type Doc = { game: { runtime: Record<string, Json> } } & Record<string, Json>;
    const game0 = (s0 as Doc).game;
    const game1 = (s1 as Doc).game;
    expect(game1.runtime.lives).toBe(9);
    expect(game0.runtime.lives).toBe(5);
    // untouched branches are shared by reference
    expect(game1.runtime.kinds).toBe(game0.runtime.kinds);
    expect((s1 as Record<string, Json>).project).toBe((s0 as Record<string, Json>).project);
    expect(h.undo(s2)).toBe(s1);
    expect(h.undo(s1)).toBe(s0);
  });
});
