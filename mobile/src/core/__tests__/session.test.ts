import { sleep } from '../__fixtures__/fakes';
import type { AnswerStreamer } from '../agent';
import type { Passage } from '../contextStore';
import type { Classifier } from '../detector';
import { Session, type SessionDeps, type SessionEvent } from '../session';

function makeSession(overrides: Partial<SessionDeps> = {}) {
  const events: SessionEvent[] = [];
  const session = new Session({
    classify: async (text) => (text.includes('?') ? 'question' : 'other'),
    streamAnswer: async function* (q) {
      yield `a:${q}`;
    },
    passages: async () => [],
    emit: (e) => events.push(e),
    speculative: () => true,
    maxConcurrentAnswers: 3,
    ...overrides,
  });
  return { session, events };
}

async function until(events: SessionEvent[], done: number, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (events.filter((e) => e.type === 'answer_done').length < done) {
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(events)}`);
    await sleep(5);
  }
}

const text = (events: SessionEvent[]) => {
  const out: Record<number, string> = {};
  for (const e of events) if (e.type === 'answer_delta') out[e.questionId] = (out[e.questionId] ?? '') + e.delta;
  return out;
};

it('streams answers into their own cards even when they finish out of order', async () => {
  const { session, events } = makeSession({
    streamAnswer: async function* (q) {
      for (const w of ['ans', '-', q]) {
        await sleep(q.includes('slow') ? 60 : 1);
        yield w;
      }
    },
  });
  session.ask('slow one');
  session.ask('fast two');
  await until(events, 2);
  expect(events.filter((e) => e.type === 'answer_done').map((e) => (e as any).questionId)).toEqual([2, 1]);
  expect(text(events)).toEqual({ 1: 'ans-slow one', 2: 'ans-fast two' });
});

it('creates cards in utterance order, skips non-questions and reports detector failures', async () => {
  const classify: Classifier = async (t) => {
    if (t.includes('boom')) throw new Error('api down');
    await sleep(t.includes('first') ? 60 : 1);
    return t.includes('?') ? 'question' : 'other';
  };
  const { session, events } = makeSession({ classify });
  for (const t of ['first slow question?', 'just a statement', 'boom', 'second quick one?']) session.submitUtterance(t);
  await until(events, 2);
  const cards = events.filter((e) => e.type === 'question_detected').map((e: any) => [e.questionId, e.text]);
  expect(cards).toEqual([
    [1, 'first slow question?'],
    [2, 'second quick one?'],
  ]);
  expect(events.some((e) => e.type === 'error' && e.message.includes('api down'))).toBe(true);
  expect(events.some((e) => e.type === 'utterance_ignored' && e.reason === 'not a question')).toBe(true);
});

it.each([true, false])('keeps a speculative answer hidden until confirmed (speculative=%s)', async (speculative) => {
  const started: string[] = [];
  const { session, events } = makeSession({
    speculative: () => speculative,
    classify: async (t) => {
      await sleep(30); // the answer streams fully before the detector decides
      return t.includes('?') ? 'question' : 'other';
    },
    streamAnswer: async function* (q) {
      started.push(q);
      yield 'one ';
      yield 'two ';
      yield 'three';
    },
  });
  session.submitUtterance('not a question');
  session.submitUtterance('is it?');
  await until(events, 1);
  const visible = events.filter((e) => e.type !== 'utterance_ignored').map((e) => e.type);
  expect(visible[0]).toBe('question_detected'); // nothing leaks before the card exists
  // Speculative text was held back and goes out as one delta; otherwise it streams live after the card.
  const deltas = speculative ? ['answer_delta'] : ['answer_delta', 'answer_delta', 'answer_delta'];
  expect(visible).toEqual(['question_detected', 'answer_sources', ...deltas, 'answer_done']);
  expect(text(events)).toEqual({ 1: 'one two three' });
  expect(started).toEqual(speculative ? ['not a question', 'is it?'] : ['is it?']);
});

it('cancels a rejected speculation mid-stream', async () => {
  let aborted = false;
  const streamAnswer: AnswerStreamer = async function* (_q, _p, _h, signal) {
    signal.addEventListener('abort', () => (aborted = true));
    while (!signal.aborted) {
      await sleep(2);
      yield 'x';
    }
  };
  const { session, events } = makeSession({
    streamAnswer,
    classify: async () => {
      await sleep(20);
      return 'other';
    },
  });
  await session.submitUtterance('we should grab lunch');
  await sleep(20);
  expect(aborted).toBe(true);
  expect(events).toEqual([{ type: 'utterance_ignored', utteranceId: undefined, text: 'we should grab lunch', reason: 'not a question' }]);
});

it('ignores the listener reading the answer, handles repeats, and answers follow-ups with history', async () => {
  const classified: string[] = [];
  const histories: unknown[] = [];
  const { session, events } = makeSession({
    speculative: () => false,
    classify: async (t) => {
      classified.push(t);
      return t.includes('again') ? 'repeat' : 'question';
    },
    streamAnswer: async function* (_q, _p, history) {
      histories.push(history);
      yield 'The refund window is 45 days from delivery, ';
      yield 'and refunds go to the original payment method.';
    },
  });
  await session.submitUtterance('what is the refund window?', 'u1');
  await until(events, 1);
  await session.submitUtterance('so the refund window is 45 days from delivery and refunds go to the original payment method', 'u2');
  await session.submitUtterance('sorry what was that again', 'u3');
  await session.submitUtterance('and what about exchanges?', 'u4');
  await until(events, 2);
  const ignored = events.filter((e) => e.type === 'utterance_ignored') as any[];
  expect(ignored.map((e) => [e.utteranceId, e.reason, e.questionId])).toEqual([
    ['u2', 'reading answer', undefined],
    ['u3', 'repeat', 1],
  ]);
  expect(classified).toEqual(['what is the refund window?', 'sorry what was that again', 'and what about exchanges?']);
  expect(events.find((e) => e.type === 'question_detected' && e.questionId === 2)).toMatchObject({ utteranceId: 'u4' });
  expect(histories[1]).toEqual([
    { role: 'user', content: 'what is the refund window?' },
    { role: 'assistant', content: 'The refund window is 45 days from delivery, and refunds go to the original payment method.' },
  ]);
});

it('caps concurrent answers and keeps card order', async () => {
  let active = 0;
  let peak = 0;
  const { session, events } = makeSession({
    streamAnswer: async function* (q) {
      active++;
      peak = Math.max(peak, active);
      try {
        for (let i = 0; i < 3; i++) {
          await sleep(10);
          yield q.slice(-1);
        }
      } finally {
        active--;
      }
    },
  });
  for (let i = 1; i <= 5; i++) session.ask(`q${i}`);
  await until(events, 5);
  expect(peak).toBe(3);
  expect(text(events)).toEqual({ 1: '111', 2: '222', 3: '333', 4: '444', 5: '555' });
});

it('sends sources before any answer text and uses the previous question for retrieval', async () => {
  const queries: string[] = [];
  const passages: Passage[] = [{ n: 1, docName: 'policy.txt', text: 'The refund window is 45 days.' }];
  const { session, events } = makeSession({
    passages: async (q) => {
      queries.push(q);
      return passages;
    },
    streamAnswer: async function* () {
      yield '45 days [1]';
    },
  });
  session.ask('what is the refund window?');
  await until(events, 1);
  session.ask('is that the same for exchanges?');
  await until(events, 2);
  expect(events.slice(0, 4).map((e) => e.type)).toEqual(['question_detected', 'answer_sources', 'answer_delta', 'answer_done']);
  expect(events[1]).toEqual({ type: 'answer_sources', questionId: 1, sources: [{ n: 1, doc: 'policy.txt', snippet: 'The refund window is 45 days.' }] });
  expect(queries[1]).toBe('what is the refund window?\nis that the same for exchanges?');
});

it('shows an answer error on its card', async () => {
  const { session, events } = makeSession({
    streamAnswer: async function* () {
      throw new Error('rate limited');
    },
  });
  session.ask('q?');
  await sleep(20);
  expect(events.at(-1)).toEqual({ type: 'error', questionId: 1, message: 'rate limited' });
});
