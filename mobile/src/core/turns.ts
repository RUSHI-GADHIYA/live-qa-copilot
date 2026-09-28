/** Conversation history for one session, and the filter that spots the listener reading an answer aloud. Port of turns.py. */

export const READBACK_THRESHOLD = 0.5; // share of the utterance's word pairs found in a recent answer
export const READBACK_WINDOW_MS = 180_000; // answers older than this no longer count
export const READBACK_MIN_WORDS = 4; // shorter utterances only count when they appear word for word
export const READBACK_FRAGMENT_WORDS = 2; // ...down to this many words (pauses split read-aloud answers into fragments)

export interface Exchange {
  questionId: number;
  question: string;
  answer: string;
  askedAt: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function words(text: string): string[] {
  // Citation markers are shown on screen, never said aloud.
  return text.replace(/\[\d+\]/g, ' ').toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

function bigrams(list: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < list.length; i++) out.add(`${list[i]} ${list[i + 1]}`);
  return out;
}

export class Conversation {
  private exchanges: Exchange[] = [];
  private other: string[] = []; // recent non-question utterances

  constructor(
    private readonly maxExchanges = 8,
    private readonly maxOther = 4,
    private readonly now: () => number = Date.now,
  ) {}

  addQuestion(questionId: number, question: string): void {
    this.exchanges.push({ questionId, question, answer: '', askedAt: this.now() });
    if (this.exchanges.length > this.maxExchanges) this.exchanges.shift();
  }

  /** Answers are recorded while they stream: the listener may start reading before they finish. */
  appendAnswer(questionId: number, delta: string): void {
    const exchange = this.exchanges.find((e) => e.questionId === questionId);
    if (exchange) exchange.answer += delta;
  }

  addOther(text: string): void {
    this.other.push(text);
    if (this.other.length > this.maxOther) this.other.shift();
  }

  get lastQuestionId(): number | undefined {
    return this.exchanges.at(-1)?.questionId;
  }

  /** How much of the utterance is recent answer text being read aloud (0..1). */
  readbackScore(utterance: string): number {
    const spoken = words(utterance);
    const cutoff = this.now() - READBACK_WINDOW_MS;
    const answers = this.exchanges.filter((e) => e.askedAt >= cutoff).map((e) => words(e.answer));
    if (spoken.length < READBACK_MIN_WORDS) {
      if (spoken.length < READBACK_FRAGMENT_WORDS) return 0;
      const fragment = ` ${spoken.join(' ')} `;
      return answers.some((a) => ` ${a.join(' ')} `.includes(fragment)) ? 1 : 0;
    }
    const answerPairs = new Set<string>();
    for (const answer of answers) for (const pair of bigrams(answer)) answerPairs.add(pair);
    const pairs = bigrams(spoken);
    let hits = 0;
    for (const pair of pairs) if (answerPairs.has(pair)) hits++;
    return pairs.size ? hits / pairs.size : 0;
  }

  isReadback(utterance: string): boolean {
    return this.readbackScore(utterance) >= READBACK_THRESHOLD;
  }

  detectorHistory(maxTurns = 6, answerChars = 300): [string, string][] {
    const turns: [string, string][] = [];
    for (const exchange of this.exchanges.slice(-3)) {
      turns.push(['QUESTION', exchange.question]);
      if (exchange.answer) turns.push(['SUGGESTED ANSWER', exchange.answer.slice(0, answerChars)]);
    }
    for (const text of this.other) turns.push(['OTHER', text]);
    return turns.slice(-maxTurns);
  }

  /** Earlier questions and answers as chat messages, so follow-up questions resolve. */
  answerHistory(beforeQuestionId = Infinity, maxPairs = 4): ChatMessage[] {
    const earlier = this.exchanges.filter((e) => e.questionId < beforeQuestionId && e.answer).slice(-maxPairs);
    return earlier.flatMap((e): ChatMessage[] => [
      { role: 'user', content: e.question },
      { role: 'assistant', content: e.answer },
    ]);
  }
}
