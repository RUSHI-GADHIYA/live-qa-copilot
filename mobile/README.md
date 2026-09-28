# Live Copilot (Android)

The phone version of the [web app](../web). Put the phone near a conversation. It detects the questions the other person asks and streams answers grounded in your documents. When you say an answer aloud, it recognises that and waits for the next real question.

It runs **standalone**: the phone calls OpenAI directly, and no laptop or server is involved. Your OpenAI key is typed into the app once and kept in Android's secure storage. It is never part of the app file.

## Install on your phone

The app uses native modules (live microphone streaming, PDF reading), so it runs as its own installed app, not inside Expo Go. EAS builds it in the cloud, so you don't need Android Studio.

```bash
npm install
npx eas-cli@latest login                                    # free Expo account
npx eas-cli@latest build -p android --profile preview       # about 10-15 min; prints a download link / QR code
```

Open the link on the phone, install the APK (allow "install unknown apps" for your browser if asked), then:

1. **Settings**: paste your OpenAI key, then tap **Check and save key**.
2. **Docs**: add a resume, job description, notes or manuals (txt, md, pdf, docx), or paste text.
3. **Conversation**: tap the mic and allow microphone and notification access.

## Using it

- The **Conversation** screen is a timeline of what was said. Questions become answer cards in the place where they were asked. Other lines are greyed out with the reason they were skipped (`reading answer`, `not a question`, `repeat`).
- While listening, the header shows a pulsing **● Listening**, and the status bar shows a mic icon and a "Listening to the conversation" notification. Listening keeps going with the screen off, and the screen stays on while the app is open.
- Cards show small citation numbers and the source documents (tap a chip to see the passage). **General knowledge** means your documents didn't cover the question. **Not in your notes** means a question about you that your documents don't answer, so the app says so instead of inventing something.
- A repeated question ("sorry, what was that?") makes its card flash instead of creating a new one. Follow-ups ("is that the same for exchanges?") use the earlier questions and answers.
- You can also type a question at the bottom.

**Limits:**
- The phone can only listen through its own microphone. Android doesn't let an app capture another app's call audio. For online calls, use the web app's **Call audio** mode on the laptop.
- One microphone can't tell voices apart. The app filters out *you reading or paraphrasing an answer*, but a genuinely new question from you would still get a card.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Answer while checking | on | Starts the answer in parallel with the question check (about 1 s faster) |
| Skip silence | on | Sends audio only while someone speaks (lower cost) |
| End-of-question pause | 400 ms | Raise it if slow speakers get cut off mid-sentence |
| Models | `gpt-transcribe`, `gpt-4o-mini`, `gpt-4.1` | For transcription, the question check and answers. `gpt-5.x` models run with reasoning off |

Documents up to 24k characters are sent whole with each question. Above that, the app sends every small document (up to 8k characters, e.g. a resume) plus the 6 most relevant chunks of the large ones. Documents and their embeddings are saved on the phone, so they survive restarts.

## Development

```bash
npm test                     # 45 unit tests (pipeline, audio, retrieval, timeline), no network
npm run typecheck
npx expo lint
OPENAI_API_KEY=sk-... npm run live-test   # the real pipeline against OpenAI, in Node (a few cents)
```

`npm run live-test` streams generated speech (at the phone's 48 kHz) through the same `Copilot` class the app uses. It checks a grounded and cited answer, that reading the answer aloud is ignored, a paraphrase with a rhetorical question, a repeat, a follow-up that needs history, a first-person answer from a profile, and "Not in your notes".

For a development build with fast refresh: `npx expo install expo-dev-client`, then `eas build -p android --profile development` (add that profile to `eas.json`), then `npx expo start`.

| Path | Role |
|---|---|
| `src/core/` | The pipeline, platform-independent (ported from the web app): `copilot.ts` wires it together; `session.ts` handles ordering, speculation and the concurrency cap; `transcriber.ts`, `detector.ts`, `agent.ts`, `turns.ts` (read-back filter), `contextStore.ts` + `retrieval.ts`, `audio/` (48→24 kHz, silence gate), `openai.ts` + `sse.ts` |
| `src/services/` | Phone glue: microphone stream, secure key and file storage, the app's Copilot instance |
| `src/app/` | Screens: conversation (`index`), `documents`, `settings` |
| `src/store.ts`, `src/ui/` | Timeline state and components |

## Privacy

While listening, audio is streamed to OpenAI for transcription, and questions, your documents and the answers are sent to OpenAI. No audio is written to the phone. Tell the people you're talking to, and get their consent before recording them.
