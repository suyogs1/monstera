#!/usr/bin/env python3
"""Check a Device Lab log of a generated app against the canonical spec it was built from (contract section 10).

Usage: check-sprite-log.py [--require-all-frames] <monstera.spec.json> <logs.txt>

The apps log, from their draw path, `sprites atlas=loaded size=WxH frames=N` once and `sprites tick=T kind=K frame=F` whenever
the frame drawn for an animated kind changes. This script requires, for the spec's own values:
  * the atlas line (skipped for a spec without an atlas), with the size and frame count the spec's atlas declares;
  * with --require-all-frames, for every kind with two or more frames, a frame line for each of its frames (a kind can spawn late);
  * every frame line to equal frames[(tick div ticksPerFrame) mod count] of that kind, and to name a kind the spec animates.
It prints one JSON line with what it checked and exits 1 on the first violation. Standard library only.
"""
import json
import re
import sys

ATLAS = re.compile(r"sprites atlas=loaded size=(\d+)x(\d+) frames=(\d+)")
FRAME = re.compile(r"sprites tick=(\d+) kind=([a-z][a-z0-9-]*) frame=(\d+)")


def main(spec_path: str, log_path: str, require_all: bool) -> int:
    game = json.load(open(spec_path, encoding="utf-8"))["game"]
    atlas = game["atlas"]
    if atlas["png"] == "":
        print(json.dumps({"atlas": [], "animatedKinds": [], "frameLines": 0, "problems": [], "note": "the spec has no atlas"}))
        return 0
    animated = {k["id"]: k["sprite"] for k in game["runtime"]["kinds"] if len(k["sprite"]["frames"]) > 1}
    text = open(log_path, encoding="utf-8", errors="replace").read()
    problems = []
    want = (atlas["columns"] * atlas["frameWidth"], atlas["rows"] * atlas["frameHeight"], atlas["columns"] * atlas["rows"])
    seen_atlas = [tuple(map(int, m.groups())) for m in ATLAS.finditer(text)]
    if not seen_atlas:
        problems.append("no 'sprites atlas=loaded' line: the atlas was not decoded by the app")
    elif any(a != want for a in seen_atlas):
        problems.append(f"atlas line {seen_atlas[0]} differs from the spec's {want}")
    shown: dict[str, set[int]] = {k: set() for k in animated}
    lines = 0
    for m in FRAME.finditer(text):
        tick, kind, frame = int(m.group(1)), m.group(2), int(m.group(3))
        lines += 1
        sprite = animated.get(kind)
        if sprite is None:
            problems.append(f"frame line for kind {kind!r}, which the spec does not animate")
            continue
        expected = sprite["frames"][(tick // sprite["ticksPerFrame"]) % len(sprite["frames"])]
        if frame != expected:
            problems.append(f"tick {tick} kind {kind}: drew frame {frame}, the rule gives {expected}")
        shown[kind].add(frame)
    for kind, sprite in (animated.items() if require_all else ()):
        missing = sorted(set(sprite["frames"]) - shown[kind])
        if missing:
            problems.append(f"kind {kind}: frames {missing} were never drawn")
    print(json.dumps({"atlas": seen_atlas[:1], "animatedKinds": sorted(animated), "frameLines": lines, "problems": problems}))
    return 1 if problems else 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--require-all-frames"]
    if len(args) != 2:
        sys.exit(__doc__)
    sys.exit(main(args[0], args[1], "--require-all-frames" in sys.argv))
