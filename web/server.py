import asyncio
import itertools
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from agent import stream_answer

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="Live Q&A Agent")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


class Session:
    """One WebSocket connection: serializes sends and owns the answer tasks."""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self._send_lock = asyncio.Lock()
        self._question_ids = itertools.count(1)
        self._tasks: set[asyncio.Task] = set()

    async def send(self, event_type: str, **payload):
        async with self._send_lock:
            await self.ws.send_json({"type": event_type, **payload})

    async def ask(self, question: str):
        # The card is created before any answering starts, so feed order matches ask order.
        question_id = next(self._question_ids)
        await self.send("question_detected", question_id=question_id, text=question)
        task = asyncio.create_task(self._answer(question_id, question))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _answer(self, question_id: int, question: str):
        try:
            async for delta in stream_answer(question):
                await self.send("answer_delta", question_id=question_id, delta=delta)
            await self.send("answer_done", question_id=question_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.send("error", question_id=question_id, message=str(exc))

    async def close(self):
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    session = Session(ws)
    try:
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "ask" and msg.get("text", "").strip():
                await session.ask(msg["text"].strip())
    except WebSocketDisconnect:
        pass
    finally:
        await session.close()
