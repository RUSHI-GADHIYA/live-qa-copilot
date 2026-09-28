import io
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from docx import Document as DocxDocument
from pypdf import PdfReader

import config
from retrieval import Chunk, Index, chunk_text, embed

SUPPORTED_EXTENSIONS = {".txt", ".md", ".pdf", ".docx"}


class UnsupportedFileError(ValueError):
    pass


class ContextFullError(ValueError):
    pass


def extract_text(filename: str, data: bytes) -> str:
    ext = Path(filename).suffix.lower()
    if ext in (".txt", ".md"):
        return data.decode("utf-8-sig", errors="replace")
    if ext == ".pdf":
        reader = PdfReader(io.BytesIO(data))
        return "\n\n".join(page.extract_text() or "" for page in reader.pages)
    if ext == ".docx":
        doc = DocxDocument(io.BytesIO(data))
        return "\n".join(p.text for p in doc.paragraphs)
    raise UnsupportedFileError(
        f"Unsupported file type '{ext or filename}'. Use one of: {', '.join(sorted(SUPPORTED_EXTENSIONS))}"
    )


@dataclass
class Document:
    name: str
    text: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])


@dataclass
class Passage:
    """A numbered piece of context shown to the answer agent, which cites it as [n]."""

    n: int
    doc_name: str
    text: str


class ContextStore:
    """In-memory documents shared by the single local user.

    Small context goes into the prompt whole; above FULL_CONTEXT_CHARS only the most relevant chunks do.
    """

    def __init__(self):
        self.documents: dict[str, Document] = {}
        self.index = Index()

    @property
    def total_chars(self) -> int:
        return sum(len(d.text) for d in self.documents.values())

    @property
    def mode(self) -> str:
        return "full" if self.total_chars <= config.FULL_CONTEXT_CHARS else "retrieval"

    async def add(self, text: str, name: str) -> Document:
        text = text.strip()
        if not text:
            raise ValueError(f"No text found in {name}")
        if self.total_chars + len(text) > config.MAX_CONTEXT_CHARS:
            raise ContextFullError(
                f"Adding {name} ({len(text):,} chars) would exceed the {config.MAX_CONTEXT_CHARS:,}-char context limit"
            )
        doc = Document(name, text)
        chunks = [Chunk(doc.id, name, piece) for piece in chunk_text(text)]
        # Embed every document up front, so crossing into retrieval mode later needs no re-indexing.
        self.index.add(chunks, await embed([c.text for c in chunks]))
        self.documents[doc.id] = doc
        return doc

    def remove(self, doc_id: str) -> bool:
        if self.documents.pop(doc_id, None) is None:
            return False
        self.index.remove_doc(doc_id)
        return True

    def clear(self) -> None:
        self.documents.clear()
        self.index.clear()

    async def passages(self, query: str) -> list[Passage]:
        if not self.documents:
            return []
        if self.mode == "full":
            return [Passage(n, d.name, d.text) for n, d in enumerate(self.documents.values(), 1)]
        # Small documents (a resume, a job description, notes) always go in whole, so a large manual that
        # matches the query better on the surface cannot crowd them out. Only large documents are searched.
        pinned, budget = [], config.FULL_CONTEXT_CHARS // 2
        for doc in sorted(self.documents.values(), key=lambda d: len(d.text)):
            if len(doc.text) <= config.PIN_DOC_CHARS and len(doc.text) <= budget:
                pinned.append(doc)
                budget -= len(doc.text)
        pinned_ids = {d.id for d in pinned}
        query_vector = (await embed([query]))[0]
        chunks = self.index.search(query_vector, config.RETRIEVAL_TOP_K, exclude_docs=pinned_ids)
        pieces = [(d.name, d.text) for d in pinned] + [(c.doc_name, c.text) for c in chunks]
        return [Passage(n, name, text) for n, (name, text) in enumerate(pieces, 1)]

    def keywords(self, limit: int = 40) -> list[str]:
        """Distinctive terms (names, acronyms, product words) to help transcription spell them right."""
        counts: dict[str, int] = {}
        lowercase: set[str] = set()
        for doc in self.documents.values():
            for word in doc.text.split():
                word = word.strip(".,;:!?()[]\"'")
                has_digit = any(ch.isdigit() for ch in word)
                if len(word) > 2 and has_digit and not word.replace(".", "").isdigit():  # versions, model numbers
                    counts[word] = counts.get(word, 0) + 1
                elif word.islower():
                    lowercase.add(word)
                elif len(word) > 2 and word[0].isupper() and not has_digit:
                    counts[word] = counts.get(word, 0) + 1
        # A capitalised word that also appears in lowercase ("The", "We") is just a sentence start.
        distinctive = {w: n for w, n in counts.items() if w.lower() not in lowercase}
        return [w for w, _ in sorted(distinctive.items(), key=lambda kv: -kv[1])[:limit]]

    def summary(self) -> dict:
        return {
            "mode": self.mode,
            "total_chars": self.total_chars,
            "max_chars": config.MAX_CONTEXT_CHARS,
            "full_context_chars": config.FULL_CONTEXT_CHARS,
            "chunks": len(self.index.chunks),
            "documents": [
                {"id": d.id, "name": d.name, "chars": len(d.text), "preview": d.text[:200]}
                for d in self.documents.values()
            ],
        }
