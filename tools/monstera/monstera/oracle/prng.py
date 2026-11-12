"""PCG32 (XSH-RR), SplitMix64 stream derivation and FNV-1a 64. Contract: RUNTIME-CONTRACT.md section 3."""

M64 = (1 << 64) - 1
M32 = (1 << 32) - 1
PCG_MULT = 6364136223846793005
SPLITMIX_GAMMA = 0x9E3779B97F4A7C15
FNV_OFFSET = 0xCBF29CE484222325
FNV_PRIME = 0x100000001B3


def fnv1a64(data: bytes, h: int = FNV_OFFSET) -> int:
    for byte in data:
        h = ((h ^ byte) * FNV_PRIME) & M64
    return h


def splitmix64_next(state: int) -> "tuple[int, int]":
    """Returns (new_state, output)."""
    state = (state + SPLITMIX_GAMMA) & M64
    z = state
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & M64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & M64
    return state, z ^ (z >> 31)


class Pcg32:
    __slots__ = ("state", "inc")

    def __init__(self, initstate: int, initseq: int) -> None:
        """Reference pcg32_srandom_r."""
        self.state = 0
        self.inc = ((initseq << 1) | 1) & M64
        self.next_u32()
        self.state = (self.state + initstate) & M64
        self.next_u32()

    @classmethod
    def for_stream(cls, seed: int, name: str) -> "Pcg32":
        """Named independent stream: SplitMix64 seeded with seed XOR fnv1a64(utf8(name))."""
        sm = (seed ^ fnv1a64(name.encode("utf-8"))) & M64
        sm, initstate = splitmix64_next(sm)
        sm, initseq = splitmix64_next(sm)
        return cls(initstate, initseq)

    def next_u32(self) -> int:
        old = self.state
        self.state = (old * PCG_MULT + self.inc) & M64
        xorshifted = (((old >> 18) ^ old) >> 27) & M32
        rot = old >> 59
        return ((xorshifted >> rot) | (xorshifted << ((-rot) & 31))) & M32

    def next_below(self, bound: int) -> int:
        """Unbiased value in [0, bound) for 1 <= bound <= 2^32 - 1 (reference pcg32_boundedrand_r)."""
        threshold = ((M32 + 1 - bound) & M32) % bound
        while True:
            r = self.next_u32()
            if r >= threshold:
                return r % bound
