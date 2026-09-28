import io

import pytest
from docx import Document

import config
from context_store import ContextStore, UnsupportedFileError, extract_text


def make_pdf(text: str) -> bytes:
    content = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R"
        b" /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % i + obj + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref))
    return out.getvalue()


def make_docx(text: str) -> bytes:
    doc = Document()
    doc.add_paragraph(text)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


@pytest.mark.parametrize(
    "name,data,expected",
    [
        ("a.txt", b"plain text", "plain text"),
        ("b.md", "# Héading".encode(), "# Héading"),
        ("bom.txt", b"\xef\xbb\xbfhi", "hi"),
        ("c.pdf", make_pdf("PDF refund policy"), "PDF refund policy"),
        ("d.docx", make_docx("Refund window is 45 days."), "Refund window is 45 days."),
    ],
    ids=["txt", "md", "bom", "pdf", "docx"],
)
def test_extract_text(name, data, expected):
    assert extract_text(name, data).strip() == expected


def test_unsupported_extension():
    with pytest.raises(UnsupportedFileError):
        extract_text("x.exe", b"zz")


# ---- multi-document store and retrieval ----
import asyncio  # noqa: E402

from retrieval import chunk_text  # noqa: E402
from context_store import ContextFullError, ContextStore  # noqa: E402


def filler_paragraphs(topic: str, n: int) -> str:
    return "\n\n".join(f"{topic} paragraph {i}: " + " ".join(f"{topic}word{j}" for j in range(40)) for i in range(n))


def test_chunks_respect_size_and_overlap():
    text = filler_paragraphs("alpha", 30)
    chunks = chunk_text(text, target=1000, overlap=100)
    assert len(chunks) > 5
    assert all(len(c) <= 1100 for c in chunks)
    assert all(chunks[i][-40:] in chunks[i + 1] for i in range(len(chunks) - 1))  # consecutive chunks overlap
    long_paragraph = "word " * 1000
    assert all(len(c) <= 1100 for c in chunk_text(long_paragraph, target=1000, overlap=100))


def test_small_context_goes_in_whole():
    store = ContextStore()
    asyncio.run(store.add("Refund window is 45 days.", "policy.txt"))
    asyncio.run(store.add("I led the Kubernetes migration at Acme.", "resume.docx"))
    assert store.mode == "full"
    passages = asyncio.run(store.passages("anything"))
    assert [(p.n, p.doc_name) for p in passages] == [(1, "policy.txt"), (2, "resume.docx")]


def test_large_context_retrieves_relevant_chunks(monkeypatch):
    monkeypatch.setattr(config, "FULL_CONTEXT_CHARS", 5000)
    store = ContextStore()
    manual = filler_paragraphs("engine", 40) + "\n\nThe warranty on the turbocharger lasts 7 years.\n\n" + filler_paragraphs("brake", 40)
    asyncio.run(store.add(manual, "manual.pdf"))
    asyncio.run(store.add("Refund window is 45 days.", "policy.txt"))
    assert store.mode == "retrieval"
    passages = asyncio.run(store.passages("how long is the turbocharger warranty"))
    assert passages[0].doc_name == "policy.txt"  # small documents are always included, first
    assert "turbocharger lasts 7 years" in passages[1].text  # then the best-matching chunks
    assert [p.n for p in passages] == list(range(1, config.RETRIEVAL_TOP_K + 2))


def test_remove_clear_and_limits(monkeypatch):
    store = ContextStore()
    doc = asyncio.run(store.add("some text", "a.txt"))
    asyncio.run(store.add("more text", "b.txt"))
    assert store.remove(doc.id) and not store.remove(doc.id)
    assert [d["name"] for d in store.summary()["documents"]] == ["b.txt"]
    assert all(c.doc_name == "b.txt" for c in store.index.chunks)
    store.clear()
    assert store.summary()["documents"] == [] and store.index.vectors is None
    monkeypatch.setattr(config, "MAX_CONTEXT_CHARS", 10)
    with pytest.raises(ContextFullError):
        asyncio.run(store.add("x" * 11, "big.txt"))
    with pytest.raises(ValueError):
        asyncio.run(store.add("   ", "empty.txt"))


def test_keywords_are_distinctive_terms():
    store = ContextStore()
    text = "The Kestrelwind project. The team used Kubeflow and EKS. We shipped v2.3 in 2024. We love the Kestrelwind team."
    asyncio.run(store.add(text, "notes.txt"))
    keywords = store.keywords()
    assert keywords[0] == "Kestrelwind"
    assert {"Kubeflow", "EKS", "v2.3"} <= set(keywords)
    assert "The" not in keywords and "We" not in keywords and "2024" not in keywords


def test_small_documents_are_never_crowded_out(monkeypatch):
    monkeypatch.setattr(config, "FULL_CONTEXT_CHARS", 5000)
    store = ContextStore()
    manual = "\n\n".join(f"The X7 arm section {i}: X7 X7 maintenance X7 notes." for i in range(300))
    asyncio.run(store.add(manual, "manual.txt"))
    asyncio.run(store.add("Jordan led the X7 integration team for four years.", "profile.txt"))
    passages = asyncio.run(store.passages("tell me about your experience with the X7"))
    assert passages[0].doc_name == "profile.txt" and passages[0].n == 1
    assert [p.doc_name for p in passages[1:]] == ["manual.txt"] * config.RETRIEVAL_TOP_K
