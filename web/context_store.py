import io
from dataclasses import dataclass
from pathlib import Path

from docx import Document
from pypdf import PdfReader

import config

SUPPORTED_EXTENSIONS = {".txt", ".md", ".pdf", ".docx"}


class UnsupportedFileError(ValueError):
    pass


def extract_text(filename: str, data: bytes) -> str:
    ext = Path(filename).suffix.lower()
    if ext in (".txt", ".md"):
        return data.decode("utf-8-sig", errors="replace")
    if ext == ".pdf":
        reader = PdfReader(io.BytesIO(data))
        return "\n\n".join(page.extract_text() or "" for page in reader.pages)
    if ext == ".docx":
        doc = Document(io.BytesIO(data))
        return "\n".join(p.text for p in doc.paragraphs)
    raise UnsupportedFileError(
        f"Unsupported file type '{ext or filename}'. Use one of: {', '.join(sorted(SUPPORTED_EXTENSIONS))}"
    )


@dataclass
class ContextStore:
    """In-memory context shared by the single local user."""

    text: str = ""
    source: str = ""
    original_length: int = 0

    def set(self, text: str, source: str) -> None:
        text = text.strip()
        self.original_length = len(text)
        self.text = text[: config.MAX_CONTEXT_CHARS]
        self.source = source if text else ""

    def clear(self) -> None:
        self.set("", "")

    @property
    def truncated(self) -> bool:
        return self.original_length > len(self.text)

    def summary(self, preview_chars: int = 500) -> dict:
        return {
            "source": self.source,
            "length": len(self.text),
            "original_length": self.original_length,
            "max_length": config.MAX_CONTEXT_CHARS,
            "truncated": self.truncated,
            "preview": self.text[:preview_chars],
        }
