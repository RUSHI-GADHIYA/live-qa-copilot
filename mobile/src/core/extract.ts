import JSZip from 'jszip';

export class UnsupportedFileError extends Error {}

export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.pdf', '.docx'];

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

const decoder = new TextDecoder();

export function decodeText(bytes: Uint8Array): string {
  const text = decoder.decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // drop a UTF-8 BOM
}

/** Plain text of a .docx: its paragraphs, one per line. */
export async function extractDocx(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('Not a Word document');
  return xml
    .split(/<\/w:p>/)
    .map((paragraph) =>
      [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
        .map((m) => (m[1] !== undefined ? unescapeXml(m[1]) : m[0] === '<w:tab/>' ? '\t' : '\n'))
        .join(''),
    )
    .filter((line) => line.trim())
    .join('\n');
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** txt/md/docx. PDFs need the native extractor, which the app layer supplies. */
export async function extractText(
  name: string,
  bytes: Uint8Array,
  extractPdf?: () => Promise<string>,
): Promise<string> {
  const ext = extensionOf(name);
  if (ext === '.txt' || ext === '.md') return decodeText(bytes);
  if (ext === '.docx') return extractDocx(bytes);
  if (ext === '.pdf' && extractPdf) return extractPdf();
  throw new UnsupportedFileError(`Unsupported file type '${ext || name}'. Use one of: ${SUPPORTED_EXTENSIONS.join(', ')}`);
}
