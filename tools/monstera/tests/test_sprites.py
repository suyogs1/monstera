"""Gate E1: the sprite atlas and kind sprites (contract section 10).

Validation of the embedded PNG and of frame references, the bundled resource on both platforms, and validator mutants that
these cases must kill. Oracle invariance is proven in test_presentation.py (atlas and sprite are deleted by strip_unread and
changed by visual_variant, and every scenario still reproduces its recorded checkpoints).
"""
from __future__ import annotations

import base64
import copy
import struct
import sys
import types
import unittest
import zlib
from pathlib import Path

from monstera import generate
from monstera.atlas import ATLAS_FILE, atlas_bytes, png_issues
from monstera.cli import DEFAULT_SCHEMAS
from monstera.jsonio import load_path
from monstera.schema import SchemaStore
from monstera.validate import validate_value

REPO = Path(__file__).resolve().parents[3]
STORE = SchemaStore.load(DEFAULT_SCHEMAS)
SAMPLE = REPO / "spec" / "samples" / "monstera-sample" / "monstera.spec.json"
GAMES = {g: REPO / "apps" / g / "monstera.spec.json" for g in ("pumpkin-blaster", "trick-or-treat-rush")}
PACKAGE = Path(__file__).resolve().parents[1] / "monstera"


def chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def make_png(width: int, height: int, *, depth: int = 8, colour: int = 6, raw: bytes | None = None, interlace: int = 0) -> bytes:
    channels = {2: 3, 6: 4}.get(colour, 4)
    if raw is None:
        raw = b"".join(b"\x00" + bytes(range(width * channels)) for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, depth, colour, 0, 0, interlace))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def with_atlas(png: bytes | str, columns: int = 2, rows: int = 1, frame: int = 4, sprites=None) -> dict:
    spec = load_path(SAMPLE)
    text = png if isinstance(png, str) else base64.b64encode(png).decode("ascii")
    spec["game"]["atlas"] = {"png": text, "frameWidth": frame, "frameHeight": frame, "columns": columns, "rows": rows}
    for i, kind in enumerate(spec["game"]["runtime"]["kinds"]):
        kind["sprite"] = (sprites or {}).get(i, {"frames": [0], "ticksPerFrame": 1})
    return spec


def codes(spec: dict) -> list[tuple[str, str]]:
    return [(i.path, i.code) for i in validate_value(spec, STORE).issues]


class AtlasValidationTests(unittest.TestCase):
    def test_both_games_have_a_real_atlas_and_animate_at_most_two_kinds(self) -> None:
        for game, path in GAMES.items():
            spec = load_path(path)
            self.assertEqual(codes(spec), [], game)
            atlas = spec["game"]["atlas"]
            data = atlas_bytes(atlas)
            self.assertIsNotNone(data, game)
            self.assertEqual(png_issues(data, atlas["columns"] * atlas["frameWidth"], atlas["rows"] * atlas["frameHeight"]), [])
            sprites = [k["sprite"]["frames"] for k in spec["game"]["runtime"]["kinds"]]
            self.assertGreaterEqual(sum(1 for f in sprites if f), 4, f"{game}: most kinds are drawn from the atlas")
            animated = sum(1 for f in sprites if len(f) > 1)
            self.assertTrue(1 <= animated <= 2, game)
            # The committed art file is the same bytes as the spec (assets/sprites/make_atlases.py writes both).
            self.assertEqual((REPO / "assets" / "sprites" / f"{game}-atlas.png").read_bytes(), data, game)

    def test_a_well_formed_atlas_and_still_and_animated_sprites_are_accepted(self) -> None:
        spec = with_atlas(make_png(8, 4), sprites={0: {"frames": [0, 1], "ticksPerFrame": 6}})
        self.assertEqual(codes(spec), [])
        self.assertEqual(codes(with_atlas(make_png(8, 4, colour=2))), [])  # RGB is accepted too

    def test_malformed_pngs_are_refused_with_the_reason(self) -> None:
        good = make_png(8, 4)
        bad_crc = bytearray(good)
        bad_crc[29] ^= 0xFF  # inside the IHDR CRC
        cases = {
            "signature": b"\x89PNX" + good[4:],
            "chunk CRC": bytes(bad_crc),
            "truncated": good[:-6],
            "data after IEND": good + b"x",
            "16-bit": make_png(8, 4, depth=16),
            "palette": make_png(8, 4, colour=3),
            "interlaced": make_png(8, 4, interlace=1),
            "wrong size": make_png(8, 8),
            "short image data": make_png(8, 4, raw=b"\x00" * 10),
            "unknown filter": make_png(8, 4, raw=b"".join(b"\x07" + bytes(32) for _ in range(4))),
        }
        for label, data in cases.items():
            self.assertIn(("$.game.atlas.png", "semantic.atlas-png"), codes(with_atlas(data)), label)

    def test_chunk_order_and_stream_rules(self) -> None:
        good = make_png(8, 4)
        ihdr = good[8:33]  # length, type, 13 bytes, CRC
        rest = good[33:]
        raw = b"".join(b"\x00" + bytes(range(32)) for _ in range(4))
        comp = zlib.compress(raw)
        half = len(comp) // 2
        text = chunk(b"tEXt", b"k\x00v")
        cases = {
            "duplicate IHDR": good[:33] + ihdr + rest,
            "IDAT not consecutive": good[:33] + chunk(b"IDAT", comp[:half]) + text + chunk(b"IDAT", comp[half:]) + chunk(b"IEND", b""),
            "bytes after the zlib stream": good[:33] + chunk(b"IDAT", comp + b"\x00\x01") + chunk(b"IEND", b""),
        }
        expect = {"duplicate IHDR": "more than one IHDR", "IDAT not consecutive": "not consecutive",
                  "bytes after the zlib stream": "after the end of its compressed stream"}
        for label, data in cases.items():
            found = png_issues(data, 8, 4)
            self.assertTrue(found and expect[label] in found[0], f"{label}: {found}")
        split = good[:33] + chunk(b"IDAT", comp[:half]) + chunk(b"IDAT", comp[half:]) + chunk(b"IEND", b"")
        self.assertEqual(png_issues(split, 8, 4), [])  # consecutive IDAT chunks are one stream

    def test_the_documented_inflate_limit_is_checked_from_the_header(self) -> None:
        from monstera import atlas
        # A header whose scanlines exceed MAX_INFLATED is refused before inflating (the schema keeps real atlases far below it).
        found = png_issues(make_png(1100, 1000, raw=b"\x00"), 1100, 1000)
        self.assertTrue(found and str(atlas.MAX_INFLATED) in found[0], found)

    def test_text_that_is_not_strict_base64_is_refused_by_the_schema(self) -> None:
        for text in ("abc", "ab=c", "a b=", "iVBORw0KGgo\n"):
            self.assertIn(("$.game.atlas.png", "pattern"), codes(with_atlas(text)), repr(text))
        self.assertIn(("$.game.atlas.png", "maxLength"), codes(with_atlas("A" * 24580)))

    def test_frames_must_exist_need_an_atlas_and_at_most_two_kinds_animate(self) -> None:
        spec = with_atlas(make_png(8, 4), sprites={0: {"frames": [0, 2], "ticksPerFrame": 1}})
        self.assertIn(("$.game.runtime.kinds[0].sprite.frames[1]", "semantic.sprite-frame"), codes(spec))
        spec = load_path(SAMPLE)
        spec["game"]["runtime"]["kinds"][0]["sprite"] = {"frames": [0], "ticksPerFrame": 1}
        self.assertIn(("$.game.runtime.kinds[0].sprite.frames", "semantic.sprite-without-atlas"), codes(spec))
        two = {0: {"frames": [0, 1], "ticksPerFrame": 2}, 1: {"frames": [1, 0], "ticksPerFrame": 2}}
        self.assertEqual(codes(with_atlas(make_png(8, 4), sprites=two)), [])
        three = {**two, 2: {"frames": [0, 1], "ticksPerFrame": 2}}
        self.assertIn(("$.game.runtime.kinds", "semantic.sprite-animations"), codes(with_atlas(make_png(8, 4), sprites=three)))
        five = {0: {"frames": [0, 1, 0, 1, 0], "ticksPerFrame": 1}}
        self.assertIn(("$.game.runtime.kinds[0].sprite.frames", "maxItems"), codes(with_atlas(make_png(8, 4), sprites=five)))
        zero = {0: {"frames": [0], "ticksPerFrame": 0}}
        self.assertIn(("$.game.runtime.kinds[0].sprite.ticksPerFrame", "minimum"), codes(with_atlas(make_png(8, 4), sprites=zero)))


class BundlingTests(unittest.TestCase):
    def plan(self, spec: dict, layout: str = "app") -> dict[str, generate.OutFile]:
        return {f.path: f for f in generate.plan(spec, "monstera.spec.json", STORE, layout=layout)}

    def test_the_decoded_atlas_is_bundled_unchanged_on_both_platforms(self) -> None:
        for game, path in GAMES.items():
            spec = load_path(path)
            files = self.plan(spec)
            data = atlas_bytes(spec["game"]["atlas"])
            product = next(p.split("/")[2] for p in files if p.startswith("ios/Sources/"))
            android = files[f"android/app/src/main/assets/{ATLAS_FILE}"]
            ios = files[f"ios/Sources/{product}/Resources/{ATLAS_FILE}"]
            self.assertEqual((android.data, ios.data, android.kind, android.mode), (data, data, "asset", 0o644), game)
            self.assertIn(f'.copy("Resources/{ATLAS_FILE}")', files["ios/Package.swift"].data.decode(), game)

    def test_no_atlas_means_no_resource_and_the_old_package_resources(self) -> None:
        files = self.plan(load_path(SAMPLE), layout="fixture")
        self.assertFalse(any(p.endswith(ATLAS_FILE) for p in files))
        self.assertIn('resources: [.copy("Resources/monstera.spec.json")]', files["ios/Package.swift"].data.decode())

    def test_generation_is_deterministic(self) -> None:
        spec = load_path(GAMES["pumpkin-blaster"])
        a, b = self.plan(spec), self.plan(copy.deepcopy(spec))
        self.assertEqual({p: f.data for p, f in a.items()}, {p: f.data for p, f in b.items()})


# Validator mutants: each one is a plausible mistake in atlas.py or semantic.py; the cases above must reject what it accepts.
MUTANTS = [
    ("frame bound off by one", "semantic.py", "if frame >= count:", "if frame > count:"),
    ("size check ignores height", "atlas.py", "if (w, h) != (width, height):", "if w != width:"),
    ("CRC not checked", "atlas.py", "if zlib.crc32(kind + body) & 0xFFFFFFFF != crc:", "if False:"),
    ("trailing data accepted", "atlas.py", "if pos != len(data):", "if False:"),
    ("16-bit accepted", "atlas.py", "if depth != 8 or colour not in _CHANNELS:", "if colour not in _CHANNELS:"),
    ("short data accepted", "atlas.py", "if len(raw) != expected:", "if len(raw) > expected:"),
    ("frames without an atlas accepted", "semantic.py", "if frames and data is None:", "if False:"),
    ("three animations accepted", "semantic.py", "if len(animated) > MAX_ANIMATIONS:", "if len(animated) > MAX_ANIMATIONS + 1:"),
]


def mutated_validate(file: str, old: str, new: str):
    """validate_value with one mutated module, loaded under a private package name so the real modules stay intact."""
    name = "monstera_mutant"
    pkg = types.ModuleType(name)
    pkg.__path__ = [str(PACKAGE)]
    saved = {k: v for k, v in sys.modules.items() if k == name or k.startswith(name + ".")}
    for k in saved:
        del sys.modules[k]
    sys.modules[name] = pkg
    try:
        import importlib
        for mod in ("atlas", "semantic"):
            src = (PACKAGE / f"{mod}.py").read_text(encoding="utf-8")
            if f"{mod}.py" == file:
                if src.count(old) != 1:
                    raise AssertionError(f"mutant text not found once in {file}: {old!r}")
                src = src.replace(old, new)
            m = types.ModuleType(f"{name}.{mod}")
            m.__package__ = name
            sys.modules[m.__name__] = m
            if mod == "semantic":  # semantic imports .naming and .schema too; reuse the real ones
                sys.modules[f"{name}.naming"] = importlib.import_module("monstera.naming")
                sys.modules[f"{name}.schema"] = importlib.import_module("monstera.schema")
            exec(compile(src, f"{name}/{mod}.py", "exec"), m.__dict__)
        return sys.modules[f"{name}.semantic"].validate
    finally:
        for k in [k for k in sys.modules if k == name or k.startswith(name + ".")]:
            del sys.modules[k]
        sys.modules.update(saved)


class ValidatorMutantTests(unittest.TestCase):
    CASES = {
        "frame bound off by one": with_atlas(make_png(8, 4), sprites={0: {"frames": [2], "ticksPerFrame": 1}}),
        "size check ignores height": with_atlas(make_png(8, 8)),
        "CRC not checked": with_atlas(bytes(b ^ 0xFF if i == 29 else b for i, b in enumerate(make_png(8, 4)))),
        "trailing data accepted": with_atlas(make_png(8, 4) + b"x"),
        "16-bit accepted": with_atlas(make_png(8, 4, depth=16)),
        "short data accepted": with_atlas(make_png(8, 4, raw=b"\x00" * 10)),
        "three animations accepted": with_atlas(make_png(8, 4), sprites={i: {"frames": [0, 1], "ticksPerFrame": 2} for i in range(3)}),
    }

    def test_every_validator_mutant_is_killed(self) -> None:
        no_atlas = load_path(SAMPLE)
        no_atlas["game"]["runtime"]["kinds"][0]["sprite"] = {"frames": [0], "ticksPerFrame": 1}
        cases = {**self.CASES, "frames without an atlas accepted": no_atlas}
        from monstera.semantic import validate as real
        for name, file, old, new in MUTANTS:
            spec = cases[name]
            self.assertTrue(real(spec), f"{name}: the real validator must reject this case")
            self.assertEqual(mutated_validate(file, old, new)(spec), [], f"mutant '{name}' survived: the case does not isolate it")


if __name__ == "__main__":
    unittest.main()
