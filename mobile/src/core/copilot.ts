import { makeAnswerStreamer } from './agent';
import { AudioPipeline } from './audio/pipeline';
import { DEFAULT_SETTINGS, KEYWORD_MODELS, type Settings } from './config';
import { ContextStore, type ContextStorage } from './contextStore';
import { makeClassifier } from './detector';
import { OpenAIClient, type FetchLike } from './openai';
import { Session, type SessionEvent } from './session';
import { RealtimeTranscriber, type SocketFactory } from './transcriber';

export interface CopilotOptions {
  apiKey: string;
  fetch: FetchLike;
  socketFactory: SocketFactory;
  emit: (event: SessionEvent) => void;
  settings?: Settings;
  contextStorage?: ContextStorage;
  log?: (message: string) => void;
}

const WARM_INTERVAL_MS = 45_000;

/**
 * Everything the app needs, wired together: microphone audio in, conversation events out.
 * The phone app and the live Node test both use this class, so the test exercises the real wiring.
 */
export class Copilot {
  readonly client: OpenAIClient;
  readonly context: ContextStore;
  settings: Settings;
  private session: Session;
  private transcriber: RealtimeTranscriber | null = null;
  private readonly pipeline: AudioPipeline;
  private warmTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: CopilotOptions) {
    this.settings = options.settings ?? DEFAULT_SETTINGS;
    this.client = new OpenAIClient(options.apiKey, options.fetch);
    this.context = new ContextStore(
      (texts) => this.client.embed(this.settings.embeddingModel, texts),
      options.contextStorage,
    );
    this.session = this.newSession();
    this.pipeline = new AudioPipeline(
      (pcm) => this.transcriber?.sendAudio(pcm),
      () => this.settings.skipSilence,
    );
  }

  private newSession(): Session {
    return new Session({
      classify: makeClassifier(this.client, () => this.settings.detectorModel),
      streamAnswer: makeAnswerStreamer(this.client, () => this.settings.answerModel),
      passages: (query) => this.context.passages(query),
      emit: this.options.emit,
      speculative: () => this.settings.speculativeAnswers,
      maxConcurrentAnswers: this.settings.maxConcurrentAnswers,
      log: this.options.log,
    });
  }

  get listening(): boolean {
    return this.transcriber !== null;
  }

  async startListening(): Promise<void> {
    if (this.transcriber) return;
    const { transcribeModel, vadSilenceMs } = this.settings;
    const { emit, log } = this.options;
    const transcriber = new RealtimeTranscriber({
      apiKey: this.options.apiKey,
      socketFactory: this.options.socketFactory,
      model: transcribeModel,
      vadSilenceMs,
      keywords: KEYWORD_MODELS.has(transcribeModel) ? this.context.keywords() : undefined,
      onPartial: (utteranceId, text) => emit({ type: 'transcript_partial', utteranceId, text }),
      onFinal: (utteranceId, text) => {
        emit({ type: 'transcript_final', utteranceId, text });
        void this.session.submitUtterance(text, utteranceId);
      },
      onError: (message) => emit({ type: 'error', message }),
      log,
    });
    await transcriber.start();
    this.transcriber = transcriber;
    this.warm();
    this.warmTimer = setInterval(() => this.warm(), WARM_INTERVAL_MS);
    emit({ type: 'listening', active: true });
  }

  stopListening(): void {
    if (this.warmTimer) clearInterval(this.warmTimer);
    this.warmTimer = null;
    const transcriber = this.transcriber;
    this.transcriber = null;
    transcriber?.close();
    this.options.emit({ type: 'listening', active: false });
  }

  /** Microphone audio: 48 kHz mono PCM16. */
  pushAudio48k(samples: Int16Array): void {
    if (this.transcriber) this.pipeline.push48k(samples);
  }

  /** A typed question: skips the detector. */
  ask(question: string): void {
    this.session.ask(question);
  }

  /** A typed utterance that goes through the detector, like speech. */
  submitUtterance(text: string): Promise<void> {
    return this.session.submitUtterance(text);
  }

  clearConversation(): void {
    this.session.close();
    this.session = this.newSession();
  }

  /** Keep a connection each warm for the detector and the answer, which run at the same time. */
  private warm(): void {
    void Promise.all([this.client.warm(this.settings.detectorModel), this.client.warm(this.settings.answerModel)]);
  }
}
