import os

from dotenv import load_dotenv

load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
TRANSCRIBE_MODEL = os.getenv("TRANSCRIBE_MODEL", "gpt-transcribe")
DETECTOR_MODEL = os.getenv("DETECTOR_MODEL", "gpt-4o-mini")
ANSWER_MODEL = os.getenv("ANSWER_MODEL", "gpt-4.1")
# Context up to FULL_CONTEXT_CHARS goes into the prompt whole; beyond it, the top RETRIEVAL_TOP_K chunks do.
MAX_CONTEXT_CHARS = int(os.getenv("MAX_CONTEXT_CHARS", "2000000"))
FULL_CONTEXT_CHARS = int(os.getenv("FULL_CONTEXT_CHARS", "24000"))
RETRIEVAL_TOP_K = int(os.getenv("RETRIEVAL_TOP_K", "6"))
# In retrieval mode, documents up to this size (a resume, a job description) are always sent whole.
PIN_DOC_CHARS = int(os.getenv("PIN_DOC_CHARS", "8000"))
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
MAX_CONCURRENT_ANSWERS = int(os.getenv("MAX_CONCURRENT_ANSWERS", "3"))
VAD_SILENCE_MS = int(os.getenv("VAD_SILENCE_MS", "400"))
# Start answering while the detector runs; the answer is shown only if the utterance is a question.
SPECULATIVE_ANSWERS = os.getenv("SPECULATIVE_ANSWERS", "true").lower() in ("1", "true", "yes")
