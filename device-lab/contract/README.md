# Device Lab operation contract (v0)

Every adapter is an executable script invoked as:

```
<adapter> <op> [args]
```

Environment: `RUN_ID` (optional; default UTC timestamp). Output directory:
`device-lab/reports/runs/$RUN_ID/<target>/`.

| op | Args | Effect | Artifact |
|---|---|---|---|
| build | - | Build the debug app for the target | app binary (`.apk` / `.app`) |
| install | - | Install the built app on the target | - |
| launch | - | Start the app's main entry point | - |
| stop | - | Force-stop the app | - |
| screenshot | `[name]` | Capture the screen as PNG | `<name>.png` |
| logs | - | Dump app/device logs captured so far | `logs.txt` |
| test | - | Run the platform's automated tests, if any | test output |
| report | - | Summarize the run's results | `report.json` |

Rules:

- Exit code 0 means `status: ok`. Non-zero means `failed`. Exit code 3 means `unsupported`.
- Each op prints exactly one JSON line to stdout matching `result.schema.json`.
  Human-readable tool output goes to stderr.
- Ops are independent and idempotent where the platform allows; no hidden state other than
  the run directory.
- Target selection is per adapter via environment (`ANDROID_SERIAL`, `SIM_DEVICE`, `IOS_UDID`).
