// Sends audio only while someone is speaking, to cut Realtime transcription cost during silence.
// Works on the 100 ms PCM16 chunks from pcm-worklet.js. Keeps 300 ms before speech (so first words are not
// clipped) and 800 ms after it (so the server's turn detection still sees the pause that ends a turn).
class SilenceGate {
  constructor({ preRollChunks = 3, hangoverChunks = 8, minRms = 0.003, floorRatio = 2.5 } = {}) {
    this.preRollChunks = preRollChunks;
    this.hangoverChunks = hangoverChunks;
    this.minRms = minRms; // about -50 dBFS: never treat anything quieter as speech
    this.floorRatio = floorRatio; // speech must be this much louder than the background
    this.floor = null; // running estimate of background noise
    this.preRoll = [];
    this.hangover = 0;
  }

  static rms(int16) {
    let sum = 0;
    for (let i = 0; i < int16.length; i++) sum += int16[i] * int16[i];
    return Math.sqrt(sum / int16.length) / 32768;
  }

  // Returns the chunks to send now (possibly none), in order.
  push(chunk) {
    const level = SilenceGate.rms(new Int16Array(chunk));
    const threshold = Math.max(this.minRms, (this.floor ?? this.minRms) * this.floorRatio);
    const voiced = level > threshold;
    if (!voiced) {
      // Track the background: drop quickly to quieter levels, rise slowly.
      this.floor = this.floor === null ? level : level < this.floor ? level : this.floor + (level - this.floor) * 0.02;
    }
    if (voiced) {
      const out = [...this.preRoll, chunk];
      this.preRoll = [];
      this.hangover = this.hangoverChunks;
      return out;
    }
    if (this.hangover > 0) {
      this.hangover--;
      return [chunk];
    }
    this.preRoll.push(chunk);
    if (this.preRoll.length > this.preRollChunks) this.preRoll.shift();
    return [];
  }
}

if (typeof module !== "undefined") module.exports = { SilenceGate };
