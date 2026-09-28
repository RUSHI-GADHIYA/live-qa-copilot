"""Conversation history for one session, and the filter that spots the listener reading an answer aloud."""

import re
import time
from collections import deque
from dataclasses import dataclass, field

READBACK_THRESHOLD = 0.5  # share of the utterance's word pairs found in a recent answer
READBACK_WINDOW_S = 180  # answers older than this no longer count
READBACK_MIN_WORDS = 4  # shorter utterances only count when they appear word for word
READBACK_FRAGMENT_WORDS = 2  # ...down to this many words (pauses split read-aloud answers into fragments)


@dataclass
class Exchange:
    question_id: int
    question: str
    answer: str = ""
    asked_at: float = field(default_factory=time.monotonic)


def _words(text: str) -> list[str]:
    text = re.sub(r"\[\d+\]", " ", text)  # citation markers are shown on screen, never said aloud
    return re.findall(r"[a-z0-9']+", text.lower())


def _bigrams(words: list[str]) -> set[tuple[str, str]]:
    return set(zip(words, words[1:]))


class Conversation:
    def __init__(self, max_exchanges: int = 8, max_other: int = 4):
        self._exchanges: deque[Exchange] = deque(maxlen=max_exchanges)
        self._by_id: dict[int, Exchange] = {}
        self._other: deque[str] = deque(maxlen=max_other)  # recent non-question utterances

    def add_question(self, question_id: int, question: str) -> None:
        if len(self._exchanges) == self._exchanges.maxlen:
            self._by_id.pop(self._exchanges[0].question_id, None)
        exchange = Exchange(question_id, question)
        self._exchanges.append(exchange)
        self._by_id[question_id] = exchange

    def append_answer(self, question_id: int, delta: str) -> None:
        """Answers are recorded while they stream: the listener may start reading before they finish."""
        if exchange := self._by_id.get(question_id):
            exchange.answer += delta

    def add_other(self, text: str) -> None:
        self._other.append(text)

    @property
    def last_question_id(self) -> int | None:
        return self._exchanges[-1].question_id if self._exchanges else None

    def readback_score(self, utterance: str) -> float:
        """How much of the utterance is recent answer text being read aloud (0..1)."""
        words = _words(utterance)
        cutoff = time.monotonic() - READBACK_WINDOW_S
        answers = [_words(e.answer) for e in self._exchanges if e.asked_at >= cutoff]
        if len(words) < READBACK_MIN_WORDS:
            if len(words) < READBACK_FRAGMENT_WORDS:
                return 0.0
            fragment = " " + " ".join(words) + " "
            return 1.0 if any(fragment in " " + " ".join(answer) + " " for answer in answers) else 0.0
        answer_pairs: set[tuple[str, str]] = set()
        for answer in answers:
            answer_pairs |= _bigrams(answer)
        pairs = _bigrams(words)
        return len(pairs & answer_pairs) / len(pairs) if pairs else 0.0

    def is_readback(self, utterance: str) -> bool:
        return self.readback_score(utterance) >= READBACK_THRESHOLD

    def detector_history(self, max_turns: int = 6, answer_chars: int = 300) -> list[tuple[str, str]]:
        turns: list[tuple[str, str]] = []
        for exchange in list(self._exchanges)[-3:]:
            turns.append(("QUESTION", exchange.question))
            if exchange.answer:
                turns.append(("SUGGESTED ANSWER", exchange.answer[:answer_chars]))
        turns += [("OTHER", text) for text in self._other]
        return turns[-max_turns:]

    def answer_history(self, before_question_id: int, max_pairs: int = 4) -> list[dict]:
        """Earlier questions and answers as chat messages, so follow-up questions resolve."""
        messages: list[dict] = []
        earlier = [e for e in self._exchanges if e.question_id < before_question_id and e.answer]
        for exchange in earlier[-max_pairs:]:
            messages.append({"role": "user", "content": exchange.question})
            messages.append({"role": "assistant", "content": exchange.answer})
        return messages
