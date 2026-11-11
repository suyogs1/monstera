# Canonical spec v1 to v2 migration (G2)

`specVersion` is now exactly `2`. A v1 spec is rejected with `must be 2`. Migrate by explicit edits, then run
`monstera format` and `monstera generate`.

All new properties are required; there are no defaults.

| Where | New properties | Meaning |
|---|---|---|
| `game.input` | `dragGain`, `swipeSpeed`, `tapKind`, `tapVx`, `tapVy` | Q16.16 raw integers; `tapKind` is a kind id or `""` for none |
| `game.simulation` | `tickRate` (30, 60 or 120), `maxTicksPerFrame` (1..10) | fixed timestep |
| `game.runtime` | `maxEntities`, `lives`, `winScore`, `kinds`, `initialEntities`, `spawners`, `collisions` | see `architecture/RUNTIME-CONTRACT.md` |

Quantities are Q16.16 raw integers: 1.5 units is `98304` (units times 65536). `world.width` and `world.height`
must be whole units no larger than 32767. Kind ids and stream names match `^[a-z][a-z0-9-]{0,31}$`.

`spec/samples/monstera-sample/monstera.spec.json` is a complete worked example; `spec/samples/boundary-lab/`
shows the edge cases. Golden scenarios record the spec hash, so after any spec change run
`monstera scenarios record --all`, review the diff and commit.
