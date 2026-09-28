import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture(autouse=True)
def no_real_openai(monkeypatch):
    """Tests never reach OpenAI: a stray real call fails fast on a bogus key."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
