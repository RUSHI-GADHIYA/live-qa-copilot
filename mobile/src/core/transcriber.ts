import { bytesToBase64, int16ToBytes } from './audio/pcm';

/** The subset of the WebSocket API used here. React Native's WebSocket and the `ws` package both fit. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

/** Opens a socket with headers (the Realtime API authenticates with an Authorization header). */
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export interface TranscriberOptions {
  apiKey: string;
  socketFactory: SocketFactory;
  model: string;
  vadSilenceMs: number;
  /** Names and terms from the documents, so they are spelled the way the documents do. */
  keywords?: string[];
  onPartial: (utteranceId: string, textSoFar: string) => void;
  onFinal: (utteranceId: string, text: string) => void;
  onError: (message: string) => void;
  log?: (message: string) => void;
}

const URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const OPEN = 1;

export function sessionConfig(model: string, vadSilenceMs: number, keywords?: string[]) {
  return {
    type: 'transcription',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        transcription: { model, ...(keywords?.length ? { keywords } : {}) },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: vadSilenceMs,
        },
        // A phone lying on a table hears speakers from a distance.
        noise_reduction: { type: 'far_field' },
      },
    },
  };
}

/** Streams 24 kHz PCM16 to an OpenAI Realtime transcription session. Port of the web app's transcriber.py. */
export class RealtimeTranscriber {
  private socket: SocketLike | null = null;
  private partials = new Map<string, string>();
  private speechStoppedAt: number | null = null;

  constructor(private readonly options: TranscriberOptions) {}

  /** Resolves once the session is configured; rejects if the API refuses the connection or the settings. */
  start(): Promise<void> {
    const { apiKey, socketFactory, model, vadSilenceMs, keywords } = this.options;
    return new Promise((resolve, reject) => {
      let ready = false;
      const socket = socketFactory(URL, { Authorization: `Bearer ${apiKey}` });
      this.socket = socket;
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'session.update', session: sessionConfig(model, vadSilenceMs, keywords) }));
      };
      socket.onmessage = (message) => {
        const event = JSON.parse(String(message.data));
        if (!ready) {
          if (event.type === 'session.updated') {
            ready = true;
            resolve();
          } else if (event.type === 'error') {
            reject(new Error(event.error?.message ?? 'Transcription session was refused'));
            this.close();
          }
          return;
        }
        this.handle(event);
      };
      socket.onerror = (event) => {
        const message = (event as { message?: string })?.message ?? 'connection error';
        if (!ready) reject(new Error(`Could not connect to transcription: ${message}`));
        else this.options.onError(`Transcription connection error: ${message}`);
      };
      socket.onclose = () => {
        if (!ready) reject(new Error('Transcription connection closed before it was ready'));
        else if (this.socket === socket) this.options.onError('Transcription connection lost');
        this.socket = null;
      };
    });
  }

  sendAudio(pcm24k: Int16Array): void {
    if (this.socket?.readyState !== OPEN) return;
    this.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: bytesToBase64(int16ToBytes(pcm24k)) }));
  }

  close(): void {
    const socket = this.socket;
    this.socket = null; // closing on purpose: onclose must not report a lost connection
    socket?.close();
  }

  private handle(event: any): void {
    switch (event.type) {
      case 'input_audio_buffer.speech_stopped':
        this.speechStoppedAt = Date.now();
        break;
      case 'conversation.item.input_audio_transcription.delta': {
        const text = (this.partials.get(event.item_id) ?? '') + (event.delta ?? '');
        this.partials.set(event.item_id, text);
        this.options.onPartial(event.item_id, text);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        this.partials.delete(event.item_id);
        if (this.speechStoppedAt !== null) {
          this.options.log?.(`transcript final ${Date.now() - this.speechStoppedAt} ms after speech stopped`);
        }
        const text = String(event.transcript ?? '').trim();
        if (text) this.options.onFinal(event.item_id, text);
        break;
      }
      case 'conversation.item.input_audio_transcription.failed':
        this.partials.delete(event.item_id);
        this.options.onError(`Transcription failed: ${event.error?.message ?? 'unknown error'}`);
        break;
      case 'error':
        this.options.onError(`Realtime API error: ${event.error?.message ?? 'unknown error'}`);
        break;
    }
  }
}
