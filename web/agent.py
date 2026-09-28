from collections.abc import AsyncIterator

from agents import Agent, Runner
from openai.types.responses import ResponseTextDeltaEvent

import config

INSTRUCTIONS = """You are a live assistant. You are given questions overheard from a conversation.
Answer concisely in 1-3 sentences unless the question clearly needs more.
If CONTEXT is provided below, prioritize it. If the answer is not in the context,
answer from general knowledge and say the context did not cover it.
Never mention that you are transcribing audio.

CONTEXT:
{context}"""


def build_agent(context: str) -> Agent:
    return Agent(
        name="Live Q&A",
        instructions=INSTRUCTIONS.format(context=context.strip() or "(none provided)"),
        model=config.ANSWER_MODEL,
    )


async def stream_answer(question: str, context: str = "") -> AsyncIterator[str]:
    """Yield answer text deltas for a question, grounded in the given context."""
    result = Runner.run_streamed(build_agent(context), input=question)
    async for event in result.stream_events():
        if event.type == "raw_response_event" and isinstance(event.data, ResponseTextDeltaEvent):
            yield event.data.delta
