/**
 * Server-sent events parser working on raw bytes.
 *
 * Lines are split on the newline byte before decoding, so a multi-byte UTF-8 character split across two
 * network chunks is never decoded in halves (the native TextDecoder has no streaming mode).
 */
const NEWLINE = 0x0a;
const decoder = new TextDecoder();

export class SSEParser {
  private pending = new Uint8Array(0);
  private data: string[] = [];

  /** Feed bytes; returns the `data` payload of every event completed by them. */
  push(bytes: Uint8Array): string[] {
    const buffer = new Uint8Array(this.pending.length + bytes.length);
    buffer.set(this.pending);
    buffer.set(bytes, this.pending.length);

    const events: string[] = [];
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== NEWLINE) continue;
      let line = decoder.decode(buffer.subarray(start, i));
      start = i + 1;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (this.data.length) events.push(this.data.join('\n'));
        this.data = [];
      } else if (line.startsWith('data:')) {
        this.data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
      }
    }
    this.pending = buffer.slice(start);
    return events;
  }
}
