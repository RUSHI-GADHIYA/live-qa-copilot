import re
import sys
import zlib
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import context_store  # noqa: E402

DIM = 512
STOP_WORDS = {"a", "an", "and", "are", "for", "how", "in", "is", "it", "long", "of", "on", "the", "to", "what"}


async def fake_embed(texts: list[str]) -> np.ndarray:
    """Deterministic bag-of-words vectors: texts sharing words are similar, like real embeddings."""
    vectors = np.zeros((len(texts), DIM), dtype=np.float32)
    for row, text in enumerate(texts):
        for word in set(re.findall(r"[a-z0-9]+", text.lower())) - STOP_WORDS:
            vectors[row, zlib.crc32(word.encode()) % DIM] += 1
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.where(norms == 0, 1, norms)


@pytest.fixture(autouse=True)
def no_real_openai(monkeypatch):
    """Tests never reach OpenAI: embeddings are faked, and a stray real call fails fast on a bogus key."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    monkeypatch.setattr(context_store, "embed", fake_embed)
