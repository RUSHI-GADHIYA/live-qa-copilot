const DIM = 256;
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'for', 'how', 'in', 'is', 'it', 'long', 'of', 'on', 'the', 'to', 'what']);

function hash(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
  return (h >>> 0) % DIM;
}

/** Deterministic bag-of-words vectors: texts sharing words are similar, like real embeddings. */
export async function fakeEmbed(texts: string[]): Promise<Float32Array[]> {
  return texts.map((text) => {
    const vector = new Float32Array(DIM);
    const unique = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    for (const word of unique) if (!STOP_WORDS.has(word)) vector[hash(word)] += 1;
    let norm = 0;
    for (const v of vector) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return vector.map((v) => v / norm);
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
