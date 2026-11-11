# xtool tooling

`linux-build.sh` builds `apps/ios` on Linux with xtool 1.24.0, unsigned, without an Apple ID.

```bash
tools/xtool/linux-build.sh <Xcode.xip | Xcode.app | darwin.xtoolsdk.tar.gz>
```

Requirements: Linux x86_64 or aarch64, Swift 6.4 on PATH, curl. The xtool AppImage is downloaded
and extracted, so no FUSE is needed.

Pitfalls found in Phase 0 (details in `docs/XTOOL-EXPERIMENT.md`):

- A Darwin SDK contains Linux linker tools for the arch of the host that ran `xtool sdk build`.
  If you build the SDK on a different arch than the Linux build host, set
  `XTL_TOOLSET_TARBALL=<toolset-<arch>.tar.gz from darwin-tools-linux-llvm>`.
- On macOS, call `xtool.app/Contents/Resources/bin/xtool`, not `Contents/MacOS/xtool`
  (the latter starts the GUI app).

Physical device (not yet tested): `xtool setup` (Apple ID), connect the iPhone over USB
(`usbmuxd`), then `xtool dev` in `apps/ios`.
