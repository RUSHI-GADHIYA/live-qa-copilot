"""Live latency benchmark for each pipeline stage. Uses real OpenAI calls and costs a few cents per run.

    python scripts/bench_latency.py transcribe [--models gpt-4o-transcribe,gpt-live-transcribe]
    python scripts/bench_latency.py detector   [--models gpt-4o-mini,gpt-4.1-nano,gpt-5.4-nano]
    python scripts/bench_latency.py answer     [--models gpt-4o,gpt-4.1,gpt-5.4-mini]
    python scripts/bench_latency.py e2e        [--url ws://localhost:8000/ws]   (needs the app running)

Speech for the transcription stage is generated with TTS once and cached in scripts/.bench_cache/.
"""

import argparse
import asyncio
import re
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402  (loads .env)
from openai import AsyncOpenAI  # noqa: E402

CACHE = Path(__file__).parent / ".bench_cache"
CHUNK = 4800  # 100 ms of 24 kHz PCM16

SPEECH = [
    "What is the refund window for Acme orders?",
    "How does photosynthesis work?",
    "Can you explain the difference between a process and a thread?",
]

DETECTOR_CASES = [
    ("so um what is the refund window for acme", True),
    ("I wonder how photosynthesis actually works", True),
    ("can you explain what a vector database is", True),
    ("tell me about your experience with kubernetes", True),
    ("we should grab lunch after this meeting", False),
    ("hey how are you doing today", False),
    ("that's a good point, right?", False),
    ("the refund window is forty five days from delivery", False),
]

CONTEXT = "Acme Corp policy: the refund window is 45 days from delivery. Support hours are 9am-5pm CET."
ANSWER_QUESTIONS = ["What is the refund window?", "Who wrote Hamlet?", "When does support open?"]


def reasoning_kwargs(model: str) -> dict:
    return {"reasoning": {"effort": "none"}} if model.startswith("gpt-5") else {}


async def tts(client: AsyncOpenAI, text: str, voice: str = "alloy") -> bytes:
    CACHE.mkdir(exist_ok=True)
    path = CACHE / f"{voice}_{re.sub(r'[^a-z0-9]+', '_', text.lower())[:60]}.pcm"
    if not path.exists():
        r = await client.audio.speech.create(model="gpt-4o-mini-tts", voice=voice, input=text, response_format="pcm")
        path.write_bytes(r.content)
    return path.read_bytes()


def median_ms(values: list[float]) -> str:
    return f"{statistics.median(values) * 1000:6.0f} ms" if values else "   n/a"


async def bench_transcribe(client: AsyncOpenAI, models: list[str], vads: list[dict]):
    from transcriber import RealtimeTranscriber

    clips = [await tts(client, t) for t in SPEECH]
    for model in models:
        for vad in vads:
            finals: asyncio.Queue = asyncio.Queue()

            async def on_final(_id, text):
                await finals.put((time.perf_counter(), text))

            async def noop(*_):
                pass

            t = RealtimeTranscriber(noop, on_final, noop, model=model, turn_detection=vad)
            try:
                await t.start()
            except Exception as exc:
                print(f"{model:24} {vad_label(vad):22} ERROR {exc}")
                continue
            lags, texts = [], []
            for clip in clips:
                for off in range(0, len(clip), CHUNK):
                    await t.send_audio(clip[off:off + CHUNK])
                    await asyncio.sleep(0.1)
                speech_end = time.perf_counter()
                try:
                    for _ in range(40):  # keep streaming silence until the turn closes
                        await t.send_audio(b"\0" * CHUNK)
                        await asyncio.sleep(0.1)
                        if not finals.empty():
                            break
                    at, text = await asyncio.wait_for(finals.get(), 5)
                    lags.append(at - speech_end)
                    texts.append(text)
                except asyncio.TimeoutError:
                    texts.append("<timeout>")
            await t.close()
            print(f"{model:24} {vad_label(vad):22} speech end -> final: {median_ms(lags)}  | {texts}")


def vad_label(vad: dict) -> str:
    if vad["type"] == "semantic_vad":
        return f"semantic/{vad.get('eagerness', 'auto')}"
    return f"server/{vad.get('silence_duration_ms')}ms"


async def bench_detector(client: AsyncOpenAI, models: list[str], runs: int):
    from pydantic import BaseModel

    from detector import INSTRUCTIONS

    class Classification(BaseModel):
        is_question: bool
        cleaned_question: str

    for model in models:
        await client.responses.create(model=model, input="hi", max_output_tokens=16, **reasoning_kwargs(model))  # warm up
        latencies, correct = [], 0
        for run in range(runs):
            for text, want in DETECTOR_CASES:
                t0 = time.perf_counter()
                r = await client.responses.parse(
                    model=model, instructions=INSTRUCTIONS, input=text, text_format=Classification,
                    **reasoning_kwargs(model),
                )
                latencies.append(time.perf_counter() - t0)
                if run == 0:
                    correct += r.output_parsed.is_question == want
        print(f"{model:16} median {median_ms(latencies)}  p90 {sorted(latencies)[int(len(latencies) * .9)] * 1000:5.0f} ms"
              f"  accuracy {correct}/{len(DETECTOR_CASES)}")


async def bench_answer(models: list[str], runs: int):
    from agents import ModelSettings
    from openai.types.shared import Reasoning

    import agent

    for model in models:
        config.ANSWER_MODEL = model
        settings = ModelSettings(reasoning=Reasoning(effort="none")) if model.startswith("gpt-5") else ModelSettings()
        ttfts, answers = [], []
        for run in range(runs + 1):  # first run warms the connection and is not counted
            for q in ANSWER_QUESTIONS:
                t0 = time.perf_counter()
                first, text = None, ""
                async for delta in agent.stream_answer(q, CONTEXT, model_settings=settings):
                    first = first or time.perf_counter() - t0
                    text += delta
                if run > 0:
                    ttfts.append(first)
                if run == 1:
                    answers.append(text)
        print(f"{model:16} first token median {median_ms(ttfts)}")
        for q, a in zip(ANSWER_QUESTIONS, answers):
            print(f"    {q} -> {a}")


async def bench_e2e(client: AsyncOpenAI, url: str):
    """Speech -> running app over its WebSocket, at real-time pace. Measures what the user sees."""
    import json

    import websockets

    clips = [await tts(client, t) for t in SPEECH]
    to_card, to_token = [], []
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"type": "start"}))
        assert json.loads(await ws.recv())["active"], "transcription did not start"
        for text, clip in zip(SPEECH, clips):
            for off in range(0, len(clip), CHUNK):
                await ws.send(clip[off:off + CHUNK])
                await asyncio.sleep(0.1)
            speech_end = time.perf_counter()
            card_at = token_at = None
            deadline = speech_end + 10
            while token_at is None and time.perf_counter() < deadline:
                await ws.send(b"\0" * CHUNK)
                try:
                    event = json.loads(await asyncio.wait_for(ws.recv(), 0.1))
                except asyncio.TimeoutError:
                    continue
                if event["type"] == "question_detected":
                    card_at = time.perf_counter()
                elif event["type"] == "answer_delta" and card_at:
                    token_at = time.perf_counter()
            if token_at:
                to_card.append(card_at - speech_end)
                to_token.append(token_at - speech_end)
            print(f"  {text!r}: card {fmt(card_at, speech_end)}, first answer text {fmt(token_at, speech_end)}")
            await drain(ws, 3)
        await ws.send(json.dumps({"type": "stop"}))
    print(f"median speech end -> card {median_ms(to_card)}, -> first answer text {median_ms(to_token)}")


def fmt(at, since):
    return f"{(at - since) * 1000:.0f} ms" if at else "none"


async def drain(ws, seconds: float):
    """Let the current answer finish while feeding silence, so questions don't overlap."""
    end = time.perf_counter() + seconds
    while time.perf_counter() < end:
        await ws.send(b"\0" * CHUNK)
        try:
            await asyncio.wait_for(ws.recv(), 0.1)
        except asyncio.TimeoutError:
            pass


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["transcribe", "detector", "answer", "e2e"])
    parser.add_argument("--url", default="ws://localhost:8000/ws")
    parser.add_argument("--models")
    parser.add_argument("--runs", type=int, default=3)
    args = parser.parse_args()
    client = AsyncOpenAI()
    if args.stage == "transcribe":
        models = (args.models or "gpt-4o-transcribe,gpt-4o-mini-transcribe,gpt-live-transcribe").split(",")
        vads = [
            {"type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 300, "silence_duration_ms": 500},
            {"type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 300, "silence_duration_ms": 350},
            {"type": "semantic_vad", "eagerness": "high"},
        ]
        await bench_transcribe(client, models, vads)
    elif args.stage == "detector":
        await bench_detector(client, (args.models or "gpt-4o-mini,gpt-4.1-nano,gpt-5.4-nano").split(","), args.runs)
    elif args.stage == "e2e":
        await bench_e2e(client, args.url)
    else:
        await bench_answer((args.models or "gpt-4o,gpt-4.1,gpt-5.4-mini").split(","), args.runs)


if __name__ == "__main__":
    asyncio.run(main())
