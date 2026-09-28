import { create } from 'zustand';

import type { Source, SessionEvent } from '@/core/session';

export type TimelineItem =
  | { kind: 'utterance'; key: string; utteranceId?: string; text: string; partial: boolean; ignored?: string }
  | {
      kind: 'card';
      key: string;
      questionId: number;
      question: string;
      answer: string;
      sources: Source[];
      state: 'thinking' | 'streaming' | 'done' | 'error';
      error?: string;
      pulse: number; // bumped when the asker repeats this question
    };

interface ConversationState {
  items: TimelineItem[];
  listening: boolean;
  notice: string | null;
  apply: (event: SessionEvent) => void;
  clear: () => void;
  setNotice: (notice: string | null) => void;
}

type Card = Extract<TimelineItem, { kind: 'card' }>;

function updateCard(items: TimelineItem[], questionId: number, change: (card: Card) => Partial<Card>): TimelineItem[] {
  return items.map((item) => (item.kind === 'card' && item.questionId === questionId ? { ...item, ...change(item) } : item));
}

function utteranceIndex(items: TimelineItem[], utteranceId?: string): number {
  return utteranceId === undefined ? -1 : items.findIndex((i) => i.kind === 'utterance' && i.utteranceId === utteranceId);
}

/** Turns session events into the conversation timeline: what was said, in order, with answer cards in place. */
export function reduce(items: TimelineItem[], event: SessionEvent): TimelineItem[] {
  switch (event.type) {
    case 'transcript_partial':
    case 'transcript_final': {
      const partial = event.type === 'transcript_partial';
      const index = utteranceIndex(items, event.utteranceId);
      if (index < 0) return [...items, { kind: 'utterance', key: `u-${event.utteranceId}`, utteranceId: event.utteranceId, text: event.text, partial }];
      return items.map((item, i) => (i === index ? { ...item, text: event.text, partial } : item));
    }
    case 'question_detected': {
      const card: Card = {
        kind: 'card',
        key: `q-${event.questionId}`,
        questionId: event.questionId,
        question: event.text,
        answer: '',
        sources: [],
        state: 'thinking',
        pulse: 0,
      };
      // A spoken question becomes its card, in the place where it was said.
      const index = utteranceIndex(items, event.utteranceId);
      return index < 0 ? [...items, card] : items.map((item, i) => (i === index ? card : item));
    }
    case 'utterance_ignored': {
      let next = items;
      const index = utteranceIndex(items, event.utteranceId);
      if (index >= 0) next = items.map((item, i) => (i === index ? { ...item, ignored: event.reason } : item));
      else next = [...items, { kind: 'utterance', key: `t-${Date.now()}-${items.length}`, text: event.text, partial: false, ignored: event.reason }];
      if (event.reason === 'repeat' && event.questionId !== undefined) {
        next = updateCard(next, event.questionId, (card) => ({ pulse: card.pulse + 1 }));
      }
      return next;
    }
    case 'answer_sources':
      return updateCard(items, event.questionId, () => ({ sources: event.sources }));
    case 'answer_delta':
      return updateCard(items, event.questionId, (card) => ({ answer: card.answer + event.delta, state: 'streaming' }));
    case 'answer_done':
      return updateCard(items, event.questionId, () => ({ state: 'done' }));
    case 'error':
      return event.questionId === undefined
        ? items
        : updateCard(items, event.questionId, () => ({ state: 'error', error: event.message }));
    default:
      return items;
  }
}

export const useConversation = create<ConversationState>((set) => ({
  items: [],
  listening: false,
  notice: null,
  apply: (event) =>
    set((state) => ({
      items: reduce(state.items, event),
      listening: event.type === 'listening' ? event.active : state.listening,
      notice: event.type === 'error' && event.questionId === undefined ? event.message : state.notice,
    })),
  clear: () => set({ items: [] }),
  setNotice: (notice) => set({ notice }),
}));

/** How a finished card's grounding should be labelled. */
export function grounding(card: Card): { cited: Source[]; label: 'sources' | 'general' | 'missing' | null } {
  const numbers = new Set([...card.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  const cited = card.sources.filter((s) => numbers.has(s.n));
  if (cited.length) return { cited, label: 'sources' };
  if (!card.sources.length) return { cited, label: null }; // no documents loaded: nothing to say
  return { cited, label: card.answer.trimStart().startsWith('Not in your notes') ? 'missing' : 'general' };
}
