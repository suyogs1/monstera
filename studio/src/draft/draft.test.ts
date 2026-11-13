import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Json } from "../schema/schema";
import { addCollision, addInitialEntity, addKind, addSpawner, kindIds, kindReferences, removeKind, renameKind } from "./ops";
import { getAt, parseIssuePath, setAt, toIssuePath, toPattern } from "./path";

const repo = join(__dirname, "..", "..", "..");
const load = (rel: string): Json => JSON.parse(readFileSync(join(repo, rel), "utf8")) as Json;
const pumpkin = load("apps/pumpkin-blaster/monstera.spec.json");
const runner = load("apps/trick-or-treat-rush/monstera.spec.json");

describe("paths", () => {
  it("formats and parses engine issue paths", () => {
    const p = ["game", "runtime", "kinds", 2, "glyph"];
    expect(toIssuePath(p)).toBe("$.game.runtime.kinds[2].glyph");
    expect(parseIssuePath("$.game.runtime.kinds[2].glyph")).toEqual(p);
    expect(parseIssuePath("$")).toEqual([]);
    expect(parseIssuePath("pumpkin.json:line 1, column 5")).toBeUndefined();
    expect(toPattern(p)).toBe("game.runtime.kinds[].glyph");
  });
  it("sets immutably and shares untouched branches", () => {
    const next = setAt(pumpkin, ["game", "runtime", "lives"], 9);
    expect(getAt(next, ["game", "runtime", "lives"])).toBe(9);
    expect(getAt(pumpkin, ["game", "runtime", "lives"])).toBe(5);
    expect(getAt(next, ["project"])).toBe(getAt(pumpkin, ["project"]));
    expect(getAt(next, ["game", "runtime", "kinds"])).toBe(getAt(pumpkin, ["game", "runtime", "kinds"]));
  });
});

describe("kind references and rename", () => {
  it("finds every reference to a kind", () => {
    const labels = kindReferences(pumpkin, "player").map((r) => r.label);
    expect(labels).toEqual(["starting entity 1", "collision 3 (second kind)", "collision 4 (second kind)", "collision 5 (second kind)"]);
    expect(kindReferences(pumpkin, "bullet").map((r) => r.label)).toContain("input: tap spawns");
  });
  it("renames the definition and every reference in one step, and renaming back restores the document", () => {
    const refs = kindReferences(pumpkin, "bullet").length;
    const r = renameKind(pumpkin, "bullet", "shot");
    if (!r.ok) throw new Error(r.reason);
    expect(r.updatedReferences).toBe(refs);
    expect(kindIds(r.doc)).toContain("shot");
    expect(kindReferences(r.doc, "bullet")).toEqual([]);
    expect(getAt(r.doc, ["game", "input", "tapKind"])).toBe("shot");
    const back = renameKind(r.doc, "shot", "bullet");
    if (!back.ok) throw new Error(back.reason);
    expect(back.doc).toEqual(pumpkin);
  });
  it("does not touch a spawner stream that merely shares the kind's name", () => {
    const doc = setAt(pumpkin, ["game", "runtime", "spawners", 0, "stream"], "pumpkin");
    const r = renameKind(doc, "pumpkin", "gourd");
    if (!r.ok) throw new Error(r.reason);
    expect(getAt(r.doc, ["game", "runtime", "spawners", 0, "stream"])).toBe("pumpkin");
    expect(getAt(r.doc, ["game", "runtime", "spawners", 0, "kind"])).toBe("gourd");
  });
  it("refuses empty, duplicate and unknown ids", () => {
    expect(renameKind(pumpkin, "bullet", "")).toMatchObject({ ok: false });
    expect(renameKind(pumpkin, "bullet", "bat")).toMatchObject({ ok: false });
    expect(renameKind(pumpkin, "nope", "x")).toMatchObject({ ok: false });
  });
  it("an empty tapKind (no tap kind) is never produced by a rename", () => {
    const r = renameKind(runner, "runner", "sprinter");
    if (!r.ok) throw new Error(r.reason);
    expect(getAt(r.doc, ["game", "input", "tapKind"])).toBe(""); // was none, stays none
  });
});

describe("remove kind", () => {
  it("is blocked while referenced and lists the references", () => {
    const r = removeKind(pumpkin, "pumpkin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.references.length).toBeGreaterThan(0);
  });
  it("removes an unreferenced kind", () => {
    const { doc, id } = addKind(pumpkin);
    expect(kindIds(doc)).toContain(id);
    const r = removeKind(doc, id);
    if (!r.ok) throw new Error(r.reason);
    expect(r.doc).toEqual(pumpkin);
  });
});

describe("adding rows writes complete items", () => {
  it("adds a kind, spawner, collision and initial entity with every schema-required property", () => {
    const withKind = addKind(pumpkin).doc;
    const keys = (v: Json | undefined) => Object.keys(v as Record<string, Json>).sort();
    const sample = (path: (string | number)[]) => keys(getAt(withKind, path));
    expect(keys(getAt(addSpawner(withKind), ["game", "runtime", "spawners", 4]))).toEqual(sample(["game", "runtime", "spawners", 0]));
    expect(keys(getAt(addCollision(withKind), ["game", "runtime", "collisions", 5]))).toEqual(sample(["game", "runtime", "collisions", 0]));
    expect(keys(getAt(addInitialEntity(withKind), ["game", "runtime", "initialEntities", 1]))).toEqual(sample(["game", "runtime", "initialEntities", 0]));
    expect(keys(getAt(withKind, ["game", "runtime", "kinds", 6]))).toEqual(sample(["game", "runtime", "kinds", 0]));
  });
});
