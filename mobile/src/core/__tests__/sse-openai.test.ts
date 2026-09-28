import { normalize, OpenAIClient, outputText } from '../openai';
import { SSEParser } from '../sse';

const encode = (text: string) => new TextEncoder().encode(text);

describe('SSEParser', () => {
  it('handles events split anywhere, including inside a multi-byte character', () => {
    const stream = encode('event: a\ndata: {"t":"héllo"}\n\ndata: second\r\n\r\n');
    const parser = new SSEParser();
    const out: string[] = [];
    for (let i = 0; i < stream.length; i += 3) out.push(...parser.push(stream.subarray(i, i + 3)));
    expect(out).toEqual(['{"t":"héllo"}', 'second']);
  });
});

function sseResponse(events: object[]): Response {
  const body = events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200 });
}

describe('OpenAIClient', () => {
  it('streams output_text deltas and sends auth + stream flag', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new OpenAIClient('sk-test', async (url, init) => {
      calls.push({ url, init: init! });
      return sseResponse([
        { type: 'response.created' },
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_text.delta', delta: ' world' },
        { type: 'response.completed' },
      ]);
    });
    const parts: string[] = [];
    for await (const d of client.streamText({ model: 'm', input: 'hi' })) parts.push(d);
    expect(parts.join('')).toBe('Hello world');
    expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(calls[0].init.body)).stream).toBe(true);
  });

  it('surfaces API errors with their message', async () => {
    const client = new OpenAIClient('bad', async () =>
      new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 }),
    );
    await expect(client.responseText({ model: 'm' })).rejects.toThrow('OpenAI 401: Incorrect API key provided');
  });

  it('extracts output text from a Responses API payload', () => {
    expect(
      outputText({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'Q' }] }] }),
    ).toBe('Q');
    expect(Array.from(normalize(Float32Array.from([3, 4])))).toEqual([0.6000000238418579, 0.800000011920929]);
  });
});
