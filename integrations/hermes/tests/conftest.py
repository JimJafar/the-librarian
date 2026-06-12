"""Test bootstrap + shared fakes. No network anywhere in this suite.

The package under test is the plain package dir ``librarian/`` one level up;
``pyproject.toml`` already puts it on ``pythonpath`` for pytest ≥ 7, and the
sys.path inserts below make the tests (and the ``_helpers`` module beside this
file) importable regardless of how pytest is invoked.
"""

from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent

# The package root (so `import librarian.provider` works) and the tests dir
# (so `from _helpers import FakeClient` works under --import-mode=importlib).
for path in (str(_HERE.parent), str(_HERE)):
    if path not in sys.path:
        sys.path.insert(0, path)
