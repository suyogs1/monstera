// Classification of EVERY leaf of the canonical spec schema. A leaf is only "editable" when Studio really renders
// a control bound to it; the acceptance run proves that against the rendered UI (data-path attributes), and the
// unit test proves this table has exactly the schema's leaves. Do not move a field to "editable" to make a test pass,
// and do not add a leaf here that the schema does not have.
//
//   editable        a control is bound to the path; the engine validates the value.
//   read-only       shown but not changeable in Studio.
//   engine-managed  owned by the engine / migration tooling; Studio preserves it and never changes it.

export type Role = "editable" | "read-only" | "engine-managed";

const e = (): { role: Role; note?: string } => ({ role: "editable" });

export const COVERAGE: Record<string, { role: Role; note?: string }> = {
  "specVersion": { role: "engine-managed", note: "Format version. Only the engine (and docs/SPEC-V2-MIGRATION.md) define it; Studio shows it and keeps it." },

  "project.id": e(), "project.displayName": e(), "project.identifier": e(),
  "project.version.name": e(), "project.version.code": e(),
  "project.targets[]": e(),
  "project.platforms.android.minSdk": e(), "project.platforms.ios.deploymentTarget": e(),

  "game.genre": e(), "game.orientation": e(), "game.targetFps": e(),
  "game.world.width": e(), "game.world.height": e(),
  "game.palette.background": e(), "game.palette.primary": e(), "game.palette.accent": e(),
  "game.hud.lifeGlyph": e(), "game.hud.scoreLabel": e(),
  "game.screens.startHint": e(), "game.screens.winTitle": e(), "game.screens.loseTitle": e(),
  "game.input.scheme": e(), "game.input.dragGain": e(), "game.input.swipeSpeed": e(),
  "game.input.tapKind": e(), "game.input.tapVx": e(), "game.input.tapVy": e(),
  "game.simulation.tickRate": e(), "game.simulation.maxTicksPerFrame": e(),

  "game.runtime.maxEntities": e(), "game.runtime.lives": e(), "game.runtime.winScore": e(),
  "game.runtime.kinds[].id": { role: "editable", note: "Rename cascades to every reference (tapKind, initial entities, spawners, collisions)." },
  "game.runtime.kinds[].color": e(), "game.runtime.kinds[].glyph": e(), "game.runtime.kinds[].effect": e(),
  "game.runtime.kinds[].width": e(), "game.runtime.kinds[].height": e(),
  "game.runtime.kinds[].lifetimeTicks": e(), "game.runtime.kinds[].exitPolicy": e(),
  "game.runtime.initialEntities[].kind": e(), "game.runtime.initialEntities[].x": e(), "game.runtime.initialEntities[].y": e(),
  "game.runtime.initialEntities[].vx": e(), "game.runtime.initialEntities[].vy": e(), "game.runtime.initialEntities[].controlled": e(),
  "game.runtime.spawners[].stream": e(), "game.runtime.spawners[].kind": e(),
  "game.runtime.spawners[].startTick": e(), "game.runtime.spawners[].intervalTicks": e(),
  "game.runtime.spawners[].xMin": e(), "game.runtime.spawners[].xMax": e(),
  "game.runtime.spawners[].yMin": e(), "game.runtime.spawners[].yMax": e(),
  "game.runtime.spawners[].vx": e(), "game.runtime.spawners[].vy": e(),
  "game.runtime.collisions[].a": e(), "game.runtime.collisions[].b": e(),
  "game.runtime.collisions[].despawnA": e(), "game.runtime.collisions[].despawnB": e(),
  "game.runtime.collisions[].score": e(), "game.runtime.collisions[].lives": e(),
};

export const editablePatterns = (): string[] =>
  Object.entries(COVERAGE).filter(([, v]) => v.role === "editable").map(([k]) => k).sort();
