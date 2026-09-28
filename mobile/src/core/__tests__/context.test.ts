import JSZip from 'jszip';

import { fakeEmbed } from '../__fixtures__/fakes';
import { CONTEXT_LIMITS } from '../config';
import { ContextFullError, ContextStore, type ContextStorage } from '../contextStore';
import { extractDocx, extractText, UnsupportedFileError } from '../extract';
import { chunkText } from '../retrieval';

const filler = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${topic} paragraph ${i}: ` + Array.from({ length: 40 }, (_, j) => `${topic}word${j}`).join(' ')).join('\n\n');

const smallLimits = { ...CONTEXT_LIMITS, fullContextChars: 5000 };

describe('chunkText', () => {
  it('respects size and overlaps consecutive chunks', () => {
    const chunks = chunkText(filler('alpha', 30), 1000, 100);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 1100)).toBe(true);
    for (let i = 0; i + 1 < chunks.length; i++) expect(chunks[i + 1]).toContain(chunks[i].slice(-40));
    expect(chunkText('word '.repeat(1000), 1000, 100).every((c) => c.length <= 1100)).toBe(true);
  });
});

describe('ContextStore', () => {
  it('sends small context whole', async () => {
    const store = new ContextStore(fakeEmbed);
    await store.add('Refund window is 45 days.', 'policy.txt');
    await store.add('I led the Kubernetes migration at Acme.', 'resume.docx');
    expect(store.mode).toBe('full');
    const passages = await store.passages('anything');
    expect(passages.map((p) => [p.n, p.docName])).toEqual([
      [1, 'policy.txt'],
      [2, 'resume.docx'],
    ]);
  });

  it('retrieves relevant chunks from large context and always includes small documents', async () => {
    const store = new ContextStore(fakeEmbed, undefined, smallLimits);
    const manual = `${filler('engine', 40)}\n\nThe warranty on the turbocharger lasts 7 years.\n\n${filler('brake', 40)}`;
    await store.add(manual, 'manual.pdf');
    await store.add('Refund window is 45 days.', 'policy.txt');
    expect(store.mode).toBe('retrieval');
    const passages = await store.passages('how long is the turbocharger warranty');
    expect(passages[0].docName).toBe('policy.txt');
    expect(passages[1].text).toContain('turbocharger lasts 7 years');
    expect(passages.map((p) => p.n)).toEqual(Array.from({ length: CONTEXT_LIMITS.retrievalTopK + 1 }, (_, i) => i + 1));
  });

  it('never lets a big manual crowd out a profile', async () => {
    const store = new ContextStore(fakeEmbed, undefined, smallLimits);
    await store.add(Array.from({ length: 300 }, (_, i) => `The X7 arm section ${i}: X7 X7 maintenance X7 notes.`).join('\n\n'), 'manual.txt');
    await store.add('Jordan led the X7 integration team for four years.', 'profile.txt');
    const passages = await store.passages('tell me about your experience with the X7');
    expect(passages[0]).toMatchObject({ n: 1, docName: 'profile.txt' });
    expect(passages.slice(1).every((p) => p.docName === 'manual.txt')).toBe(true);
  });

  it('removes, clears, enforces limits and persists across launches', async () => {
    let saved: string | null = null;
    const storage: ContextStorage = { load: async () => saved, save: async (json) => void (saved = json) };
    const store = new ContextStore(fakeEmbed, storage);
    const doc = await store.add('some text', 'a.txt');
    await store.add('more text about turbochargers', 'b.txt');
    expect(await store.remove(doc.id)).toBe(true);
    expect(await store.remove(doc.id)).toBe(false);

    const reopened = new ContextStore(fakeEmbed, storage);
    await reopened.load();
    expect(reopened.summary().documents.map((d) => d.name)).toEqual(['b.txt']);
    expect(Array.from(reopened.index.vectors[0])).toEqual(Array.from(store.index.vectors[0]));

    await reopened.clear();
    expect(reopened.summary().documents).toEqual([]);
    const tiny = new ContextStore(fakeEmbed, undefined, { ...CONTEXT_LIMITS, maxContextChars: 10 });
    await expect(tiny.add('x'.repeat(11), 'big.txt')).rejects.toBeInstanceOf(ContextFullError);
    await expect(tiny.add('   ', 'empty.txt')).rejects.toThrow('No text found');
  });

  it('extracts distinctive keywords for transcription', async () => {
    const store = new ContextStore(fakeEmbed);
    await store.add('The Kestrelwind project. The team used Kubeflow and EKS. We shipped v2.3 in 2024. We love the Kestrelwind team.', 'notes.txt');
    const keywords = store.keywords();
    expect(keywords[0]).toBe('Kestrelwind');
    expect(keywords).toEqual(expect.arrayContaining(['Kubeflow', 'EKS', 'v2.3']));
    expect(keywords).not.toEqual(expect.arrayContaining(['The']));
    expect(keywords.some((k) => ['The', 'We', '2024'].includes(k))).toBe(false);
  });
});

describe('extract', () => {
  async function docx(xmlBody: string): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file('word/document.xml', `<?xml version="1.0"?><w:document><w:body>${xmlBody}</w:body></w:document>`);
    return zip.generateAsync({ type: 'uint8array' });
  }

  it('reads docx paragraphs, runs, tabs and entities', async () => {
    const bytes = await docx(
      '<w:p><w:r><w:t>Refund window </w:t></w:r><w:r><w:t xml:space="preserve">is 45 days &amp; free</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Name</w:t><w:tab/><w:t>Jordan</w:t></w:r></w:p><w:p></w:p>',
    );
    expect(await extractDocx(bytes)).toBe('Refund window is 45 days & free\nName\tJordan');
  });

  it('decodes text files, strips a BOM, and rejects unknown types', async () => {
    expect(await extractText('a.md', new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0xc3, 0xa9]))).toBe('hé');
    await expect(extractText('x.exe', new Uint8Array())).rejects.toBeInstanceOf(UnsupportedFileError);
    expect(await extractText('p.pdf', new Uint8Array(), async () => 'pdf text')).toBe('pdf text');
  });
});
