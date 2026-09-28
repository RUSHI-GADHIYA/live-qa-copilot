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
