from turns import Conversation

ANSWER = "The refund window is 45 days from delivery, and refunds go back to the original payment method."


def conversation_with_answer() -> Conversation:
    c = Conversation()
    c.add_question(1, "What is the refund window?")
    c.append_answer(1, ANSWER)
    return c


def test_verbatim_reading_is_readback():
    c = conversation_with_answer()
    assert c.readback_score("the refund window is 45 days from delivery") == 1.0
    assert c.is_readback("so the refund window is 45 days from delivery and refunds go back")


def test_partial_answer_counts_while_streaming():
    c = Conversation()
    c.add_question(1, "q")
    c.append_answer(1, "The refund window is 45 days")
    assert c.is_readback("the refund window is 45 days")


def test_new_questions_sharing_words_are_not_readback():
    c = conversation_with_answer()
    assert not c.is_readback("what is the refund window for exchanges")
    assert not c.is_readback("you said 45 days from delivery, does that include weekends?")
    assert not c.is_readback("how does photosynthesis work")


def test_fragments_count_only_when_read_word_for_word():
    c = conversation_with_answer()
    assert c.is_readback("The refund window.")
    assert c.is_readback("from delivery")
    assert not c.is_readback("It's 45 days.")  # "it's" is not in the answer text
    assert not c.is_readback("what about exchanges")
    assert c.readback_score("window") == 0.0  # single words are left to the detector


def test_detector_history_and_answer_history():
    c = conversation_with_answer()
    c.add_other("we should grab lunch")
    assert c.detector_history() == [
        ("QUESTION", "What is the refund window?"),
        ("SUGGESTED ANSWER", ANSWER),
        ("OTHER", "we should grab lunch"),
    ]
    c.add_question(2, "And exchanges?")
    assert c.answer_history(before_question_id=2) == [
        {"role": "user", "content": "What is the refund window?"},
        {"role": "assistant", "content": ANSWER},
    ]
    assert c.last_question_id == 2


def test_old_exchanges_are_evicted():
    c = Conversation(max_exchanges=2)
    for i in range(1, 4):
        c.add_question(i, f"q{i}")
        c.append_answer(i, f"a{i}")
    c.append_answer(1, "late delta for an evicted question")  # must not raise
    assert [m["content"] for m in c.answer_history(before_question_id=99)] == ["q2", "a2", "q3", "a3"]
