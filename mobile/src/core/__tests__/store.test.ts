import type { SessionEvent } from '../session';
import { grounding, reduce, type TimelineItem } from '../../store';

const run = (events: SessionEvent[]) => events.reduce<TimelineItem[]>(reduce, []);

it('shows what was said in order, turning a spoken question into its card in place', () => {
  const items = run([
    { type: 'transcript_partial', utteranceId: 'u1', text: 'what is' },
    { type: 'transcript_final', utteranceId: 'u1', text: 'what is the refund window?' },
    { type: 'transcript_final', utteranceId: 'u2', text: 'we should grab lunch' },
    { type: 'question_detected', questionId: 1, utteranceId: 'u1', text: 'what is the refund window?' },
    { type: 'utterance_ignored', utteranceId: 'u2', text: 'we should grab lunch', reason: 'not a question' },
    { type: 'answer_sources', questionId: 1, sources: [{ n: 1, doc: 'policy.txt', snippet: '45 days' }] },
    { type: 'answer_delta', questionId: 1, delta: '45 days ' },
    { type: 'answer_delta', questionId: 1, delta: '[1].' },
    { type: 'answer_done', questionId: 1 },
  ]);
  expect(items.map((i) => i.kind)).toEqual(['card', 'utterance']);
  expect(items[0]).toMatchObject({ question: 'what is the refund window?', answer: '45 days [1].', state: 'done' });
  expect(items[1]).toMatchObject({ text: 'we should grab lunch', ignored: 'not a question', partial: false });
});

it('pulses the card of a repeated question and shows answer errors on their card', () => {
  const items = run([
    { type: 'question_detected', questionId: 1, text: 'q' },
    { type: 'utterance_ignored', text: 'sorry, again?', reason: 'repeat', questionId: 1 },
    { type: 'error', questionId: 1, message: 'rate limited' },
  ]);
  expect(items[0]).toMatchObject({ pulse: 1, state: 'error', error: 'rate limited' });
  expect(items[1]).toMatchObject({ kind: 'utterance', ignored: 'repeat' });
});

it('labels grounding: cited sources, general knowledge, or not in your notes', () => {
  const card = (answer: string, docs = 1) =>
    ({ kind: 'card', key: 'k', questionId: 1, question: 'q', answer, state: 'done', pulse: 0,
       sources: Array.from({ length: docs }, (_, i) => ({ n: i + 1, doc: `d${i + 1}`, snippet: '' })) }) as const;
  expect(grounding({ ...card('Yes [2].', 2), sources: [...card('', 2).sources] }).cited.map((s) => s.doc)).toEqual(['d2']);
  expect(grounding({ ...card('Leonardo.'), sources: [...card('').sources] }).label).toBe('general');
  expect(grounding({ ...card('Not in your notes: Kubernetes.'), sources: [...card('').sources] }).label).toBe('missing');
  expect(grounding({ ...card('Leonardo.', 0), sources: [] }).label).toBeNull();
});
