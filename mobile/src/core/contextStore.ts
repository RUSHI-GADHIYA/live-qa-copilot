import { CONTEXT_LIMITS } from './config';
import { bytesToBase64, base64ToBytes } from './audio/pcm';
import { chunkText, VectorIndex, type Chunk } from './retrieval';

export interface Document {
  id: string;
  name: string;
  text: string;
}

/** A numbered piece of context shown to the answer agent, which cites it as [n]. */
export interface Passage {
  n: number;
  docName: string;
  text: string;
}

export type Embedder = (texts: string[]) => Promise<Float32Array[]>;

/** Where documents and their vectors are kept between app launches. */
export interface ContextStorage {
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
}

export class ContextFullError extends Error {}

interface Snapshot {
  documents: Document[];
  chunks: Chunk[];
  vectors: string[]; // base64 Float32Array bytes: ~4x smaller than JSON numbers
}

/**
 * Documents on the phone (port of context_store.py). Small context goes into the prompt whole; above
 * fullContextChars only the most relevant chunks do, plus every small document (pinned).
 */
export class ContextStore {
  documents: Document[] = [];
  readonly index = new VectorIndex();

  constructor(
    private readonly embed: Embedder,
    private readonly storage?: ContextStorage,
    private readonly limits = CONTEXT_LIMITS,
  ) {}

  get totalChars(): number {
    return this.documents.reduce((n, d) => n + d.text.length, 0);
  }

  get mode(): 'full' | 'retrieval' {
    return this.totalChars <= this.limits.fullContextChars ? 'full' : 'retrieval';
  }

  async load(): Promise<void> {
    const json = await this.storage?.load();
    if (!json) return;
    const snapshot: Snapshot = JSON.parse(json);
    this.documents = snapshot.documents;
    this.index.clear();
    this.index.add(
      snapshot.chunks,
      snapshot.vectors.map((b64) => {
        const bytes = base64ToBytes(b64);
        return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      }),
    );
  }

  private async persist(): Promise<void> {
    if (!this.storage) return;
    const snapshot: Snapshot = {
      documents: this.documents,
      chunks: this.index.chunks,
      vectors: this.index.vectors.map((v) => bytesToBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))),
    };
    await this.storage.save(JSON.stringify(snapshot));
  }

  async add(text: string, name: string): Promise<Document> {
    text = text.trim();
    if (!text) throw new Error(`No text found in ${name}`);
    if (this.totalChars + text.length > this.limits.maxContextChars) {
      throw new ContextFullError(
        `Adding ${name} (${text.length.toLocaleString()} chars) would exceed the ${this.limits.maxContextChars.toLocaleString()}-char limit`,
      );
    }
    const doc: Document = { id: Math.random().toString(36).slice(2, 10), name, text };
    const chunks: Chunk[] = chunkText(text).map((piece) => ({ docId: doc.id, docName: name, text: piece }));
    // Embed every document up front, so crossing into retrieval mode later needs no re-indexing.
    this.index.add(chunks, await this.embed(chunks.map((c) => c.text)));
    this.documents.push(doc);
    await this.persist();
    return doc;
  }

  async remove(docId: string): Promise<boolean> {
    const before = this.documents.length;
    this.documents = this.documents.filter((d) => d.id !== docId);
    if (this.documents.length === before) return false;
    this.index.removeDoc(docId);
    await this.persist();
    return true;
  }

  async clear(): Promise<void> {
    this.documents = [];
    this.index.clear();
    await this.persist();
  }

  async passages(query: string): Promise<Passage[]> {
    if (!this.documents.length) return [];
    if (this.mode === 'full') return this.documents.map((d, i) => ({ n: i + 1, docName: d.name, text: d.text }));
    // Small documents (a resume, a job description) always go in whole, so a large manual that matches the
    // query better on the surface cannot crowd them out. Only large documents are searched.
    const pinned: Document[] = [];
    let budget = this.limits.fullContextChars / 2;
    for (const doc of [...this.documents].sort((a, b) => a.text.length - b.text.length)) {
      if (doc.text.length <= this.limits.pinDocChars && doc.text.length <= budget) {
        pinned.push(doc);
        budget -= doc.text.length;
      }
    }
    const [queryVector] = await this.embed([query]);
    const chunks = this.index.search(queryVector, this.limits.retrievalTopK, new Set(pinned.map((d) => d.id)));
    const pieces = [
      ...pinned.map((d) => ({ docName: d.name, text: d.text })),
      ...chunks.map((c) => ({ docName: c.docName, text: c.text })),
    ];
    return pieces.map((p, i) => ({ n: i + 1, ...p }));
  }

  /** Distinctive terms (names, acronyms, versions) to help transcription spell them right. */
  keywords(limit = 40): string[] {
    const counts = new Map<string, number>();
    const lowercase = new Set<string>();
    for (const doc of this.documents) {
      for (let word of doc.text.split(/\s+/)) {
        word = word.replace(/^[.,;:!?()[\]"']+|[.,;:!?()[\]"']+$/g, '');
        const hasDigit = /\d/.test(word);
        if (word.length > 2 && hasDigit && !/^[\d.]+$/.test(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
        else if (word && word === word.toLowerCase() && word !== word.toUpperCase()) lowercase.add(word);
        else if (word.length > 2 && /^[A-Z]/.test(word) && !hasDigit) counts.set(word, (counts.get(word) ?? 0) + 1);
      }
    }
    // A capitalised word that also appears in lowercase ("The", "We") is just a sentence start.
    return [...counts.entries()]
      .filter(([w]) => !lowercase.has(w.toLowerCase()))
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([w]) => w);
  }

  summary() {
    return {
      mode: this.mode,
      totalChars: this.totalChars,
      chunks: this.index.chunks.length,
      documents: this.documents.map((d) => ({ id: d.id, name: d.name, chars: d.text.length, preview: d.text.slice(0, 200) })),
    };
  }
}
