import { reasoningFor } from './config';
import type { OpenAIClient } from './openai';

export type Label = 'question' | 'repeat' | 'other';

export const MIN_WORDS = 2;

export const INSTRUCTIONS = `You label utterances overheard in a live conversation between an ASKER, who asks questions, and a LISTENER, who answers them, often by reading or paraphrasing the assistant's suggested answer aloud. Both may be picked up by the same microphone.

Label the LATEST utterance with exactly one letter:
Q - a new question or request for information from the asker that the assistant should answer. Includes implicit requests ("tell me about X", "I wonder how Y works") and follow-ups ("what about the second one?").
R - a repeat or rephrasing of a question already asked ("sorry, what was that?", "can you repeat the refund window?").
N - anything else: the listener answering or reading an answer (even if it contains rhetorical questions like "so why does that matter? because..."), statements, small talk, greetings, filler, social questions ("how are you?", "right?"), or fragments.

Reply with the single letter only.`;

const LABELS: Record<string, Label> = { Q: 'question', R: 'repeat', N: 'other' };

export function buildInput(utterance: string, history: [string, string][]): string {
  const lines = history.length ? ['Recent conversation:', ...history.map(([who, text]) => `${who}: ${text}`), ''] : [];
  lines.push(`LATEST utterance: ${utterance}`);
  return lines.join('\n');
}

export type Classifier = (text: string, history: [string, string][]) => Promise<Label>;

/** One-letter turn classifier (port of detector.py). A one-letter reply keeps the call near the API's minimum latency. */
export function makeClassifier(client: OpenAIClient, model: () => string): Classifier {
  return async (text, history) => {
    text = text.trim();
    if (text.split(/\s+/).length < MIN_WORDS) return 'other';
    const reasoning = reasoningFor(model());
    const reply = await client.responseText({
      model: model(),
      instructions: INSTRUCTIONS,
      input: buildInput(text, history),
      max_output_tokens: 16,
      ...(reasoning ? { reasoning } : {}),
    });
    return LABELS[reply.trim().charAt(0).toUpperCase()] ?? 'other';
  };
}
