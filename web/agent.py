from collections.abc import AsyncIterator

from agents import Agent, ModelSettings, Runner
from openai.types.responses import ResponseTextDeltaEvent

import config

BASE_INSTRUCTIONS = """You are a live assistant. You are given questions overheard from a conversation.
Answer concisely in 1-3 sentences unless the question clearly needs more.
Never mention that you are transcribing audio."""

CONTEXT_INSTRUCTIONS = """
The user has provided the CONTEXT below. If it is relevant to the question, base your answer on it.
If the context does not contain the answer, answer from general knowledge and start your answer with
"The provided context doesn't cover this, but" followed by the answer.

CONTEXT:
{context}"""


def build_instructions(context: str) -> str:
    context = context.strip()
    if not context:
        return BASE_INSTRUCTIONS
    return BASE_INSTRUCTIONS + "\n" + CONTEXT_INSTRUCTIONS.format(context=context)


def build_agent(context: str, model_settings: ModelSettings | None = None) -> Agent:
    return Agent(
        name="Live Q&A",
        instructions=build_instructions(context),
        model=config.ANSWER_MODEL,
        model_settings=model_settings or ModelSettings(),
    )


async def stream_answer(
    question: str, context: str = "", model_settings: ModelSettings | None = None
) -> AsyncIterator[str]:
    """Yield answer text deltas for a question, grounded in the given context."""
    result = Runner.run_streamed(build_agent(context, model_settings), input=question)
    async for event in result.stream_events():
        if event.type == "raw_response_event" and isinstance(event.data, ResponseTextDeltaEvent):
            yield event.data.delta
