from typing import Literal

import config
from openai_client import get_client, reasoning_settings

Label = Literal["question", "repeat", "other"]

MIN_WORDS = 2

INSTRUCTIONS = """You label utterances overheard in a live conversation between an ASKER, who asks questions, and a LISTENER, who answers them, often by reading or paraphrasing the assistant's suggested answer aloud. Both may be picked up by the same microphone.

Label the LATEST utterance with exactly one letter:
Q - a new question or request for information from the asker that the assistant should answer. Includes implicit requests ("tell me about X", "I wonder how Y works") and follow-ups ("what about the second one?").
R - a repeat or rephrasing of a question already asked ("sorry, what was that?", "can you repeat the refund window?").
N - anything else: the listener answering or reading an answer (even if it contains rhetorical questions like "so why does that matter? because..."), statements, small talk, greetings, filler, social questions ("how are you?", "right?"), or fragments.

Reply with the single letter only."""

_LABELS: dict[str, Label] = {"Q": "question", "R": "repeat", "N": "other"}


def build_input(utterance: str, history: list[tuple[str, str]]) -> str:
    lines = ["Recent conversation:", *(f"{who}: {text}" for who, text in history), ""] if history else []
    lines.append(f"LATEST utterance: {utterance}")
    return "\n".join(lines)


async def classify(text: str, history: list[tuple[str, str]] | None = None) -> Label:
    """Label a finished utterance. A one-letter reply keeps this call close to the API's minimum latency."""
    text = text.strip()
    if len(text.split()) < MIN_WORDS:
        return "other"
    reasoning = reasoning_settings(config.DETECTOR_MODEL)
    response = await get_client().responses.create(
        model=config.DETECTOR_MODEL,
        instructions=INSTRUCTIONS,
        input=build_input(text, history or []),
        max_output_tokens=16,
        **({"reasoning": reasoning} if reasoning else {}),
    )
    return _LABELS.get(response.output_text.strip()[:1].upper(), "other")
