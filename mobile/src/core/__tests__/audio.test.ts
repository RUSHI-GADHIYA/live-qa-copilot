import { SilenceGate } from '../audio/gate';
import { AudioPipeline } from '../audio/pipeline';
import { base64ToBytes, bytesToBase64, bytesToInt16, Downsampler48to24, int16ToBytes, rms } from '../audio/pcm';

describe('base64', () => {
  it.each([0, 1, 2, 3, 4, 5, 100, 4801])('round-trips %i bytes and matches Node', (n) => {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe(Buffer.from(bytes).toString('base64'));
    expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes));
  });

  it('decodes PCM16 little-endian samples', () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768]);
    expect(Array.from(bytesToInt16(base64ToBytes(bytesToBase64(int16ToBytes(samples)))))).toEqual(Array.from(samples));
  });
});

describe('Downsampler48to24', () => {
  it('averages sample pairs and carries an odd sample into the next chunk', () => {
    const d = new Downsampler48to24();
    expect(Array.from(d.push(Int16Array.from([10, 20, 30])))).toEqual([15]);
    expect(Array.from(d.push(Int16Array.from([40, 50, 60])))).toEqual([35, 55]);
  });

  it('keeps a 440 Hz tone at the same level and halves the sample count', () => {
    const input = Int16Array.from({ length: 48000 }, (_, i) => Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 48000)));
    const out = new Downsampler48to24().push(input);
    expect(out.length).toBe(24000);
    expect(rms(out)).toBeCloseTo(rms(input), 2);
  });
});

describe('SilenceGate', () => {
  const chunk = (level: number) => Int16Array.from({ length: 2400 }, (_, i) => Math.round(level * 32767 * Math.sin(i / 3)));

  it('sends speech with 300 ms before and 800 ms after, and nothing during silence', () => {
    const gate = new SilenceGate();
    const sent: Int16Array[] = [];
    const input = [...Array(10).fill(chunk(0.001)), ...Array(5).fill(chunk(0.3)), ...Array(20).fill(chunk(0.001))];
    for (const c of input) sent.push(...gate.push(c));
    expect(sent.length).toBe(3 + 5 + 8);
    expect(sent.slice(3, 8).every((c) => rms(c) > 0.1)).toBe(true);
  });
});

describe('AudioPipeline', () => {
  it('downsamples 48 kHz input and can bypass the gate', () => {
    const received: number[] = [];
    let skip = false;
    const pipeline = new AudioPipeline((pcm) => received.push(pcm.length), () => skip);
    pipeline.push48k(new Int16Array(4800)); // silence passes when the gate is off
    skip = true;
    pipeline.push48k(new Int16Array(4800)); // ...and is held back when it is on
    expect(received).toEqual([2400]);
  });
});
