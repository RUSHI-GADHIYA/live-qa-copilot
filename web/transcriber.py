import asyncio
import base64
import logging
import time
from collections.abc import Awaitable, Callable

import config
from openai_client import get_client

log = logging.getLogger("live_qa")

PartialHandler = Callable[[str, str], Awaitable[None]]  # (utterance_id, text so far)
FinalHandler = Callable[[str, str], Awaitable[None]]  # (utterance_id, final text)
ErrorHandler = Callable[[str], Awaitable[None]]

DEFAULT_TURN_DETECTION = {
    "type": "server_vad",
    "threshold": 0.5,
    "prefix_padding_ms": 300,
    "silence_duration_ms": config.VAD_SILENCE_MS,
}


def session_config(model: str, turn_detection: dict, transcription_extra: dict | None = None) -> dict:
    return {
        "type": "transcription",
        "audio": {
            "input": {
                "format": {"type": "audio/pcm", "rate": 24000},
                "transcription": {"model": model, **(transcription_extra or {})},
                "turn_detection": turn_detection,
                "noise_reduction": {"type": "near_field"},
            }
        },
    }


class RealtimeTranscriber:
    """Bridges PCM16 audio (24 kHz mono) to an OpenAI Realtime transcription session."""

    def __init__(
        self,
        on_partial: PartialHandler,
        on_final: FinalHandler,
        on_error: ErrorHandler,
        model: str | None = None,
        turn_detection: dict | None = None,
        transcription_extra: dict | None = None,
    ):
        self._session = session_config(
            model or config.TRANSCRIBE_MODEL, turn_detection or DEFAULT_TURN_DETECTION, transcription_extra
        )
        self._on_partial = on_partial
        self._on_final = on_final
        self._on_error = on_error
        self._connection = None
        self._reader: asyncio.Task | None = None
        self._partials: dict[str, str] = {}
        self._speech_stopped_at: float | None = None

    async def start(self) -> None:
        manager = get_client().realtime.connect(extra_query={"intent": "transcription"})
        self._connection = await manager.enter()
        await self._connection.session.update(session=self._session)
        self._reader = asyncio.create_task(self._read_events())

    async def send_audio(self, pcm16: bytes) -> None:
        if self._connection is not None:
            await self._connection.input_audio_buffer.append(audio=base64.b64encode(pcm16).decode("ascii"))

    async def close(self) -> None:
        connection, self._connection = self._connection, None
        if connection is not None:
            await connection.close()
        if self._reader is not None:
            self._reader.cancel()
            await asyncio.gather(self._reader, return_exceptions=True)
            self._reader = None

    async def _read_events(self) -> None:
        try:
            async for event in self._connection:
                if event.type == "input_audio_buffer.speech_stopped":
                    self._speech_stopped_at = time.perf_counter()
                elif event.type == "conversation.item.input_audio_transcription.delta":
                    text = self._partials.get(event.item_id, "") + (event.delta or "")
                    self._partials[event.item_id] = text
                    await self._on_partial(event.item_id, text)
                elif event.type == "conversation.item.input_audio_transcription.completed":
                    self._partials.pop(event.item_id, None)
                    if self._speech_stopped_at is not None:
                        log.info("transcript final %.0f ms after speech stopped",
                                 (time.perf_counter() - self._speech_stopped_at) * 1000)
                    if event.transcript.strip():
                        await self._on_final(event.item_id, event.transcript.strip())
                elif event.type == "conversation.item.input_audio_transcription.failed":
                    self._partials.pop(event.item_id, None)
                    await self._on_error(f"Transcription failed: {event.error.message}")
                elif event.type == "error":
                    await self._on_error(f"Realtime API error: {event.error.message}")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self._connection is not None:
                await self._on_error(f"Transcription connection lost: {exc}")
