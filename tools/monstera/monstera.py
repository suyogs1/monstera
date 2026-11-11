#!/usr/bin/env python3
"""Entry point: python3 tools/monstera/monstera.py <command> ... (see `--help`)."""

import sys
from pathlib import Path

if sys.version_info < (3, 10):
    sys.exit("monstera requires Python 3.10 or newer")

sys.path.insert(0, str(Path(__file__).resolve().parent))

from monstera.cli import main  # noqa: E402

sys.exit(main())
