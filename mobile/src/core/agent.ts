import { reasoningFor } from './config';
import type { Passage } from './contextStore';
import type { OpenAIClient } from './openai';
import type { ChatMessage } from './turns';

/** Same instructions as the web app's agent.py. */
export const BASE_INSTRUCTIONS = `You are a live assistant. You receive questions overheard in a conversation, and your answer is shown on screen to the person being asked, who may say it aloud.
Answer concisely in 1-3 sentences unless the question clearly needs more. Write the answer itself, with no preamble.
If the question is addressed to that person (their experience, work, opinions), answer in the first person as them.
Never invent facts about that person: employers, projects, years, numbers or experiences must come from the CONTEXT.
If the CONTEXT says nothing about them on the topic, reply only with a short note for them that starts with
"Not in your notes:" and names what is missing, optionally followed by one or two general talking points.
Never mention that you are transcribing audio.`;

const CONTEXT_INSTRUCTIONS = `
Base your answer on the numbered CONTEXT passages below whenever they are relevant.
When a sentence uses a passage, end the sentence with its number in brackets, e.g. [2]. Only cite passages that support the sentence.
If the passages do not contain the answer, answer from general knowledge and do not cite anything.

CONTEXT:
`;

export function buildInstructions(passages: Passage[]): string {
  if (!passages.length) return BASE_INSTRUCTIONS;
  const body = passages.map((p) => `[${p.n}] (${p.docName})\n${p.text}`).join('\n\n');
  return `${BASE_INSTRUCTIONS}\n${CONTEXT_INSTRUCTIONS}${body}`;
}

export type AnswerStreamer = (
  question: string,
  passages: Passage[],
  history: ChatMessage[],
  signal: AbortSignal,
) => AsyncIterable<string>;

/** Streams an answer grounded in the passages and earlier exchanges. */
export function makeAnswerStreamer(client: OpenAIClient, model: () => string): AnswerStreamer {
  return (question, passages, history, signal) => {
    const reasoning = reasoningFor(model());
    return client.streamText(
      {
        model: model(),
        // Instructions + context come first and history + question last, so prompt caching can reuse the prefix.
        instructions: buildInstructions(passages),
        input: [...history, { role: 'user', content: question }],
        ...(reasoning ? { reasoning } : {}),
      },
      signal,
    );
  };
}
