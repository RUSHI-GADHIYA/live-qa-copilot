"""Live room-mode check: only the asker's questions become cards. Needs the app running; uses real OpenAI calls.

    python scripts/room_scenario.py [--url ws://localhost:8000]

Voice A (the asker) and voice B (the listener) are generated with TTS and streamed at real-time pace.
Voice B reads the app's own generated answer aloud, which must not create a card.
"""

import argparse
import asyncio
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402,F401  (loads .env)
from openai import AsyncOpenAI  # noqa: E402

from bench_latency import CHUNK, tts  # noqa: E402

CONTEXT = (
    "Acme Corp customer policy. Refunds: the refund window is 45 days from delivery, and refunds go back to the "
    "original payment method. Exchanges: allowed within 60 days of delivery, free of charge. "
    "Support hours: 9am to 5pm CET, Monday to Friday."
)
ASKER, LISTENER = "alloy", "onyx"


class App:
    def __init__(self, ws):
        self.ws = ws
        self.events: list[dict] = []
        self.mark = 0  # wait_for() looks at events from here: the start of the latest speech

    async def say(self, client: AsyncOpenAI, voice: str, text: str) -> float:
        clip = await tts(client, text, voice)
        self.mark = len(self.events)
        for off in range(0, len(clip), CHUNK):
            await self.ws.send(clip[off:off + CHUNK])
            await self.collect(0.1)
        return time.perf_counter()

    async def collect(self, seconds: float):
        end = time.perf_counter() + seconds
        while (left := end - time.perf_counter()) > 0:
            try:
                self.events.append(json.loads(await asyncio.wait_for(self.ws.recv(), left)))
            except asyncio.TimeoutError:
                return

    async def pump(self, seconds: float):
        """Stream silence (100 ms chunks) while collecting events."""
        end = time.perf_counter() + seconds
        while time.perf_counter() < end:
            await self.ws.send(b"\0" * CHUNK)
            await self.collect(0.1)

    async def wait_for(self, predicate, timeout: float = 12) -> dict | None:
        end = time.perf_counter() + timeout
        while time.perf_counter() < end:
            for event in self.events[self.mark:]:
                if predicate(event):
                    return event
            await self.pump(0.1)
        return None

    def answer(self, question_id: int) -> str:
        return "".join(e["delta"] for e in self.events if e["type"] == "answer_delta" and e["question_id"] == question_id)


def post_context(base: str):
    urllib.request.urlopen(urllib.request.Request(f"{base}/context", method="DELETE"))
    req = urllib.request.Request(
        f"{base}/context/text", data=json.dumps({"text": CONTEXT}).encode(), headers={"Content-Type": "application/json"}
    )
    urllib.request.urlopen(req)


async def main():
    import websockets

    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8000")
    base = parser.parse_args().url.rstrip("/")
    post_context(base)
    client = AsyncOpenAI()
    failures = []

    def check(name: str, ok: bool, detail: str = ""):
        print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}")
        if not ok:
            failures.append(name)

    async with websockets.connect(base.replace("http", "ws") + "/ws") as ws:
        app = App(ws)
        await ws.send(json.dumps({"type": "start"}))
        await app.wait_for(lambda e: e["type"] == "listening")

        # 1. The asker asks; a card appears and the answer streams.
        spoken_at = await app.say(client, ASKER, "What is the refund window for Acme orders?")
        card = await app.wait_for(lambda e: e["type"] == "question_detected")
        first = await app.wait_for(lambda e: e["type"] == "answer_delta")
        await app.wait_for(lambda e: e["type"] == "answer_done")
        answer = app.answer(1)
        check("asker question creates a card", card is not None, f"{answer!r}")
        if first:
            print(f"      speech end -> first answer text: {(time.perf_counter() - spoken_at) * 1000:.0f} ms (upper bound)")

        def no_new_card_and(reason: str):
            async def run(voice: str, text: str):
                before = sum(e["type"] == "question_detected" for e in app.events)
                await app.say(client, voice, text)
                ignored = await app.wait_for(lambda e: e["type"] == "utterance_ignored")
                await app.pump(2)
                after = sum(e["type"] == "question_detected" for e in app.events)
                got = ignored["reason"] if ignored else None
                check(f"{text[:50]!r} -> ignored ({reason})", after == before and got == reason, f"got {got!r}")
            return run

        # 2. The listener reads the generated answer aloud: filtered locally.
        await no_new_card_and("reading answer")(LISTENER, answer)
        # 3. The listener paraphrases, with a rhetorical question inside: the detector says it's not a question.
        await no_new_card_and("not a question")(
            LISTENER, "So basically you get about a month and a half. Why does that matter? Because nobody is rushed."
        )
        # 4. The asker asks for a repeat: no new card.
        await no_new_card_and("repeat")(ASKER, "Sorry, what was the refund window again?")

        # 5. A follow-up that only makes sense with history.
        await app.say(client, ASKER, "Is that the same for exchanges?")
        card = await app.wait_for(lambda e: e["type"] == "question_detected")
        await app.wait_for(lambda e: e["type"] == "answer_done")
        followup = app.answer(card["question_id"]) if card else ""
        check("follow-up creates a card", card is not None)
        check("follow-up resolved with history and context", "60" in followup, repr(followup))
        await ws.send(json.dumps({"type": "stop"}))

    print("\nAll checks passed." if not failures else f"\nFailed: {failures}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
