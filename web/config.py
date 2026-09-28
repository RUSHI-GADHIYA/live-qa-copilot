import os

from dotenv import load_dotenv

load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
TRANSCRIBE_MODEL = os.getenv("TRANSCRIBE_MODEL", "gpt-transcribe")
DETECTOR_MODEL = os.getenv("DETECTOR_MODEL", "gpt-4o-mini")
ANSWER_MODEL = os.getenv("ANSWER_MODEL", "gpt-4.1")
MAX_CONTEXT_CHARS = int(os.getenv("MAX_CONTEXT_CHARS", "30000"))
MAX_CONCURRENT_ANSWERS = int(os.getenv("MAX_CONCURRENT_ANSWERS", "3"))
VAD_SILENCE_MS = int(os.getenv("VAD_SILENCE_MS", "400"))
# Start answering while the detector runs; the answer is shown only if the utterance is a question.
SPECULATIVE_ANSWERS = os.getenv("SPECULATIVE_ANSWERS", "true").lower() in ("1", "true", "yes")
