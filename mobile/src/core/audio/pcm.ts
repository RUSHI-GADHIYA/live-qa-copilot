/** PCM16 helpers. Platform-independent (no atob/btoa/Buffer), so they behave the same on Hermes and in Node. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(128);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + '=';
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (LOOKUP[clean.charCodeAt(i)] << 18) |
      (LOOKUP[clean.charCodeAt(i + 1)] << 12) |
      ((i + 2 < clean.length ? LOOKUP[clean.charCodeAt(i + 2)] : 0) << 6) |
      (i + 3 < clean.length ? LOOKUP[clean.charCodeAt(i + 3)] : 0);
    out[o++] = n >> 16;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

/** Little-endian PCM16 bytes as samples (Android and Node are little-endian). */
export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const copy = bytes.slice(0, bytes.length - (bytes.length % 2)); // aligned copy
  return new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2);
}

export function int16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * 48 kHz → 24 kHz. Averaging each pair of samples is a simple low-pass before dropping every other one,
 * enough for speech. An odd sample left at the end of a chunk is carried into the next chunk.
 */
export class Downsampler48to24 {
  private carry: number | null = null;

  push(input: Int16Array): Int16Array {
    const samples = this.carry === null ? input : prepend(this.carry, input);
    const pairs = Math.floor(samples.length / 2);
    const out = new Int16Array(pairs);
    for (let i = 0; i < pairs; i++) out[i] = (samples[2 * i] + samples[2 * i + 1]) >> 1;
    this.carry = samples.length % 2 ? samples[samples.length - 1] : null;
    return out;
  }
}

function prepend(first: number, rest: Int16Array): Int16Array {
  const out = new Int16Array(rest.length + 1);
  out[0] = first;
  out.set(rest, 1);
  return out;
}

/** Root-mean-square level in [0, 1]. */
export function rms(samples: Int16Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length) / 32768;
}
