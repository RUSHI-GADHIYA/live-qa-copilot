# Live Q&A Copilot

A live assistant for conversations. It listens, detects the questions the other person asks, and streams short answers grounded in your own documents (resume, notes, policies, manuals). When you say an answer aloud, it recognises that and waits for the next real question.

| App | Folder | Runs on | Best for |
|---|---|---|---|
| **Web** | [`web/`](web) | A Python (FastAPI) server on your computer, used in Chrome | Online calls: it captures only the call's audio, so your own voice never triggers answers. Also works with a room microphone |
| **Mobile** | [`mobile/`](mobile) | Android (Expo), standalone | In-person conversations, with the phone as the microphone. It calls OpenAI directly; no server needed |

Both apps share the same pipeline design:

```
audio → silence gate → OpenAI Realtime transcription → read-back filter → question check ─┐
                                                          (in parallel) grounded answer ─┴→ card with sources
```

- **Answers only the asker:** speech that repeats a recent answer is ignored locally, a turn-aware check skips paraphrases, rhetorical questions and repeats, and follow-ups use the conversation history.
- **Grounded:** answers cite your documents. Large documents are retrieved by embedding search, and small ones like a resume are always included. If a question about you isn't covered by your notes, the app says so instead of inventing an answer.
- **Fast:** the answer starts in parallel with the question check, and connections are kept warm. About 1.9 s from the end of a question to the first answer text (the first version took 3.2 s).

See [`web/README.md`](web/README.md) and [`mobile/README.md`](mobile/README.md) for setup.

## You need

An OpenAI API key with Realtime API access. The web app reads it from `web/.env`, which is git-ignored. The mobile app stores it in Android's secure storage. Neither app includes a key in this repository.

## Privacy

While listening, audio is streamed to OpenAI for transcription, and questions, your documents and the answers are sent to OpenAI. Tell the people you're talking to, and get their consent before recording them.
