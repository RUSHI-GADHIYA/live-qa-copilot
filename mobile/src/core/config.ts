/** User-adjustable settings. Defaults match the tuned web app (see personal_live_copilot/README.md). */
export interface Settings {
  transcribeModel: string;
  detectorModel: string;
  answerModel: string;
  embeddingModel: string;
  /** Silence that ends a turn. Raise it if slow speakers get cut off mid-sentence. */
  vadSilenceMs: number;
  /** Start answering while the detector runs; the answer is shown only if the utterance is a question. */
  speculativeAnswers: boolean;
  /** Only send audio while someone is speaking (lower cost, no accuracy loss). */
  skipSilence: boolean;
  maxConcurrentAnswers: number;
}

export const DEFAULT_SETTINGS: Settings = {
  transcribeModel: 'gpt-transcribe',
  detectorModel: 'gpt-4o-mini',
  answerModel: 'gpt-4.1',
  embeddingModel: 'text-embedding-3-small',
  vadSilenceMs: 400,
  speculativeAnswers: true,
  skipSilence: true,
  maxConcurrentAnswers: 3,
};

/** Context sizing: all text in the prompt up to FULL_CONTEXT_CHARS, retrieval above it. */
export const CONTEXT_LIMITS = {
  maxContextChars: 2_000_000,
  fullContextChars: 24_000,
  /** In retrieval mode, documents this small (a resume, a job description) are always sent whole. */
  pinDocChars: 8_000,
  retrievalTopK: 6,
  /** Smaller vectors keep the on-device index light; retrieval quality stays good. */
  embeddingDimensions: 512,
};

/** gpt-5.x / o-series models reason by default; for live answers we want the fastest setting. */
export function reasoningFor(model: string): { effort: string } | undefined {
  if (model.startsWith('gpt-5')) return { effort: 'none' };
  if (/^o\d/.test(model)) return { effort: 'low' };
  return undefined;
}

/** Models that accept transcription `keywords` (names and terms to spell correctly). */
export const KEYWORD_MODELS = new Set(['gpt-transcribe', 'gpt-live-transcribe']);
