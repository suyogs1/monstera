import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Json } from "../schema/schema";
import { facts, ruleSentences, seconds, spawnLines, spawnTicks } from "./summary";

const load = (rel: string): Json => JSON.parse(readFileSync(join(__dirname, "..", "..", "..", rel), "utf8")) as Json;
const pumpkin = load("apps/pumpkin-blaster/monstera.spec.json");

describe("summary", () => {
  it("states collision rules as sentences", () => {
    const rules = ruleSentences(pumpkin).map((r) => r.text);
    expect(rules[0]).toBe("bullet touches pumpkin: score +10; bullet and pumpkin vanish");
    expect(rules[2]).toBe("pumpkin touches player: lives \u22121; pumpkin vanishes");
  });
  it("states spawn rhythm in seconds", () => {
    expect(spawnLines(pumpkin)[0]?.text).toBe("pumpkin: every 1 s, from 0 s (60 per minute)");
    expect(spawnLines(pumpkin)[2]?.text).toBe("ember: every 3.33 s, from 0 s (18 per minute)");
  });
  it("lists facts with the path that controls each", () => {
    const f = facts(pumpkin);
    expect(f.find((x) => x.label === "World")?.value).toBe("1920 \u00d7 1080 units");
    expect(f.find((x) => x.label === "Winning")?.value).toBe("reach 1000 points");
    expect(f.find((x) => x.label === "World")?.path).toEqual(["game", "world", "width"]); // a control, not a bare object
    expect(f.find((x) => x.label === "Entity kinds")?.path).toEqual(["game", "runtime", "kinds", 0]); // first item's card
  });
  it("tolerates half-formed documents", () => {
    expect(ruleSentences({})).toEqual([]);
    expect(spawnLines({ game: { runtime: { spawners: [{}] } } })[0]?.text).toContain("?");
    expect(facts(null)).toEqual([{ label: "Entity kinds", value: "0", path: ["game", "runtime", "kinds"] }, { label: "Spawners", value: "0", path: ["game", "runtime", "spawners"] }, { label: "Rules", value: "0", path: ["game", "runtime", "collisions"] }]);
  });
  it("computes spawn ticks within a horizon", () => {
    expect(spawnTicks(0, 60, 180)).toEqual([0, 60, 120, 180]);
    expect(spawnTicks(100, 0, 500)).toEqual([]);
    expect(seconds(90, 60)).toBe("1.5");
  });
});
