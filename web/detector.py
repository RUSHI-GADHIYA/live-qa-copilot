from openai import AsyncOpenAI
from pydantic import BaseModel

import config

MIN_WORDS = 3

INSTRUCTIONS = """You classify utterances overheard in a live conversation.
Decide whether the utterance is a genuine question (or request for information) that an assistant should answer.
Treat implicit questions as questions too, e.g. "I wonder how X works" or "tell me about Y".
Not questions: statements, greetings, filler, rhetorical or social questions ("how are you?", "right?", "you know?"),
and fragments too incomplete to answer.
If it is a question, return cleaned_question: the question rewritten clearly, with filler words and transcription
noise removed and the meaning unchanged. Otherwise return an empty cleaned_question."""


class Classification(BaseModel):
    is_question: bool
    cleaned_question: str


_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI()
    return _client


async def classify(text: str) -> tuple[bool, str]:
    """Return (is_question, cleaned_question) for a finished utterance."""
    text = text.strip()
    if len(text.split()) < MIN_WORDS:
        return False, ""
    response = await _get_client().responses.parse(
        model=config.DETECTOR_MODEL,
        instructions=INSTRUCTIONS,
        input=text,
        text_format=Classification,
    )
    result = response.output_parsed
    if result is None or not result.is_question:
        return False, ""
    return True, result.cleaned_question.strip() or text
