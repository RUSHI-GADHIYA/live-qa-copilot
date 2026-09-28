# Live Q&A Agent

A local web app that listens to your microphone, detects questions in the conversation, and streams answers into cards. Answers are grounded in context you paste or upload.

```
mic → Realtime transcription (server VAD) → question detector → Agents SDK answer → streamed card
```

## Setup

Requires Python 3.11+ and an OpenAI API key with Realtime API access.

```bash
pip install -r requirements.txt
cp .env.example .env   # then set OPENAI_API_KEY
uvicorn server:app --reload
```

Open http://localhost:8000. Use `localhost` rather than an IP address, because browsers only allow mic access on `localhost` or HTTPS.

## Using it

- **Start listening** asks for mic access and begins transcribing. Each finished utterance goes through the question detector. Questions get a card, and the answer streams in.
- **Context panel:** paste text and click **Save**, or upload a `.txt`, `.md`, `.pdf` or `.docx` file. Context over `MAX_CONTEXT_CHARS` is truncated, with a warning. Changes apply to the next question.
- **Debug input** (bottom of the feed): type an utterance. With "via detector" checked, it goes through the detector like speech does. Unchecked, it is answered directly.
- **Clear feed** clears the cards. **Clear** in the context panel removes the context.

## Configuration (`.env`)

| Key | Default | Purpose |
|---|---|---|
| `TRANSCRIBE_MODEL` | `gpt-4o-transcribe` | Realtime transcription model |
| `DETECTOR_MODEL` | `gpt-4o-mini` | Question classifier |
| `ANSWER_MODEL` | `gpt-4o` | Answer agent (`gpt-4o-mini` is cheaper and faster) |
| `MAX_CONTEXT_CHARS` | `30000` | Context size cap |
| `MAX_CONCURRENT_ANSWERS` | `3` | Answers streamed at once; extra questions queue |

## Files

| File | Role |
|---|---|
| `server.py` | FastAPI app: `/ws` WebSocket session, `/context` routes |
| `transcriber.py` | Bridge from browser PCM16 audio to an OpenAI Realtime transcription session |
| `detector.py` | Classifies utterances as questions (structured output) |
| `agent.py` | Agents SDK answer agent, streamed token by token |
| `context_store.py` | In-memory context and file text extraction |
| `static/` | UI (`index.html`, `app.js`, `style.css`) and the `pcm-worklet.js` audio worklet |

## Privacy

While listening, microphone audio is streamed to OpenAI for transcription. Detected questions and your context are also sent to OpenAI. Tell the people around you, and get their consent before recording them. Nothing is stored on disk: context and the feed live in memory and disappear on restart.
