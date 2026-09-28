import { Downsampler48to24 } from './pcm';
import { SilenceGate } from './gate';

/** Microphone audio (48 kHz PCM16) → 24 kHz for the Realtime API → optional silence gate → sink. */
export class AudioPipeline {
  private readonly downsampler = new Downsampler48to24();
  private readonly gate = new SilenceGate();

  constructor(
    private readonly sink: (pcm24k: Int16Array) => void,
    private readonly skipSilence: () => boolean,
  ) {}

  push48k(samples: Int16Array): void {
    const pcm24k = this.downsampler.push(samples);
    if (!pcm24k.length) return;
    for (const chunk of this.skipSilence() ? this.gate.push(pcm24k) : [pcm24k]) this.sink(chunk);
  }
}
