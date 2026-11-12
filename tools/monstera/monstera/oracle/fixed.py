"""Q16.16 fixed point with saturation. Contract: architecture/RUNTIME-CONTRACT.md section 2.

A value is a Python int holding the raw Q16.16 number. Every result is saturated to
[RAW_MIN, RAW_MAX] so products always fit a signed 64-bit integer (|a*b| <= 2^62).
"""

FRAC_BITS = 16
ONE = 1 << FRAC_BITS
RAW_MIN = -(1 << 31)
RAW_MAX = (1 << 31) - 1
I32_MIN = -(1 << 31)
I32_MAX = (1 << 31) - 1


def sat(v: int) -> int:
    """Saturate any integer to the Q16.16 raw range."""
    return RAW_MIN if v < RAW_MIN else RAW_MAX if v > RAW_MAX else v


def sat32(v: int) -> int:
    """Saturate an exact integer sum to int32 (score and lives counters)."""
    return I32_MIN if v < I32_MIN else I32_MAX if v > I32_MAX else v


def add(a: int, b: int) -> int:
    return sat(sat(a) + sat(b))


def sub(a: int, b: int) -> int:
    return sat(sat(a) - sat(b))


def neg(a: int) -> int:
    return sat(-sat(a))


def mul(a: int, b: int) -> int:
    """(a*b) >> 16 with an arithmetic shift, i.e. rounds toward negative infinity."""
    return sat((sat(a) * sat(b)) >> FRAC_BITS)


def div(a: int, b: int) -> int:
    """trunc((a << 16) / b), rounding toward zero. Division by zero never traps:
    it saturates by the sign of the dividend (0 / 0 is 0)."""
    a, b = sat(a), sat(b)
    if b == 0:
        return RAW_MAX if a > 0 else RAW_MIN if a < 0 else 0
    n = a << FRAC_BITS
    q = abs(n) // abs(b)
    return sat(q if (n < 0) == (b < 0) else -q)


def clamp(v: int, lo: int, hi: int) -> int:
    return lo if v < lo else hi if v > hi else v
