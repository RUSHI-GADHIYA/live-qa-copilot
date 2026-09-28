"""Chunking, embeddings and top-k search for context too large to put in the prompt whole."""

import re
from dataclasses import dataclass

import numpy as np

import config
from openai_client import get_client

CHUNK_CHARS = 3000  # about 750 tokens
OVERLAP_CHARS = 300
EMBED_BATCH = 256


@dataclass
class Chunk:
    doc_id: str
    doc_name: str
    text: str


def chunk_text(text: str, target: int = CHUNK_CHARS, overlap: int = OVERLAP_CHARS) -> list[str]:
    """Split on paragraph boundaries into ~target-size chunks; each chunk repeats the end of the previous one."""
    pieces: list[str] = []
    for paragraph in re.split(r"\n\s*\n", text):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        while len(paragraph) > target:  # a single huge paragraph: cut at the last sentence or word break
            cut = max(paragraph.rfind(". ", 0, target), paragraph.rfind(" ", 0, target))
            cut = cut + 1 if cut > target // 2 else target
            pieces.append(paragraph[:cut].strip())
            paragraph = paragraph[cut:].strip()
        pieces.append(paragraph)

    chunks: list[str] = []
    current = ""
    for piece in pieces:
        if current and len(current) + len(piece) + 2 > target:
            chunks.append(current)
            tail = current[-overlap:]
            current = tail[tail.find(" ") + 1:] if " " in tail else tail
        current = f"{current}\n\n{piece}" if current else piece
    if current:
        chunks.append(current)
    return chunks


async def embed(texts: list[str]) -> np.ndarray:
    """Unit-length embeddings, one row per text."""
    rows = []
    for start in range(0, len(texts), EMBED_BATCH):
        response = await get_client().embeddings.create(
            model=config.EMBEDDING_MODEL, input=texts[start:start + EMBED_BATCH]
        )
        rows.extend(item.embedding for item in response.data)
    vectors = np.asarray(rows, dtype=np.float32)
    return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)


class Index:
    def __init__(self):
        self.chunks: list[Chunk] = []
        self.vectors: np.ndarray | None = None

    def add(self, chunks: list[Chunk], vectors: np.ndarray) -> None:
        self.chunks.extend(chunks)
        self.vectors = vectors if self.vectors is None else np.vstack([self.vectors, vectors])

    def remove_doc(self, doc_id: str) -> None:
        keep = [i for i, c in enumerate(self.chunks) if c.doc_id != doc_id]
        self.chunks = [self.chunks[i] for i in keep]
        self.vectors = self.vectors[keep] if keep and self.vectors is not None else None

    def clear(self) -> None:
        self.chunks, self.vectors = [], None

    def search(self, query_vector: np.ndarray, k: int, exclude_docs: set[str] = frozenset()) -> list[Chunk]:
        if self.vectors is None:
            return []
        scores = self.vectors @ query_vector
        ranked = (self.chunks[i] for i in np.argsort(-scores))
        return [c for c in ranked if c.doc_id not in exclude_docs][:k]
