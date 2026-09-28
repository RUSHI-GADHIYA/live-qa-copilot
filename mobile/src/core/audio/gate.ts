import { rms } from './pcm';

/**
 * Passes audio only while someone is speaking, to cut Realtime transcription cost during silence.
 * Port of the web app's static/gate.js. Works on ~100 ms chunks: keeps 300 ms before speech (so first words
 * are not clipped) and 800 ms after it (so the server's turn detection still sees the pause that ends a turn).
 */
export class SilenceGate {
  private floor: number | null = null; // running estimate of background noise
  private preRoll: Int16Array[] = [];
  private hangover = 0;

  constructor(
    private readonly preRollChunks = 3,
    private readonly hangoverChunks = 8,
    private readonly minRms = 0.003, // about -50 dBFS: never treat anything quieter as speech
    private readonly floorRatio = 2.5, // speech must be this much louder than the background
  ) {}

  /** Returns the chunks to send now (possibly none), in order. */
  push(chunk: Int16Array): Int16Array[] {
    const level = rms(chunk);
    const threshold = Math.max(this.minRms, (this.floor ?? this.minRms) * this.floorRatio);
    if (level > threshold) {
      const out = [...this.preRoll, chunk];
      this.preRoll = [];
      this.hangover = this.hangoverChunks;
      return out;
    }
    // Track the background: drop quickly to quieter levels, rise slowly.
    this.floor = this.floor === null || level < this.floor ? level : this.floor + (level - this.floor) * 0.02;
    if (this.hangover > 0) {
      this.hangover--;
      return [chunk];
    }
    this.preRoll.push(chunk);
    if (this.preRoll.length > this.preRollChunks) this.preRoll.shift();
    return [];
  }
}
