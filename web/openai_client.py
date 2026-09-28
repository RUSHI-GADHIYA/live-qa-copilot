from agents import set_default_openai_client
from openai import AsyncOpenAI

_client: AsyncOpenAI | None = None


def get_client() -> AsyncOpenAI:
    """One shared client, so the detector, embeddings and answers reuse warm connections."""
    global _client
    if _client is None:
        _client = AsyncOpenAI()
        set_default_openai_client(_client)
    return _client


def reasoning_settings(model: str) -> dict | None:
    """gpt-5.x / o-series models reason by default; for live answers we want the fastest setting."""
    if model.startswith(("gpt-5", "o")):
        return {"effort": "none" if model.startswith("gpt-5") else "low"}
    return None
