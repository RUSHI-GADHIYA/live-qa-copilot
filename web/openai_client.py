import asyncio

import httpx2
from agents import set_default_openai_client
from openai import AsyncOpenAI, DefaultAsyncHttpx2Client

import config

# The SDK drops idle connections after 5 s; a fresh TLS handshake then adds ~0.5 s to the next question.
# Real conversations have longer gaps than that, so keep connections open much longer.
KEEPALIVE_S = 120
WARM_CONNECTIONS = 2  # the detector and the answer run at the same time

_client: AsyncOpenAI | None = None


def get_client() -> AsyncOpenAI:
    """One shared client, so the detector, embeddings and answers reuse warm connections."""
    global _client
    if _client is None:
        limits = httpx2.Limits(max_connections=100, max_keepalive_connections=20, keepalive_expiry=KEEPALIVE_S)
        _client = AsyncOpenAI(http_client=DefaultAsyncHttpx2Client(limits=limits))
        set_default_openai_client(_client)
    return _client


async def warm_connections() -> None:
    """Open (or keep open) enough connections for a detector call and an answer in parallel. Free: no tokens."""
    client = get_client()
    await asyncio.gather(
        *(client.models.retrieve(config.DETECTOR_MODEL) for _ in range(WARM_CONNECTIONS)), return_exceptions=True
    )


def reasoning_settings(model: str) -> dict | None:
    """gpt-5.x / o-series models reason by default; for live answers we want the fastest setting."""
    if model.startswith(("gpt-5", "o")):
        return {"effort": "none" if model.startswith("gpt-5") else "low"}
    return None
