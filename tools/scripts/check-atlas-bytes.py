#!/usr/bin/env python3
"""Check that both generated native projects bundle the spec's atlas PNG byte for byte.

Usage: check-atlas-bytes.py <monstera.spec.json> <generated project dir>
Standard library only. Exits 1 with the reason when a bundled atlas differs, is missing, or is present for a spec without an atlas.
"""
import base64
import hashlib
import json
import pathlib
import sys


def main(spec_path: str, root: str) -> int:
    png = json.load(open(spec_path, encoding="utf-8"))["game"]["atlas"]["png"]
    base = pathlib.Path(root)
    found = sorted([*base.glob("android/app/src/main/assets/monstera-atlas.png"), *base.glob("ios/Sources/*/Resources/monstera-atlas.png")])
    if png == "":
        print("no atlas in the spec; bundled atlas files:", len(found))
        return 1 if found else 0
    want = base64.b64decode(png, validate=True)
    if len(found) != 2:
        print(f"expected an Android and an iOS atlas file, found {[str(f) for f in found]}")
        return 1
    bad = [str(f) for f in found if f.read_bytes() != want]
    print(json.dumps({"atlasSha256": hashlib.sha256(want).hexdigest(), "files": [str(f.relative_to(base)) for f in found], "differing": bad}))
    return 1 if bad else 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2]))
