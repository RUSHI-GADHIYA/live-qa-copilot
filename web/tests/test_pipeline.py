import asyncio

import pytest
from fastapi.testclient import TestClient

import config
import server


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(server, "answer_slots", asyncio.Semaphore(config.MAX_CONCURRENT_ANSWERS))
    server.context.clear()
    return TestClient(server.app)


def collect(ws, until_done: int):
    events, done = [], 0
    while done < until_done:
        event = ws.receive_json()
        events.append(event)
        done += event["type"] == "answer_done"
    return events


def answer_text(events):
    text = {}
    for e in events:
        if e["type"] == "answer_delta":
            text[e["question_id"]] = text.get(e["question_id"], "") + e["delta"]
    return text


def test_answers_stream_into_their_own_cards(client, monkeypatch):
    async def fake_stream(q, context=""):
        for word in ["ans", "-", q]:
            await asyncio.sleep(0.3 if "slow" in q else 0.01)
            yield word

    monkeypatch.setattr(server, "stream_answer", fake_stream)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "ask", "text": "slow one"})
        ws.send_json({"type": "ask", "text": "fast two"})
        events = collect(ws, 2)
    assert [e["question_id"] for e in events if e["type"] == "answer_done"] == [2, 1]
    assert answer_text(events) == {1: "ans-slow one", 2: "ans-fast two"}


def test_cards_follow_utterance_order_and_skip_non_questions(client, monkeypatch):
    async def fake_classify(text):
        if "boom" in text:
            raise RuntimeError("api down")
        await asyncio.sleep(0.3 if "first" in text else 0.01)
        return "?" in text, text.upper()

    async def fake_stream(q, context=""):
        yield "a:" + q

    monkeypatch.setattr(server, "classify", fake_classify)
    monkeypatch.setattr(server, "stream_answer", fake_stream)
    with client.websocket_connect("/ws") as ws:
        for text in ["first slow question?", "just a statement", "boom", "second quick one?"]:
            ws.send_json({"type": "utterance", "text": text})
        events = collect(ws, 2)
    cards = [(e["question_id"], e["text"]) for e in events if e["type"] == "question_detected"]
    assert cards == [(1, "FIRST SLOW QUESTION?"), (2, "SECOND QUICK ONE?")]
    assert any(e["type"] == "error" and "api down" in e["message"] for e in events)


@pytest.mark.parametrize("speculative", [True, False])
def test_speculative_answer_is_hidden_until_confirmed(client, monkeypatch, speculative):
    started = []

    async def fake_classify(text):
        await asyncio.sleep(0.2)  # the answer streams fully before the detector decides
        return "?" in text, text

    async def fake_stream(q, context=""):
        started.append(q)
        for word in ["one ", "two ", "three"]:
            yield word

    monkeypatch.setattr(config, "SPECULATIVE_ANSWERS", speculative)
    monkeypatch.setattr(server, "classify", fake_classify)
    monkeypatch.setattr(server, "stream_answer", fake_stream)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "utterance", "text": "not a question"})
        ws.send_json({"type": "utterance", "text": "is it?"})
        events = collect(ws, 1)
    types = [e["type"] for e in events]
    assert types[0] == "question_detected"  # no text leaks before the card exists
    assert answer_text(events) == {1: "one two three"}
    assert started == (["not a question", "is it?"] if speculative else ["is it?"])


def test_rejected_speculation_is_cancelled(client, monkeypatch):
    cancelled = asyncio.Event()

    async def fake_classify(text):
        await asyncio.sleep(0.05)
        return False, ""

    async def fake_stream(q, context=""):
        try:
            while True:
                await asyncio.sleep(0.01)
                yield "x"
        except (asyncio.CancelledError, GeneratorExit):
            cancelled.set()
            raise

    monkeypatch.setattr(config, "SPECULATIVE_ANSWERS", True)
    monkeypatch.setattr(server, "classify", fake_classify)
    monkeypatch.setattr(server, "stream_answer", fake_stream)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "utterance", "text": "we should grab lunch"})
        ws.send_json({"type": "ask", "text": "marker"})
        first = ws.receive_json()
    assert first == {"type": "question_detected", "question_id": 1, "text": "marker"}
    assert cancelled.is_set()


def test_concurrency_cap_and_order(client, monkeypatch):
    active = peak = 0

    async def fake_stream(q, context=""):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        try:
            for _ in range(3):
                await asyncio.sleep(0.05)
                yield q[-1]
        finally:
            active -= 1

    monkeypatch.setattr(server, "stream_answer", fake_stream)
    with client.websocket_connect("/ws") as ws:
        for i in range(1, 6):
            ws.send_json({"type": "ask", "text": f"q{i}"})
        events = collect(ws, 5)
    assert [e["question_id"] for e in events if e["type"] == "question_detected"] == [1, 2, 3, 4, 5]
    assert peak == config.MAX_CONCURRENT_ANSWERS
    assert answer_text(events) == {i: str(i) * 3 for i in range(1, 6)}


def test_transcripts_flow_into_cards_and_stop(client, monkeypatch):
    class FakeTranscriber:
        last = None

        def __init__(self, on_partial, on_final, on_error, **_):
            self.on_partial, self.on_final = on_partial, on_final
            self.chunks = 0
            self.closed = False
            FakeTranscriber.last = self

        async def start(self):
            pass

        async def send_audio(self, chunk):
            self.chunks += 1
            await self.on_partial("u1", f"chunk{self.chunks}")
            if self.chunks == 2:
                await self.on_final("u1", "what is the refund window?")

        async def close(self):
            self.closed = True

    async def fake_classify(text):
        return True, text

    async def fake_stream(q, context=""):
        yield "45 days"

    monkeypatch.setattr(server, "RealtimeTranscriber", FakeTranscriber)
    monkeypatch.setattr(server, "classify", fake_classify)
    monkeypatch.setattr(server, "stream_answer", fake_stream)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "start"})
        assert ws.receive_json() == {"type": "listening", "active": True}
        ws.send_bytes(b"\0" * 4800)
        ws.send_bytes(b"\0" * 4800)
        events = collect(ws, 1)
        ws.send_json({"type": "stop"})
        events.append(ws.receive_json())
    assert [e["type"] for e in events] == [
        "transcript_partial", "transcript_partial", "transcript_final",
        "question_detected", "answer_delta", "answer_done", "listening",
    ]
    assert FakeTranscriber.last.closed


def test_start_without_credentials_reports_error(client, monkeypatch):
    class FailingTranscriber:
        def __init__(self, *args, **kwargs):
            pass

        async def start(self):
            raise RuntimeError("Missing credentials")

    monkeypatch.setattr(server, "RealtimeTranscriber", FailingTranscriber)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "start"})
        error, listening = ws.receive_json(), ws.receive_json()
    assert error["type"] == "error" and "Missing credentials" in error["message"]
    assert listening == {"type": "listening", "active": False}
