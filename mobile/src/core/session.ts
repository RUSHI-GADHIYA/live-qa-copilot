import type { AnswerStreamer } from './agent';
import type { Passage } from './contextStore';
import type { Classifier } from './detector';
import { Conversation, type ChatMessage } from './turns';

export interface Source {
  n: number;
  doc: string;
  snippet: string;
}

/** Same event types as the web app's WebSocket protocol. */
export type SessionEvent =
  | { type: 'listening'; active: boolean }
  | { type: 'transcript_partial'; utteranceId: string; text: string }
  | { type: 'transcript_final'; utteranceId: string; text: string }
  | { type: 'utterance_ignored'; utteranceId?: string; text: string; reason: 'reading answer' | 'repeat' | 'not a question'; questionId?: number }
  | { type: 'question_detected'; questionId: number; utteranceId?: string; text: string }
  | { type: 'answer_sources'; questionId: number; sources: Source[] }
  | { type: 'answer_delta'; questionId: number; delta: string }
  | { type: 'answer_done'; questionId: number }
  | { type: 'error'; message: string; questionId?: number };

export interface SessionDeps {
  classify: Classifier;
  streamAnswer: AnswerStreamer;
  passages: (query: string) => Promise<Passage[]>;
  emit: (event: SessionEvent) => void;
  speculative: () => boolean;
  maxConcurrentAnswers: number;
  log?: (message: string) => void;
}

/** Limits simultaneous answer streams (rate-limit protection); extra questions wait their turn. */
class Semaphore {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}

  async acquire(signal: AbortSignal): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener('abort', cancel);
        resolve();
      };
      const cancel = () => {
        this.waiting = this.waiting.filter((w) => w !== grant);
        reject(abortError());
      };
      this.waiting.push(grant);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free++;
  }
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function isAbort(error: unknown): boolean {
  return (error as Error)?.name === 'AbortError';
}

/**
 * The conversation pipeline for one listening session (port of the web app's Session/AnswerStream).
 * Utterances are classified in parallel, but cards are created in the order they were spoken.
 */
export class Session {
  readonly conversation = new Conversation();
  private nextQuestionId = 1;
  private tail: Promise<void> = Promise.resolve();
  private readonly slots: Semaphore;
  private readonly answers = new Set<AnswerStream>();

  constructor(private readonly deps: SessionDeps) {
    this.slots = new Semaphore(deps.maxConcurrentAnswers);
  }

  /** A finished transcript line (or a typed utterance). */
  submitUtterance(text: string, utteranceId?: string): Promise<void> {
    const previous = this.tail;
    const handled = this.handleUtterance(text, utteranceId, previous);
    this.tail = handled.catch(() => undefined);
    return handled;
  }

  private async handleUtterance(text: string, utteranceId: string | undefined, previous: Promise<void>): Promise<void> {
    const { emit } = this.deps;
    // The listener reading a suggested answer aloud is never a new question; no API call needed.
    if (this.conversation.isReadback(text)) {
      await previous;
      emit({ type: 'utterance_ignored', utteranceId, text, reason: 'reading answer' });
      return;
    }
    // Speculatively start the answer so it overlaps the detector call; it stays hidden until confirmed.
    let answer: AnswerStream | undefined = this.deps.speculative() ? this.startAnswer(text) : undefined;
    try {
      const started = Date.now();
      let label: Awaited<ReturnType<Classifier>> = 'other';
      try {
        label = await this.deps.classify(text, this.conversation.detectorHistory());
        this.deps.log?.(`detector ${Date.now() - started} ms: ${label} "${text}"`);
      } catch (error) {
        emit({ type: 'error', message: `Question detector failed: ${(error as Error).message}` });
      }
      await previous;
      if (label === 'question') {
        this.ask(text, utteranceId, answer);
        answer = undefined;
      } else if (label === 'repeat') {
        emit({ type: 'utterance_ignored', utteranceId, text, reason: 'repeat', questionId: this.conversation.lastQuestionId });
      } else {
        this.conversation.addOther(text);
        emit({ type: 'utterance_ignored', utteranceId, text, reason: 'not a question' });
      }
    } finally {
      answer?.cancel();
    }
  }

  /** Creates the card immediately, so feed order matches ask order. Typed questions skip the detector. */
  ask(question: string, utteranceId?: string, answer?: AnswerStream): number {
    const questionId = this.nextQuestionId++;
    this.conversation.addQuestion(questionId, question);
    this.deps.emit({ type: 'question_detected', questionId, utteranceId, text: question });
    (answer ?? this.startAnswer(question)).attach(questionId);
    return questionId;
  }

  private startAnswer(question: string): AnswerStream {
    const stream = new AnswerStream(this, question, this.conversation.answerHistory());
    this.answers.add(stream);
    stream.done.finally(() => this.answers.delete(stream));
    return stream;
  }

  /** Cancels every answer in flight (used when the session ends). */
  close(): void {
    for (const answer of this.answers) answer.cancel();
  }

  /** @internal */
  get internals() {
    return { deps: this.deps, slots: this.slots };
  }
}

type HeldEvent = { type: 'answer_sources'; sources: Source[] } | { type: 'answer_delta'; delta: string };

/** One answer generation. Its events are held back until attach() binds it to a card, then delivered live. */
class AnswerStream {
  private questionId: number | undefined;
  private held: HeldEvent[] = [];
  private attached!: () => void;
  private readonly attachedPromise = new Promise<void>((resolve) => (this.attached = resolve));
  private readonly controller = new AbortController();
  private readonly created = Date.now();
  readonly done: Promise<void>;

  constructor(
    private readonly session: Session,
    private readonly question: string,
    private readonly history: ChatMessage[],
  ) {
    this.done = this.run();
  }

  attach(questionId: number): void {
    this.questionId = questionId;
    let merged = '';
    for (const event of this.held) {
      if (event.type === 'answer_delta') merged += event.delta; // held-back text goes out as one delta
      else this.deliver(event);
    }
    if (merged) this.deliver({ type: 'answer_delta', delta: merged });
    this.held = [];
    this.attached();
  }

  cancel(): void {
    this.controller.abort();
    this.attached(); // a finished but rejected speculation must not wait forever for a card
  }

  private hold(event: HeldEvent): void {
    if (this.questionId === undefined) this.held.push(event);
    else this.deliver(event);
  }

  private deliver(event: HeldEvent): void {
    const questionId = this.questionId!;
    if (event.type === 'answer_delta') this.session.conversation.appendAnswer(questionId, event.delta);
    this.session.internals.deps.emit({ ...event, questionId });
  }

  private retrievalQuery(): string {
    // Follow-ups like "is that the same for exchanges?" only make sense next to the previous question.
    const previous = this.history.filter((m) => m.role === 'user').slice(-1).map((m) => m.content);
    return [...previous, this.question].join('\n');
  }

  private async run(): Promise<void> {
    const { deps, slots } = this.session.internals;
    const signal = this.controller.signal;
    try {
      await slots.acquire(signal);
      try {
        const passages = await deps.passages(this.retrievalQuery());
        if (signal.aborted) throw abortError();
        this.hold({ type: 'answer_sources', sources: passages.map((p) => ({ n: p.n, doc: p.docName, snippet: p.text.slice(0, 240) })) });
        let first = true;
        for await (const delta of deps.streamAnswer(this.question, passages, this.history, signal)) {
          if (signal.aborted) throw abortError();
          if (first) {
            first = false;
            deps.log?.(`answer first token ${Date.now() - this.created} ms after start`);
          }
          this.hold({ type: 'answer_delta', delta });
        }
      } finally {
        slots.release();
      }
      await this.attachedPromise;
      if (signal.aborted) return;
      deps.emit({ type: 'answer_done', questionId: this.questionId! });
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      await this.attachedPromise; // errors only matter once there is a card to show them on
      if (signal.aborted) return;
      deps.emit({ type: 'error', questionId: this.questionId, message: (error as Error).message });
    }
  }
}
