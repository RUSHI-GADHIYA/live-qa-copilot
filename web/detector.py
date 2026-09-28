from pydantic import BaseModel

import config
from openai_client import get_client, reasoning_settings

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


async def classify(text: str) -> tuple[bool, str]:
    """Return (is_question, cleaned_question) for a finished utterance."""
    text = text.strip()
    if len(text.split()) < MIN_WORDS:
        return False, ""
    reasoning = reasoning_settings(config.DETECTOR_MODEL)
    response = await get_client().responses.parse(
        model=config.DETECTOR_MODEL,
        instructions=INSTRUCTIONS,
        input=text,
        text_format=Classification,
        **({"reasoning": reasoning} if reasoning else {}),
    )
    result = response.output_parsed
    if result is None or not result.is_question:
        return False, ""
    return True, result.cleaned_question.strip() or text
