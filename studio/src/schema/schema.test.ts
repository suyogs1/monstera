import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COVERAGE } from "./coverage";
import { SchemaModel } from "./schema";

const dir = join(__dirname, "..", "..", "..", "spec", "schema");
const texts = Object.fromEntries(
  ["monstera.spec.schema.json", "project.schema.json", "game.schema.json"].map((n) => [n, readFileSync(join(dir, n), "utf8")]));
const model = new SchemaModel(texts);

describe("schema coverage", () => {
  it("classifies exactly the leaves of the schema", () => {
    const leaves = model.leaves();
    const classified = Object.keys(COVERAGE).sort();
    expect(leaves.filter((l) => !classified.includes(l)), "schema leaves without a classification").toEqual([]);
    expect(classified.filter((c) => !leaves.includes(c)), "classifications that are not schema leaves").toEqual([]);
  });
  it("every classified leaf resolves to a field description", () => {
    for (const p of Object.keys(COVERAGE)) expect(model.field(p), p).toBeDefined();
  });
  it("keeps engine-managed and read-only entries explained", () => {
    for (const [p, v] of Object.entries(COVERAGE)) if (v.role !== "editable") expect(v.note, p).toBeTruthy();
  });
});

describe("field descriptions come from the schema", () => {
  it("marks Q16.16 quantities by their schema type, and plain numbers not", () => {
    const q16 = model.leaves().filter((l) => model.field(l)?.unit === "q16").sort();
    expect(q16).toEqual([
      "game.input.dragGain", "game.input.swipeSpeed", "game.input.tapVx", "game.input.tapVy",
      "game.runtime.initialEntities[].vx", "game.runtime.initialEntities[].vy",
      "game.runtime.initialEntities[].x", "game.runtime.initialEntities[].y",
      "game.runtime.kinds[].height", "game.runtime.kinds[].width",
      "game.runtime.spawners[].vx", "game.runtime.spawners[].vy",
      "game.runtime.spawners[].xMax", "game.runtime.spawners[].xMin",
      "game.runtime.spawners[].yMax", "game.runtime.spawners[].yMin",
    ]);
    expect(model.field("game.world.width")?.unit).toBeUndefined();
    expect(model.field("game.runtime.spawners[].intervalTicks")?.unit).toBeUndefined();
  });
  it("carries constraints, enums and descriptions", () => {
    const lives = model.field("game.runtime.lives");
    expect([lives?.minimum, lives?.maximum]).toEqual([1, 99]);
    expect(model.field("game.orientation")?.enum).toEqual(["landscape", "portrait"]);
    expect(model.field("project.platforms.android.minSdk")?.minimum).toBe(26);
    expect(model.field("game.palette.primary")?.regex).toBe("^#[0-9A-F]{6}$");
    expect(model.field("game.hud.lifeGlyph")?.maxLength).toBe(8);
    expect(model.field("game.hud.lifeGlyph")?.description).toContain("once per remaining life"); // sibling overrides the $ref
    expect(model.field("game.runtime.kinds[].id")?.regex).toContain("a-z");
    expect(model.field("specVersion")?.const).toBe(4);
    expect(model.field("project.targets[]")?.enum).toEqual(["android", "ios"]);
  });
  it("returns undefined for paths the schema does not have", () => {
    expect(model.field("game.nope")).toBeUndefined();
    expect(model.field("game.runtime.kinds.id")).toBeUndefined();
  });
});
