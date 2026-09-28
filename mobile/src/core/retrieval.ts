/** Chunking and top-k search for context too large to send whole. Port of retrieval.py. */

export const CHUNK_CHARS = 3000; // about 750 tokens
export const OVERLAP_CHARS = 300;

export interface Chunk {
  docId: string;
  docName: string;
  text: string;
}

/** Split on paragraph boundaries into ~target-size chunks; each chunk repeats the end of the previous one. */
export function chunkText(text: string, target = CHUNK_CHARS, overlap = OVERLAP_CHARS): string[] {
  const pieces: string[] = [];
  for (let paragraph of text.split(/\n\s*\n/)) {
    paragraph = paragraph.trim();
    if (!paragraph) continue;
    while (paragraph.length > target) {
      // A single huge paragraph: cut at the last sentence or word break.
      let cut = Math.max(paragraph.lastIndexOf('. ', target), paragraph.lastIndexOf(' ', target));
      cut = cut > target / 2 ? cut + 1 : target;
      pieces.push(paragraph.slice(0, cut).trim());
      paragraph = paragraph.slice(cut).trim();
    }
    pieces.push(paragraph);
  }

  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > target) {
      chunks.push(current);
      const tail = current.slice(-overlap);
      current = tail.includes(' ') ? tail.slice(tail.indexOf(' ') + 1) : tail;
    }
    current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

export class VectorIndex {
  chunks: Chunk[] = [];
  vectors: Float32Array[] = [];

  add(chunks: Chunk[], vectors: Float32Array[]): void {
    this.chunks.push(...chunks);
    this.vectors.push(...vectors);
  }

  removeDoc(docId: string): void {
    const keep = this.chunks.map((c, i) => (c.docId === docId ? -1 : i)).filter((i) => i >= 0);
    this.chunks = keep.map((i) => this.chunks[i]);
    this.vectors = keep.map((i) => this.vectors[i]);
  }

  clear(): void {
    this.chunks = [];
    this.vectors = [];
  }

  /** Top-k chunks by cosine similarity (vectors are unit length, so a dot product). */
  search(query: Float32Array, k: number, excludeDocs: Set<string> = new Set()): Chunk[] {
    const scored: { score: number; chunk: Chunk }[] = [];
    this.vectors.forEach((vector, i) => {
      if (excludeDocs.has(this.chunks[i].docId)) return;
      let score = 0;
      for (let d = 0; d < vector.length; d++) score += vector[d] * query[d];
      scored.push({ score, chunk: this.chunks[i] });
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((s) => s.chunk);
  }
}
