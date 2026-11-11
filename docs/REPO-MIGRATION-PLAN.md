# Repository migration plan (G1.5)

Status: **PROPOSED, not executed.** Approved decisions: move the G0 reference apps to
`reference/g0/`; `apps/` will contain exactly the two Skeleton Crew applications.

Base: `main` at `ca477be` (G1 merged).

## Target layout

```
.kiro/                      Kiro development foundation (steering, specs, agents, hooks,
                            prompts, workflows, settings/mcp.json)
apps/
  pumpkin-blaster/          Skeleton Crew app 1 (G3)
  trick-or-treat-rush/      Skeleton Crew app 2 (G3)
reference/
  g0/android/               G0 toolchain proof (moved from apps/android)
  g0/ios/                   G0 toolchain proof (moved from apps/ios)
spec/                       canonical schemas, sample specs, fixtures, golden scenarios (G2)
generated/monstera-sample/  engine fixture output (unchanged)
tools/monstera/             the one engine + CLI (unchanged)
tools/monstera-mcp/         MCP server: adapter over tools/monstera (G1.5)
studio/                     MONSTERA Studio: web/ (Vercel), api/ (Railway) (G4)
powers/monstera/            Kiro power for external developers (G4, after MCP is proven)
device-lab/  architecture/  docs/  assets/  .github/workflows/
```

## Per-application layout (G3)

The spec and assets are hand-maintained. The native projects are generator-owned.

```
apps/<id>/
  monstera.spec.json          hand-maintained canonical spec (the only source of truth)
  assets/                     hand-maintained source assets
  assets/PROVENANCE.md        origin + licence of every asset
  README.md                   hand-maintained: what the game is, how to build/run/install
  MONSTERA-MANIFEST.json      GENERATED: ownership of android/ and ios/ only
  android/                    GENERATED: Gradle/Kotlin/Compose project
  ios/                        GENERATED: SwiftPM + xtool.yml + SwiftUI/SpriteKit project
```

**Engine change needed (scheduled in G3, not done now):** today the generator owns an entire
output directory. For `apps/<id>/` it must own only `android/`, `ios/` and the manifest, and
leave hand-maintained siblings (`monstera.spec.json`, `assets/`, `README.md`) alone. Proposal: the
manifest gains `"ownedRoots": ["android", "ios"]`. `check`, `verify` and `write` consider only files
under owned roots plus the manifest, and still refuse anything unexpected *inside* them. The
existing `generated/monstera-sample` keeps today's whole-directory ownership (`ownedRoots: ["."]`).

## Step 1: move (one commit, history preserved)

```bash
git mv apps/android reference/g0/android
git mv apps/ios     reference/g0/ios
```

`git log --follow reference/g0/android/app/src/main/kotlin/app/monstera/hello/MainActivity.kt`
must show the G0 history. File contents are unchanged by this commit.

## Step 2: update references (separate commit)

| File | Change |
|---|---|
| `.github/workflows/android.yml` | `paths:` `apps/android/**` → `reference/g0/android/**`; adapter call gets `DL_APP_DIR=reference/g0/android` |
| `.github/workflows/ios-simulator.yml` | `paths:` `apps/ios/**` → `reference/g0/ios/**`; adapter call gets `DL_APP_DIR=reference/g0/ios` |
| `device-lab/android/adapter.sh`, `device-lab/ios/adapter.sh` | **Remove** the G0 default app (`apps/android` / `apps/ios`): `DL_APP_DIR` and friends become required. This avoids a default that silently points at a reference app |
| `tools/scripts/android-emulator-smoke.sh` | Passes the `DL_APP_*` variables through; documents them |
| `tools/xtool/linux-build.sh`, `tools/xtool/README.md` | `apps/ios` → `reference/g0/ios` |
| `.gitignore` | `apps/ios/.bsp/` → `reference/g0/ios/.bsp/`; add `apps/*/ios/.bsp/` |
| `.kiro/agents/android-native.json`, `ios-native.json` | Ownership: `reference/g0/<platform>` (read-mostly) + their template dirs + (G3) `apps/*/` platform folders through the generator only |
| `.kiro/steering/02-native-architecture.md`, `03-code-quality-and-testing.md` | Path updates; 02 also gets the Studio split (see `architecture/MONSTERA-STUDIO.md`) |
| `README.md` | Layout table, quick start, status |
| `reference/g0/android/README.md` | `cd apps/android` → `cd reference/g0/android` |
| `docs/XTOOL-EXPERIMENT.md` | Add a dated note: "since G1.5 the app lives at `reference/g0/ios`". Commands are updated; the recorded results are not edited |

**Not edited (historical evidence):** `docs/G0-TOOLCHAIN-REPORT.md`, `docs/G1-SPECIFICATION-REPORT.md`,
everything under `docs/evidence/`. Each report gets one prepended line: *"Paths: `apps/android` and
`apps/ios` moved to `reference/g0/` in G1.5 (commit `<sha>`); the results below are unchanged."*

## Step 3: verify

| Check | How |
|---|---|
| Nothing still references the old paths | `git grep -nE 'apps/(android\|ios)'` outside the historical docs and evidence must be empty |
| History preserved | `git log --follow` on one file per platform shows its G0 commits |
| G0 Android pipeline | `android` workflow passes (build + emulator smoke) |
| G0 iOS pipeline | `ios-simulator` workflow passes |
| G1 pipeline | `monstera` workflow passes (it doesn't depend on `apps/`) |
| Architecture check | `monstera check-architecture` clean |
| `apps/` content | Empty until G3 (a `README.md` stating the two planned folders is allowed) |

## Rollback

Both commits are plain moves/edits: `git revert` of the two commits restores the old layout.
