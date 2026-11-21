"""Every example demonstrates a real bug, so each one must FAIL with a RaceError."""
import os
import pathlib
import subprocess
import sys

import pytest

EXAMPLES = pathlib.Path(__file__).parent.parent / "examples"


@pytest.mark.parametrize("path", sorted(EXAMPLES.glob("test_*.py")), ids=lambda p: p.name)
def test_example_catches_its_race(path):
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(path)],
        capture_output=True,
        text=True,
        env={**os.environ, "NO_COLOR": "1"},
        timeout=120,
    )
    out = proc.stdout + proc.stderr
    assert proc.returncode == 1, out
    assert "RaceError" in out
    assert "⚡ overtook" in out
    assert 'Replay exactly: explore(fn, replay="' in out
