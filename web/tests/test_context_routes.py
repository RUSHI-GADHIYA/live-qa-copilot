import asyncio

from fastapi.testclient import TestClient

import server
from tests.test_context_store import make_docx, make_pdf


def test_documents_are_added_listed_and_removed():
    server.context.clear()
    c = TestClient(server.app)
    for name, data in [("a.txt", b"plain"), ("c.pdf", make_pdf("PDF refund policy")), ("d.docx", make_docx("45 days"))]:
        r = c.post("/context/file", files={"file": (name, data)})
        assert r.status_code == 200, r.text
    r = c.post("/context/text", json={"text": "pasted notes"})
    docs = r.json()["documents"]
    assert [d["name"] for d in docs] == ["a.txt", "c.pdf", "d.docx", "pasted text"]
    assert r.json()["mode"] == "full"
    assert c.post("/context/file", files={"file": ("x.exe", b"zz")}).status_code == 415
    assert c.post("/context/text", json={"text": "  "}).status_code == 400
    r = c.delete(f"/context/{docs[0]['id']}")
    assert [d["name"] for d in r.json()["documents"]] == ["c.pdf", "d.docx", "pasted text"]
    assert c.delete("/context/nope").status_code == 404
    assert c.delete("/context").json()["documents"] == []


def test_answer_sources_precede_speculative_text(monkeypatch):
    server.context.clear()
    asyncio.run(server.context.add("The refund window is 45 days.", "policy.txt"))
    seen = {}

    async def fake_classify(text, history=None):
        await asyncio.sleep(0.1)
        return "question"

    async def fake_stream(q, passages=None, history=None):
        seen["passages"] = passages
        yield "45 days [1]"

    async def no_warmup():
        pass

    monkeypatch.setattr(server, "classify", fake_classify)
    monkeypatch.setattr(server, "stream_answer", fake_stream)
    monkeypatch.setattr(server, "warm_connections", no_warmup)
    with TestClient(server.app).websocket_connect("/ws") as ws:
        ws.send_json({"type": "utterance", "text": "what is the refund window?"})
        events = [ws.receive_json() for _ in range(4)]
    server.context.clear()
    assert [e["type"] for e in events] == ["question_detected", "answer_sources", "answer_delta", "answer_done"]
    assert events[1]["sources"] == [{"n": 1, "doc": "policy.txt", "snippet": "The refund window is 45 days."}]
    assert [p.doc_name for p in seen["passages"]] == ["policy.txt"]
