// Converts mic audio to 24 kHz mono PCM16 and posts ~100 ms chunks to the main thread.
const TARGET_RATE = 24000;
const CHUNK_SAMPLES = 2400;

class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // 1 when the AudioContext honoured 24 kHz
    this.pos = 0; // fractional read position within the current block
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outLen = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    // Linear resampling (a no-op copy when ratio is 1).
    while (this.pos < input.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = input[i];
      const b = i + 1 < input.length ? input[i + 1] : input[i];
      const s = Math.max(-1, Math.min(1, a + (b - a) * frac));
      this.out[this.outLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.outLen === CHUNK_SAMPLES) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(CHUNK_SAMPLES);
        this.outLen = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
