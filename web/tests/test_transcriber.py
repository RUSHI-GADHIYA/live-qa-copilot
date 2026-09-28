import asyncio
from types import SimpleNamespace as NS

import transcriber


class FakeConnection:
    def __init__(self, events):
        self.events = events

    async def __aiter__(self):
        for event in self.events:
            yield event


def test_events_become_partials_finals_and_errors():
    got = []

    async def record(kind, *args):
        got.append((kind, *args))

    t = transcriber.RealtimeTranscriber(
        lambda i, x: record("partial", i, x), lambda i, x: record("final", i, x), lambda m: record("error", m)
    )
    t._connection = FakeConnection([
        NS(type="conversation.item.input_audio_transcription.delta", item_id="i1", delta="What is"),
        NS(type="conversation.item.input_audio_transcription.delta", item_id="i1", delta=" X?"),
        NS(type="conversation.item.input_audio_transcription.completed", item_id="i1", transcript=" What is X? "),
        NS(type="conversation.item.input_audio_transcription.completed", item_id="i2", transcript="  "),
        NS(type="error", error=NS(message="bad")),
    ])
    asyncio.run(t._read_events())
    assert got == [
        ("partial", "i1", "What is"),
        ("partial", "i1", "What is X?"),
        ("final", "i1", "What is X?"),
        ("error", "Realtime API error: bad"),
    ]
