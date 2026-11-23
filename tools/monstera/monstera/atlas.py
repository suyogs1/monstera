"""The sprite atlas of a spec (contract section 10). Presentation only: nothing here is read by the simulation.

`game.atlas.png` holds standard base64 of one PNG. `atlas_bytes` decodes it strictly and `png_issues` checks that the PNG
is well formed (signature, chunk CRCs, one IHDR first, IDAT data that inflates to exactly the scanlines the header
declares, IEND last), 8-bit RGB or RGBA, not interlaced, and exactly columns*frameWidth by rows*frameHeight pixels.
The native apps draw the decoded file; a spec that passes here never hands a platform decoder a malformed image.
"""
from __future__ import annotations

import base64
import binascii
import struct
import zlib
from typing import Any

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
ATLAS_FILE = "monstera-atlas.png"
_CHANNELS = {2: 3, 6: 4}  # colour type -> channels (8-bit truecolour, truecolour with alpha)
MAX_INFLATED = 4 * 1024 * 1024  # 2048x512 RGBA plus filter bytes; the schema limits keep real atlases far below this


def atlas_bytes(atlas: dict[str, Any]) -> bytes | None:
    """The PNG bytes, or None when the spec has no atlas. Raises ValueError for text that is not strict base64."""
    text = atlas["png"]
    if text == "":
        return None
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f"not standard base64: {e}") from None


def png_issues(data: bytes, width: int, height: int) -> list[str]:
    """Reasons the bytes are not a well-formed width x height 8-bit RGB(A) PNG; empty when they are."""
    if not data.startswith(PNG_SIGNATURE):
        return ["the data is not a PNG (wrong signature)"]
    pos, chunks = len(PNG_SIGNATURE), []
    while pos < len(data):
        if pos + 12 > len(data):
            return ["a PNG chunk is truncated"]
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        end = pos + 12 + length
        if length > len(data) or end > len(data):
            return ["a PNG chunk is truncated"]
        body = data[pos + 8:pos + 8 + length]
        (crc,) = struct.unpack(">I", data[pos + 8 + length:end])
        if zlib.crc32(kind + body) & 0xFFFFFFFF != crc:
            return [f"PNG chunk {kind.decode('latin-1')!r} has a wrong CRC"]
        chunks.append((kind, body))
        pos = end
        if kind == b"IEND":
            break
    if pos != len(data):
        return ["the PNG has data after IEND"]
    if not chunks or chunks[0][0] != b"IHDR" or len(chunks[0][1]) != 13:
        return ["the PNG does not start with a valid IHDR chunk"]
    if chunks[-1][0] != b"IEND":
        return ["the PNG has no IEND chunk"]
    w, h, depth, colour, compression, filt, interlace = struct.unpack(">IIBBBBB", chunks[0][1])
    issues = []
    if depth != 8 or colour not in _CHANNELS:
        issues.append(f"the PNG is bit depth {depth}, colour type {colour}; only 8-bit RGB (2) or RGBA (6) is accepted")
    if compression != 0 or filt != 0 or interlace != 0:
        issues.append("the PNG must use standard compression and filtering and no interlacing")
    if (w, h) != (width, height):
        issues.append(f"the PNG is {w}x{h} pixels; columns*frameWidth x rows*frameHeight is {width}x{height}")
    if issues:
        return issues
    idat = b"".join(body for kind, body in chunks if kind == b"IDAT")
    expected = h * (1 + w * _CHANNELS[colour])
    try:
        d = zlib.decompressobj()
        raw = d.decompress(idat, MAX_INFLATED + 1)
        if not d.eof or d.unconsumed_tail or len(raw) > MAX_INFLATED:
            return ["the PNG image data is truncated or too large"]
    except zlib.error:
        return ["the PNG image data does not inflate"]
    if len(raw) != expected:
        return [f"the PNG image data is {len(raw)} bytes, its header needs {expected}"]
    if any(f > 4 for f in raw[::expected // h]):  # the filter byte that starts each scanline
        return ["the PNG uses an unknown scanline filter"]
    return []
