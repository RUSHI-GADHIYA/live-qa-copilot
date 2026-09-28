import asyncio
import itertools
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
from agent import stream_answer
from context_store import ContextStore, UnsupportedFileError, extract_text
from detector import classify
from transcriber import RealtimeTranscriber

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="Live Q&A Agent")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

context = ContextStore()
# Caps simultaneous answer streams (rate-limit protection); extra questions wait their turn.
answer_slots = asyncio.Semaphore(config.MAX_CONCURRENT_ANSWERS)


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


class ContextText(BaseModel):
    text: str


@app.post("/context/text")
async def set_context_text(body: ContextText):
    context.set(body.text, "pasted text")
    return context.summary()


@app.post("/context/file")
async def set_context_file(file: UploadFile):
    data = await file.read()
    try:
        text = await run_in_threadpool(extract_text, file.filename or "", data)
    except UnsupportedFileError as exc:
        raise HTTPException(status_code=415, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read {file.filename}: {exc}")
    if not text.strip():
        raise HTTPException(status_code=400, detail=f"No text found in {file.filename}")
    context.set(text, file.filename or "uploaded file")
    return context.summary()


@app.get("/context")
async def get_context():
    return context.summary()


@app.delete("/context")
async def clear_context():
    context.clear()
    return context.summary()


class Session:
    """One WebSocket connection: serializes sends and owns the answer tasks."""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self._send_lock = asyncio.Lock()
        self._question_ids = itertools.count(1)
        self._tasks: set[asyncio.Task] = set()
        self._transcriber: RealtimeTranscriber | None = None
        # Resolved when the previous utterance has been classified (and its card created, if any).
        self._utterance_tail: asyncio.Future = asyncio.get_running_loop().create_future()
        self._utterance_tail.set_result(None)

    async def start_listening(self):
        if self._transcriber is not None:
            return
        transcriber = RealtimeTranscriber(
            on_partial=lambda _id, text: self.send("transcript_partial", text=text),
            on_final=self._on_final_transcript,
            on_error=lambda message: self.send("error", message=message),
        )
        try:
            await transcriber.start()
        except Exception as exc:
            await self.send("error", message=f"Could not start transcription: {exc}")
            await self.send("listening", active=False)
            return
        self._transcriber = transcriber
        await self.send("listening", active=True)

    async def stop_listening(self):
        transcriber, self._transcriber = self._transcriber, None
        if transcriber is not None:
            await transcriber.close()
        await self.send("listening", active=False)

    async def send_audio(self, chunk: bytes):
        if self._transcriber is not None:
            await self._transcriber.send_audio(chunk)

    async def _on_final_transcript(self, utterance_id: str, text: str):
        await self.send("transcript_final", utterance_id=utterance_id, text=text)
        self.submit_utterance(text)

    async def send(self, event_type: str, **payload):
        async with self._send_lock:
            try:
                await self.ws.send_json({"type": event_type, **payload})
            except (WebSocketDisconnect, RuntimeError):
                pass  # Client went away; the session is being torn down.


    def submit_utterance(self, text: str):
        """Classify a finished utterance in the background and answer it if it is a question.

        Classifications run in parallel, but cards are created in utterance order.
        """
        previous, self._utterance_tail = self._utterance_tail, asyncio.get_running_loop().create_future()
        self.spawn(self._handle_utterance(text, previous, self._utterance_tail))

    async def _handle_utterance(self, text: str, previous: asyncio.Future, done: asyncio.Future):
        try:
            try:
                is_question, cleaned = await classify(text)
            except Exception as exc:
                is_question, cleaned = False, ""
                await self.send("error", message=f"Question detector failed: {exc}")
            await asyncio.shield(previous)
            if is_question:
                await self.ask(cleaned)
        finally:
            if not done.done():
                done.set_result(None)

    async def ask(self, question: str):
        # The card is created before any answering starts, so feed order matches ask order.
        question_id = next(self._question_ids)
        await self.send("question_detected", question_id=question_id, text=question)
        self.spawn(self._answer(question_id, question))

    def spawn(self, coro):
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _answer(self, question_id: int, question: str):
        try:
            async with answer_slots:
                async for delta in stream_answer(question, context.text):
                    await self.send("answer_delta", question_id=question_id, delta=delta)
            await self.send("answer_done", question_id=question_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.send("error", question_id=question_id, message=str(exc))

    async def close(self):
        transcriber, self._transcriber = self._transcriber, None
        if transcriber is not None:
            await transcriber.close()
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    session = Session(ws)
    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes"):
                await session.send_audio(message["bytes"])
                continue
            try:
                msg = json.loads(message.get("text") or "{}")
            except json.JSONDecodeError:
                continue
            kind, text = msg.get("type"), msg.get("text", "").strip()
            if kind == "start":
                await session.start_listening()
            elif kind == "stop":
                await session.stop_listening()
            elif kind == "ask" and text:
                await session.ask(text)
            elif kind == "utterance" and text:
                session.submit_utterance(text)
    except WebSocketDisconnect:
        pass
    finally:
        await session.close()
