# Live Q&A Agent

A local web app that listens to a conversation and detects the questions the other person asks. For each one it streams an answer into a card, grounded in your own documents. When you say an answer aloud, the app recognises that and waits for the next real question.

```
audio → silence gate → Realtime transcription → read-back filter → detector ─┐
                                                        (in parallel) answer ─┴→ card with sources
```

## Setup

Requires Python 3.11+ and an OpenAI API key with Realtime API access.

```bash
pip install -r requirements.txt
cp .env.example .env   # then set OPENAI_API_KEY
uvicorn server:app --reload
```

Open http://localhost:8000 in Chrome. Use `localhost`, not an IP address, because browsers only allow audio capture on `localhost` or HTTPS.

## Choosing the audio source

| Source | When | How it knows who is asking |
|---|---|---|
| **Call audio** | Online calls (Meet, Teams, Zoom) | Only the call's audio is captured, so your own voice never reaches the app. On **Start**, pick the call's browser tab with **Share tab audio** on. For a desktop app (Zoom, Teams), pick **Entire screen** with **Share system audio** on. |
| **Room mic** | Everyone in the same room | One mic hears everyone, so the app filters by content. Speech that matches a recent answer (you reading it aloud) is ignored without an API call. The detector also sees the recent conversation, so paraphrased answers, rhetorical questions inside an answer, and "sorry, what was that?" repeats don't create new cards. |

The transcript strip shows why an utterance was skipped (`ignored: reading answer`, `repeat`, `not a question`). A repeated question makes its existing card pulse.

**Skip silence** (on by default) sends audio only while someone is speaking. That lowers Realtime transcription cost and doesn't affect accuracy.

## Context and grounding

- Upload `.txt`, `.md`, `.pdf` or `.docx` files, or paste text. Each becomes a document in the list, and you can remove documents one at a time.
- Up to `FULL_CONTEXT_CHARS` (24k characters) in total, every document is sent whole with each question. Above that, documents are chunked and embedded when you add them, and each question gets the most relevant chunks. Small documents (up to `PIN_DOC_CHARS`, such as a resume or a job description) are always sent whole, so a large manual can't crowd them out.
- Answers cite the passages they used. Citations appear as small numbers, and the card lists the source documents (hover for the text).
- **General knowledge**: the context didn't cover the question, so the answer comes from the model.
- **Not in your notes**: a question about you (your experience, your work) that your documents don't cover. The app says so instead of inventing an answer.
- Names and terms from your documents are passed to the transcriber, so they're spelled correctly (for example "Kubeflow" rather than "CubeFlow").
- Follow-up questions ("is that the same for exchanges?") use the previous questions and answers.

## Speed

End to end with realistic 10 s pauses between questions, measured from the end of the speech audio to the first answer text: **3.2 s** for the original MVP, now about **1.9 s**. The main changes:

- The answer starts at the same time as the question detector, and stays hidden until the detector confirms a question.
- The detector returns a single letter instead of JSON.
- HTTP connections are kept open for 120 s and warmed while listening. After more than 5 s idle, the SDK default would add about 0.5 s to the next question.
- The benchmarks chose the fastest models: `gpt-transcribe`, `gpt-4.1` for answers, and 400 ms end-of-turn silence.

The server logs per-stage timings (`transcript final`, `detector`, `answer first token`).

## Configuration (`.env`)

| Key | Default | Purpose |
|---|---|---|
| `TRANSCRIBE_MODEL` | `gpt-transcribe` | Realtime transcription model |
| `DETECTOR_MODEL` | `gpt-4o-mini` | Question/turn detector |
| `ANSWER_MODEL` | `gpt-4.1` | Answer agent (`gpt-5.x` models run with reasoning off) |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Retrieval embeddings |
| `VAD_SILENCE_MS` | `400` | Silence that ends a turn. Raise it if slow speakers get cut off mid-sentence |
| `SPECULATIVE_ANSWERS` | `true` | Start answering while the detector runs |
| `MAX_CONTEXT_CHARS` | `2000000` | Total context limit |
| `FULL_CONTEXT_CHARS` | `24000` | Above this, use retrieval |
| `PIN_DOC_CHARS` | `8000` | In retrieval mode, documents this small are always sent whole |
| `RETRIEVAL_TOP_K` | `6` | Chunks retrieved per question |
| `MAX_CONCURRENT_ANSWERS` | `3` | Answers streamed at once; extra questions queue |

## Development

```bash
python -m pytest -q                                        # offline tests, no API calls
python scripts/bench_latency.py detector|answer|transcribe # per-stage model benchmarks (live)
python scripts/bench_latency.py e2e --url ws://localhost:8000/ws
python scripts/room_scenario.py --url http://localhost:8000  # two-voice room-mode check (live)
```

The live scripts generate speech with OpenAI TTS and cost a few cents per run.

| File | Role |
|---|---|
| `server.py` | FastAPI app: `/ws` session pipeline (filters, speculative answers, ordering), `/context` routes |
| `transcriber.py` | Bridge from PCM16 audio to an OpenAI Realtime transcription session |
| `turns.py` | Conversation history and the read-back filter |
| `detector.py` | One-letter turn classifier (question / repeat / other) |
| `agent.py` | Agents SDK answer agent with citations |
| `context_store.py`, `retrieval.py` | Documents, chunking, embeddings, top-k search |
| `openai_client.py` | Shared client with long-lived, pre-warmed connections |
| `static/` | UI, `pcm-worklet.js` (24 kHz PCM16), `gate.js` (silence gate) |

## Privacy

While listening, the captured audio is streamed to OpenAI for transcription, and detected questions, your documents and the answers are sent to OpenAI. Tell the people you're talking to, and get their consent before recording them. Nothing is written to disk: documents and the feed live in memory and disappear when the server restarts.
