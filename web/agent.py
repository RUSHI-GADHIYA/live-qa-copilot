from collections.abc import AsyncIterator

from agents import Agent, ModelSettings, Runner
from openai.types.responses import ResponseTextDeltaEvent
from openai.types.shared import Reasoning

import config
from context_store import Passage
from openai_client import get_client, reasoning_settings

BASE_INSTRUCTIONS = """You are a live assistant. You receive questions overheard in a conversation, and your answer is shown on screen to the person being asked, who may say it aloud.
Answer concisely in 1-3 sentences unless the question clearly needs more. Write the answer itself, with no preamble.
If the question is addressed to that person (their experience, work, opinions), answer in the first person as them.
Never invent facts about that person: employers, projects, years, numbers or experiences must come from the CONTEXT.
If the CONTEXT says nothing about them on the topic, reply only with a short note for them that starts with
"Not in your notes:" and names what is missing, optionally followed by one or two general talking points.
Never mention that you are transcribing audio."""

CONTEXT_INSTRUCTIONS = """
Base your answer on the numbered CONTEXT passages below whenever they are relevant.
When a sentence uses a passage, end the sentence with its number in brackets, e.g. [2]. Only cite passages that support the sentence.
If the passages do not contain the answer, answer from general knowledge and do not cite anything.

CONTEXT:
{passages}"""


def build_instructions(passages: list[Passage]) -> str:
    if not passages:
        return BASE_INSTRUCTIONS
    body = "\n\n".join(f"[{p.n}] ({p.doc_name})\n{p.text}" for p in passages)
    return BASE_INSTRUCTIONS + "\n" + CONTEXT_INSTRUCTIONS.format(passages=body)


def default_model_settings() -> ModelSettings:
    reasoning = reasoning_settings(config.ANSWER_MODEL)
    return ModelSettings(reasoning=Reasoning(**reasoning)) if reasoning else ModelSettings()


def build_agent(passages: list[Passage], model_settings: ModelSettings | None = None) -> Agent:
    get_client()  # registers the shared client with the Agents SDK
    return Agent(
        name="Live Q&A",
        instructions=build_instructions(passages),
        model=config.ANSWER_MODEL,
        model_settings=model_settings or default_model_settings(),
    )


async def stream_answer(
    question: str,
    passages: list[Passage] | None = None,
    history: list[dict] | None = None,
    model_settings: ModelSettings | None = None,
) -> AsyncIterator[str]:
    """Yield answer text deltas for a question, grounded in the passages and earlier exchanges."""
    # Instructions + context come first and history + question last, so prompt caching can reuse the prefix.
    question_input = [*history, {"role": "user", "content": question}] if history else question
    result = Runner.run_streamed(build_agent(passages or [], model_settings), input=question_input)
    async for event in result.stream_events():
        if event.type == "raw_response_event" and isinstance(event.data, ResponseTextDeltaEvent):
            yield event.data.delta
