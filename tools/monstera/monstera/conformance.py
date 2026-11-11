"""Cross-platform behavioural conformance: run every recorded scenario on the oracle, on the
generated Kotlin core (JVM unit tests) and on the generated Swift core (`swift test`), compare each
checkpoint with the expected values and report the first divergence per platform and scenario.
Contract: architecture/RUNTIME-CONTRACT.md section 7.

A verdict of `pass` means all three platforms ran against verified generated sources and matched.
The oracle is compared with its own recording, so an oracle-only run proves nothing about Kotlin or
Swift and is reported as `incomplete`.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from . import generate, scenario
from .jsonio import sha256_hex
from .schema import SchemaStore

PLATFORMS = ("oracle", "kotlin", "swift")
ENV_OUT = "MONSTERA_CONFORMANCE_OUT"
SWIFT_IMAGE = re.compile(r"swift:[0-9]+(?:\.[0-9]+){0,2}(?:-[a-z]+)?")
SCENARIO_RESOURCE = "monstera-scenarios.txt"


class ConformanceError(Exception):
    pass


def compare(expected: list[dict[str, Any]], actual: dict[int, dict[str, Any]]) -> list[dict[str, Any]]:
    """First checkpoint (lowest tick) whose hash or observables differ. `actual` maps tick -> record."""
    for want in expected:
        have = actual.get(want["tick"])
        if have is None:
            return [{"tick": want["tick"], "fields": ["missing"], "expectedHash": want["hash"], "actualHash": ""}]
        fields = [name for name in scenario.OBSERVABLES if want["observe"][name] != have["observe"][name]]
        if want["hash"] != have["hash"]:
            fields.append("hash")
        if fields:
            return [{"tick": want["tick"], "fields": fields, "expectedHash": want["hash"], "actualHash": have["hash"]}]
    return []


def parse_output(text: str, platform: str) -> dict[str, dict[int, dict[str, Any]]]:
    """JSON lines written by the native tests -> {scenario: {tick: {hash, observe}}}.
    Anything malformed, foreign or duplicated is a ConformanceError, never a traceback or a silent overwrite."""
    out: dict[str, dict[int, dict[str, Any]]] = {}
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
            if not isinstance(rec, dict):
                raise ValueError("not an object")
            name, tick, digest, observe = rec["scenario"], rec["tick"], rec["hash"], rec["observe"]
            if not (isinstance(name, str) and isinstance(tick, int) and isinstance(digest, str)
                    and isinstance(observe, list) and len(observe) == len(scenario.OBSERVABLES)
                    and all(isinstance(v, int) and not isinstance(v, bool) for v in observe)):
                raise ValueError("wrong field types or observable count")
            reported = rec.get("platform")
        except (ValueError, KeyError, TypeError) as exc:
            raise ConformanceError(f"{platform} output line {number} is malformed: {exc}") from None
        if reported != platform:
            raise ConformanceError(f"{platform} output contains a record for platform {reported!r}")
        if tick in out.setdefault(name, {}):
            raise ConformanceError(f"{platform} output has two records for scenario {name!r} tick {tick}")
        out[name][tick] = {"hash": digest, "observe": dict(zip(scenario.OBSERVABLES, observe))}
    return out


def _oracle(data: list[dict[str, Any]], store: SchemaStore) -> dict[str, dict[int, dict[str, Any]]]:
    out = {}
    for sc in data:
        fresh = scenario.oracle_checkpoints(sc, store, [c["tick"] for c in sc["checkpoints"]])
        out[sc["name"]] = {c["tick"]: {"hash": c["hash"], "observe": c["observe"]} for c in fresh}
    return out


def _run(cmd: list[str], cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=1800)


def _kotlin(gen: Path, out_file: Path) -> tuple[str, str]:
    android = gen / "android"
    if not (android / "gradlew").exists():
        return "skipped", "no android/ project in the generated directory"
    wrapper = ["cmd", "/c", "gradlew.bat"] if os.name == "nt" else ["bash", "./gradlew"]
    cmd = wrapper + ["--no-daemon", "--console=plain", "cleanTestDebugUnitTest", "testDebugUnitTest"]
    env = dict(os.environ, **{ENV_OUT: str(out_file)})
    try:
        proc = _run(cmd, android, env)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return "error", f"{' '.join(cmd)}: {exc}"
    # Test failures are decided by comparing the recorded checkpoints, not by the exit status alone,
    # but a build failure (no output) is an error.
    status = "pass" if proc.returncode == 0 else ("fail" if out_file.exists() else "error")
    return status, f"{' '.join(cmd)} (cwd {android.name}) exit {proc.returncode}"


def docker_command(pkg: Path, results: Path, image: str) -> list[str]:
    """Swift test container: no network, read-only sources, only the results directory writable."""
    return ["docker", "run", "--rm", "--network", "none", "-v", f"{pkg.resolve()}:/pkg:ro",
            "-v", f"{results}:/out", "-e", f"{ENV_OUT}=/out/result.jsonl", "-w", "/pkg", image,
            "swift", "test", "--scratch-path", "/tmp/build"]


def _swift(gen: Path, out_file: Path, image: str | None) -> tuple[str, str]:
    pkg = gen / "ios" / "Runtime"
    if not (pkg / "Package.swift").exists():
        return "skipped", "no ios/Runtime package in the generated directory"
    if image:
        if not shutil.which("docker"):
            return "skipped", "docker not found"
        with tempfile.TemporaryDirectory() as tmp:
            try:
                proc = _run(docker_command(pkg, Path(tmp), image), pkg, dict(os.environ))
            except (OSError, subprocess.TimeoutExpired) as exc:
                return "error", f"docker run {image}: {exc}"
            produced = Path(tmp) / "result.jsonl"
            if produced.exists():
                out_file.write_bytes(produced.read_bytes())
        status = "pass" if proc.returncode == 0 else ("fail" if out_file.exists() else "error")
        return status, f"docker run {image} swift test (package ios/Runtime) exit {proc.returncode}"
    swift = shutil.which("swift")
    if not swift:
        return "skipped", "swift not found; pass --swift-image to run in a container"
    cmd = [swift, "test", "--package-path", str(pkg), "--scratch-path", tempfile.mkdtemp(prefix="monstera-swift-")]
    try:
        proc = _run(cmd, pkg, dict(os.environ, **{ENV_OUT: str(out_file)}))
    except (OSError, subprocess.TimeoutExpired) as exc:
        return "error", f"swift test: {exc}"
    status = "pass" if proc.returncode == 0 else ("fail" if out_file.exists() else "error")
    return status, f"swift test --package-path ios/Runtime exit {proc.returncode}"


def _verified_manifest(gen: Path) -> dict[str, Any]:
    """The generated directory must be exactly what its manifest says: conformance executes these sources."""
    manifest = generate.read_manifest(gen)
    if manifest is None:
        raise ConformanceError(f"{gen} has no {generate.MANIFEST}")
    drift = generate.verify(gen)
    if not drift.clean:
        raise ConformanceError(
            f"{gen} differs from its manifest (changed {list(drift.changed)}, missing {list(drift.missing)}, "
            f"unexpected {list(drift.unexpected)}); refusing to run edited sources")
    return manifest


def run(gen: Path, store: SchemaStore, platforms: list[str], swift_image: str | None = None) -> dict[str, Any]:
    if (not isinstance(platforms, list) or not platforms
            or not all(isinstance(p, str) for p in platforms) or set(platforms) - set(PLATFORMS)):
        raise ConformanceError(f"platforms must be a non-empty list drawn from {list(PLATFORMS)}")
    if swift_image == "toolchain":  # the image pinned in toolchain.json
        swift_image = generate.toolchain()["ios"]["swiftConformanceImage"]
    if swift_image is not None and not (isinstance(swift_image, str) and SWIFT_IMAGE.fullmatch(swift_image)):
        raise ConformanceError("swift_image must look like swift:6.1-noble (official Swift image tags only)")
    manifest = _verified_manifest(gen)
    sha = manifest["spec"]["sha256"]
    data = scenario.load_for_project(manifest["spec"]["projectId"], sha, store)
    if not data:
        raise ConformanceError(f"no scenarios recorded for project {manifest['spec']['projectId']}")
    from . import emit_runtime
    expected_sha = sha256_hex(emit_runtime.scenarios_text(data).encode())
    shipped = [f for f in manifest["files"] if f["path"].endswith(SCENARIO_RESOURCE)]
    if not shipped:
        raise ConformanceError("the generated project embeds no scenario resource; regenerate it")
    if any(f["sha256"] != expected_sha for f in shipped):
        raise ConformanceError("the generated project embeds different scenarios than spec/scenarios; regenerate it")

    actual: dict[str, dict[str, dict[int, dict[str, Any]]]] = {}
    runs: list[dict[str, str]] = []
    with tempfile.TemporaryDirectory() as tmp:
        for platform in PLATFORMS:
            if platform not in platforms:
                continue
            out_file = Path(tmp) / f"{platform}.jsonl"
            if platform == "oracle":
                actual[platform] = _oracle(data, store)
                status, detail = "pass", "monstera.oracle in-process (compared with its own recording)"
            else:
                status, detail = (_kotlin(gen, out_file) if platform == "kotlin" else _swift(gen, out_file, swift_image))
                if status != "skipped" and out_file.exists():
                    try:
                        actual[platform] = parse_output(out_file.read_text(encoding="utf-8"), platform)
                    except ConformanceError as exc:
                        status, detail = "error", f"{detail}; {exc}"
            runs.append({"platform": platform, "status": status, "detail": detail})

    results = []
    for sc in data:
        name = sc["name"]
        per: list[dict[str, Any]] = []
        for run_ in runs:
            platform = run_["platform"]
            if run_["status"] == "skipped":
                per.append({"platform": platform, "status": "skipped", "divergences": []})
                continue
            produced = actual.get(platform, {}).get(name)
            if produced is None:
                per.append({"platform": platform, "status": "error", "divergences": []})
                continue
            div = compare(sc["checkpoints"], produced)
            per.append({"platform": platform, "status": "fail" if div else "pass", "divergences": div})
        path = scenario.SCENARIOS / manifest["spec"]["projectId"] / f"{name}{scenario.SUFFIX}"
        results.append({"name": name, "sha256": sha256_hex(path.read_bytes()),
                        "checkpoints": len(sc["checkpoints"]), "results": per})

    for run_ in runs:  # a platform whose tests failed must fail even if no checkpoint differs
        if run_["status"] == "pass" and any(
                r["status"] != "pass" for s in results for r in s["results"] if r["platform"] == run_["platform"]):
            run_["status"] = "fail"
    bad = any(r["status"] in ("fail", "error") for r in runs)
    incomplete = any(r["status"] == "skipped" for r in runs) or set(platforms) != set(PLATFORMS)
    # The digests are computed from the verified files, not copied from the manifest.
    digests = [{"path": f["path"], "sha256": sha256_hex((gen / f["path"]).read_bytes())} for f in manifest["files"]
               if "/runtime/" in f["path"] or "/Runtime/" in f["path"]]
    return {
        "reportVersion": 1, "specSha256": sha, "runtimeDigests": digests, "platforms": runs,
        "scenarios": results, "verdict": "fail" if bad else ("incomplete" if incomplete else "pass"),
    }


def summarize(report: dict[str, Any]) -> list[str]:
    lines = [f"spec {report['specSha256'][:12]}  verdict: {report['verdict'].upper()}"]
    if report["verdict"] == "incomplete":
        lines.append("  NOT a pass: not every platform (oracle, kotlin, swift) ran and matched; the oracle alone proves nothing "
                     "about the native cores")
    for p in report["platforms"]:
        lines.append(f"  {p['platform']:7s} {p['status']:8s} {p['detail']}")
    for sc in report["scenarios"]:
        cells = " ".join(f"{r['platform']}={r['status']}" for r in sc["results"])
        lines.append(f"  {sc['name']:20s} {sc['checkpoints']:4d} checkpoints  {cells}")
        for r in sc["results"]:
            for d in r["divergences"]:
                lines.append(f"    DIVERGENCE {r['platform']} at tick {d['tick']}: {', '.join(d['fields'])} "
                             f"(expected hash {d['expectedHash']}, got {d['actualHash'] or '-'})")
    return lines
