# Authored sprites, Studio to native apps

A sprite sheet imported and authored in Studio is drawn by the generated Android and iOS apps. Device Lab output in `android/` and `ios/`
is copied unchanged from the runs below.

## Identity

| | |
|---|---|
| Exported canonical spec | `monstera.spec.json` in this directory, SHA-256 **`0f1ba683b85ed3b0271a47ad0eb8f09e61efbebf6d045d9ca6892b7efe11b241`** (4760 bytes) |
| Source sheet | `source-sheet.png`, SHA-256 `bd53cbe6d011b7e0fa2bbb2a206c6144d0108943fe9fc5aa1869c7bc5cd8f45f`. It is the existing deterministic atlas of Pumpkin Blaster (`apps/pumpkin-blaster/monstera.spec.json` `game.atlas.png`, decoded): 8 frames of 16 x 16 |
| Atlas Studio built (`game.atlas`) | 8 x 1 frames of 16 x 16, PNG SHA-256 `ae938487e172a0a7fa455292442517119be200a915372b3edf8522d2176b0788` |
| Base | Lantern Run template (no atlas, no sprites), forked in Studio as `atlas-proof` / `app.monstera.atlasproof` |
| Assignment | `keeper` frame 0 (saucer), `lantern` frame 4 (ember), `wisp` frames 2, 3 every 8 ticks (bat, animated) |

`identity.json` is the record the browser flow wrote.

## How the spec was made

`studio/scripts/atlas-proof.mjs` (`npm run atlas:proof`) drives the production Studio build in Chromium on the real engine worker and IndexedDB.
It loads the Lantern Run template and sets the project id, name and identifier in the Overview fields. It then imports `source-sheet.png`
in Asset Studio with provenance (user-owned, `proprietary-owned`), slices it into 8 x 1 frames of 16 x 16 in the Sprite editor, clicks
**Build atlas from sheet**, types the frames and ticks per frame above, and clicks **Apply to specification**. The engine accepts the
spec and reports that the oracle hash is unchanged. Last, it clicks **Generate source files**, **Download ZIP** and the top bar's
**Export** button. The script checks the following:

- The exported spec equals the engine's canonical text of the draft, and it has the SHA-256 above.
- The CLI (`monstera generate`) run on the exported spec gives files that are byte-identical to every file in the Studio ZIP. The CLI
  only adds its `README.md`.
- The ZIP manifest lists the same spec SHA-256 and the same hash for every file as the CLI's manifest.
- Both native projects bundle the authored atlas bytes unchanged.

The studio CI runs it with `--check` on every change. That run fails unless the committed spec is exactly what Studio exports.

## Runs

| Platform | Where | Run | Build input |
|---|---|---|---|
| Android | Local Windows host, emulator AVD `Pixel_9_Pro_XL` (Android 16, API 36), working tree of `studio/atlas-native-proof` with this spec | `atlas-native-proof-android` | `monstera generate docs/evidence/atlas-native-proof/monstera.spec.json --out g6-clean-room/atlas-proof --layout fixture`, then `device-lab/android/adapter.sh` `build install launch screenshot 01-launched screenshot 02-later logs stop report` |
| iOS | GitHub Actions `monstera` run **45362548326**, job `ios-generated`, commit `783b38fa807a4de5b19bfe41af31cbfaa855e36e`, artifact `g1-ios-simulator-45362548326` | `ci-45362548326-atlas-proof` | the same `generate` and `verify` in the job, then the job's Device Lab loop |

The same CI run's `android-generated` job did the following from the same spec: generate and verify, checked the atlas bytes
(`tools/scripts/check-atlas-bytes.py`), compiled the app and ran the presentation JVM tests. Those tests include the sprite frame rule.

## Results

| | Android emulator | iOS simulator |
|---|---|---|
| Device Lab operations | build, install, launch, two screenshots, logs, stop, report: all `ok` | build, install, launch, two screenshots, logs, stop, report: all `ok` |
| Spec the app loaded | `spec sha256=0f1ba683…b241 bundledMatches=true` | `spec sha256=0f1ba683…b241 bundledMatches=true decodedMatches=true` |
| Atlas | `sprites atlas=loaded size=128x16 frames=8` | same |
| `wisp` frames drawn (tick: frame) | 331:3, 336:2, 344:3, 352:2, 360:3, 368:2 | 182:2, 184:3, 192:2, 200:3, 208:2, 216:3 |
| `tools/scripts/check-sprite-log.py --require-all-frames` | `problems: []` | `problems: []` (also run by the CI job) |
| Screenshots | `android/02-later.png`: the saucer (keeper), ember (lantern) and bat (wisp) sprites from the authored atlas | `ios/02-later.png`: the same three sprites |

Every logged frame equals `frames[(tick div 8) mod 2]` of `[2, 3]` (contract section 10). The template draws these kinds as emoji glyphs.
In the screenshots they are drawn as atlas pixel art, so the image the apps draw comes from the authored atlas.

## What this does not show

- The Android run was local, on a branch working tree that held this spec, not on a CI runner. No CI job runs the Android emulator for
  generated apps. The CI job compiles them and runs their JVM tests only.
- The fork has no recorded golden scenarios, because goldens belong to the template's spec. For this project the native runtime
  conformance tests are not run. Simulation equality with Lantern Run is shown by the Studio apply path, which compares the oracle hash
  before and after over 600 ticks.
- The screenshots show attract mode behind the start card. Gameplay, touch input, physical devices and performance were not tested.
- The two screenshots of a run are a few seconds apart and are not tied to a tick. The frame log is the animation proof.
