# Mixed-Size Atlas Normalization, Studio to Native iOS Simulator

A mixed-size sprite fixture exceeding the legacy 24 KiB base64 limit and normalized to uniform `48 x 48` cells (Spec v5) is bundled, verified, and drawn by the generated iOS application on the CI simulator.

## Identity

| | |
|---|---|
| Canonical spec | `docs/evidence/mixed-size-atlas/monstera.spec.json`, SHA-256 **`19b811b84105af6d0af49632a18c37015f86cc718b89d9c9b31065a98d7da3f8`** (38,798 bytes) |
| Project | `mixed-atlas` (`Mixed Atlas` / `app.monstera.mixedatlas`) |
| Normalized atlas (`game.atlas`) | `6 x 1` frames of `48 x 48` (`288 x 48` PNG, `34,812` base64 characters under the 1 MiB / `1,048,576` char limit) |
| Kind assignments | `keeper`, `lantern`, `wisp` (animated across frames `1, 2, 3, 5`) |

## CI Run

| Platform | Workflow / Run | Job | Commit | Artifact / Run ID |
|---|---|---|---|---|
| iOS Simulator | GitHub Actions `monstera` run **45788638779** | `ios-generated` (`139802116904`) | `dc635bc9d58ce8946ba546af4279866439c0a321` | `g1-ios-simulator-45788638779` / `ci-45788638779-mixed-atlas` |

The same CI run's `android-generated` job (`139802117012`) generated the Android project from this fixture, verified `monstera-atlas.png` bytes, compiled the APK, and ran the JVM unit tests.

## iOS Simulator Results (`ios/`)

| Check | Observed Output |
|---|---|
| Device Lab operations | `build`, `install`, `launch`, `screenshot` (`01-launched.png`, `02-later.png`), `logs`, `stop`, `report`: all `ok` (`ios/report.json`, `ios/results.jsonl`) |
| Loaded spec | `[app.monstera.mixedatlas:spec] spec sha256=19b811b84105af6d0af49632a18c37015f86cc718b89d9c9b31065a98d7da3f8 bundledMatches=true decodedMatches=true` |
| Loaded atlas | `[app.monstera.mixedatlas:sprites] sprites atlas=loaded size=288x48 frames=6` |
| Determinism | `[app.monstera.mixedatlas:runtime] runtime ticks=60 hash=8c50805da43ed903 seed=5486338598638030` |
| `wisp` frames logged (tick:frame) | `1081:1`, `1086:2`, `1092:3`, `1098:5`, `1104:1`, `1110:2` (`ios/logs.txt`) |
| Screenshots | `ios/01-launched.png`, `ios/02-later.png` |

## Scope & Limitations

- The capability remains `prototype`: Studio's Spec v5 atlas output is bounded to a `16 x 16` grid, `128 x 128` max normalized cell size, `1,048,576` base64 chars, max `4` frames per kind, and at most `2` animated kinds.
- Android emulator rendering was not run in CI for this fixture (`android-generated` verified generation, compilation, JVM tests, and atlas bytes).
- Attract-mode rendering only; gameplay input, performance, and physical devices are not tested.
