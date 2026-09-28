/**
 * Live check of the phone pipeline in Node, against the real OpenAI API (costs a few cents per run).
 *
 *   OPENAI_API_KEY=sk-... npm run live-test
 *
 * Voice A (the asker) and voice B (the listener) are generated with TTS, upsampled to the phone's 48 kHz,
 * and streamed at real-time pace through the same Copilot class the app uses. Voice B reads the app's own
 * generated answer aloud, which must not create a card.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

import { Copilot } from '../src/core/copilot';
import type { SessionEvent } from '../src/core/session';
import type { SocketLike } from '../src/core/transcriber';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('Set OPENAI_API_KEY');

const CACHE = join(__dirname, '.cache');
const CHUNK_48K = 4800; // 100 ms
const ASKER = 'alloy';
const LISTENER = 'onyx';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CONTEXT =
  'Acme Corp customer policy. Refunds: the refund window is 45 days from delivery, and refunds go back to the ' +
  'original payment method. Exchanges: allowed within 60 days of delivery, free of charge. ' +
  'Support hours: 9am to 5pm CET, Monday to Friday.';
const PROFILE =
  'Jordan Lee is a robotics engineer. Jordan spent four years at Acme Robotics leading the X7 arm integration team, ' +
  'and before that two years at Nordwerk building PLC control software.';

async function tts(text: string, voice: string): Promise<Int16Array> {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, `${voice}_${text.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60)}.pcm`);
  if (!existsSync(path)) {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'pcm' }),
    });
    if (!response.ok) throw new Error(`TTS failed: ${response.status} ${await response.text()}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = readFileSync(path);
  const pcm24 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  // The phone records at 48 kHz: repeat each sample, then the app's downsampler brings it back to 24 kHz.
  const pcm48 = new Int16Array(pcm24.length * 2);
  for (let i = 0; i < pcm24.length; i++) pcm48[2 * i] = pcm48[2 * i + 1] = pcm24[i];
  return pcm48;
}

const socketFactory = (url: string, headers: Record<string, string>) => new WebSocket(url, { headers }) as unknown as SocketLike;

async function main() {
  const events: SessionEvent[] = [];
  const copilot = new Copilot({
    apiKey: apiKey!,
    fetch: (url, init) => fetch(url, init),
    socketFactory,
    emit: (event) => events.push(event),
    log: (message) => console.log(`      [${message}]`),
  });
  let mark = 0;
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
    if (!ok) failures.push(name);
  };

  /** Streams speech at real-time pace, then silence; returns when the speech ends. */
  async function say(voice: string, text: string): Promise<number> {
    const pcm = await tts(text, voice);
    mark = events.length;
    for (let off = 0; off < pcm.length; off += CHUNK_48K) {
      copilot.pushAudio48k(pcm.subarray(off, off + CHUNK_48K));
      await sleep(100);
    }
    return Date.now();
  }
  async function silence(ms: number) {
    for (let t = 0; t < ms; t += 100) {
      copilot.pushAudio48k(new Int16Array(CHUNK_48K));
      await sleep(100);
    }
  }
  async function waitFor(predicate: (e: SessionEvent) => boolean, timeoutMs = 12_000): Promise<SessionEvent | undefined> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const found = events.slice(mark).find(predicate);
      if (found) return found;
      await silence(100);
    }
    return undefined;
  }
  const answerOf = (questionId: number) =>
    events.filter((e) => e.type === 'answer_delta' && e.questionId === questionId).map((e: any) => e.delta).join('');

  await copilot.context.clear();
  await copilot.context.add(CONTEXT, 'policy.txt');
  await copilot.context.add(PROFILE, 'profile.txt');
  await copilot.startListening();

  // 1. The asker asks; a card appears and the answer streams with a citation.
  const spokenAt = await say(ASKER, 'What is the refund window for Acme orders?');
  const card = (await waitFor((e) => e.type === 'question_detected')) as any;
  await waitFor((e) => e.type === 'answer_delta');
  const firstTextAt = Date.now();
  await waitFor((e) => e.type === 'answer_done');
  const answer = card ? answerOf(card.questionId) : '';
  check('asker question creates a card', !!card, JSON.stringify(answer));
  check('answer is grounded and cited', /45 days/.test(answer) && /\[\d\]/.test(answer));
  console.log(`      speech end -> first answer text: ${firstTextAt - spokenAt} ms (upper bound)`);

  const ignoredAs = async (reason: string, voice: string, text: string) => {
    const cardsBefore = events.filter((e) => e.type === 'question_detected').length;
    await say(voice, text);
    const ignored = (await waitFor((e) => e.type === 'utterance_ignored')) as any;
    await silence(2000);
    const cardsAfter = events.filter((e) => e.type === 'question_detected').length;
    check(`${JSON.stringify(text.slice(0, 48))} -> ignored (${reason})`, cardsAfter === cardsBefore && ignored?.reason === reason, `got ${ignored?.reason}`);
  };
  // 2. The listener reads the generated answer aloud (citation markers are not spoken).
  await ignoredAs('reading answer', LISTENER, answer.replace(/\[\d+\]/g, ''));
  // 3. A paraphrase with a rhetorical question inside.
  await ignoredAs('not a question', LISTENER, 'So basically you get about a month and a half. Why does that matter? Because nobody is rushed.');
  // 4. The asker asks for a repeat.
  await ignoredAs('repeat', ASKER, 'Sorry, what was the refund window again?');

  // 5. A follow-up that only makes sense with history.
  await say(ASKER, 'Is that the same for exchanges?');
  const followUp = (await waitFor((e) => e.type === 'question_detected')) as any;
  await waitFor((e) => e.type === 'answer_done');
  const followUpAnswer = followUp ? answerOf(followUp.questionId) : '';
  check('follow-up resolved with history and context', /60/.test(followUpAnswer), JSON.stringify(followUpAnswer));

  // 6. A first-person question answered from the profile, and one the notes do not cover.
  await say(ASKER, 'Tell me about your experience with the X7 arm.');
  const personal = (await waitFor((e) => e.type === 'question_detected')) as any;
  await waitFor((e) => e.type === 'answer_done');
  const personalAnswer = personal ? answerOf(personal.questionId) : '';
  check('first-person answer from the profile', /four years/i.test(personalAnswer), JSON.stringify(personalAnswer));

  await say(ASKER, 'What is your experience with Kubernetes?');
  const missing = (await waitFor((e) => e.type === 'question_detected')) as any;
  await waitFor((e) => e.type === 'answer_done');
  const missingAnswer = missing ? answerOf(missing.questionId) : '';
  check('no invented experience', /^Not in your notes/.test(missingAnswer.trim()), JSON.stringify(missingAnswer));

  copilot.stopListening();
  await copilot.context.clear();
  const errors = events.filter((e) => e.type === 'error');
  check('no errors', errors.length === 0, JSON.stringify(errors));
  console.log(failures.length ? `\nFailed: ${failures.join('; ')}` : '\nAll checks passed.');
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
