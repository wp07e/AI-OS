"""Pytest configuration for the Blender pipeline tests.

Adds the parent directory (where state.py / run.py live) to sys.path so tests
can `import state` the same way run.py does (run.py inserts its own dir).
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)  # container/blender/
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)
