# xtool experiment (Phase 0)

Goal: find out, by trying it, whether the MONSTERA iOS app (SwiftUI + SpriteKit, SwiftPM) can be
built on Linux with [xtool](https://github.com/xtool-org/xtool), and what blocks deployment to a
physical iPhone.

Sources read: the xtool README, `Documentation/xtool.docc/{Installation-Linux,Installation-macOS,First-app.tutorial,Control}`,
and `Sources/{XToolSupport/{NewCommand,DevCommand,SDKCommand,SDKBuilder}.swift,PackLib/PackSchema.swift}`
at `main`, as of 2026-11-11. Release used: **xtool 1.24.0**.

## Findings from documentation and source

| Topic | Finding | Source |
|---|---|---|
| Linux install | Swift 6.4 toolchain, `usbmuxd` (device only), xtool AppImage, and a Darwin SDK built from Xcode (docs say Xcode 27.1 `.xip`). Windows: WSL + USBIPD. | Installation-Linux.md |
| Xcode requirement | Unavoidable. `xtool sdk build <Xcode.xip or Xcode.app> <out>` generates `darwin.xtoolsdk`, and `xtool sdk install` accepts `.xip`, `.app` or `.xtoolsdk`. Downloading the `.xip` needs an Apple ID. | SDKCommand.swift |
| SwiftPM | The project is a normal SwiftPM package with exactly one library product. `xtool dev build` builds it and packs it into an `.app`. | NewCommand.swift, DevCommand.swift |
| xtool.yml | `version: 1` plus `bundleID` or `orgID`. Optional: `product`, `infoPath`, `entitlementsPath`, `iconPath`, `resources`, `extensions`, `skipLSP`. | PackSchema.swift, Control.md |
| SwiftUI | Supported. The default template is a SwiftUI `@main` App. | NewCommand.swift |
| SpriteKit | Not mentioned in the docs. It's a system framework in the iOS SDK; **proven by our build** below. | experiment |
| Unsigned build | `xtool dev build` without `--sign` needs no login. `--ipa` packages a `.ipa`. `--triple arm64-apple-ios-simulator` targets the simulator. | DevCommand.swift |
| Physical device | `xtool dev` builds, registers the device, creates certificate + App ID + profile, signs and installs. Also `xtool install`, `launch`, `uninstall`, `devices`. Requires USB pairing ("Trust"), Developer Mode, and trusting the developer profile on the device. | First-app.tutorial |
| Free Apple ID | Supported through the "Password" login mode, which uses private Apple APIs (docs suggest a throwaway Apple ID). Bundle IDs get a prefix (e.g. `XTL-1234.`) because free accounts can't share IDs. Some entitlements don't work with free accounts. | Installation-Linux.md, Control.md |
| Paid account | "API Key" login (App Store Connect Team Key, App Manager role), using the public API. | Installation-Linux.md |
| Free-account limits (Apple, not xtool) | Not verified here. Commonly cited: 7-day profiles, small device/App ID limits. **To be confirmed during the device test.** | - |
| macOS CLI | Use `xtool.app/Contents/Resources/bin/xtool` (sets `XTL_CLI=1`). Running `Contents/MacOS/xtool` directly starts the GUI app and **hangs in CI**. | release zip, CI run 42967516221 |

## Experiment: unsigned Linux build in CI (historical; SDK transfer now disabled)

The experiment ran from commit `a51320b` to `6cd7fb8` of `.github/workflows/xtool-linux.yml`;
see the licensing section below for why it's disabled. Script: `tools/xtool/linux-build.sh`.

No Linux machine was available locally (WSL has only the `docker-desktop` distro and Docker
Desktop wasn't running), and no Apple ID was used. So:

1. A `macos-26` job generates the Darwin SDK from the runner's preinstalled Xcode 26.6 with
   `xtool sdk build "$XCODE" "$OUT"`.
2. An `ubuntu-24.04` job in the official `swift:6.4.2-noble` container installs it with
   `xtool sdk install darwin.xtoolsdk` and runs `xtool dev build` in `apps/ios`.

### Attempt 1: FAILED (link step), run 42969821746

Swift compilation for `arm64-apple-ios` ran on Linux, but linking failed:

```
.../darwin.artifactbundle/toolset/bin/ld64.lld: 68: exec: .../toolset/bin/llvm-lib: Exec format error
clang: error: unable to execute command: Program could not be executed
error: Build failed
```

Cause: `SDKBuilder` downloads `darwin-tools-linux-llvm` `toolset-<arch>.tar.gz` for the CPU of
the host running `sdk build`. The macOS runner is arm64, so the SDK carried aarch64 Linux
binaries, and the Linux runner is x86_64. Evidence: `docs/evidence/xtool-linux/attempt-1-*`.

### Attempt 2: COMPILED (unsigned), run 42972339280

Fix: set xtool's `XTL_TOOLSET_TARBALL` to `toolset-x86_64.tar.gz` (darwin-tools-linux-llvm
v1.1.0, matching xtool 1.24.0) while building the SDK.

```
Swift version 6.4.2 (swift-6.4.2-RELEASE)  Target: x86_64-unknown-linux-gnu
Darwin SDK is installed  Flavor: slim  Version: epoch=4,darwinTools=1.1.0,oam=1.4.1
xtool dev build
Build complete! (48.25 secs)
Wrote to /__w/monstera/monstera/apps/ios/xtool/MonsteraHello.app
MonsteraHello: cf fa ed fe 0c 00 00 01   (Mach-O 64-bit, CPU arm64)
```

`Info.plist`: `CFBundleIdentifier=app.monstera.hello`, `MinimumOSVersion=17.0`. The binary
references SpriteKit. Evidence: `docs/evidence/xtool-linux/attempt-2-compiled.txt`,
`MonsteraHello.app-Info.plist`.

Toolchain skew: Linux Swift 6.4.2 against an SDK from Xcode 26.6 (Swift 6.3.3). This worked
here, but xtool documents Swift 6.4 with Xcode 27.1. Expect to align versions when Xcode 27
reaches the runners.

## Reproduce

On a Linux x86_64 host with Swift 6.4 and your own Xcode download:

```bash
tools/xtool/linux-build.sh ~/Downloads/Xcode_27.1.xip     # or a darwin.xtoolsdk.tar.gz
```

In CI: `xtool-linux (experimental)` is manual-trigger only. On hosted runners it does the
toolchain check and skips the build. Pass a self-hosted `runner` label whose user installed a
Darwin SDK from their own Xcode download to build.

## Not tested (needs the user)

Physical-device deployment needs:

1. An Apple ID (free or paid) for `xtool setup` / `xtool auth`. Credentials go only to Apple.
2. An iPhone connected by USB to a Linux host (or Windows + WSL + USBIPD), with Developer Mode on.
3. Running `xtool dev` in `apps/ios`, trusting the device and the developer profile.

Nothing above was attempted, so iOS stays at **COMPILED** for Linux. It is not
PHYSICAL-DEVICE-TESTED.

## Documented setup vs. our CI experiment

| | xtool's documented Linux setup | Our CI SDK transfer experiment (disabled) |
|---|---|---|
| Who downloads Xcode | The developer, with their own Apple ID, from developer.apple.com | Nobody. The SDK came from the Xcode preinstalled on a GitHub-hosted macOS runner |
| Where the SDK is generated | On the developer's Linux machine (`xtool setup` / `xtool sdk install Xcode.xip`) | On a hosted macOS runner (`xtool sdk build Xcode.app`) |
| Where the SDK goes | Stays on that machine (`~/.swiftpm/swift-sdks/`) | Uploaded as a workflow artifact and downloaded by a hosted Linux runner |
| Who can access it | The developer | Anyone with artifact access during retention; this repository is public |
| Apple ID | Required to download Xcode | Not used |

## Licensing status: UNRESOLVED, transfer disabled

Whether Apple's Xcode and SDK license terms allow building with Xcode-derived SDK files on a
non-Apple host is **not established here and is not legal advice**. The transfer experiment adds
two more questions: the SDK was derived from an Xcode copy we didn't download under our own
agreement, and it was made available as an artifact of a public repository.

Actions taken at the G0 review:

- `xtool-linux.yml` no longer generates or transfers a Darwin SDK. It's manual-trigger only and
  marked experimental. By default it checks the Linux toolchain only (Swift, xtool AppImage,
  `swift package describe`), and it builds only on a runner whose owner already installed a
  Darwin SDK from their own Xcode download.
- The two `darwin-xtoolsdk` artifacts from runs 42969821746 and 42972339280 were deleted from
  GitHub Actions on 2026-11-11. No SDK material is committed to this repository; the committed
  evidence is build logs, an `Info.plist` of our own app, and text excerpts.
- The iOS Simulator workflow runs entirely on macOS with its own Xcode and uploads only
  screenshots, logs and reports.

The attempt-1/attempt-2 results above remain valid as **historical evidence** that the toolchain
can compile this app on Linux. Reproducing them requires the documented setup: your own Xcode
download on your own machine. Re-enabling any CI hand-off of Apple SDK material requires an
explicit licensing decision by the project owner.
