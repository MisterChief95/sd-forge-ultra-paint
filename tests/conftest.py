"""pytest bootstrap for the Ultra Paint backend test suite.

This is the first Python test infra anywhere in this repo (see PLAN.md's
Phase 3 task table, T25) -- there is no shared root `conftest.py`/`pytest.ini`
to inherit from. Puts the extension root (the directory containing
`ultra_paint/`) on `sys.path` so `import ultra_paint.<module>` works
regardless of the directory pytest is invoked from.
"""

import sys
from pathlib import Path

EXTENSION_ROOT = Path(__file__).resolve().parent.parent
if str(EXTENSION_ROOT) not in sys.path:
    sys.path.insert(0, str(EXTENSION_ROOT))
